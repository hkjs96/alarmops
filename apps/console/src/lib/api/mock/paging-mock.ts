import { ApiError, type ConsoleApi } from "../client";
import type {
  CallOrderRow, CustomerPersonResponder, LevelRef, OrgChain, PagingConfig, PagingConfigInput, PagingHealth, PagingPath, PagingPathStep, RespondersResponse,
  ScopeLevelName, StaffResponder, StaffSummary,
} from "../types";
import {
  MAX_MINUTE, MAX_REPEAT, computeHealth, isEdited, pagedNow, resolveStep, resolveStored, sentenceText, toInput, type Directory,
} from "../../call-order/model";
import { isSlug } from "../../validate";
import type { FxContact, FxPaging, FxStoredConfig } from "./paging-fixtures";
import type { FxCustomer, FxProject, FxService } from "./scope-fixtures";

type PagingApi = Pick<ConsoleApi,
  "callOrderList" | "pagingPath" | "getPaging" | "putPaging" | "putPagingOverride" | "deletePagingOverride" | "pagingHealth" |
  "getResponders" | "addResponder" | "patchResponder" | "removeResponder" | "listRotations" | "listStaff">;

interface Ctx {
  customers: FxCustomer[];
  paging: FxPaging;
  me: { name: string };
  now: () => string;
  /** customers with an open incident, for onlyProblems */
  openCustomerIds: () => Set<string>;
  err: (status: number, code: string, message: string) => ApiError;
}

export function directoryOf(paging: FxPaging, c: FxCustomer): Directory {
  const cp = paging.byCustomer[c.id]!;
  const disp = (x: FxContact) => ({ name: x.name, title: x.title, channels: x.channels, emailMasked: x.emailMasked, phoneMasked: x.phoneMasked });
  const tpl = cp.templateId ? paging.templates[cp.templateId] : undefined;
  const staff: StaffResponder[] = [
    ...(tpl?.members ?? []).map((id) => ({ contactId: id, source: "TEMPLATE" as const, templateId: cp.templateId!, templateName: tpl!.name, ...disp(paging.contacts[id]!) })),
    ...cp.staff.filter((id) => !tpl?.members.includes(id)).map((id) => ({ contactId: id, source: "DIRECT" as const, ...disp(paging.contacts[id]!) })),
  ];
  const people: CustomerPersonResponder[] = cp.people.map((p) => ({ contactId: p.contactId, role: p.role, extras: [...p.extras], scope: { ...p.scope }, ...disp(paging.contacts[p.contactId]!) }));
  return {
    customerName: c.name, staff, people,
    rotations: paging.rotations.filter((r) => r.scope === "MSP" || r.customerId === c.id),
    allStaff: Object.values(paging.contacts).filter((x) => x.kind === "STAFF").map((x) => ({ contactId: x.id, name: x.name, title: x.title, channels: x.channels })),
  };
}
export function healthOf(paging: FxPaging, c: FxCustomer): PagingHealth {
  const cp = paging.byCustomer[c.id]!;
  return computeHealth(cp.config.steps, directoryOf(paging, c), cp.extraProblems);
}
export const hasOwnSteps = (paging: FxPaging, customerId: string, level: ScopeLevelName, id: string) =>
  paging.byCustomer[customerId]!.overrides.some((o) => o.scopeType === level && o.scopeId === id);

export function createPagingApi(x: Ctx): PagingApi {
  const { paging } = x;
  const notFound = () => x.err(404, "NOT_FOUND", "Not found.");
  const invalid = (message: string) => x.err(400, "VALIDATION_FAILED", message);
  const customerById = (id: string) => { const c = x.customers.find((k) => k.id === id); if (!c) throw notFound(); return c; };

  function find(q: { customer?: string; project?: string; service?: string }): { c: FxCustomer; p?: FxProject; s?: FxService } | null {
    if (q.customer === undefined) { if (q.project !== undefined || q.service !== undefined) throw notFound(); return null; }
    if (![q.customer, q.project, q.service].every((v) => v === undefined || isSlug(v)) || (q.service !== undefined && q.project === undefined)) throw notFound();
    const c = x.customers.find((k) => k.slug === q.customer);
    const p = q.project === undefined ? undefined : c?.projects.find((k) => k.slug === q.project);
    const s = q.service === undefined ? undefined : p?.services.find((k) => k.slug === q.service);
    if (!c || (q.project !== undefined && !p) || (q.service !== undefined && !s)) throw notFound();
    return { c, p, s };
  }
  const ref = (level: ScopeLevelName, n: { id: string; name: string }): LevelRef => ({ level, id: n.id, name: n.name });
  const org = (c: FxCustomer, p?: FxProject, s?: FxService): OrgChain => {
    const r = (n: { id: string; name: string; slug: string }) => ({ id: n.id, name: n.name, slug: n.slug });
    return { customer: r(c), project: p ? r(p) : null, service: s ? r(s) : null };
  };
  /** the level a stored config belongs to, as a LevelRef */
  function levelRef(c: FxCustomer, cfg: FxStoredConfig): LevelRef {
    if (cfg.scopeType === "CUSTOMER") return ref("CUSTOMER", c);
    for (const p of c.projects) {
      if (cfg.scopeType === "PROJECT" && p.id === cfg.scopeId) return ref("PROJECT", p);
      const s = p.services.find((v) => v.id === cfg.scopeId);
      if (cfg.scopeType === "SERVICE" && s) return ref("SERVICE", s);
    }
    throw notFound();
  }
  const resolved = (c: FxCustomer, cfg: FxStoredConfig, d: Directory): PagingPathStep[] => cfg.steps.map((s) => resolveStep(s, d));
  function out(c: FxCustomer, cfg: FxStoredConfig): PagingConfig {
    const d = directoryOf(paging, c);
    return structuredClone({ ...toInput(cfg), id: cfg.id, customerId: c.id, scopeType: cfg.scopeType, scopeId: cfg.scopeId, edited: isEdited(cfg), version: cfg.version,
      updatedByName: cfg.updatedByName, updatedAt: cfg.updatedAt, sentence: sentenceText(resolved(c, cfg, d), cfg.repeatCount, c.name) });
  }

  /** the server-side form of the editor's checks: shape and targets. Reachability is health, not a save error. */
  function check(c: FxCustomer, body: PagingConfigInput): PagingConfigInput {
    const b = toInput(body);
    const d = directoryOf(paging, c);
    if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > 20) throw invalid("steps must hold 1 to 20 steps.");
    if (!Number.isInteger(b.repeatCount) || b.repeatCount < 0 || b.repeatCount > MAX_REPEAT) throw invalid("repeatCount is out of range.");
    b.steps.forEach((s, i) => {
      if (!Number.isInteger(s.atMin) || s.atMin < 0 || s.atMin > MAX_MINUTE || (i === 0 ? s.atMin !== 0 : s.atMin <= b.steps[i - 1]!.atMin)) throw invalid(`steps[${i}].atMin must come after the step before it.`);
      if (s.channels.length === 0) throw invalid(`steps[${i}].channels is empty.`);
      if (s.targetType === "ROTATION" && !d.rotations.some((r) => r.id === s.targetId)) throw x.err(422, "CROSS_CUSTOMER", `steps[${i}] names a rotation this customer cannot use.`);
      if (s.targetType === "PERSON") {
        const k = s.targetId ? paging.contacts[s.targetId] : undefined;
        const person = d.people.find((p) => p.contactId === s.targetId);
        if (!k || (k.kind === "CUSTOMER" && !person)) throw x.err(422, "CROSS_CUSTOMER", `steps[${i}] names a contact of another customer.`);
        if (person && person.role !== "PAGEABLE") throw invalid(`steps[${i}] names a Notify only person.`);
      }
    });
    return b;
  }
  const conflict = () => x.err(409, "VERSION_CONFLICT", "The call order was changed by someone else.");
  function stamp(cfg: FxStoredConfig, b: PagingConfigInput) {
    Object.assign(cfg, { ...b, sharedRotationId: b.sharedRotationId, version: cfg.version + 1, updatedByName: x.me.name, updatedAt: x.now() });
  }
  function namedInSteps(customerId: string, contactId: string): boolean {
    const cp = paging.byCustomer[customerId]!;
    return [cp.config, ...cp.overrides].some((cfg) => cfg.steps.some((s) => s.targetType === "PERSON" && s.targetId === contactId));
  }

  return {
    async callOrderList(q = {}) {
      const at = find(q);
      const open = x.openCustomerIds();
      const rank = { UNREACHABLE: 0, AT_RISK: 1, OK: 2 } as const;
      const list = x.customers
        .filter((c) => (at ? c.id === at.c.id : !q.mine || c.mine))
        .map((c) => ({ c, h: healthOf(paging, c) }))
        .filter(({ c, h }) => !q.onlyProblems || h.level !== "OK" || open.has(c.id))
        .sort((a, b) => rank[a.h.level] - rank[b.h.level]);
      const rows: CallOrderRow[] = [];
      for (const { c, h } of list) {
        const cp = paging.byCustomer[c.id]!;
        const d = directoryOf(paging, c);
        const row = (cfg: FxStoredConfig, p: FxProject | undefined, s: FxService | undefined, own: boolean): CallOrderRow => ({
          key: [c.slug, p?.slug, s?.slug].filter(Boolean).join("/"), org: org(c, p, s), level: s ? "SERVICE" : p ? "PROJECT" : "CUSTOMER", own,
          inheritedFrom: own ? null : levelRef(c, cfg), style: cfg.style, plan: cfg.plan, edited: isEdited(cfg), steps: resolved(c, cfg, d), repeatCount: cfg.repeatCount,
          responderCount: d.staff.length + d.people.filter((k) => k.role === "PAGEABLE").length,
          health: !p ? { level: h.level, problems: h.problems.length, first: h.problems[0]?.message } : null,
        });
        rows.push(row(cp.config, undefined, undefined, true));
        for (const p of c.projects) {
          const inP = !at?.p || at.p.id === p.id;
          const pOv = cp.overrides.find((o) => o.scopeType === "PROJECT" && o.scopeId === p.id);
          if (inP && pOv) rows.push(row(pOv, p, undefined, true));
          else if (at?.p?.id === p.id && !at.s) rows.push(row(cp.config, p, undefined, false));
          for (const s of p.services) {
            const sOv = cp.overrides.find((o) => o.scopeType === "SERVICE" && o.scopeId === s.id);
            if (inP && (!at?.s || at.s.id === s.id) && sOv) rows.push(row(sOv, p, s, true));
            else if (at?.s?.id === s.id) rows.push(row(pOv ?? cp.config, p, s, false));
          }
        }
      }
      return structuredClone({ rotations: paging.rotations, rows });
    },
    async pagingPath(q) {
      const at = find(q);
      if (!at) throw notFound();
      const { c, p, s } = at;
      const cp = paging.byCustomer[c.id]!;
      const cfg = resolveStored(cp.config, cp.overrides, { projectId: p?.id, serviceId: s?.id });
      const d = directoryOf(paging, c);
      const steps = resolved(c, cfg, d);
      const asked = s ? ref("SERVICE", s) : p ? ref("PROJECT", p) : ref("CUSTOMER", c);
      const from = levelRef(c, cfg);
      const paged = new Set(pagedNow(steps).map((k) => k.id));
      // a Notify only person is told when their scope and the asked scope overlap (one contains the other)
      const overlaps = (sc: LevelRef) => sc.level === "CUSTOMER"
        || (sc.level === "PROJECT" && (!p || p.id === sc.id))
        || (sc.level === "SERVICE" && (!p || p.services.some((v) => v.id === sc.id)) && (!s || s.id === sc.id));
      const path: PagingPath = {
        path: [...(s ? [ref("SERVICE", s)] : []), ...(p ? [ref("PROJECT", p)] : []), ref("CUSTOMER", c)],
        customer: { id: c.id, name: c.name }, inheritedFrom: from, own: from.level === asked.level && from.id === asked.id,
        style: cfg.style, plan: cfg.plan, edited: isEdited(cfg), pagingConfigId: cfg.id, version: cfg.version, sharedRotationId: cfg.sharedRotationId,
        steps, repeatCount: cfg.repeatCount, stopAtMin: (cfg.steps[cfg.steps.length - 1]?.atMin ?? 0) * (cfg.repeatCount + 1),
        sentence: sentenceText(steps, cfg.repeatCount, c.name),
        customerNotified: d.people.filter((k) => k.role === "NOTIFY_ONLY" && overlaps(k.scope) && !paged.has(k.contactId))
          .map((k) => ({ contactId: k.contactId, name: k.name, scope: k.scope })),
        updatedByName: cfg.updatedByName, updatedAt: cfg.updatedAt,
      };
      return structuredClone(path);
    },
    async getPaging(customerId) {
      const c = customerById(customerId);
      return out(c, paging.byCustomer[c.id]!.config);
    },
    async putPaging(customerId, body, version) {
      const c = customerById(customerId);
      const cfg = paging.byCustomer[c.id]!.config;
      const b = check(c, body);
      if (cfg.version !== version) throw conflict();
      stamp(cfg, b);
      return out(c, cfg);
    },
    async putPagingOverride(customerId, scopeType, scopeId, body, version) {
      const c = customerById(customerId);
      const cp = paging.byCustomer[c.id]!;
      const node = scopeType === "PROJECT" ? c.projects.find((p) => p.id === scopeId) : c.projects.flatMap((p) => p.services).find((s) => s.id === scopeId);
      if (!node) throw notFound();
      const b = check(c, body);
      let cfg = cp.overrides.find((o) => o.scopeType === scopeType && o.scopeId === scopeId);
      if (version === null) {
        if (cfg) throw x.err(409, "ALREADY_EXISTS", "This level already has its own steps.");
        cfg = { ...b, id: `pc_${scopeId}`, scopeType, scopeId, version: 0, updatedByName: null, updatedAt: null };
        cp.overrides.push(cfg);
      } else if (!cfg || cfg.version !== version) throw conflict();
      stamp(cfg, b);
      return out(c, cfg);
    },
    async deletePagingOverride(customerId, scopeType, scopeId, version) {
      const cp = paging.byCustomer[customerById(customerId).id]!;
      const i = cp.overrides.findIndex((o) => o.scopeType === scopeType && o.scopeId === scopeId);
      if (i < 0) throw notFound();
      if (cp.overrides[i]!.version !== version) throw conflict();
      cp.overrides.splice(i, 1);
    },
    async pagingHealth(customerId) { return structuredClone(healthOf(paging, customerById(customerId))); },
    async getResponders(customerId): Promise<RespondersResponse> {
      const c = customerById(customerId);
      const d = directoryOf(paging, c);
      return structuredClone({ staff: d.staff, people: d.people, templateId: paging.byCustomer[c.id]!.templateId });
    },
    async addResponder(customerId, input) {
      const c = customerById(customerId);
      const cp = paging.byCustomer[c.id]!;
      if ("contactId" in input) {
        const k = paging.contacts[input.contactId];
        if (!k) throw notFound();
        if (k.kind === "CUSTOMER") {
          if (k.customerId !== c.id) throw x.err(422, "CROSS_CUSTOMER", "This contact belongs to another customer.");
          if (cp.people.some((p) => p.contactId === k.id)) throw x.err(409, "ALREADY_EXISTS", `${k.name} is already in Responders.`);
          cp.people.push({ contactId: k.id, role: input.role ?? "NOTIFY_ONLY", extras: [], scope: ref("CUSTOMER", c) });
        } else {
          if (directoryOf(paging, c).staff.some((s) => s.contactId === k.id)) throw x.err(409, "ALREADY_EXISTS", `${k.name} is already in Responders.`);
          cp.staff.push(k.id);
        }
        return { contactId: k.id };
      }
      const name = input.name?.trim();
      if (!name || name.length > 80) throw invalid("name is required.");
      if (input.role !== "PAGEABLE" && input.role !== "NOTIFY_ONLY") throw invalid("role is not valid.");
      const email = input.email?.trim();
      const phone = input.phone?.trim();
      if (!email && !phone) throw invalid("An email or a phone number is required.");
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("email is not valid.");
      if (phone && !/^\+?[0-9][0-9 -]{6,18}$/.test(phone)) throw invalid("phone is not valid.");
      const id = `ct_new_${Object.keys(paging.contacts).length + 1}`;
      // the address and the number are taken and never handed back: the list shows the masked form only (D-35)
      paging.contacts[id] = {
        id, kind: "CUSTOMER", customerId: c.id, name, title: "Added just now",
        channels: { ...(email ? { EMAIL: "LINK_SENT" as const } : {}), ...(phone ? { SMS: "LINK_SENT" as const, VOICE: "LINK_SENT" as const } : {}) },
        emailMasked: email ? `${email[0]!.toLowerCase()}•••@${email.split("@")[1]}` : undefined,
        phoneMasked: phone ? `${phone.replace(/\D/g, "").slice(0, 3)}-••••-${phone.replace(/\D/g, "").slice(-4)}` : undefined,
      };
      cp.people.push({ contactId: id, role: input.role, extras: input.extras ?? [], scope: ref("CUSTOMER", c) });
      return { contactId: id };
    },
    async patchResponder(customerId, contactId, body) {
      const cp = paging.byCustomer[customerById(customerId).id]!;
      const p = cp.people.find((k) => k.contactId === contactId);
      if (!p) throw notFound();
      if (body.role !== "PAGEABLE" && body.role !== "NOTIFY_ONLY") throw invalid("role is not valid.");
      if (body.role === "NOTIFY_ONLY" && namedInSteps(customerId, contactId)) throw x.err(409, "IN_USE", `${paging.contacts[contactId]!.name} is named in a step. Change the step first.`);
      p.role = body.role;
    },
    async removeResponder(customerId, contactId) {
      const c = customerById(customerId);
      const cp = paging.byCustomer[c.id]!;
      const k = paging.contacts[contactId];
      const d = directoryOf(paging, c);
      const staff = d.staff.find((s) => s.contactId === contactId);
      if (!k || (!staff && !cp.people.some((p) => p.contactId === contactId))) throw notFound();
      if (staff?.source === "TEMPLATE") throw x.err(409, "FROM_TEMPLATE", `${k.name} comes from the template ${staff.templateName}. Change the template in Call order › Templates.`);
      if (namedInSteps(customerId, contactId)) throw x.err(409, "IN_USE", `${k.name} is named in a step. Change the step first.`);
      cp.staff = cp.staff.filter((id) => id !== contactId);
      cp.people = cp.people.filter((p) => p.contactId !== contactId);
    },
    async listRotations(q = {}) {
      return structuredClone(paging.rotations.filter((r) => (!q.scope || r.scope === q.scope) && (!q.customerId || r.scope === "MSP" || r.customerId === q.customerId)));
    },
    async listStaff(q): Promise<StaffSummary[]> {
      const needle = q?.trim().toLowerCase();
      return Object.values(paging.contacts).filter((k) => k.kind === "STAFF" && (!needle || k.name.toLowerCase().includes(needle)))
        .map((k) => ({ contactId: k.id, name: k.name, title: k.title, channels: { ...k.channels } }));
    },
  };
}
