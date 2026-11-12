import type { Metadata } from "next";
import "@alarmops/design-system/styles.css";
import "./globals.css";
import { fontVariables } from "./fonts";
import { ScopeShell } from "@/components/ScopeShell";
import { shellInitScript } from "@/lib/shell-prefs";
import { themeInitScript } from "@/components/ThemeToggle";
import { getApi } from "@/lib/api";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "AlarmOps", description: "AlarmOps console" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // /login renders without a session; everything else is gated by middleware.
  let shell: { user: { id: string; name: string; role: "VIEWER" | "OPERATOR" | "ADMIN" }; open: number; customers: Awaited<ReturnType<Awaited<ReturnType<typeof getApi>>["scopeTree"]>>["customers"] } | null = null;
  if (await getSession()) {
    const api = await getApi();
    const [me, list, tree] = await Promise.all([api.me(), api.listIncidents({ status: "active" }), api.scopeTree()]);
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
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {shell ? <script dangerouslySetInnerHTML={{ __html: shellInitScript }} /> : null}
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
