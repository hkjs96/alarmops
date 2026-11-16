import { NotConfiguredError } from '../config.js';

export interface DbConnOptions { ssl?: { rejectUnauthorized: true }; pooler?: 'transaction' }

/**
 * Connection hardening for the Lambda (security review lambda-packaging 2, 6). In Lambda (AWS_LAMBDA_FUNCTION_NAME set)
 * the URL must ask for TLS (`sslmode=require|verify-ca|verify-full`); a missing, `disable`, `allow` or `prefer` mode
 * refuses to start (only the setting name is reported, never the URL). Certificates are always verified
 * (`rejectUnauthorized: true`); if the database CA is not in the Node trust store, add `sslrootcert=<file in the bundle>`
 * to the URL (pg reads it). Port 6543 (or DATABASE_POOLER=transaction) means a transaction-mode pooler: no startup options.
 * Outside Lambda (local runs) nothing is enforced.
 */
export function dbConnOptions(url: string, env: Record<string, string | undefined> = process.env): DbConnOptions {
  const out: DbConnOptions = {};
  let port = '';
  let mode: string | null = null;
  try {
    const u = new URL(url);
    port = u.port;
    mode = u.searchParams.get('sslmode');
  } catch {
    throw new NotConfiguredError('DATABASE_URL_SECRET_ARN (secret is not a valid URL)');
  }
  if (env.DATABASE_POOLER === 'transaction' || port === '6543') out.pooler = 'transaction';
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    if (!mode || !['require', 'verify-ca', 'verify-full'].includes(mode)) {
      throw new NotConfiguredError('DATABASE_URL_SECRET_ARN (connection string needs sslmode=require, verify-ca or verify-full)');
    }
    out.ssl = { rejectUnauthorized: true };
  }
  return out;
}
