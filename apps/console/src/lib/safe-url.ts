/** Allowlist for payload-supplied links (security review C-4). Returns null when the URL must render as text. */
export function safeExternalUrl(raw: unknown, opts: { slack?: boolean } = {}): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (opts.slack) {
    const h = u.hostname.toLowerCase();
    if (h !== "slack.com" && !h.endsWith(".slack.com")) return null;
  }
  return u.toString();
}
