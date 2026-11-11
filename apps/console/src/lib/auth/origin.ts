type Env = Record<string, string | undefined>;
export interface PostHeaders {
  origin: string | null; host: string | null; forwardedHost: string | null; secFetchSite: string | null;
  /**
   * the scheme of the request as the server sees it: "http" or "https" (with or without the colon). In a route handler
   * this is `req.nextUrl.protocol` — Next takes it from `X-Forwarded-Proto` when a proxy (or a client that is not a
   * browser) sent one, and from the connection otherwise.
   */
  proto: string | null;
}

const first = (v: string | null | undefined): string | null => v?.split(",")[0]?.trim() || null;
/** "https://Console.Example:443" → "https://console.example"; anything that is not an http(s) origin → null */
function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

/**
 * Is this POST from the console's own origin? (sign-out: a page on another site must not be able to sign a user out)
 *
 * `Origin` is compared as a whole — scheme, host and port (security 재검토 3 권고 2: `https://host` was accepted by
 * a console served over `http://host`, because only the host was looked at) — with the origin the console is served at:
 *   - `CONSOLE_ORIGIN` when it is set (e.g. `https://console.example.com`): the one value that counts, whatever the
 *     request's own headers say. The strict setting for production.
 *   - otherwise the request's scheme (`proto`) plus the `Host` header. `X-Forwarded-Host` is believed only when
 *     TRUSTED_PROXY=1 says the console runs behind a proxy that sets it itself — overwriting whatever the client
 *     sent. Without that, anyone can send the header and the check would mean nothing.
 *     The scheme is the one Next reports, and Next reads `X-Forwarded-Proto`: a load balancer that ends TLS and sets
 *     it needs no setting. A page in a victim's browser cannot add that header to a form post, so it cannot make an
 *     `http` console look like `https`; a client that can set headers freely carries no victim's cookie.
 * `Sec-Fetch-Site`, when the browser sends it, must say same-origin. A request with neither header comes from an old
 * browser or from something that is not a browser, which carries no victim's cookie: it is let through.
 */
export function sameOriginPost(h: PostHeaders, env: Env = process.env): boolean {
  if (h.secFetchSite && h.secFetchSite !== "same-origin") return false;
  if (!h.origin) return true;
  const from = originOf(h.origin);
  if (!from) return false;
  if (env.CONSOLE_ORIGIN) return originOf(env.CONSOLE_ORIGIN) === from;
  const trusted = env.TRUSTED_PROXY === "1";
  const host = (trusted ? first(h.forwardedHost) : null) ?? h.host;
  const proto = h.proto?.replace(/:$/, "").toLowerCase();
  if (!host || (proto !== "http" && proto !== "https")) return false;
  return originOf(`${proto}://${host}`) === from;
}
