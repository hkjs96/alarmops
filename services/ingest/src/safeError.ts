/** Log-safe view of an error: type name and a short code (SQLSTATE / errno) only. Never the message: a driver error can carry host, user or the connection string. */
export function safeError(err: unknown): { name: string; code?: string } {
  const name = err instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(err.name) ? err.name : 'Error';
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? { name, code } : { name };
}
