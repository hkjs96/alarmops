import type { Metadata } from "next";
import "@alarmops/design-system/styles.css";
import "./globals.css";
import { ScopeShell } from "@/components/ScopeShell";
import { themeInitScript } from "@/components/ThemeToggle";
import { getApi } from "@/lib/api";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "AlarmOps", description: "AlarmOps console" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // /login renders without a session; everything else is gated by middleware.
  let shell: { name: string; open: number; customers: Awaited<ReturnType<Awaited<ReturnType<typeof getApi>>["scopeTree"]>>["customers"] } | null = null;
  if (await getSession()) {
    const api = await getApi();
    const [me, list, tree] = await Promise.all([api.me(), api.listIncidents({ status: "open" }), api.scopeTree()]);
    // badge = open in ALL customers, whatever the list filter is
    shell = { name: me.name, open: list.counts.triggered + list.counts.escalated, customers: tree.customers };
  }
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" />
      </head>
      <body>
        <a href="#main" className="skip">Skip to content</a>
        {shell ? (
          <ScopeShell customers={shell.customers} userName={shell.name} openCount={shell.open}>{children}</ScopeShell>
        ) : (
          <main id="main">{children}</main>
        )}
      </body>
    </html>
  );
}
