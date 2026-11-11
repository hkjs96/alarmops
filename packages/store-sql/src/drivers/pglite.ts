import { txPreamble, type SqlClient, type SqlExecutor, type SqlRow } from '../client.js';

/** The part of `@electric-sql/pglite`'s PGlite this driver uses (the package is a devDependency: tests and local runs). */
export interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>; exec(text: string): Promise<unknown> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * PGlite driver (Postgres compiled to WASM, in-process). For tests and local runs where no server exists.
 * Limits against a real server, see db/README.md: ONE connection (transactions run one after the
 * other, so FOR UPDATE SKIP LOCKED never has anything to skip) and `statement_timeout` is accepted but not enforced.
 */
export function pgliteClient(db: PGliteLike): SqlClient {
  const num = (rows: SqlRow[]): SqlRow[] => rows; // int8/numeric already arrive as numbers / are cast in SQL
  return {
    query: async <T extends SqlRow>(text: string, params?: readonly unknown[]) => num((await db.query<SqlRow>(text, params as unknown[] | undefined)).rows) as T[],
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => db.transaction(async (tx) => {
      await tx.exec(txPreamble());
      return fn({ query: async <R extends SqlRow>(text: string, params?: readonly unknown[]) => (await tx.query<SqlRow>(text, params as unknown[] | undefined)).rows as R[] });
    }),
    now: () => 'now()',
    close: () => db.close(),
  };
}
