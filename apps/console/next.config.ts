import type { NextConfig } from "next";

/**
 * Security response headers for every route (security review R-4). Customer, project and service slugs are part of
 * every address and Acknowledge is one click, so the console must never render inside someone else's frame and must
 * not leak its paths in Referer.
 *
 * The Content-Security-Policy is not here: it carries a nonce that changes with every request, so middleware.ts sets
 * it (lib/csp.ts).
 */
export function securityHeaders(production: boolean): { key: string; value: string }[] {
  return [
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
  // the live e2e runs `next dev` next to a production build: it gets its own output folder
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The API, its store and the core run inside this app (D-09). They are TypeScript sources with `.js` import
  // specifiers (NodeNext style); webpack is told to try `.ts` for them.
  transpilePackages: ["@alarmops/design-system", "@alarmops/api", "@alarmops/core", "@alarmops/store-sql"],
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  webpack(cfg) {
    cfg.resolve ??= {};
    cfg.resolve.extensionAlias = { ...(cfg.resolve.extensionAlias ?? {}), ".js": [".ts", ".tsx", ".js"] };
    return cfg;
  },
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "production") }];
  },
};
export default config;
