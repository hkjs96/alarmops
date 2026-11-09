import { createHash, timingSafeEqual } from 'node:crypto';

/** `Authorization: Bearer in_<hex>` first, `?token=` fallback for providers that cannot set headers (API-CONTRACT §4). */
export function extractToken(headers: Record<string, string | undefined>, query: Record<string, string | undefined> | null | undefined): string | null {
  const auth = headers.authorization ?? headers.Authorization;
  const m = auth ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
  if (m?.[1]) return m[1];
  const q = query?.token;
  return q && q.trim() ? q.trim() : null;
}

export const TOKEN_RE = /^in_[0-9a-f]{40}$/;
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time compare of two hex digests. */
export function digestEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
