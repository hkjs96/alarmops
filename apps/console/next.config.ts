import type { NextConfig } from "next";

/**
 * Security response headers for every route (security review R-4). Customer, project and service slugs are part of
 * every address and Acknowledge is one click, so the console must never render inside someone else's frame and must
 * not leak its paths in Referer.
 *
 * CSP notes — kept as tight as a static header allows:
 * - script-src needs 'unsafe-inline': Next streams the page data as inline scripts, and the two pre-paint scripts
 *   (theme, tree rail) are inline. No remote script origin is allowed. A nonce-based policy is the next step
 *   (it has to be set per request in middleware).
 * - 'unsafe-eval' only outside production (React Refresh in `next dev`).
 * - style-src: the app sets inline style attributes; fonts.googleapis.com serves the Space Mono stylesheet,
 *   fonts.gstatic.com the font files. Nothing else is fetched from another origin.
 */
export function securityHeaders(production: boolean): { key: string; value: string }[] {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self'${production ? "" : " ws: wss:"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // the console uses none of these; Copy link (clipboard-write) is allowed for the own origin by default
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    // production only: `next dev` and plain-http local runs must not pin a browser to https
    ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
  ];
}

const config: NextConfig = {
  transpilePackages: ["@alarmops/design-system"],
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "production") }];
  },
};
export default config;
