type Env = Record<string, string | undefined>;
export interface PostHeaders { origin: string | null; host: string | null; forwardedHost: string | null; secFetchSite: string | null }

/**
 * Is this POST from the console's own origin? (sign-out: a page on another site must not be able to sign a user out)
 *
 * `Origin` is compared with the host the request was addressed to. That is the `Host` header. `X-Forwarded-Host` is
 * believed only when TRUSTED_PROXY=1 says the console runs behind a proxy that sets it itself — overwriting whatever
 * the client sent. Without that, anyone can send the header and the check would mean nothing (security 재검토 권고 3).
 * `Sec-Fetch-Site`, when the browser sends it, must say same-origin. A request with neither header comes from an old
 * browser or from something that is not a browser, which carries no victim's cookie: it is let through.
 */
export function sameOriginPost(h: PostHeaders, env: Env = process.env): boolean {
  if (h.secFetchSite && h.secFetchSite !== "same-origin") return false;
  if (!h.origin) return true;
  const forwarded = env.TRUSTED_PROXY === "1" ? h.forwardedHost?.split(",")[0]?.trim() || null : null;
  const host = forwarded ?? h.host;
  if (!host) return false;
  try { return new URL(h.origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}
