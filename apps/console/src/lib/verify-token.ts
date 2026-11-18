/**
 * The public verification link is /verify/<token>. A token is a credential: it is checked for shape before anything
 * is asked of the API (a malformed one is the same "expired" answer as an unknown one), and it never reaches a log line.
 */
export const VERIFY_TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
export const isVerifyToken = (v: unknown): v is string => typeof v === "string" && VERIFY_TOKEN_RE.test(v);
/** The path as it may be logged (packages/api `loggablePath` does the same for its own log) */
export const loggablePath = (path: string): string => path.replace(/(\/verify\/)[^/?#]*/g, "$1[token]");
/** The public paths of the verification page, for the middleware: the page and its Confirm action (the same address, POST) */
export const VERIFY_PATH = /^\/verify\/[A-Za-z0-9_-]{1,200}$/;
