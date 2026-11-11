import pg from 'pg';
import { STATEMENT_TIMEOUT_MS, LOCK_TIMEOUT_MS, txPreamble, type SqlClient, type SqlExecutor, type SqlRow } from '../client.js';

export interface PgClientOptions {
  connectionString: string;
  /** Pool size (default 10). One tick uses up to 4 lanes × 5 sends at once, each holding a connection only per statement. */
  max?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Extra `search_path` (tests: one schema per run). */
  schema?: string;
  ssl?: pg.PoolConfig['ssl'];
}

// int8 (count(*), sequences) and numeric as JS numbers: every such value in this schema fits.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/**
 * node-postgres driver: real Postgres 15+ / Supabase. `statement_timeout` is set twice: as a connection default
 * (single statements) and with SET LOCAL in every transaction (so it also holds behind a transaction-mode pooler,
 * where session settings are not kept — use `transaction` paths only, or the session pooler, in that setup).
 */
export function pgClient(opts: PgClientOptions): SqlClient & { pool: pg.Pool } {
  const st = opts.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  const lt = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const settings = [`-c statement_timeout=${st}`, `-c lock_timeout=${lt}`, ...(opts.schema ? [`-c search_path=${opts.schema},public`] : [])].join(' ');
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.max ?? 10, options: settings, ssl: opts.ssl, idleTimeoutMillis: 0, allowExitOnIdle: true });
  pool.on('error', () => undefined); // an idle connection that died is replaced on the next checkout
  const exec = (c: pg.Pool | pg.PoolClient): SqlExecutor => ({
    query: async <T extends SqlRow>(text: string, params?: readonly unknown[]) => (await c.query(text, params as unknown[] | undefined)).rows as T[],
  });
  return {
    pool,
    ...exec(pool),
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      let broken: unknown;
      try {
        await c.query(`BEGIN; ${txPreamble(st, lt)}`);
        const out = await fn(exec(c));
        await c.query('COMMIT');
        return out;
      } catch (err) {
        try { await c.query('ROLLBACK'); } catch (e) { broken = e; }
        throw err;
      } finally {
        c.release(broken ? (broken as Error) : undefined);
      }
    },
    now: () => 'now()',
    close: () => pool.end(),
  };
}
