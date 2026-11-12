/** Never log raw messages (they can carry SQL, row values or connection strings): name + pg code only. */
export function errorTag(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,16}$/.test(code) ? `${e.name} code=${code}` : e.name;
}
