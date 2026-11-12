import { txPreamble, type SqlClient, type SqlExecutor, type SqlRow } from '../client.js';

/** The two PrismaClient methods this driver needs (no generated types are imported). */
export interface PrismaLike {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
}

/**
 * Driver over an existing PrismaClient ($queryRawUnsafe with positional parameters). NOT exercised in the agent
 * sandbox (the Prisma engine cannot be downloaded there): run `npm run test:sql` with a driver switch before
 * relying on it. Known differences to handle when it is first used: Prisma returns int8 as BigInt and numeric as
 * Decimal — every count in this package is cast to int in SQL, numeric columns go through Number().
 */
export function prismaClient(prisma: PrismaLike): SqlClient {
  const exec = (p: PrismaLike): SqlExecutor => ({ query: <T extends SqlRow>(text: string, params: readonly unknown[] = []) => p.$queryRawUnsafe<T[]>(text, ...params) });
  return {
    ...exec(prisma),
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) => prisma.$transaction(async (tx) => {
      for (const s of txPreamble().split('; ')) await tx.$executeRawUnsafe(s);
      return fn(exec(tx));
    }, { timeout: 10_000, maxWait: 5_000 }),
    now: () => 'now()',
  };
}
