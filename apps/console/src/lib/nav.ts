/** Top menu + sub-routes per docs/ui/IA.md §1 (D-26, D-31). */
export interface NavSection {
  key: string;
  label: string;
  href: string;
  sub: { label: string; href: string }[];
}

export const NAV: NavSection[] = [
  { key: "incidents", label: "Incidents", href: "/incidents", sub: [] },
  {
    key: "monitoring", label: "Monitoring", href: "/monitoring/alarms",
    sub: [
      { label: "Alarms", href: "/monitoring/alarms" },
      { label: "Resources", href: "/monitoring/resources" },
      { label: "Coverage gaps", href: "/monitoring/coverage-gaps" },
      { label: "Needs review", href: "/monitoring/needs-review" },
      { label: "Sync runs", href: "/monitoring/sync-runs" },
    ],
  },
  {
    key: "oncall", label: "On-call", href: "/oncall/now",
    sub: [
      { label: "Now", href: "/oncall/now" },
      { label: "Rotations", href: "/oncall/rotations" },
      { label: "People", href: "/oncall/people" },
      { label: "Templates", href: "/oncall/templates" },
      { label: "Maintenance", href: "/oncall/maintenance" },
    ],
  },
  { key: "customers", label: "Customers", href: "/customers", sub: [] },
  {
    key: "settings", label: "Settings", href: "/settings/msp-defaults",
    sub: [
      { label: "MSP defaults", href: "/settings/msp-defaults" },
      { label: "Severity mapping", href: "/settings/severity-mapping" },
      { label: "Suppression", href: "/settings/suppression" },
      { label: "Integrations", href: "/settings/integrations" },
      { label: "Users", href: "/settings/users" },
      { label: "Audit log", href: "/settings/audit-log" },
    ],
  },
];

export function sectionFor(pathname: string): NavSection | undefined {
  const seg = pathname.split("/")[1] ?? "";
  return NAV.find((s) => s.key === seg);
}
