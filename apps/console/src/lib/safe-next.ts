/**
 * The only check for a `next=` address (dev sign-in today, the SSO callback later): the value must be a path on this
 * origin. Security S-3: `/%09/evil.example` passed a `startsWith("//")` check, and the URL parser then dropped the tab
 * and read `//evil.example` as another host.
 *
 * Refused, raw or percent-encoded (decoded up to 3 times): control characters, backslashes, `//` anywhere.
 * Then the value is parsed against a placeholder origin and must stay on it. Returns the normalised
 * path + query + hash, or `fallback`.
 */
const PLACEHOLDER = "http://console.invalid";
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]|\/\//;

export function safeNextPath(raw: unknown, fallback = "/incidents"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || raw[0] !== "/") return fallback;
  let s = raw;
  for (let round = 0; ; round++) {
    if (FORBIDDEN.test(s)) return fallback;
    let d: string;
    try { d = decodeURIComponent(s); } catch { return fallback; }
    if (d === s) break;
    if (round === 3) return fallback; // still unwrapping after three rounds: not an address this app made
    s = d;
  }
  let u: URL;
  try { u = new URL(raw, PLACEHOLDER); } catch { return fallback; }
  if (u.origin !== PLACEHOLDER || u.username || u.password || !u.pathname.startsWith("/") || u.pathname.startsWith("//")) return fallback;
  return u.pathname + u.search + u.hash;
}
