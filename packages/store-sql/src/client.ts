/**
 * The thin SQL port every repository in this package is written against. No ORM, no generated types: the hot paths
 * (tick claim, outbox claim) are explicit SQL (D-10: Prisma stays the MIGRATION tool only).
 *
 * Drivers: `pgClient` (node-postgres: real Postgres, Supabase), `pgliteClient` (WASM Postgres for tests where no
 * server exists), `prismaClient` ($queryRawUnsafe / $transaction of an existing PrismaClient).
 */
export type SqlRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SqlExecutor {
  /** One statement, positional parameters `$1 …`. Timestamps are passed as ISO strings, json as text + `::jsonb`. */
  query<T extends SqlRow = SqlRow>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface SqlClient extends SqlExecutor {
  /**
   * One transaction, isolation level READ COMMITTED — set explicitly at its start, not inherited from the server
   * (the claim relies on it: after the lane's advisory lock is granted, the next statement must see what the
   * previous holder committed). The driver also sets `statement_timeout`, `lock_timeout` and
   * `idle_in_transaction_session_timeout` with SET LOCAL (N-33: below STORE_CALL_TIMEOUT_MS), so the limits hold
   * behind a transaction pooler too. A throw rolls back and is re-thrown.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /**
   * SQL expression for the STORE's clock (R-14). Production: `now()` — the database's time, the same for every
   * runner. The repositories never take "now" from the caller for due / lease / retry decisions; they splice this
   * expression into the statement. Tests replace it with a literal (`withClock`) to run on simulated time.
   */
  now(): string;
  close?(): Promise<void>;
}

/** N-33: must stay below core STORE_CALL_TIMEOUT_MS (5 000 ms). */
export const STATEMENT_TIMEOUT_MS = 4_500;
/** A row lock that is not granted in this time fails the statement instead of holding the tick. */
export const LOCK_TIMEOUT_MS = 3_000;
/** A transaction whose process froze between two statements is ended by the server after this long; its row locks go with it (R-3). */
export const IDLE_IN_TX_TIMEOUT_MS = 15_000;
/** Waiting for a pooled connection (or for the TCP/TLS connect) gives up after this long instead of queueing without end (R-3). */
export const CONNECT_TIMEOUT_MS = 3_000;
/**
 * Client-side limit of one statement: when the server does not answer at all (network gone — `statement_timeout`
 * is enforced by the server and cannot help), the call fails here and the connection is thrown away (R-3).
 * Above STATEMENT_TIMEOUT_MS so that a slow statement is cancelled by the server first.
 */
export const QUERY_TIMEOUT_MS = 5_000;
/**
 * First statements of every transaction. `SET TRANSACTION` must come before any query; everything is SET LOCAL
 * (transaction-scoped), so nothing here relies on session state — safe behind a transaction-mode pooler.
 */
export const txPreamble = (statementMs = STATEMENT_TIMEOUT_MS, lockMs = LOCK_TIMEOUT_MS, idleMs = IDLE_IN_TX_TIMEOUT_MS): string =>
  `SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout = ${Math.floor(statementMs)}; SET LOCAL lock_timeout = ${Math.floor(lockMs)}; SET LOCAL idle_in_transaction_session_timeout = ${Math.floor(idleMs)}`;

/** Postgres error codes the repositories react to. */
export const PG = { UNIQUE: '23505', QUERY_CANCELED: '57014', LOCK_NOT_AVAILABLE: '55P03', SERIALIZATION: '40001', DEADLOCK: '40P01' } as const;
export const pgCode = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

/**
 * The same client on another clock: `now()` becomes a timestamptz literal taken from `clock` at the moment a
 * statement is built. Tests and local simulations only — production uses the database's own `now()`.
 */
export function withClock(client: SqlClient, clock: () => Date): SqlClient {
  return {
    query: (t, p) => client.query(t, p),
    transaction: (fn) => client.transaction(fn),
    now: () => `'${clock().toISOString()}'::timestamptz`,
    close: () => client.close?.() ?? Promise.resolve(),
  };
}

/** Counts statements in flight, so a test on fake timers can wait for real I/O (`busy`). */
export function tracked(client: SqlClient): SqlClient & { busy(): boolean; statements: number } {
  let inFlight = 0;
  const run = <T>(p: () => Promise<T>): Promise<T> => { inFlight++; out.statements++; return p().finally(() => { inFlight--; }); };
  const out = {
    statements: 0,
    query: <T extends SqlRow>(t: string, p?: readonly unknown[]) => run(() => client.query<T>(t, p)),
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => run(() => client.transaction(fn)),
    now: () => client.now(),
    close: () => client.close?.() ?? Promise.resolve(),
    busy: () => inFlight > 0,
  };
  return out;
}
