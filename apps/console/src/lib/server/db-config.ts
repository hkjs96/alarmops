type Env = Record<string, string | undefined>;
/** DATABASE_URL (+ DATABASE_POOLER=transaction|direct, DATABASE_POOL_MAX). null when DATABASE_URL is not set: fail closed. */
export function databaseConfig(env: Env): { url: string; pooler: "direct" | "transaction"; max: number } | null {
  const url = env.DATABASE_URL?.trim();
  if (!url) return null;
  const max = Number(env.DATABASE_POOL_MAX ?? "");
  // serverless: few connections per instance; the pooler multiplexes
  return { url, pooler: env.DATABASE_POOLER === "transaction" ? "transaction" : "direct", max: Number.isInteger(max) && max > 0 && max <= 20 ? max : 3 };
}
