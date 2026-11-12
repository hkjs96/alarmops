import pg from 'pg';
import { CONNECT_TIMEOUT_MS, IDLE_IN_TX_TIMEOUT_MS, LOCK_TIMEOUT_MS, QUERY_TIMEOUT_MS, STATEMENT_TIMEOUT_MS, txPreamble, type SqlClient, type SqlExecutor, type SqlRow } from '../client.js';

export interface PgClientOptions {
  connectionString: string;
  /** Pool size (default 10). One tick uses up to 4 lanes × 5 sends at once, each holding a connection only per statement. */
  max?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Waiting for a free pooled connection / for the connect itself (default CONNECT_TIMEOUT_MS). */
  connectionTimeoutMs?: number;
  /** Client-side limit per statement (default QUERY_TIMEOUT_MS). */
  queryTimeoutMs?: number;
  /**
   * What sits between this process and Postgres.
   * - 'direct' (default; also a SESSION-mode pooler, Supabase port 5432): the limits are connection defaults sent
   *   as startup parameters, single statements run as they are.
   * - 'transaction' (a TRANSACTION-mode pooler: Supabase/Supavisor port 6543, PgBouncer `pool_mode = transaction`):
   *   a server connection is only ours for one transaction, so NO session state is assumed — no startup
   *   `options` are sent, every single statement is wrapped in its own short transaction that sets the limits with
   *   SET LOCAL, and nothing is ever SET outside a transaction. Named prepared statements are not used in either
   *   mode (node-postgres only prepares when a query has a `name`; this package never gives one).
   */
  pooler?: 'direct' | 'transaction';
  /** Extra `search_path` (tests: one schema per run). Letters, digits and `_` only: it is spliced into SQL. */
  schema?: string;
  ssl?: pg.PoolConfig['ssl'];
}

// int8 (count(*), sequences) and numeric as JS numbers: every such value in this schema fits.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/**
 * node-postgres driver: real Postgres 15+ / Supabase (security review SQL, R-3).
 *
 * Every wait has an upper bound:
 * - a free connection / the connect: `connectionTimeoutMillis` (3 s);
 * - a statement the server is working on: `statement_timeout` (4.5 s), a lock: `lock_timeout` (3 s);
 * - a statement the server never answers (network gone): `query_timeout` (5 s, client side) + TCP keep-alive;
 * - a transaction whose process froze: `idle_in_transaction_session_timeout` (15 s) — its locks are released.
 * The server-side limits are set in every transaction with SET LOCAL and, depending on `pooler`, as connection
 * defaults ('direct') or by wrapping single statements in a transaction ('transaction'). As a third layer the
 * database role should carry them (`ALTER ROLE … SET …`, db/README.md): that holds whatever the pooler does.
 */
export function pgClient(opts: PgClientOptions): SqlClient & { pool: pg.Pool } {
  const st = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  const lt = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const pooled = opts.pooler === 'transaction';
  if (opts.schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(opts.schema)) throw new Error('pgClient: schema must be a plain identifier');
  const settings = [
    `-c statement_timeout=${st}`, `-c lock_timeout=${lt}`, `-c idle_in_transaction_session_timeout=${IDLE_IN_TX_TIMEOUT_MS}`,
    '-c default_transaction_isolation=read\\ committed', ...(opts.schema ? [`-c search_path=${opts.schema},public`] : []),
  ].join(' ');
  const pool = new pg.Pool({
    connectionString: opts.connectionString, max: opts.max ?? 10, ssl: opts.ssl, idleTimeoutMillis: 0, allowExitOnIdle: true,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? CONNECT_TIMEOUT_MS,
    query_timeout: opts.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
    keepAlive: true, keepAliveInitialDelayMillis: 10_000,
    ...(pooled ? {} : { options: settings }),
  });
  pool.on('error', () => undefined); // an idle connection that died is replaced on the next checkout
  const exec = (c: pg.Pool | pg.PoolClient): SqlExecutor => ({
    query: async <T extends SqlRow>(text: string, params?: readonly unknown[]) => (await c.query(text, params as unknown[] | undefined)).rows as T[],
  });
  const begin = `BEGIN; ${txPreamble(st, lt)}${pooled && opts.schema ? `; SET LOCAL search_path = ${opts.schema}, public` : ''}`;
  async function transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    let broken: unknown;
    try {
      await c.query(begin);
      const out = await fn(exec(c));
      await c.query('COMMIT');
      return out;
    } catch (err) {
      // A statement that timed out on the client may still be on the wire: the ROLLBACK then fails or times out
      // too and the connection is destroyed, not returned to the pool.
      try { await c.query('ROLLBACK'); } catch (e) { broken = e; }
      throw err;
    } finally {
      c.release(broken ? (broken as Error) : undefined);
    }
  }
  return {
    pool,
    // 'transaction' pooler: a single statement has no connection defaults to rely on → its own short transaction.
    query: pooled ? <T extends SqlRow>(text: string, params?: readonly unknown[]) => transaction((tx) => tx.query<T>(text, params)) : exec(pool).query,
    transaction,
    now: () => 'now()',
    close: () => pool.end(),
  };
}
