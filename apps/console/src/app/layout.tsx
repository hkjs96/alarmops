import type { Metadata } from "next";
import "@alarmops/design-system/styles.css";
import "./globals.css";
import { fontVariables } from "./fonts";
import { ScopeShell } from "@/components/ScopeShell";
import { shellInitScript } from "@/lib/shell-prefs";
import { themeInitScript } from "@/components/ThemeToggle";
import { getApi } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { ApiError } from "@/lib/api/client";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { ENDED_FROM_LAYOUT } from "@/lib/auth/ended-flags";

export const metadata: Metadata = { title: "AlarmOps", description: "AlarmOps console" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // /login renders without a session; everything else is gated by middleware.
  let shell: { user: { id: string; name: string; role: "VIEWER" | "OPERATOR" | "ADMIN" }; open: number; customers: Awaited<ReturnType<Awaited<ReturnType<typeof getApi>>["scopeTree"]>>["customers"] } | null = null;
  if (await getSession()) {
    const api = await getApi();
    let loaded: [Awaited<ReturnType<typeof api.me>>, Awaited<ReturnType<typeof api.listIncidents>>, Awaited<ReturnType<typeof api.scopeTree>>] | null = null;
    try {
      loaded = await Promise.all([api.me(), api.listIncidents({ status: "active" }), api.scopeTree()]);
    } catch (e) {
      // A signed cookie whose user the API no longer accepts (suspended customer, disabled user): not signed in, not
      // an error page. /auth/ended removes the dead cookie (or /login would send it straight back here) → /login.
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
    // ?from=layout (fixed flag): /auth/ended shows a plain page instead of sending a session it finds alive back here
    if (!loaded) redirect(ENDED_FROM_LAYOUT);
    const [me, list, tree] = loaded;
    // badge = open in ALL customers, whatever the list filter is
    shell = { user: { id: me.id, name: me.name, role: me.role }, open: list.counts.open, customers: tree.customers };
  }
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      {/*
        No <head> element here, and the two pre-paint scripts are the first thing in <body> (they still run before
        anything is painted). With children rendered inside <head>, React's hydration sometimes looked for the body's
        first element among the head's (error #418) and threw the whole page away to render it again in the browser —
        when the layout's and the page's own scripts arrived a moment after the framework's (4 loads in 10 that way).
        A press during that re-render is lost. e2e/y-fonts.spec.ts loads the page that way. Titles and meta come from
        `metadata`; fonts from ./fonts.ts.
      */}
      <body>
        {/* the nonce is made per request in middleware.ts; without it the CSP (no 'unsafe-inline') would not run these */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {shell ? <script nonce={nonce} dangerouslySetInnerHTML={{ __html: shellInitScript }} /> : null}
        <a href="#main" className="skip">Skip to content</a>
        {shell ? (
          <ScopeShell customers={shell.customers} user={shell.user} openCount={shell.open}>{children}</ScopeShell>
        ) : (
          <main id="main">{children}</main>
        )}
      </body>
    </html>
  );
}
