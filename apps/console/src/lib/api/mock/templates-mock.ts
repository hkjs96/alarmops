/**
 * Mock of API-CONTRACT §8.3 "Responder 템플릿" and "고객에 템플릿 연결·해제" (D-41, D-64). packages/api/src/templatesApi.ts is the
 * reference for every rule here: the roles (read: MSP staff, write: ADMIN, portal 404), the effects of a change, the preview hash
 * (a preview and the save compute the same thing), what a change must not do (UNREACHABLE 409, D-38 limits 422, no override),
 * VERSION_CONFLICT / PREVIEW_STALE / ALREADY_EXISTS / CUSTOMER_TERMINATED and 503 BUSY.
 *
 * The template of a customer is `byCustomer[id].templateId`; its rows are the members of that template who were not added
 * directly (`staff`). So "the list the customer would have after the change" is the same store with the template (or the
 * member list) changed — the health and the limits are asked of that, with the same functions the Responders writes use.
 */
import { createHash } from "node:crypto";
import { ApiError, withBusyRetry, type ConsoleApi } from "../client";
import type { Role, TemplateBlocking, TemplateBlockReason, TemplateEffect, TemplatePreview, ResponderTemplate, TemplateProposal } from "../types";
import { pageableIds } from "../../call-order/model";
import { capViolation } from "../../call-order/limits";
import type { FxPaging } from "./paging-fixtures";
import type { FxCustomer } from "./scope-fixtures";
import { directoryOf, healthOf } from "./paging-mock";

export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_MEMBERS_MAX = 50;

type TemplatesApi = Pick<ConsoleApi, "listResponderTemplates" | "createResponderTemplate" | "previewResponderTemplate" | "saveResponderTemplate" | "previewCustomerTemplate" | "putCustomerTemplate">;

/** `busy`: the next N writes answer 503 BUSY (a test sets it; nothing in the console does) */
export interface TemplatesStore { busy: number; seq: number }
export const createTemplatesStore = (): TemplatesStore => ({ busy: 0, seq: 0 });

interface Ctx {
  store: TemplatesStore;
  customers: FxCustomer[];
  paging: FxPaging;
  terminated: () => Set<string>;
  me: { id?: string; name: string; role: Role; kind?: "INTERNAL" | "CUSTOMER" };
  now: () => string;
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError;
}

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };
const KIND_RANK: Record<TemplateEffect["kind"], number> = { JOINS: 0, LEAVES: 1, STEP_NAMES: 2, STAYS_DIRECT: 3, ALREADY_DIRECT: 4 };
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

interface Row { contactId: string; source: "TEMPLATE" | "DIRECT"; templateId?: string }
interface Named { contactId: string; stepIndex: number }

export function createTemplatesApi(x: Ctx): TemplatesApi {
  const { paging } = x;
  const invalid = (message: string, field: string) => x.err(400, "VALIDATION_FAILED", message, { fields: [{ field, message }] });
  const notFound = () => x.err(404, "NOT_FOUND", "Not found.");
  const portalGate = () => { if (x.me.kind === "CUSTOMER") throw notFound(); };
  const needAdmin = () => { if (RANK[x.me.role] < RANK.ADMIN) throw x.err(403, "ROLE_REQUIRED", "This action needs the ADMIN role.", { role: "ADMIN" }); };
  const busy = () => {
    if (x.store.busy > 0) { x.store.busy -= 1; throw x.err(503, "BUSY", "The system was busy with another change. Send the same request again.", { retryAfterSec: 0 }); }
  };
  const nameOf = (id: string): string => paging.contacts[id]?.name ?? id;
  const staffIds = (): Set<string> => new Set(Object.values(paging.contacts).filter((c) => c.kind === "STAFF").map((c) => c.id));

  const live = (c: FxCustomer) => !x.terminated().has(c.id);
  const usersOf = (templateId: string) => x.customers.filter((c) => live(c) && paging.byCustomer[c.id]?.templateId === templateId);

  function view(id: string): ResponderTemplate {
    const t = paging.templates[id]!;
    return {
      id, name: t.name, version: t.version ?? 0, updatedAt: t.updatedAt ?? x.now(), ...(t.updatedByName ? { updatedByName: t.updatedByName } : {}),
      members: t.members.map((contactId) => ({ contactId, name: nameOf(contactId) })), customers: usersOf(id).map((c) => ({ id: c.id, name: c.name })),
    };
  }
  const named = (c: FxCustomer): Named[] => {
    const cp = paging.byCustomer[c.id]!;
    return [...(cp.config ? [cp.config] : []), ...cp.overrides].flatMap((cfg) => cfg.steps.flatMap((s, i) => (s.targetType === "PERSON" && s.targetId ? [{ contactId: s.targetId, stepIndex: i + 1 }] : [])));
  };
  const rowsOf = (c: FxCustomer): Row[] => directoryOf(paging, c).staff.map((s) => ({ contactId: s.contactId, source: s.source, templateId: s.templateId }));
  const stepOf = (c: FxCustomer, id: string): number | undefined => named(c).filter((n) => n.contactId === id).map((n) => n.stepIndex).sort((a, b) => a - b)[0];

  /** the same store with the template's member list, or the customer's template, changed: what Responders would look like after */
  const hypo = (change: { templateId?: string; members?: string[]; customerId?: string; attach?: string | null }): FxPaging => {
    const templates = { ...paging.templates };
    if (change.templateId && change.members) templates[change.templateId] = { ...templates[change.templateId]!, members: change.members };
    const byCustomer = { ...paging.byCustomer };
    if (change.customerId) byCustomer[change.customerId] = { ...byCustomer[change.customerId]!, templateId: change.attach ?? null };
    return { ...paging, templates, byCustomer };
  };

  /** D-64: what a change must not do. A customer already UNREACHABLE is not blocked; a limit that was already exceeded is not blocked. */
  function blockReasons(c: FxCustomer, after: FxPaging, listChanged: boolean): TemplateBlockReason[] {
    if (!listChanged) return [];
    const reasons: TemplateBlockReason[] = [];
    if (healthOf(paging, c).level !== "UNREACHABLE" && healthOf(after, c).level === "UNREACHABLE") reasons.push("UNREACHABLE");
    const cp = paging.byCustomer[c.id]!;
    const [was, will] = [pageableIds(directoryOf(paging, c)).length, pageableIds(directoryOf(after, c)).length];
    for (const cfg of [...(cp.config ? [cp.config] : []), ...cp.overrides]) {
      const [a, b] = [capViolation(cfg.steps, cfg.repeatCount, was), capViolation(cfg.steps, cfg.repeatCount, will)];
      if (!a && b && !reasons.includes(b.code)) reasons.push(b.code);
    }
    return reasons;
  }
  const flat = (list: { customerId: string; reasons: TemplateBlockReason[] }[]): TemplateBlocking[] =>
    list.flatMap((l) => l.reasons.map((reason) => ({ customerId: l.customerId, reason }))).sort((a, b) => byId(a.customerId, b.customerId));
  /** UNREACHABLE first (409), else the D-38 limit (422) */
  function blockedError(blocking: TemplateBlocking[]): ApiError {
    const ids = (r: TemplateBlockReason) => [...new Set(blocking.filter((b) => b.reason === r).map((b) => b.customerId))].sort(byId);
    if (blocking.some((b) => b.reason === "UNREACHABLE")) return x.err(409, "WOULD_BE_UNREACHABLE", "After this change nobody could be reached for at least one customer.", { customerIds: ids("UNREACHABLE"), blocking });
    const r: TemplateBlockReason = blocking.some((b) => b.reason === "RESPONDER_LIMIT_EXCEEDED") ? "RESPONDER_LIMIT_EXCEEDED" : "SEND_CAP_EXCEEDED";
    return x.err(422, r, r === "RESPONDER_LIMIT_EXCEEDED"
      ? "After this change a step that pages everyone in Responders would reach more people than the limit allows."
      : "After this change a call order would send too many notifications per incident.", { customerIds: ids(r), blocking });
  }

  const sortEffects = (e: TemplateEffect[]) => e.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name) || byId(a.contactId, b.contactId));

  /** planTemplateChange of the server: the effects on every customer that uses the template */
  function planChange(templateId: string, proposal: { name: string; members: string[] }) {
    const t = paging.templates[templateId]!;
    const [oldSet, newSet] = [new Set(t.members), new Set(proposal.members)];
    const added = [...newSet].filter((i) => !oldSet.has(i)).sort(byId);
    const removed = [...oldSet].filter((i) => !newSet.has(i)).sort(byId);
    const after = hypo({ templateId, members: proposal.members });
    const customers = usersOf(templateId).sort((a, b) => a.name.localeCompare(b.name) || byId(a.id, b.id)).map((c) => {
      const rows = rowsOf(c);
      const row = (i: string) => rows.find((r) => r.contactId === i);
      const effects: TemplateEffect[] = [];
      for (const i of added) {
        const r = row(i);
        if (!r) effects.push({ kind: "JOINS", contactId: i, name: nameOf(i) });
        else if (r.source === "DIRECT") effects.push({ kind: "ALREADY_DIRECT", contactId: i, name: nameOf(i) });
      }
      for (const i of removed) {
        const r = row(i);
        if (!r) continue;
        if (r.source === "TEMPLATE" && r.templateId === templateId) {
          effects.push({ kind: "LEAVES", contactId: i, name: nameOf(i) });
          const s = stepOf(c, i);
          if (s !== undefined) effects.push({ kind: "STEP_NAMES", contactId: i, name: nameOf(i), stepIndex: s });
        } else if (r.source === "DIRECT") effects.push({ kind: "STAYS_DIRECT", contactId: i, name: nameOf(i) });
      }
      sortEffects(effects);
      const listChanged = effects.some((e) => e.kind === "JOINS" || e.kind === "LEAVES");
      return { id: c.id, name: c.name, effects, reasons: blockReasons(c, after, listChanged) };
    });
    const count = (k: TemplateEffect["kind"]) => customers.reduce((n, c) => n + c.effects.filter((e) => e.kind === k).length, 0);
    const totals = { customers: customers.length, affected: customers.filter((c) => c.effects.some((e) => e.kind === "JOINS" || e.kind === "LEAVES")).length, joins: count("JOINS"), leaves: count("LEAVES"), warnings: count("STEP_NAMES") };
    const previewHash = sha({
      templateId, version: t.version ?? 0, name: proposal.name, members: [...newSet].sort(byId),
      customers: customers.map((c) => ({ id: c.id, effects: c.effects.map((e) => [e.kind, e.contactId, e.stepIndex ?? null]) })),
    });
    return {
      customers: customers.map(({ id, name, effects }) => ({ id, name, effects })), totals, previewHash, added, removed,
      blocking: flat(customers.map((c) => ({ customerId: c.id, reasons: c.reasons }))),
    };
  }

  /** planTemplateAttach of the server: giving one customer another template (or none) */
  function planAttach(c: FxCustomer, to: string | null) {
    const cp = paging.byCustomer[c.id]!;
    const from = cp.templateId;
    const ref = (id: string | null) => (id ? { id, name: paging.templates[id]!.name } : null);
    const effects: TemplateEffect[] = [];
    let joins = 0;
    let leaves = 0;
    if (from !== to) {
      const rows = rowsOf(c);
      const row = (i: string) => rows.find((r) => r.contactId === i);
      const [oldIds, newIds] = [from ? paging.templates[from]!.members : [], to ? paging.templates[to]!.members : []];
      for (const i of [...oldIds].sort(byId)) {
        const r = row(i);
        if (!r) continue;
        if (r.source === "TEMPLATE" && r.templateId === from) {
          if (newIds.includes(i)) continue; // keeps its row: it moves to the new template
          leaves += 1;
          effects.push({ kind: "LEAVES", contactId: i, name: nameOf(i) });
          const s = stepOf(c, i);
          if (s !== undefined) effects.push({ kind: "STEP_NAMES", contactId: i, name: nameOf(i), stepIndex: s });
        } else if (r.source === "DIRECT" && !newIds.includes(i)) effects.push({ kind: "STAYS_DIRECT", contactId: i, name: nameOf(i) });
      }
      for (const i of [...newIds].sort(byId)) {
        if (oldIds.includes(i) && row(i)?.source === "TEMPLATE" && row(i)?.templateId === from) continue;
        const r = row(i);
        if (!r) { joins += 1; effects.push({ kind: "JOINS", contactId: i, name: nameOf(i) }); } else if (r.source === "DIRECT") effects.push({ kind: "ALREADY_DIRECT", contactId: i, name: nameOf(i) });
      }
      sortEffects(effects);
    }
    const blocking = from === to ? [] : flat([{ customerId: c.id, reasons: blockReasons(c, hypo({ customerId: c.id, attach: to }), joins > 0 || leaves > 0) }]);
    const previewHash = sha({ customerId: c.id, from, to, toVersion: to ? paging.templates[to]!.version ?? 0 : null, effects: effects.map((e) => [e.kind, e.contactId, e.stepIndex ?? null]) });
    return { from: ref(from), to: ref(to), effects, joins, leaves, totals: { joins, leaves, warnings: effects.filter((e) => e.kind === "STEP_NAMES").length }, blocking, previewHash };
  }

  // ---- input
  function readName(v: unknown): string {
    const name = typeof v === "string" ? v.trim() : "";
    if (!name || name.length > TEMPLATE_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw invalid(`name is required (at most ${TEMPLATE_NAME_MAX} characters).`, "name");
    return name;
  }
  function readMembers(v: unknown): string[] {
    if (!Array.isArray(v) || v.length < 1 || v.length > TEMPLATE_MEMBERS_MAX) throw invalid(`members must be a list of 1-${TEMPLATE_MEMBERS_MAX} staff contact ids.`, "members");
    if (new Set(v).size !== v.length) throw invalid("members must not repeat a person.", "members");
    const staff = staffIds();
    // an unknown id, a customer person and an inactive contact are the same 400
    if (v.some((i) => typeof i !== "string" || !staff.has(i))) throw invalid("members must be active MSP staff.", "members");
    return v as string[];
  }
  function readProposal(cur: { name: string; members: string[] }, p: TemplateProposal): { name: string; members: string[] } {
    if (p === null || typeof p !== "object" || Array.isArray(p)) throw invalid("Body must be a JSON object.", "body");
    const bad = Object.keys(p).filter((k) => (p as Record<string, unknown>)[k] !== undefined && !["name", "members"].includes(k));
    if (bad.length) throw x.err(400, "VALIDATION_FAILED", "Not accepted here.", { fields: bad.map((field) => ({ field, message: "Not accepted here." })) });
    if (p.name === undefined && p.members === undefined) throw invalid("name or members is required.", "members");
    return { name: p.name === undefined ? cur.name : readName(p.name), members: p.members === undefined ? [...cur.members] : readMembers(p.members) };
  }
  const nameTaken = (name: string, exceptId?: string) => Object.entries(paging.templates).some(([id, t]) => id !== exceptId && t.name === name);

  const customerOf = (id: string): FxCustomer => {
    const c = x.customers.find((k) => k.id === id);
    if (!c) throw notFound();
    return c;
  };
  function attachInput(customerId: string, to: unknown): { c: FxCustomer; to: string | null } {
    portalGate();
    const c = customerOf(customerId);
    needAdmin();
    if (to !== null && (typeof to !== "string" || !paging.templates[to])) throw invalid("Unknown template.", "templateId");
    if (!live(c)) throw x.err(409, "CUSTOMER_TERMINATED", "A terminated customer keeps its data as it is.");
    return { c, to: to as string | null };
  }

  return {
    async listResponderTemplates() {
      portalGate();
      return structuredClone(Object.keys(paging.templates).map(view).sort((a, b) => a.name.localeCompare(b.name) || byId(a.id, b.id)));
    },
    async createResponderTemplate(body) {
      portalGate();
      needAdmin();
      return withBusyRetry(async () => {
        busy();
        const name = readName(body?.name);
        const members = readMembers(body?.members);
        if (nameTaken(name)) throw x.err(409, "ALREADY_EXISTS", "A template with that name already exists.");
        const id = `tpl_${++x.store.seq}`;
        paging.templates[id] = { name, members: [...members], version: 0, updatedAt: x.now(), updatedByName: x.me.name };
        return structuredClone(view(id));
      }, async () => {});
    },
    async previewResponderTemplate(id, p) {
      portalGate();
      const t = paging.templates[id];
      if (!t) throw notFound();
      needAdmin();
      return withBusyRetry(async () => {
        busy();
        const proposal = readProposal(t, p);
        const plan = planChange(id, proposal);
        const out: TemplatePreview = { templateId: id, version: t.version ?? 0, customers: plan.customers, totals: plan.totals, blocking: plan.blocking, previewHash: plan.previewHash };
        return structuredClone(out);
      }, async () => {});
    },
    async saveResponderTemplate(id, p, o) {
      portalGate();
      const t = paging.templates[id];
      if (!t) throw notFound();
      needAdmin();
      return withBusyRetry(async () => {
        busy();
        if (!Number.isInteger(o.version) || o.version !== (t.version ?? 0)) throw x.err(409, "VERSION_CONFLICT", "The template was updated by someone else.", { currentVersion: t.version ?? 0 });
        const proposal = readProposal(t, p);
        if (typeof o.previewHash !== "string" || !/^[0-9a-f]{64}$/.test(o.previewHash)) throw invalid("previewHash from the preview of this change is required.", "previewHash");
        const same = proposal.name === t.name && proposal.members.length === t.members.length && t.members.every((m) => proposal.members.includes(m));
        if (same) return structuredClone({ ...view(id), affected: 0 });
        if (nameTaken(proposal.name, id)) throw x.err(409, "ALREADY_EXISTS", "A template with that name already exists.");
        const plan = planChange(id, proposal);
        if (plan.previewHash !== o.previewHash) throw x.err(409, "PREVIEW_STALE", "The template or the customers changed after the preview. Preview again.", { currentVersion: t.version ?? 0 });
        if (plan.blocking.length) throw blockedError(plan.blocking);
        paging.templates[id] = { ...t, name: proposal.name, members: [...proposal.members], version: (t.version ?? 0) + 1, updatedAt: x.now(), updatedByName: x.me.name };
        return structuredClone({ ...view(id), affected: plan.totals.affected });
      }, async () => {});
    },
    async previewCustomerTemplate(customerId, templateId) {
      const { c, to } = attachInput(customerId, templateId);
      return withBusyRetry(async () => {
        busy();
        const plan = planAttach(c, to);
        return structuredClone({ customerId: c.id, version: paging.byCustomer[c.id]!.respondersVersion, from: plan.from, to: plan.to, effects: plan.effects, totals: plan.totals, blocking: plan.blocking, previewHash: plan.previewHash });
      }, async () => {});
    },
    async putCustomerTemplate(customerId, templateId, o) {
      const { c, to } = attachInput(customerId, templateId);
      const cp = paging.byCustomer[c.id]!;
      return withBusyRetry(async () => {
        busy();
        if (typeof o.previewHash !== "string" || !/^[0-9a-f]{64}$/.test(o.previewHash)) throw invalid("previewHash from the preview of this change is required.", "previewHash");
        if (o.version !== cp.respondersVersion) throw x.err(409, "VERSION_CONFLICT", "The Responders were updated by someone else.", { currentVersion: cp.respondersVersion });
        if (cp.templateId === to) return { customerId: c.id, templateId: to, version: cp.respondersVersion, joins: 0, leaves: 0 };
        const plan = planAttach(c, to);
        if (plan.previewHash !== o.previewHash) throw x.err(409, "PREVIEW_STALE", "The template or the customer changed after the preview. Preview again.", { currentVersion: cp.respondersVersion });
        if (plan.blocking.length) throw blockedError(plan.blocking);
        cp.templateId = to;
        // the template rows of the old template are gone with it; a direct row of someone the new template names too stays direct
        return { customerId: c.id, templateId: to, version: ++cp.respondersVersion, joins: plan.joins, leaves: plan.leaves };
      }, async () => {});
    },
  };
}
