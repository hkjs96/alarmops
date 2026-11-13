/**
 * Content-Security-Policy with a per-request nonce (set in middleware.ts; hardening 2c).
 *
 * Production: scripts run only with this request's nonce ('strict-dynamic' lets those scripts load the framework's
 * chunks); no 'unsafe-inline' and no 'unsafe-eval' for scripts. Development keeps 'unsafe-eval' (React Refresh).
 * style-src keeps 'unsafe-inline': the app sets inline style attributes (heights that hold rows in place).
 * Fonts are the console's own files: nothing is fetched from another origin.
 */
export function buildCsp(nonce: string, production: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self'${production ? "" : " ws: wss:"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** 128 random bits, base64 */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
