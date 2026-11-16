import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { NotConfiguredError, requireEnv } from '../config.js';

export type SecretsClient = Pick<SecretsManagerClient, 'send'>;

/**
 * Reads the Postgres connection string from Secrets Manager (`DATABASE_URL_SECRET_ARN`, central.yaml).
 * The value is never logged and never put in an error message. The secret holds the bare connection string
 * (docs/GO-LIVE.md step 9); a JSON object with `url` or `DATABASE_URL` is accepted as well.
 */
export async function readDatabaseUrl(client: SecretsClient, env: Record<string, string | undefined> = process.env): Promise<string> {
  const arn = requireEnv('DATABASE_URL_SECRET_ARN', env);
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const raw = res.SecretString?.trim();
  if (!raw) throw new NotConfiguredError('DATABASE_URL_SECRET_ARN (secret has no value yet)');
  if (!raw.startsWith('{')) return raw;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { throw new NotConfiguredError('DATABASE_URL_SECRET_ARN (secret is not a connection string)'); }
  const o = obj as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url : typeof o.DATABASE_URL === 'string' ? o.DATABASE_URL : '';
  if (!url.trim()) throw new NotConfiguredError('DATABASE_URL_SECRET_ARN (secret JSON has no url)');
  return url.trim();
}

/**
 * One value per container (cold start). A failed read is not cached: the next invocation tries again, so a secret
 * that a person fills in later starts working without a redeploy.
 */
export function onceAsync<T>(init: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    if (!p) p = init().catch((e) => { p = undefined; throw e; });
    return p;
  };
}
