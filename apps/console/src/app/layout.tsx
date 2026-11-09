import type { Metadata } from "next";
import "@alarmops/design-system/styles.css";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { themeInitScript } from "@/components/ThemeToggle";
import { getApi } from "@/lib/api";

export const metadata: Metadata = { title: "AlarmOps", description: "AlarmOps console" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const api = getApi();
  const [me, list] = await Promise.all([api.me(), api.listIncidents({ status: "open" })]);
  const unacked = list.counts.triggered + list.counts.escalated;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" />
      </head>
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <TopNav unackedCount={unacked} userName={me.name} />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
