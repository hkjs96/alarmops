/**
 * Customer › project › service fixture, same data as docs/ui/mockups/scope-variants.html (variant E):
 * 14 customers by default, 34 with the toggle (MOCK_CUSTOMERS=34 or createStore({ customers: 34 })).
 * "mine" is from the point of view of the mock user Haeun Kim (member of the "Infra core" responder template).
 */
import type { CallHealth } from "@alarmops/design-system";
import { slugify } from "../../scope";

export interface FxService { id: string; slug: string; name: string; ownSteps: boolean }
export interface FxProject extends FxService { services: FxService[] }
export interface FxCustomer { id: string; slug: string; name: string; mine: boolean; callHealth: CallHealth; projects: FxProject[] }

type Def = [slug: string, name: string, mine: boolean, projects: [string, string[]][], health?: CallHealth];

/** project or service names that have their own call order (paging override) */
const OWN = new Set(["mirae/data-platform", "hanbit/fulfilment/orders-api"]);

const BASE: Def[] = [
  ["mirae", "Mirae Pay", true, [["Core", ["Payments API", "Settlement", "Checkout"]], ["Merchant", ["Merchant portal"]], ["Data platform", ["Ledger"]]]],
  ["daon", "Daon Retail", false, [["Commerce", ["Checkout", "Search"]], ["Platform", ["EKS prod"]]]],
  ["hanbit", "Hanbit Logistics", false, [["Tracking", ["Public API"]], ["Ops", ["Batch"]], ["Fulfilment", ["Orders API"]]]],
  ["ara", "Ara Games", true, [["Live ops", ["Game API", "Matchmaking"]], ["Web", ["Store"]]]],
  ["bora", "Bora Foods", true, [["Main", ["Web", "Orders"]]]],
  ["cheong", "Cheong Media", true, [["Main", ["Web"]], ["Streaming", ["Player API"]]]],
  ["dasol", "Dasol Health", true, [["Main", ["Web"]]]],
  ["eden", "Eden Mobility", false, [["Main", ["Web"]], ["Fleet", ["Telemetry"]]]],
  ["gaon", "Gaon Energy", true, [["Main", ["Web"]]]],
  ["haneul", "Haneul Air", false, [["Main", ["Web", "Booking"]]]],
  ["iruda", "Iruda Edu", false, [["Main", ["Web"]]]],
  ["jeil", "Jeil Insure", true, [["Main", ["Web"]], ["Claims", ["Claims API"]]]],
  ["kumho", "Kumho Clinic", false, [["Main", ["EMR"]]], "UNREACHABLE"],
  ["lumen", "Lumen Bank", false, [["Main", ["Core banking"]]], "AT_RISK"],
];

const EXTRA_NAMES = [
  "Namu Tech", "Onnuri Bank", "Pureun Farm", "Saebyeok Labs", "Taeyang Solar", "Uri Telecom", "Vita Pharm", "Wooju Space", "Yeoul Travel", "Zio Fashion",
  "Nuri Soft", "Maru Homes", "Byeol Media", "Sarang Care", "Garam Trade", "Dodam Kids", "Haru Coffee", "Mindle Books", "Sol Finance", "Narae Air",
];
const EXTRA: Def[] = EXTRA_NAMES.map((n) => [n.split(" ")[0]!.toLowerCase(), n, false, [["Main", ["Web", "API"]]]]);

function build(defs: Def[]): FxCustomer[] {
  return defs.map(([slug, name, mine, projects, health]) => ({
    id: `cus_${slug}`, slug, name, mine, callHealth: health ?? "OK",
    projects: projects.map(([pn, svcs]) => {
      const ps = slugify(pn);
      return {
        id: `prj_${slug}_${ps}`, slug: ps, name: pn, ownSteps: OWN.has(`${slug}/${ps}`),
        services: svcs.map((sn) => {
          const ss = slugify(sn);
          return { id: `svc_${slug}_${ps}_${ss}`, slug: ss, name: sn, ownSteps: OWN.has(`${slug}/${ps}/${ss}`) };
        }),
      };
    }),
  }));
}

export const customers14: FxCustomer[] = build(BASE);
export const customers34: FxCustomer[] = build([...BASE, ...EXTRA]);

/** Org chain for an incident fixture, by customer slug and project/service names. */
export function orgOf(customerSlug: string | null, projectName?: string, serviceName?: string) {
  if (!customerSlug) return { customer: null, project: null, service: null };
  const c = customers34.find((x) => x.slug === customerSlug);
  if (!c) throw new Error(`fixture: unknown customer ${customerSlug}`);
  const p = projectName ? c.projects.find((x) => x.name === projectName) : undefined;
  if (projectName && !p) throw new Error(`fixture: unknown project ${customerSlug}/${projectName}`);
  const s = serviceName ? p?.services.find((x) => x.name === serviceName) : undefined;
  if (serviceName && !s) throw new Error(`fixture: unknown service ${customerSlug}/${projectName}/${serviceName}`);
  const ref = (n: { id: string; name: string; slug: string }) => ({ id: n.id, name: n.name, slug: n.slug });
  return { customer: ref(c), project: p ? ref(p) : null, service: s ? ref(s) : null };
}
