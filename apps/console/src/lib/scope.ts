/**
 * Scope in the URL (scope-variants.md T13):
 *   list filter  → ?customer=&project=&service=   (or ?mine=1 for My customers)
 *   panel        → /c/<customer>/<project>/<service>/incident/<id>   (the path is the panel's own scope; "-" = no customer)
 * A panel link without the query is complete; the query only carries the reader's list filter.
 */
import { normalizeSel, type ScopeSel } from "@alarmops/design-system";

export type { ScopeSel };
export const SCOPE_PARAMS = ["customer", "project", "service", "mine"] as const;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const NO_CUSTOMER = "-";

export const isSlug = (v: unknown): v is string => typeof v === "string" && SLUG_RE.test(v);

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

type Getter = { get(name: string): string | null } | Record<string, string | string[] | undefined>;
function read(src: Getter, k: string): string | undefined {
  if (typeof (src as { get?: unknown }).get === "function") return (src as { get(n: string): string | null }).get(k) ?? undefined;
  const v = (src as Record<string, string | string[] | undefined>)[k];
  return (Array.isArray(v) ? v[0] : v) || undefined;
}

export interface ParsedScope {
  sel: ScopeSel;
  /** a scope param was present but is not a slug: the address is wrong → Not found */
  malformed: boolean;
}

/** Reads the list filter. Lower levels without their parent are dropped; a customer replaces mine. */
export function parseScopeParams(src: Getter): ParsedScope {
  const raw = { customer: read(src, "customer"), project: read(src, "project"), service: read(src, "service") };
  const malformed = Object.values(raw).some((v) => v !== undefined && !isSlug(v));
  if (malformed) return { sel: {}, malformed };
  return { sel: normalizeSel({ ...raw, mine: read(src, "mine") === "1" }), malformed };
}

/** Query string for a filter, keeping any non-scope params of `keep` (status, severity, q…). */
export function scopeQuery(sel: ScopeSel, keep?: URLSearchParams | string): string {
  const p = new URLSearchParams(keep ?? "");
  for (const k of SCOPE_PARAMS) p.delete(k);
  p.delete("cursor");
  const s = normalizeSel(sel);
  const out = new URLSearchParams();
  if (s.customer) out.set("customer", s.customer);
  if (s.project) out.set("project", s.project);
  if (s.service) out.set("service", s.service);
  if (s.mine) out.set("mine", "1");
  for (const [k, v] of p) out.append(k, v);
  const q = out.toString();
  return q ? `?${q}` : "";
}

export function clearLevel(sel: ScopeSel, level: "customer" | "project" | "service"): ScopeSel {
  const s = normalizeSel(sel);
  if (level === "customer") return {};
  if (level === "project") return { customer: s.customer };
  return { customer: s.customer, project: s.project };
}

interface OrgSlugs {
  customer: { slug?: string } | null;
  project: { slug?: string } | null;
  service: { slug?: string } | null;
}

/** One path for the panel: the incident's own scope, then /incident/<id>. */
export function incidentPanelPath(org: OrgSlugs, id: string): string {
  const segs = org.customer?.slug ? [org.customer.slug, org.project?.slug, org.project?.slug ? org.service?.slug : undefined].filter(isSlug) : [NO_CUSTOMER];
  return `/c/${segs.join("/")}/incident/${encodeURIComponent(id)}`;
}

export interface PanelRoute {
  /** null = the "-" segment: no customer (unmapped account) */
  customer: string | null;
  project?: string;
  service?: string;
  kind: "incident";
  id: string;
}

/** Parses /c/[customer]/[[...path]]. Anything that is not exactly <scope>/incident/<id> is null (→ Not found). */
export function parsePanelRoute(customer: string, path: string[] | undefined): PanelRoute | null {
  const p = path ?? [];
  if (p.length < 2 || p.length > 4) return null;
  const [kind, id] = p.slice(-2) as [string, string];
  if (kind !== "incident" || !ID_RE.test(id)) return null;
  const scope = p.slice(0, -2);
  if (customer === NO_CUSTOMER) return scope.length ? null : { customer: null, kind: "incident", id };
  if (!isSlug(customer) || !scope.every(isSlug)) return null;
  return { customer, project: scope[0], service: scope[1], kind: "incident", id };
}

/** The address must be the incident's own scope, segment for segment. */
export function panelRouteMatches(route: PanelRoute, org: OrgSlugs): boolean {
  return (route.customer ?? undefined) === (org.customer?.slug ?? undefined)
    && route.project === (org.customer ? org.project?.slug : undefined)
    && route.service === (org.customer && org.project ? org.service?.slug : undefined);
}

export const isPanelPath = (pathname: string) => pathname.startsWith("/c/");
