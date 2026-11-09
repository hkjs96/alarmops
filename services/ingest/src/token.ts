import { createHash, timingSafeEqual } from 'node:crypto';

export interface ExtractedToken { token: string; via: 'header' | 'query' }

/**
 * `Authorization: Bearer in_<hex>` first, `?token=` fallback for providers that cannot set headers (API-CONTRACT §4).
 * Security B-2: the query fallback is only honoured when the matched source has `allowQueryToken` (checked by the
 * caller via `via`), because query strings end up in access logs.
 */
export function extractToken(headers: Record<string, string | undefined>, query: Record<string, string | undefined> | null | undefined): ExtractedToken | null {
  const auth = headers.authorization ?? headers.Authorization;
  const m = auth ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
  if (m?.[1]) return { token: m[1], via: 'header' };
  const q = query?.token;
  return q && q.trim() ? { token: q.trim(), via: 'query' } : null;
}

/** Security B-2: strip ingest tokens from anything that may be logged (paths, query strings, header values). */
export function redactToken(s: string): string {
  return s
    .replace(/([?&]token=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/in_[0-9a-f]{8,}/gi, 'in_[REDACTED]');
}

export const TOKEN_RE = /^in_[0-9a-f]{40}$/;
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time compare of two hex digests. */
export function digestEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
