import { ApiError, type ConsoleApi } from "../client";
import type { ContactRevealEntry, ContactRevealQuery, Paginated, RevealChannel, RevealResult, Role } from "../types";
import type { Directory } from "../../call-order/model";
import { isSlug } from "../../validate";
import type { FxContact, FxPaging } from "./paging-fixtures";
import type { FxCustomer } from "./scope-fixtures";

/**
 * Mock of POST /contacts/{id}/reveal and GET /contact-reveals (API-CONTRACT §8.4, D-35), following the contract's order:
 * out of scope → the one 404 first; then who may open it; every call writes one log row (never the value); an
 * emergency reveal needs a typed reason and notifies the customer's primary Responder.
 * The fixtures hold only masked values; a full value is made up from the same masked text (stable, fake).
 */
export interface RevealStore { log: ContactRevealEntry[]; hits: Map<string, number[]>; seq: number }

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };
export interface RevealMe { id: string; contactId: string; name: string; email: string; role: Role; kind?: "INTERNAL" | "CUSTOMER" }
export interface RevealCtx {
  paging: FxPaging;
  customers: FxCustomer[];
  me: RevealMe;
  store: RevealStore;
  /** the customer's Responders as the call order sees them */
  directory: (c: FxCustomer) => Directory;
  now: () => string;
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError;
}
export type RevealApi = Pick<ConsoleApi, "revealContact" | "listContactReveals">;

export const REASON_MAX = 500;
const PER_MINUTE = 30;
const EMERGENCY_PER_HOUR = 10;

/** The portal user's customer: the mock has one portal user and the customer is the one of their address (…@mirae.example). */
export const portalCustomerId = (me: { email: string }): string => `cus_${me.email.split("@")[1]?.split(".")[0] ?? ""}`;

export function createRevealStore(customers: FxCustomer[]): RevealStore {
  const log: ContactRevealEntry[] = [];
  const add = (n: number, at: string, mode: "NORMAL" | "EMERGENCY", actor: [string, string], contact: [string, string], slug: string, channel: RevealChannel, reason: string | null, notified: [string, string][]) => {
    const c = customers.find((x) => x.slug === slug);
    if (!c) return;
    log.push({ id: `crl_seed_${n}`, at, mode, actor: { id: actor[0], name: actor[1] }, contact: { id: contact[0], name: contact[1] }, org: { customer: { id: c.id, name: c.name, slug: c.slug } }, channel, reason, notified: notified.map(([contactId, name]) => ({ contactId, name })) });
  };
  add(1, "2026-11-06T14:12:00Z", "NORMAL", ["usr_minjae", "Minjae Lee"], ["ct_hyunwoo", "Hyunwoo Ahn"], "hanbit", "PHONE", null, []);
  add(2, "2026-11-07T07:40:00Z", "EMERGENCY", ["usr_haeun", "Haeun Kim"], ["ct_eunbi", "Eunbi Song"], "hanbit", "PHONE", "Nobody on the rotation answered the SEV-1 page; calling the tracking lead directly.", [["ct_junho", "Junho Park"]]);
  add(3, "2026-11-07T09:05:00Z", "NORMAL", ["usr_haeun", "Haeun Kim"], ["ct_yuna", "Yuna Seo"], "mirae", "EMAIL", "Sending the post-incident note", []);
  add(4, "2026-11-08T01:20:00Z", "EMERGENCY", ["usr_haeun", "Haeun Kim"], ["ct_soyeon", "Soyeon Choi"], "daon", "PHONE", "Customer asked for a call back about the checkout outage ticket.", [["ct_junho", "Junho Park"]]);
  log.reverse();
  return { log, hits: new Map(), seq: 0 };
}

/** What `me` may do with a contact of customer `c` (the `canReveal` / `revealRequiresReason` of the contract). */
export function revealRule(ctx: Pick<RevealCtx, "directory"> & { me: RevealMe }, c: FxCustomer, target: FxContact): { ok: boolean; reason: boolean; deny?: "NOT_A_RESPONDER" | "ROLE_REQUIRED" } {
  const { me } = ctx;
  if (me.kind === "CUSTOMER") return target.kind === "CUSTOMER" && target.customerId === portalCustomerId(me) ? { ok: true, reason: false } : { ok: false, reason: false, deny: "NOT_A_RESPONDER" };
  const responder = ctx.directory(c).staff.some((s) => s.contactId === me.contactId);
  if (responder) return RANK[me.role] >= RANK.OPERATOR ? { ok: true, reason: false } : { ok: false, reason: false, deny: "ROLE_REQUIRED" };
  // the emergency exception is for the contacts of a customer, never for staff
  if (me.role === "ADMIN" && target.kind === "CUSTOMER") return { ok: true, reason: true };
  return { ok: false, reason: false, deny: "NOT_A_RESPONDER" };
}

const hash = (s: string) => { let n = 0; for (const ch of s) n = (n * 31 + ch.charCodeAt(0)) % 9000; return n; };
const handle = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
/** a fake full value that matches the masked text the lists show */
function fullValue(k: FxContact, channel: RevealChannel): string | null {
  if (channel === "PHONE") return k.phoneMasked ? k.phoneMasked.replace("••••", String(1000 + hash(k.name))) : null;
  if (channel === "EMAIL") return k.emailMasked ? `${handle(k.name)}@${k.emailMasked.split("@")[1]}` : null;
  return k.channels.SLACK ? `@${handle(k.name)}` : null;
}

export function createRevealApi(ctx: RevealCtx): RevealApi {
  const { me, store, paging } = ctx;
  const notFound = () => ctx.err(404, "NOT_FOUND", "Not found.");
  /** a customer's own people are in that customer; a staff member is "in" every customer whose Responders include them */
  const customersOf = (k: FxContact): FxCustomer[] => k.kind === "CUSTOMER"
    ? ctx.customers.filter((c) => c.id === k.customerId)
    : ctx.customers.filter((c) => ctx.directory(c).staff.some((s) => s.contactId === k.id));

  function hit(kind: "all" | "emergency", limit: number, windowMs: number) {
    const key = `${me.id}:${kind}`;
    const now = Date.now();
    const list = (store.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) throw ctx.err(429, "RATE_LIMITED", "Too many reveals. Try again shortly.", { retryAfterSec: Math.ceil((windowMs - (now - list[0]!)) / 1000) });
    list.push(now);
    store.hits.set(key, list);
  }

  return {
    async revealContact(contactId, body): Promise<RevealResult> {
      const k = paging.contacts[contactId];
      // out of scope first: a portal user sees only the people of their own customer; anything else is the one 404
      if (!k || (me.kind === "CUSTOMER" && !(k.kind === "CUSTOMER" && k.customerId === portalCustomerId(me)))) throw notFound();
      if (!body || !["PHONE", "EMAIL", "SLACK"].includes(body.channel)) throw ctx.err(400, "VALIDATION_FAILED", "Invalid channel.", { fields: [{ field: "channel", message: "Must be PHONE, EMAIL or SLACK." }] });
      if (body.reason !== undefined && typeof body.reason !== "string") throw ctx.err(400, "VALIDATION_FAILED", "Invalid reason.", { fields: [{ field: "reason", message: "Must be text." }] });
      const reason = (body.reason ?? "").trim();
      if (reason.length > REASON_MAX) throw ctx.err(400, "VALIDATION_FAILED", "Invalid reason.", { fields: [{ field: "reason", message: `At most ${REASON_MAX} characters.` }] });

      // the most permissive standing over the customers this contact belongs to
      const rules = customersOf(k).map((c) => ({ c, r: revealRule(ctx, c, k) }));
      const normal = rules.find((x) => x.r.ok && !x.r.reason);
      const pick = normal ?? rules.find((x) => x.r.ok && x.r.reason);
      if (!pick) {
        const roleOnly = rules.length > 0 && rules.every((x) => x.r.deny === "ROLE_REQUIRED");
        throw roleOnly ? ctx.err(403, "ROLE_REQUIRED", "This action needs the OPERATOR role.", { role: "OPERATOR" }) : ctx.err(403, "NOT_A_RESPONDER", "Only a responder of this customer can open this contact.");
      }
      const mode = normal ? "NORMAL" : "EMERGENCY";
      if (mode === "EMERGENCY" && reason.length === 0) throw ctx.err(422, "EMERGENCY_REASON_REQUIRED", "You are not a responder for this customer. Give the reason you need this contact.");
      hit("all", PER_MINUTE, 60_000);
      if (mode === "EMERGENCY") hit("emergency", EMERGENCY_PER_HOUR, 3_600_000);
      const value = fullValue(k, body.channel);
      if (value === null) throw ctx.err(422, "VALIDATION_FAILED", "This contact has nothing on file for that channel.", { fields: [{ field: "channel", message: "Nothing on file." }] });

      const c = pick.c;
      const primary = ctx.directory(c).staff.find((s) => s.contactId !== me.contactId);
      const admin = paging.contacts["ct_haeun"];
      const notified = mode === "EMERGENCY"
        ? (primary ? [{ contactId: primary.contactId, name: primary.name }] : admin && admin.id !== me.contactId ? [{ contactId: admin.id, name: admin.name }] : [])
        : [];
      const at = ctx.now();
      const id = `crl_${++store.seq}`;
      // the log row is written before the value is handed out (a failed write would mean no value); never the value itself
      store.log.unshift({ id, at, mode, actor: { id: me.id, name: me.name }, contact: { id: k.id, name: k.name }, org: { customer: { id: c.id, name: c.name, slug: c.slug } }, channel: body.channel, reason: reason || null, notified });
      return { channel: body.channel, value, mode, revealedAt: at, auditId: id };
    },

    async listContactReveals(q: ContactRevealQuery = {}): Promise<Paginated<ContactRevealEntry>> {
      if (me.kind === "CUSTOMER") throw notFound();
      if (RANK[me.role] < RANK.OPERATOR) throw ctx.err(403, "ROLE_REQUIRED", "This action needs the OPERATOR role.", { role: "OPERATOR" });
      const mine = (c: FxCustomer) => me.role === "ADMIN" || ctx.directory(c).staff.some((s) => s.contactId === me.contactId);
      let only: string | null = null;
      if (q.customer !== undefined) {
        const c = isSlug(q.customer) ? ctx.customers.find((x) => x.slug === q.customer) : undefined;
        if (!c || !mine(c)) throw notFound();
        only = c.id;
      }
      if (q.mode !== undefined && q.mode !== "NORMAL" && q.mode !== "EMERGENCY") throw ctx.err(400, "VALIDATION_FAILED", "Invalid mode.", { fields: [{ field: "mode", message: "Must be NORMAL or EMERGENCY." }] });
      const from = q.from ? Date.parse(q.from) : null;
      const to = q.to ? Date.parse(q.to) : null;
      if (from !== null && Number.isNaN(from)) throw ctx.err(400, "VALIDATION_FAILED", "Invalid date.", { fields: [{ field: "from", message: "Not a date." }] });
      if (to !== null && Number.isNaN(to)) throw ctx.err(400, "VALIDATION_FAILED", "Invalid date.", { fields: [{ field: "to", message: "Not a date." }] });
      const visible = new Set(ctx.customers.filter(mine).map((c) => c.id));
      const items = store.log.filter((e) => {
        const cid = e.org.customer?.id;
        if (!cid || !visible.has(cid)) return false;
        if (only && cid !== only) return false;
        if (q.mode && e.mode !== q.mode) return false;
        if (q.actorUserId && e.actor.id !== q.actorUserId) return false;
        if (q.contactId && e.contact.id !== q.contactId) return false;
        const t = Date.parse(e.at);
        return (from === null || t >= from) && (to === null || t <= to);
      }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const start = q.cursor ? Math.max(0, Number(q.cursor) || 0) : 0;
      return structuredClone({ items: items.slice(start, start + 50), nextCursor: start + 50 < items.length ? String(start + 50) : null });
    },
  };
}
