/**
 * Call order fixtures — the data of docs/ui/mockups/scope-variants.html (variant E → Call order):
 * the four ordering patterns (Mirae Pay: custom, Daon Retail: all at once, Hanbit Logistics: customer rotation,
 * Ara Games: shared MSP rotation), the two own-step levels (Mirae Pay › Data platform, Hanbit › Fulfilment › Orders API)
 * and the two problem customers (Kumho Clinic: unreachable, Lumen Bank: at risk).
 * Differences from the mockup, so that paging health comes out of the data instead of being hard-coded:
 * Junho Park's phone is verified, Lumen Bank has Jiwoo Han as a direct responder, Iruda's second step also uses Slack.
 */
import type {
  ChannelState, ContactChannelKey, CustomerPersonRole, LevelRef, PagingConfigInput, PagingPlan, PagingProblem, PagingStep, PagingStyle,
  RotationSummary, ScopeLevelName, StepChannel,
} from "../types";
import { planSteps } from "../../call-order/model";
import { customers34, type FxCustomer } from "./scope-fixtures";

type Ch = Partial<Record<ContactChannelKey, ChannelState>>;
export interface FxContact { id: string; kind: "STAFF" | "CUSTOMER"; customerId?: string; name: string; title: string; channels: Ch; emailMasked?: string; phoneMasked?: string }
export interface FxStoredConfig extends PagingConfigInput { id: string; scopeType: ScopeLevelName; scopeId: string; version: number; updatedByName: string | null; updatedAt: string | null }
export interface FxCustomerPaging {
  templateId: string | null;
  /** staff added directly (not through the template) */
  staff: string[];
  people: { contactId: string; role: CustomerPersonRole; extras: ("APPROVER" | "PORTAL_USER")[]; scope: LevelRef }[];
  config: FxStoredConfig;
  overrides: FxStoredConfig[];
  /** problems the data here cannot produce (rotation gaps need a shift table) */
  extraProblems: PagingProblem[];
}
export interface FxPaging {
  contacts: Record<string, FxContact>;
  templates: Record<string, { name: string; members: string[] }>;
  rotations: RotationSummary[];
  byCustomer: Record<string, FxCustomerPaging>;
}

const S: Record<string, ChannelState> = { ok: "VERIFIED", exp: "EXPIRED", unv: "UNVERIFIED", sent: "LINK_SENT", none: "NOT_SET" };
const ch = (o: Record<string, string>): Ch => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toUpperCase(), S[v]!])) as Ch;
/** Masked the way the list shows contacts (D-35). The fixture never holds a full address or number. */
function masked(name: string, domain: string, c: Ch): { emailMasked?: string; phoneMasked?: string } {
  let n = 0;
  for (const x of name) n = (n * 31 + x.charCodeAt(0)) % 10000;
  return {
    emailMasked: c.EMAIL ? `${name[0]!.toLowerCase()}•••@${domain}` : undefined,
    phoneMasked: c.SMS || c.VOICE ? `010-••••-${String(n).padStart(4, "0")}` : undefined,
  };
}

const ALL_OK = { Slack: "ok", Email: "ok", SMS: "ok", Voice: "ok" };
const STAFF: [id: string, name: string, title: string, c: Record<string, string>][] = [
  ["ct_haeun", "Haeun Kim", "Cloud engineer", ALL_OK],
  ["ct_junho", "Junho Park", "Ops lead", ALL_OK],
  ["ct_minjae", "Minjae Lee", "Cloud engineer", ALL_OK],
  ["ct_jiwoo", "Jiwoo Han", "Cloud engineer", ALL_OK],
  ["ct_sora", "Sora Yoon", "Cloud engineer", { Slack: "ok", Email: "ok", SMS: "unv", Voice: "unv" }],
  ["ct_dohyun", "Dohyun Kang", "Joined Nov 3", { Slack: "ok", Email: "unv", SMS: "sent", Voice: "sent" }],
  ["ct_taemin", "Taemin Jung", "Data engineer", ALL_OK],
  ["ct_eunji", "Eunji Kwon", "Data engineer", { Slack: "none", Email: "ok", SMS: "ok", Voice: "ok" }],
];
type Role = "pageable" | "notify" | "approver" | "portal";
const PEOPLE: [id: string, customer: string, name: string, title: string, scope: string[], roles: Role[], c: Record<string, string>][] = [
  ["ct_yuna", "mirae", "Yuna Seo", "Platform lead", ["Core", "Payments API"], ["pageable", "approver"], { Slack: "ok", Email: "ok", SMS: "unv", Voice: "ok" }],
  ["ct_seojun", "mirae", "Seojun Bae", "Core backend manager", ["Core"], ["notify"], { Email: "ok", SMS: "ok" }],
  ["ct_hana", "mirae", "Hana Noh", "SRE", ["Core"], ["notify"], { Slack: "ok", Email: "ok" }],
  ["ct_hyejin", "mirae", "Hyejin Lim", "IT manager", [], ["notify", "portal"], { Email: "ok", SMS: "ok" }],
  ["ct_dami", "mirae", "Dami Ko", "Checkout PM", ["Core", "Checkout"], ["notify"], { Email: "sent" }],
  ["ct_soyeon", "daon", "Soyeon Choi", "Head of commerce", [], ["pageable", "approver", "portal"], { Email: "sent", SMS: "unv", Voice: "unv" }],
  ["ct_taehee", "daon", "Taehee Oh", "Checkout engineer", ["Commerce", "Checkout"], ["notify"], { Email: "ok", SMS: "unv" }],
  ["ct_jaewon", "daon", "Jaewon Shin", "CTO", [], ["notify"], { Slack: "none", Email: "ok" }],
  ["ct_hyunwoo", "hanbit", "Hyunwoo Ahn", "Ops manager", [], ["pageable", "approver"], ALL_OK],
  ["ct_eunbi", "hanbit", "Eunbi Song", "Tracking lead", ["Tracking"], ["pageable"], { Email: "ok", SMS: "sent", Voice: "sent" }],
  ["ct_sungmin", "hanbit", "Sungmin Yoon", "IT director", [], ["notify"], { Email: "unv", SMS: "unv" }],
  ["ct_gyuri", "ara", "Gyuri Kim", "Live ops lead", [], ["notify", "portal"], { Email: "ok", Slack: "ok" }],
  ["ct_jieun", "kumho", "Jieun Kang", "IT lead", [], ["notify", "portal"], { Email: "ok", SMS: "ok" }],
  ["ct_byungho", "kumho", "Byungho Lee", "Infra engineer", [], ["notify"], { Email: "ok" }],
  ["ct_kyungmin", "lumen", "Kyungmin Oh", "Platform engineer", [], ["pageable"], { Email: "ok", SMS: "unv", Voice: "unv" }],
  ["ct_paul", "lumen", "Paul Seong", "Ops manager", [], ["notify"], { Email: "ok", SMS: "ok", Voice: "ok" }],
];

const step = (atMin: number, target: "ALL" | string, ...channels: StepChannel[]): PagingStep =>
  target === "ALL" ? { atMin, targetType: "ALL_RESPONDERS", channels } : target.startsWith("rot_") ? { atMin, targetType: "ROTATION", targetId: target, channels } : { atMin, targetType: "PERSON", targetId: target, channels };

/** [template, direct staff, style, rotation] per customer slug */
const SETUP: Record<string, [string | null, string[], PagingStyle, string?]> = {
  mirae: ["core", ["ct_taemin"], "CUSTOM"],
  daon: [null, ["ct_junho", "ct_minjae"], "ALL_AT_ONCE"],
  hanbit: [null, ["ct_junho", "ct_minjae"], "CUSTOMER_ROTATION", "rot_hanbit"],
  ara: ["core", [], "SHARED_ROTATION", "rot_night"],
  bora: ["core", [], "SHARED_ROTATION", "rot_night"],
  cheong: ["core", [], "ALL_AT_ONCE"],
  dasol: ["core", [], "SHARED_ROTATION", "rot_night"],
  eden: [null, ["ct_junho", "ct_jiwoo"], "ALL_AT_ONCE"],
  gaon: ["core", [], "SHARED_ROTATION", "rot_night"],
  haneul: [null, ["ct_junho", "ct_sora"], "SHARED_ROTATION", "rot_night"],
  iruda: [null, ["ct_junho", "ct_dohyun"], "CUSTOM"],
  jeil: ["core", [], "ALL_AT_ONCE"],
  kumho: [null, [], "ALL_AT_ONCE"],
  lumen: [null, ["ct_jiwoo"], "CUSTOMER_ROTATION", "rot_lumen"],
};
const CUSTOM_STEPS: Record<string, PagingStep[]> = {
  mirae: [step(0, "rot_night", "SLACK_DM", "VOICE"), step(10, "ct_yuna", "VOICE"), step(15, "ALL", "VOICE")],
  iruda: [step(0, "ct_junho", "VOICE"), step(5, "ct_dohyun", "SLACK_DM", "VOICE"), step(10, "ALL", "VOICE")],
};
const EDITED: Record<string, [string, string]> = { mirae: ["Minjae Lee", "2026-11-07T02:10:00Z"] };

export function createPaging(customers: FxCustomer[] = customers34): FxPaging {
  const contacts: Record<string, FxContact> = {};
  for (const [id, name, title, c] of STAFF) contacts[id] = { id, kind: "STAFF", name, title, channels: ch(c), ...masked(name, "msp.example", ch(c)) };
  for (const [id, cs, name, title, , , c] of PEOPLE) contacts[id] = { id, kind: "CUSTOMER", customerId: `cus_${cs}`, name, title, channels: ch(c), ...masked(name, `${cs}.example`, ch(c)) };
  const onShift = (id: string, until: string) => ({ contactId: id, name: contacts[id]!.name, until, channels: contacts[id]!.channels });
  const rotations: RotationSummary[] = [
    { id: "rot_night", scope: "MSP", name: "MSP night desk", onShift: onShift("ct_haeun", "2026-11-09T00:00:00Z"), next: "Junho Park" },
    { id: "rot_data", scope: "MSP", name: "Data desk", onShift: onShift("ct_taemin", "2026-11-09T00:00:00Z"), next: "Eunji Kwon" },
    { id: "rot_hanbit", scope: "CUSTOMER", customerId: "cus_hanbit", name: "Hanbit on-call", onShift: onShift("ct_junho", "2026-11-09T01:00:00Z"), next: "Hyunwoo Ahn" },
    { id: "rot_lumen", scope: "CUSTOMER", customerId: "cus_lumen", name: "Lumen on-call", onShift: onShift("ct_kyungmin", "2026-11-09T01:00:00Z"), next: "Kyungmin Oh" },
  ];
  const byCustomer: Record<string, FxCustomerPaging> = {};
  customers.forEach((c, n) => {
    const extraIdx = n - Object.keys(SETUP).length;
    const [templateId, staff, style, rot] = SETUP[c.slug] ?? [extraIdx % 2 ? "night" : "data", [], "SHARED_ROTATION" as const, extraIdx % 2 ? "rot_night" : "rot_data"];
    const plan: PagingPlan = "STANDARD";
    const steps = CUSTOM_STEPS[c.slug] ?? planSteps(plan, rot ? { targetType: "ROTATION", targetId: rot } : { targetType: "ALL_RESPONDERS" });
    const cfg = (scopeType: ScopeLevelName, scopeId: string, v: PagingConfigInput, by: [string, string] | undefined): FxStoredConfig =>
      ({ ...v, id: `pc_${scopeId}`, scopeType, scopeId, version: 1, updatedByName: by?.[0] ?? null, updatedAt: by?.[1] ?? null });
    const overrides: FxStoredConfig[] = [];
    if (c.slug === "mirae") {
      const p = c.projects.find((x) => x.slug === "data-platform")!;
      overrides.push(cfg("PROJECT", p.id, { style: "CUSTOM", plan: "QUIET", repeatCount: 0, steps: [step(0, "rot_data", "SLACK_DM"), step(15, "ALL", "SLACK_DM")] }, ["Taemin Jung", "2026-11-02T05:00:00Z"]));
    }
    if (c.slug === "hanbit") {
      const s = c.projects.find((x) => x.slug === "fulfilment")!.services.find((x) => x.slug === "orders-api")!;
      overrides.push(cfg("SERVICE", s.id, { style: "CUSTOM", plan: "URGENT", repeatCount: 1, steps: [step(0, "ct_hyunwoo", "VOICE"), step(5, "rot_hanbit", "VOICE")] }, ["Junho Park", "2026-10-29T01:30:00Z"]));
    }
    const ref = (names: string[]): LevelRef => {
      const p = names[0] ? c.projects.find((x) => x.name === names[0]) : undefined;
      const s = names[1] ? p?.services.find((x) => x.name === names[1]) : undefined;
      return s ? { level: "SERVICE", id: s.id, name: s.name } : p ? { level: "PROJECT", id: p.id, name: p.name } : { level: "CUSTOMER", id: c.id, name: c.name };
    };
    byCustomer[c.id] = {
      templateId, staff: [...staff],
      people: PEOPLE.filter((p) => p[1] === c.slug).map(([id, , , , sc, roles]) => ({
        contactId: id, role: roles.includes("pageable") ? "PAGEABLE" as const : "NOTIFY_ONLY" as const,
        extras: [...(roles.includes("approver") ? ["APPROVER" as const] : []), ...(roles.includes("portal") ? ["PORTAL_USER" as const] : [])], scope: ref(sc),
      })),
      config: cfg("CUSTOMER", c.id, { style, plan, ...(style === "SHARED_ROTATION" ? { sharedRotationId: rot } : {}), repeatCount: 1, steps }, EDITED[c.slug]),
      overrides,
      extraProblems: c.slug === "lumen" ? [{
        code: "ROTATION_GAP", contactIds: [], rotationId: "rot_lumen", from: "2026-11-14T00:00:00Z", to: "2026-11-15T00:00:00Z",
        message: "Lumen on-call has nobody on shift from Sat Nov 14 09:00 to Sun Nov 15 09:00 KST. A page in that day goes straight to the next step.",
      }] : [],
    };
  });
  return {
    contacts, rotations, byCustomer,
    templates: { core: { name: "Infra core", members: ["ct_haeun", "ct_junho", "ct_minjae"] }, data: { name: "Data desk", members: ["ct_taemin", "ct_eunji"] }, night: { name: "Night backup", members: ["ct_jiwoo", "ct_sora"] } },
  };
}
