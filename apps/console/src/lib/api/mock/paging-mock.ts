import { ApiError, type ConsoleApi } from "../client";
import type {
  CallOrderRow, CustomerPersonResponder, LevelRef, OrgChain, PagingConfig, PagingConfigInput, PagingHealth, PagingPath, PagingPathStep, RespondersResponse,
  Role, ScopeLevelName, SendCap, StaffResponder, StaffSummary,
} from "../types";
import {
  MAX_MINUTE, MAX_REPEAT, MAX_STEPS, computeHealth, isEdited, isStepChannel, pageableIds, pagedNow, reachable, resolveStep, resolveStored, sentenceText, toInput, type Directory,
} from "../../call-order/model";
import { MAX_ALL_RESPONDERS, MAX_SENDS_PER_CYCLE, MAX_SENDS_PER_HOUR, capViolation, estimateSends } from "../../call-order/limits";
import { isSlug } from "../../validate";
import type { FxContact, FxPaging, FxStoredConfig } from "./paging-fixtures";
import type { FxCustomer, FxProject, FxService } from "./scope-fixtures";

type PagingApi = Pick<ConsoleApi,
  "callOrderList" | "pagingPath" | "getPaging" | "putPaging" | "putPagingOverride" | "deletePagingOverride" | "pagingHealth" |
  "getResponders" | "addResponder" | "patchResponder" | "removeResponder" | "listRotations" | "listStaff">;

interface Ctx {
  customers: FxCustomer[];
  paging: FxPaging;
  me: { name: string; role: Role };
  now: () => string;
  /** customers with an open incident, for onlyProblems */
  openCustomerIds: () => Set<string>;
  err: (status: number, code: string, message: string, details?: Record<string, unknown>) => ApiError;
}
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

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
    slackChannel: cp.slackChannel,
  };
}
export function healthOf(paging: FxPaging, c: FxCustomer): PagingHealth {
  const cp = paging.byCustomer[c.id]!;
  return computeHealth(cp.config?.steps ?? [], directoryOf(paging, c), cp.extraProblems, cp.config?.repeatCount ?? 0);
}
export const hasOwnSteps = (paging: FxPaging, customerId: string, level: ScopeLevelName, id: string) =>
  paging.byCustomer[customerId]!.overrides.some((o) => o.scopeType === level && o.scopeId === id);

export function createPagingApi(x: Ctx): PagingApi {
  const { paging } = x;
  const notFound = () => x.err(404, "NOT_FOUND", "Not found.");
  /** 400 with `details.fields[]`, as the API answers (API-CONTRACT §2) */
  const invalid = (message: string, field = "body") => x.err(400, "VALIDATION_FAILED", message, { fields: [{ field, message }] });
  /** role first, as the API does after the "can you see it" check: 403 ROLE_REQUIRED */
  const need = (role: Role) => { if (RANK[x.me.role] < RANK[role]) throw x.err(403, "ROLE_REQUIRED", `This action needs the ${role} role.`, { role }); };
  /** a customer that has no steps yet is shown the way GET /customers/{id}/paging shows it */
  const EMPTY = (c: FxCustomer): FxStoredConfig => ({ id: `pc_${c.id}`, scopeType: "CUSTOMER", scopeId: c.id, style: "CUSTOM", plan: "STANDARD", repeatCount: 1, steps: [], version: 0, updatedByName: null, updatedAt: null });
  const cfgOf = (c: FxCustomer) => paging.byCustomer[c.id]!.config ?? EMPTY(c);
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
  function sendCap(cfg: FxStoredConfig, d: Directory): SendCap {
    const everyone = pageableIds(d).length;
    return { ...estimateSends(cfg.steps, cfg.repeatCount, everyone), limits: { perCycle: MAX_SENDS_PER_CYCLE, perHour: MAX_SENDS_PER_HOUR, allResponders: MAX_ALL_RESPONDERS }, exceeded: capViolation(cfg.steps, cfg.repeatCount, everyone)?.code ?? null };
  }
  function out(c: FxCustomer, cfg: FxStoredConfig): PagingConfig {
    const d = directoryOf(paging, c);
    return structuredClone({ ...toInput(cfg), id: cfg.version === 0 ? null : cfg.id, customerId: c.id, scopeType: cfg.scopeType, scopeId: cfg.scopeId, edited: cfg.steps.length > 0 && isEdited(cfg), version: cfg.version,
      updatedByName: cfg.updatedByName, updatedAt: cfg.updatedAt, sentence: cfg.steps.length ? sentenceText(resolved(c, cfg, d), cfg.repeatCount, c.name) : "Nobody is paged: no steps.", sendCap: sendCap(cfg, d) });
  }

  /**
   * The API's own checks (packages/api pagingApi.ts buildConfig): shape and limits → 400 VALIDATION_FAILED with the
   * field, targets → 422 CROSS_CUSTOMER / NOT_PAGEABLE, send limits → 422 SEND_CAP_EXCEEDED / RESPONDER_LIMIT_EXCEEDED.
   * Reachability is health, not a save error.
   */
  function check(c: FxCustomer, body: PagingConfigInput): PagingConfigInput {
    const d = directoryOf(paging, c);
    if (!Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > MAX_STEPS) throw invalid(`steps must hold 1 to ${MAX_STEPS} steps.`, "steps");
    if (!Number.isInteger(body.repeatCount) || body.repeatCount < 0 || body.repeatCount > MAX_REPEAT) throw invalid(`repeatCount must be 0 to ${MAX_REPEAT}.`, "repeatCount");
    body.steps.forEach((s, i) => {
      if (!Array.isArray(s.channels) || s.channels.length === 0 || !s.channels.every(isStepChannel) || new Set(s.channels).size !== s.channels.length) {
        throw invalid("channels must be a non-empty list of SLACK_CHANNEL, SLACK_DM, SMS, VOICE, EMAIL.", `steps[${i}].channels`);
      }
    });
    const b = toInput(body);
    b.steps.forEach((s, i) => {
      if (!Number.isInteger(s.atMin) || s.atMin < 0 || s.atMin > MAX_MINUTE) throw invalid(`atMin must be 0 to ${MAX_MINUTE} minutes.`, `steps[${i}].atMin`);
      if (i > 0 && s.atMin <= b.steps[i - 1]!.atMin) throw invalid("Each step must start later than the step before it.", `steps[${i}].atMin`);
      if (s.targetType === "ROTATION" && !d.rotations.some((r) => r.id === s.targetId)) throw x.err(422, "CROSS_CUSTOMER", "A customer rotation can only be used by its own customer.", { field: `steps[${i}].targetId` });
      if (s.targetType === "PERSON") {
        const k = s.targetId ? paging.contacts[s.targetId] : undefined;
        const person = d.people.find((p) => p.contactId === s.targetId);
        if (!k) throw invalid("Unknown person.", `steps[${i}].targetId`);
        if (k.kind === "CUSTOMER" && k.customerId !== c.id) throw x.err(422, "CROSS_CUSTOMER", "A customer person can only be paged for their own customer.", { field: `steps[${i}].targetId` });
        if (k.kind === "CUSTOMER" && person?.role !== "PAGEABLE") throw x.err(422, "NOT_PAGEABLE", "This person is notify-only and cannot be put in a paging step.", { field: `steps[${i}].targetId` });
      }
    });
    const everyone = pageableIds(d).length;
    const cap = capViolation(b.steps, b.repeatCount, everyone);
    if (cap?.code === "RESPONDER_LIMIT_EXCEEDED") {
      throw x.err(422, "RESPONDER_LIMIT_EXCEEDED", `A step that pages everyone in Responders can reach at most ${MAX_ALL_RESPONDERS} people; this customer has ${cap.responders} pageable responders. Page a rotation or named people instead, or reduce the responders.`,
        { field: `steps[${cap.stepIndex}].targetType`, responders: cap.responders, limit: MAX_ALL_RESPONDERS });
    }
    if (cap) {
      throw x.err(422, "SEND_CAP_EXCEEDED", "This call order would send too many notifications per incident. Use fewer steps, channels or repeats, or page fewer people per step.",
        { perCycle: cap.perCycle, perHour: cap.perHour, limits: { perCycle: MAX_SENDS_PER_CYCLE, perHour: MAX_SENDS_PER_HOUR } });
    }
    return b;
  }
  const conflict = (currentVersion?: number) => x.err(409, "VERSION_CONFLICT", "The call order was updated by someone else.", currentVersion === undefined ? {} : { currentVersion });
  const respondersConflict = (currentVersion: number) => x.err(409, "VERSION_CONFLICT", "The Responders were updated by someone else.", { currentVersion });
  function stamp(cfg: FxStoredConfig, b: PagingConfigInput) {
    Object.assign(cfg, { ...b, sharedRotationId: b.sharedRotationId, version: cfg.version + 1, updatedByName: x.me.name, updatedAt: x.now() });
  }
  function namedInSteps(customerId: string, contactId: string): boolean {
    const cp = paging.byCustomer[customerId]!;
    return [...(cp.config ? [cp.config] : []), ...cp.overrides].some((cfg) => cfg.steps.some((s) => s.targetType === "PERSON" && s.targetId === contactId));
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
          inheritedFrom: own ? null : levelRef(c, cfg), style: cfg.style, plan: cfg.plan, edited: cfg.steps.length > 0 && isEdited(cfg), steps: resolved(c, cfg, d), repeatCount: cfg.repeatCount,
          responderCount: d.staff.length + d.people.filter((k) => k.role === "PAGEABLE").length,
          health: !p ? { level: h.level, problems: h.problems.length, first: h.problems[0]?.message } : null,
        });
        const custCfg = cfgOf(c);
        rows.push(row(custCfg, undefined, undefined, true));
        for (const p of c.projects) {
          const inP = !at?.p || at.p.id === p.id;
          const pOv = cp.overrides.find((o) => o.scopeType === "PROJECT" && o.scopeId === p.id);
          if (inP && pOv) rows.push(row(pOv, p, undefined, true));
          else if (at?.p?.id === p.id && !at.s) rows.push(row(custCfg, p, undefined, false));
          for (const s of p.services) {
            const sOv = cp.overrides.find((o) => o.scopeType === "SERVICE" && o.scopeId === s.id);
            if (inP && (!at?.s || at.s.id === s.id) && sOv) rows.push(row(sOv, p, s, true));
            else if (at?.s?.id === s.id) rows.push(row(pOv ?? custCfg, p, s, false));
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
      const d = directoryOf(paging, c);
      const asked = s ? ref("SERVICE", s) : p ? ref("PROJECT", p) : ref("CUSTOMER", c);
      const levels = [...(s ? [ref("SERVICE", s)] : []), ...(p ? [ref("PROJECT", p)] : []), ref("CUSTOMER", c)];
      const told = (paged: Set<string>) => d.people.filter((k) => k.role === "NOTIFY_ONLY" && overlaps(k.scope) && !paged.has(k.contactId)).map((k) => ({ contactId: k.contactId, name: k.name, scope: k.scope }));
      // a Notify only person is told when their scope and the asked scope overlap (one contains the other)
      const overlaps = (sc: LevelRef) => sc.level === "CUSTOMER"
        || (sc.level === "PROJECT" && (!p || p.id === sc.id))
        || (sc.level === "SERVICE" && (!p || p.services.some((v) => v.id === sc.id)) && (!s || s.id === sc.id));
      const cfg = resolveStored(cfgOf(c), cp.overrides, { projectId: p?.id, serviceId: s?.id });
      if (cfg.version === 0 && cfg.steps.length === 0) {
        // nothing configured anywhere up the chain: said so, not shown as inherited (packages/api pagingApi.ts)
        return structuredClone<PagingPath>({ path: levels, customer: { id: c.id, name: c.name }, customerNotified: told(new Set()), inheritedFrom: null, own: false, style: null, plan: null, edited: false,
          pagingConfigId: null, version: 0, steps: [], repeatCount: 0, stopAtMin: 0, sentence: "Nobody is paged: no call order is configured for this customer.", warning: "NO_CALL_ORDER" });
      }
      const steps = resolved(c, cfg, d);
      const from = levelRef(c, cfg);
      const paged = new Set(pagedNow(steps).map((k) => k.id));
      const path: PagingPath = {
        path: levels,
        customer: { id: c.id, name: c.name }, inheritedFrom: from, own: from.level === asked.level && from.id === asked.id,
        style: cfg.style, plan: cfg.plan, edited: isEdited(cfg), pagingConfigId: cfg.id, version: cfg.version, sharedRotationId: cfg.sharedRotationId,
        steps, repeatCount: cfg.repeatCount, stopAtMin: (cfg.steps[cfg.steps.length - 1]?.atMin ?? 0) * (cfg.repeatCount + 1),
        sentence: sentenceText(steps, cfg.repeatCount, c.name),
        customerNotified: told(paged),
        updatedByName: cfg.updatedByName, updatedAt: cfg.updatedAt,
        ...(steps.every((k) => !k.nowIds.some((id) => reachable(d, id, k.channels))) ? { warning: "NOBODY_REACHABLE" as const } : {}),
      };
      return structuredClone(path);
    },
    async getPaging(customerId) {
      const c = customerById(customerId);
      need("ADMIN");
      const cp = paging.byCustomer[c.id]!;
      const name = (o: FxStoredConfig) => levelRef(c, o).name;
      return { ...out(c, cfgOf(c)), overrides: cp.overrides.map((o) => ({ scopeType: o.scopeType as "PROJECT" | "SERVICE", scopeId: o.scopeId, name: name(o), id: o.id, version: o.version, style: o.style, plan: o.plan, edited: isEdited(o) })) };
    },
    async putPaging(customerId, body, version) {
      const c = customerById(customerId);
      need("ADMIN");
      const cp = paging.byCustomer[c.id]!;
      const b = check(c, body);
      // create: If-Match must be 0 (answered 201); replace: the version the editor started from
      if ((cp.config?.version ?? 0) !== version) throw conflict(cp.config?.version ?? 0);
      cp.config ??= { ...b, id: `pc_${c.id}`, scopeType: "CUSTOMER", scopeId: c.id, version: 0, updatedByName: null, updatedAt: null };
      stamp(cp.config, b);
      return out(c, cp.config);
    },
    async putPagingOverride(customerId, scopeType, scopeId, body, version) {
      const c = customerById(customerId);
      const cp = paging.byCustomer[c.id]!;
      const node = scopeType === "PROJECT" ? c.projects.find((p) => p.id === scopeId) : c.projects.flatMap((p) => p.services).find((s) => s.id === scopeId);
      if (!node) throw notFound();
      need("ADMIN");
      const b = check(c, body);
      let cfg = cp.overrides.find((o) => o.scopeType === scopeType && o.scopeId === scopeId);
      if ((cfg?.version ?? 0) !== version) throw conflict(cfg?.version ?? 0);
      if (!cfg) {
        cfg = { ...b, id: `pc_${scopeId}`, scopeType, scopeId, version: 0, updatedByName: null, updatedAt: null };
        cp.overrides.push(cfg);
      }
      stamp(cfg, b);
      return out(c, cfg);
    },
    async deletePagingOverride(customerId, scopeType, scopeId, version) {
      const cp = paging.byCustomer[customerById(customerId).id]!;
      const i = cp.overrides.findIndex((o) => o.scopeType === scopeType && o.scopeId === scopeId);
      if (i < 0) throw notFound();
      need("ADMIN");
      if (cp.overrides[i]!.version !== version) throw conflict(cp.overrides[i]!.version);
      cp.overrides.splice(i, 1);
    },
    async pagingHealth(customerId) { return structuredClone(healthOf(paging, customerById(customerId))); },
    async getResponders(customerId): Promise<RespondersResponse> {
      const c = customerById(customerId);
      const d = directoryOf(paging, c);
      const cp = paging.byCustomer[c.id]!;
      return structuredClone({ staff: d.staff, people: d.people, templateId: cp.templateId, version: cp.respondersVersion, slackChannel: cp.slackChannel });
    },
    async addResponder(customerId, input, opts) {
      const c = customerById(customerId);
      need("ADMIN");
      const cp = paging.byCustomer[c.id]!;
      if (cp.respondersVersion !== opts.version) throw respondersConflict(cp.respondersVersion);
      const done = (contactId: string) => {
        // "Responder를 늘리는 쓰기도 같은 규칙으로 거부한다" (D-38): more than 20 people behind an "everyone" step
        const everyone = pageableIds(directoryOf(paging, c)).length;
        if (everyone > MAX_ALL_RESPONDERS && [...(cp.config ? [cp.config] : []), ...cp.overrides].some((cfg) => cfg.steps.some((s) => s.targetType === "ALL_RESPONDERS"))) {
          cp.staff = cp.staff.filter((id) => id !== contactId);
          cp.people = cp.people.filter((p) => p.contactId !== contactId);
          throw x.err(422, "RESPONDER_LIMIT_EXCEEDED", `A step that pages everyone in Responders can reach at most ${MAX_ALL_RESPONDERS} people.`, { field: "contactId", responders: everyone, limit: MAX_ALL_RESPONDERS });
        }
        return { contactId, version: ++cp.respondersVersion };
      };
      if ("contactId" in input) {
        const k = paging.contacts[input.contactId];
        // a contact of another customer is the same 404 as an id that does not exist (security review 권고 3)
        if (!k || (k.kind === "CUSTOMER" && k.customerId !== c.id)) throw notFound();
        if (k.kind === "CUSTOMER") {
          if (cp.people.some((p) => p.contactId === k.id)) throw x.err(409, "ALREADY_EXISTS", `${k.name} is already in Responders.`);
          const was = cp.removedPeople[k.id];
          cp.people.push(was ? { ...was, role: input.role ?? was.role } : { contactId: k.id, role: input.role ?? "NOTIFY_ONLY", extras: [], scope: ref("CUSTOMER", c) });
          delete cp.removedPeople[k.id];
        } else {
          if (directoryOf(paging, c).staff.some((s) => s.contactId === k.id)) throw x.err(409, "ALREADY_EXISTS", `${k.name} is already in Responders.`);
          cp.staff.push(k.id);
        }
        return done(k.id);
      }
      const name = input.name?.trim();
      if (!name || name.length > 80) throw invalid("name is required.", "name");
      if (input.role !== "PAGEABLE" && input.role !== "NOTIFY_ONLY") throw invalid("role is not valid.", "role");
      const email = input.email?.trim();
      const phone = input.phone?.trim();
      if (!email && !phone) throw invalid("An email or a phone number is required.", "email");
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("email is not valid.", "email");
      if (phone && !/^\+?[0-9][0-9 -]{6,18}$/.test(phone)) throw invalid("phone is not valid.", "phone");
      const id = `ct_new_${Object.keys(paging.contacts).length + 1}`;
      // the address and the number are taken and never handed back: the list shows the masked form only (D-35)
      paging.contacts[id] = {
        id, kind: "CUSTOMER", customerId: c.id, name, title: "Added just now",
        channels: { ...(email ? { EMAIL: "LINK_SENT" as const } : {}), ...(phone ? { SMS: "LINK_SENT" as const, VOICE: "LINK_SENT" as const } : {}) },
        emailMasked: email ? `${email[0]!.toLowerCase()}•••@${email.split("@")[1]}` : undefined,
        phoneMasked: phone ? `${phone.replace(/\D/g, "").slice(0, 3)}-••••-${phone.replace(/\D/g, "").slice(-4)}` : undefined,
      };
      cp.people.push({ contactId: id, role: input.role, extras: input.extras ?? [], scope: ref("CUSTOMER", c) });
      return done(id);
    },
    async patchResponder(customerId, contactId, body, opts) {
      const c = customerById(customerId);
      const cp = paging.byCustomer[c.id]!;
      const p = cp.people.find((k) => k.contactId === contactId);
      if (!p) throw notFound();
      need("ADMIN");
      if (cp.respondersVersion !== opts.version) throw respondersConflict(cp.respondersVersion);
      if (body.role !== "PAGEABLE" && body.role !== "NOTIFY_ONLY") throw invalid("role is not valid.", "role");
      if (body.role === "NOTIFY_ONLY" && namedInSteps(customerId, contactId)) throw x.err(409, "IN_USE", `${paging.contacts[contactId]!.name} is named in a step. Change the step first.`);
      const before = healthOf(paging, c).level;
      const was = p.role;
      p.role = body.role;
      if (!opts.confirmUnreachable && before !== "UNREACHABLE" && healthOf(paging, c).level === "UNREACHABLE") {
        p.role = was;
        throw x.err(409, "WOULD_BE_UNREACHABLE", `With ${paging.contacts[contactId]!.name} as Notify only, nobody for ${c.name} would be reached.`);
      }
      return { contactId, version: ++cp.respondersVersion };
    },
    async removeResponder(customerId, contactId, opts) {
      const c = customerById(customerId);
      const cp = paging.byCustomer[c.id]!;
      const k = paging.contacts[contactId];
      const d = directoryOf(paging, c);
      const staff = d.staff.find((s) => s.contactId === contactId);
      const person = cp.people.find((p) => p.contactId === contactId);
      if (!k || (!staff && !person)) throw notFound();
      need("ADMIN");
      if (cp.respondersVersion !== opts.version) throw respondersConflict(cp.respondersVersion);
      if (staff?.source === "TEMPLATE") throw x.err(409, "FROM_TEMPLATE", `${k.name} comes from the template ${staff.templateName}. Change the template in Call order › Templates.`);
      if (namedInSteps(customerId, contactId)) throw x.err(409, "IN_USE", `${k.name} is named in a step. Change the step first.`);
      const before = healthOf(paging, c).level;
      const [staffWas, peopleWas] = [cp.staff, cp.people];
      cp.staff = cp.staff.filter((id) => id !== contactId);
      cp.people = cp.people.filter((p) => p.contactId !== contactId);
      if (!opts.confirmUnreachable && before !== "UNREACHABLE" && healthOf(paging, c).level === "UNREACHABLE") {
        cp.staff = staffWas; cp.people = peopleWas;
        throw x.err(409, "WOULD_BE_UNREACHABLE", `Without ${k.name}, nobody for ${c.name} would be reached.`);
      }
      if (person) cp.removedPeople[contactId] = person;
      return { contactId, version: ++cp.respondersVersion };
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
