/** Top menu of the scope shell (docs/ui/scope-variants.md §7, variant E). Settings sub-routes keep their tabs. */
export interface NavSection {
  key: string;
  label: string;
  /** short label for the phone bottom bar */
  short?: string;
  href: string;
  /** first path segments that belong to this section */
  match: string[];
  sub: { label: string; href: string }[];
}

export const NAV: NavSection[] = [
  { key: "incidents", label: "Incidents", href: "/incidents", match: ["incidents", "c"], sub: [] },
  {
    key: "monitoring", label: "Monitoring", short: "Monitor", href: "/monitoring/alarms", match: ["monitoring"],
    sub: [
      { label: "Alarms", href: "/monitoring/alarms" },
      { label: "Resources", href: "/monitoring/resources" },
      { label: "Coverage gaps", href: "/monitoring/coverage-gaps" },
      { label: "Needs review", href: "/monitoring/needs-review" },
      { label: "Sync runs", href: "/monitoring/sync-runs" },
    ],
  },
  { key: "call-order", label: "Call order", href: "/call-order", match: ["call-order"], sub: [] },
  { key: "people", label: "People", href: "/people", match: ["people"], sub: [] },
  { key: "maintenance", label: "Maintenance", short: "Maint.", href: "/maintenance", match: ["maintenance"], sub: [] },
  // D-26: Customers is a top-level menu. The list is a stub for now; it lives in the shell like the others.
  { key: "customers", label: "Customers", href: "/customers", match: ["customers"], sub: [] },
  {
    key: "settings", label: "Settings", href: "/settings/msp-defaults", match: ["settings"],
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
  return NAV.find((s) => s.match.includes(seg));
}
