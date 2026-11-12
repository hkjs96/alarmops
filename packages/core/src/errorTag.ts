/**
 * A loggable tag for an unknown error: the error's name plus a short pg-style code, never its message. Raw
 * messages can carry SQL, row values, contact data or connection strings, so they are neither logged nor returned
 * (tick summary, API 500, console adapters). Used by packages/core (tick), packages/api (router) and apps/console.
 */
export function errorTag(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,16}$/.test(code) ? `${e.name} code=${code}` : e.name;
}
