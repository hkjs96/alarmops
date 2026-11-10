/**
 * API-CONTRACT §8.3 (scope parts): GET/PUT /customers/{id}/paging, PUT/DELETE /customers/{id}/paging-overrides/…,
 * GET /oncall/paging-path. D-30: each customer owns its steps; service › project › customer, first existing wins.
 */
import {
  MAX_ALL_RESPONDERS, MAX_AT_MIN, MAX_REPEAT, MAX_SENDS_PER_CYCLE, MAX_SENDS_PER_HOUR, MAX_STEPS, estimateSends, isPageableFor, pagingPath, resolvePagingConfig, sendCapViolation, sentence, templateSteps,
  type EscalationStep, type PagingConfig, type PagingWorld, type ScopeLevel, type StepChannel, type TargetType,
} from '@alarmops/core';
import { customerWide, inScope, requireAuth, requireRole, scopeOf, type AuthContext } from './auth.js';
import { ApiError, ifMatch, invalid, isRecord, notFound, ok, q, validation, versionConflict, type ApiRequest, type ApiResponse } from './http.js';
import type { ScopeFilter } from './auth.js';
import type { ApiRepository, OrgTree } from './repo.js';
import { resolveSlugs } from './scope.js';

interface Deps { repo: ApiRepository; now: () => Date }

const STYLES = ['ALL_AT_ONCE', 'CUSTOMER_ROTATION', 'SHARED_ROTATION', 'CUSTOM'] as const;
const PLANS = ['STANDARD', 'URGENT', 'QUIET'] as const;
const TARGETS = ['PERSON', 'ROTATION', 'ALL_RESPONDERS'] as const;
const CHANNELS: readonly StepChannel[] = ['SLACK_CHANNEL', 'SLACK_DM', 'SMS', 'VOICE', 'EMAIL'];
export { MAX_STEPS, MAX_AT_MIN, MAX_REPEAT };

const unprocessable = (code: 'CROSS_CUSTOMER' | 'NOT_PAGEABLE' | 'SEND_CAP_EXCEEDED' | 'RESPONDER_LIMIT_EXCEEDED', message: string, details: Record<string, unknown>) => new ApiError(422, code, message, details);

/** Step sentence with nobody resolved yet is still useful after a save: resolve against the world now. */
function view(cfg: PagingConfig, w: PagingWorld, now: Date) {
  const path = pagingPath([cfg], { customerId: cfg.customerId, projectId: cfg.scopeType === 'PROJECT' ? cfg.scopeId : null, serviceId: cfg.scopeType === 'SERVICE' ? cfg.scopeId : null }, w, now);
  const first = cfg.steps[0];
  return {
    id: cfg.id, customerId: cfg.customerId, scopeType: cfg.scopeType, scopeId: cfg.scopeId, style: cfg.style, plan: cfg.plan, edited: cfg.edited,
    ...(cfg.style === 'SHARED_ROTATION' && first?.targetType === 'ROTATION' && first.targetId ? { sharedRotationId: first.targetId } : {}),
    steps: stepsOut(cfg.steps), repeatCount: cfg.repeatCount, version: cfg.version,
    sentence: path?.sentence ?? sentence([], cfg.repeatCount),
    // R-12: re-checked on every read with the responders as they are NOW. `exceeded` is null, or the code a PUT of
    // these same steps would get today; incidents opened meanwhile are cut down to the limits by the engine.
    sendCap: sendCap(cfg, w),
  };
}
function sendCap(cfg: PagingConfig, w: PagingWorld) {
  const responders = w.responders.filter((r) => r.customerId === cfg.customerId && r.role === 'PAGEABLE' && isPageableFor(w, r.contactId)).length;
  const est = estimateSends([...cfg.steps].sort((a, b) => a.index - b.index), cfg.repeatCount, responders);
  return { perCycle: est.perCycle, perHour: est.perHour, limits: { perCycle: MAX_SENDS_PER_CYCLE, perHour: MAX_SENDS_PER_HOUR, allResponders: MAX_ALL_RESPONDERS }, exceeded: sendCapViolation(cfg, w)?.code ?? null };
}
const stepsOut = (steps: EscalationStep[]) =>
  [...steps].sort((a, b) => a.index - b.index).map((s) => ({ atMin: s.atMin, targetType: s.targetType, ...(s.targetId ? { targetId: s.targetId } : {}), channels: s.channels }));

/** Validate and build the config to store. Tenant rules for targets are enforced here (DATA-MODEL Contact, EscalationStep). */
async function buildConfig(body: unknown, base: Pick<PagingConfig, 'id' | 'customerId' | 'scopeType' | 'scopeId'>, deps: Deps, w: PagingWorld): Promise<PagingConfig> {
  if (!isRecord(body)) throw invalid('body', 'Body must be a JSON object.');
  const errors: Array<{ field: string; message: string }> = [];
  const { style, plan, sharedRotationId, steps, repeatCount } = body;
  if (!(STYLES as readonly unknown[]).includes(style)) errors.push({ field: 'style', message: 'style must be ALL_AT_ONCE, CUSTOMER_ROTATION, SHARED_ROTATION or CUSTOM.' });
  if (!(PLANS as readonly unknown[]).includes(plan)) errors.push({ field: 'plan', message: 'plan must be STANDARD, URGENT or QUIET.' });
  const repeat = repeatCount === undefined ? 1 : repeatCount; // D-20 default: repeat once
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 0 || repeat > MAX_REPEAT) errors.push({ field: 'repeatCount', message: `repeatCount must be 0 to ${MAX_REPEAT}.` });
  if (sharedRotationId !== undefined && typeof sharedRotationId !== 'string') errors.push({ field: 'sharedRotationId', message: 'sharedRotationId must be an id.' });
  if (steps !== undefined && (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS)) errors.push({ field: 'steps', message: `steps must hold 1 to ${MAX_STEPS} steps.` });
  if (errors.length) throw validation(errors);
  const st = style as PagingConfig['style'];
  const pl = plan as PagingConfig['plan'];

  let built: EscalationStep[];
  let edited: boolean;
  const template = (): EscalationStep[] | null => {
    if (st === 'ALL_AT_ONCE') return templateSteps(pl, { targetType: 'ALL_RESPONDERS', targetId: null }, true);
    if (st === 'SHARED_ROTATION') return typeof sharedRotationId === 'string' ? templateSteps(pl, { targetType: 'ROTATION', targetId: sharedRotationId }, false) : null;
    if (st === 'CUSTOMER_ROTATION') {
      const own = [...w.rotations.values()].filter((r) => r.scope === 'CUSTOMER' && r.customerId === base.customerId);
      return own.length === 1 ? templateSteps(pl, { targetType: 'ROTATION', targetId: own[0]!.id }, false) : null;
    }
    return null;
  };
  if (steps === undefined) {
    // "plan만 바꾸면 서버가 템플릿으로 단계 재생성(edited=false)"
    const t = template();
    if (!t) {
      throw invalid('steps', st === 'SHARED_ROTATION' ? 'sharedRotationId is required to build steps for a shared rotation.'
        : st === 'CUSTOMER_ROTATION' ? 'Send steps: this customer does not have exactly one rotation to build them from.' : 'steps are required for custom steps.');
    }
    built = t;
    edited = false;
  } else {
    const list = steps as unknown[];
    list.forEach((s, i) => {
      const f = `steps[${i}]`;
      if (!isRecord(s)) { errors.push({ field: f, message: 'Each step must be an object.' }); return; }
      if (typeof s.atMin !== 'number' || !Number.isInteger(s.atMin) || s.atMin < 0 || s.atMin > MAX_AT_MIN) errors.push({ field: `${f}.atMin`, message: `atMin must be 0 to ${MAX_AT_MIN} minutes.` });
      if (!(TARGETS as readonly unknown[]).includes(s.targetType)) errors.push({ field: `${f}.targetType`, message: 'targetType must be PERSON, ROTATION or ALL_RESPONDERS.' });
      else if (s.targetType === 'ALL_RESPONDERS' ? s.targetId != null : typeof s.targetId !== 'string' || !s.targetId) errors.push({ field: `${f}.targetId`, message: s.targetType === 'ALL_RESPONDERS' ? 'ALL_RESPONDERS takes no targetId.' : 'targetId is required.' });
      if (!Array.isArray(s.channels) || s.channels.length === 0 || s.channels.some((c) => !CHANNELS.includes(c as StepChannel)) || new Set(s.channels).size !== s.channels.length) {
        errors.push({ field: `${f}.channels`, message: `channels must be a non-empty list of ${CHANNELS.join(', ')}.` });
      }
      const prev = list[i - 1];
      // Strictly increasing (R-1): two steps at the same minute are one step with more targets, not a way around the caps.
      if (i > 0 && isRecord(prev) && typeof prev.atMin === 'number' && typeof s.atMin === 'number' && s.atMin <= prev.atMin) errors.push({ field: `${f}.atMin`, message: 'Each step must start later than the step before it.' });
    });
    if (errors.length) throw validation(errors);
    built = (list as Array<Record<string, unknown>>).map((s, index) => ({
      index, atMin: s.atMin as number, targetType: s.targetType as TargetType, targetId: s.targetType === 'ALL_RESPONDERS' ? null : (s.targetId as string), channels: [...(s.channels as StepChannel[])],
    }));
    const t = template();
    edited = !t || JSON.stringify(stepsOut(t)) !== JSON.stringify(stepsOut(built));
  }

  // Targets: a customer person only in their own customer and only when pageable; a rotation only when shared (MSP) or this customer's.
  for (const s of built) {
    const field = `steps[${s.index}].targetId`;
    if (s.targetType === 'PERSON') {
      const c = await deps.repo.getContact(s.targetId!);
      if (!c || !c.active) throw invalid(field, 'Unknown person.');
      if (c.kind === 'CUSTOMER' && c.customerId !== base.customerId) throw unprocessable('CROSS_CUSTOMER', 'A customer person can only be paged for their own customer.', { field });
      if (!isPageableFor(w, c.id)) throw unprocessable('NOT_PAGEABLE', 'This person is notify-only and cannot be put in a paging step.', { field });
    } else if (s.targetType === 'ROTATION') {
      const r = await deps.repo.rotationOwner(s.targetId!);
      if (!r) throw invalid(field, 'Unknown rotation.');
      if (r.scope === 'CUSTOMER' && r.customerId !== base.customerId) throw unprocessable('CROSS_CUSTOMER', 'A customer rotation can only be used by its own customer.', { field });
    }
  }
  // R-1: what one incident may send. Checked for template-built steps too. Same function as paging health and the
  // responder re-validation (R-12), so "allowed when saved" and "allowed now" are one rule.
  const cap = sendCapViolation({ steps: built, repeatCount: repeat as number }, w);
  if (cap?.code === 'RESPONDER_LIMIT_EXCEEDED') {
    throw unprocessable('RESPONDER_LIMIT_EXCEEDED', `A step that pages everyone in Responders can reach at most ${MAX_ALL_RESPONDERS} people; this customer has ${cap.responders} pageable responders. Page a rotation or named people instead, or reduce the responders.`,
      { field: `steps[${cap.stepIndex}].targetType`, responders: cap.responders, limit: MAX_ALL_RESPONDERS });
  }
  if (cap) {
    const over = cap.perCycle > MAX_SENDS_PER_CYCLE
      ? `${cap.perCycle} notifications per incident in one pass of the steps (limit ${MAX_SENDS_PER_CYCLE})`
      : `${cap.perHour} notifications per incident within one hour, repeats included (limit ${MAX_SENDS_PER_HOUR})`;
    throw unprocessable('SEND_CAP_EXCEEDED', `This call order would send ${over}. Use fewer steps, channels or repeats, or page fewer people per step.`,
      { perCycle: cap.perCycle, perHour: cap.perHour, limits: cap.limits });
  }
  return { ...base, style: st, plan: pl, edited, repeatCount: repeat as number, version: 0, steps: built };
}

async function visibleCustomer(deps: Deps, auth: AuthContext, customerId: string, level: 'CUSTOMER' | 'BELOW' = 'BELOW') {
  const scope = scopeOf(auth);
  const tree = await deps.repo.orgTree(scope);
  const customer = tree.customers.find((c) => c.id === customerId);
  if (!customer) throw notFound(); // unknown and out-of-scope: same answer
  // R-6: the customer's own call order belongs to people who have the whole customer. For a user narrowed to a
  // project or service it does not exist — the same 404 as an unknown customer, before any role or header check.
  if (level === 'CUSTOMER' && !customerWide(scope, customer.id)) throw notFound();
  return { tree, customer, scope };
}

const audit = (req: ApiRequest, auth: AuthContext, now: Date, action: string, cfgId: string, customerId: string, before: unknown, after: unknown) =>
  ({ at: now, customerId, actorType: 'USER' as const, actorId: auth.userId, action, targetType: 'PagingConfig', targetId: cfgId, before, after, requestId: req.requestId });

/** GET /customers/{id}/paging — the customer's own steps plus the list of project/service overrides. */
export async function getCustomerPaging(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const { tree, customer } = await visibleCustomer(deps, auth, customerId, 'CUSTOMER');
  requireRole(auth, 'ADMIN');
  const { configs, world } = await deps.repo.pagingContext(customer.id);
  const cfg = configs.find((c) => c.scopeType === 'CUSTOMER' && c.scopeId === customer.id);
  const name = (c: PagingConfig) => (c.scopeType === 'PROJECT' ? tree.projects.find((p) => p.id === c.scopeId)?.name : tree.services.find((s) => s.id === c.scopeId)?.name) ?? c.scopeId;
  const overrides = configs.filter((c) => c.scopeType !== 'CUSTOMER').map((c) => ({ scopeType: c.scopeType, scopeId: c.scopeId, name: name(c), id: c.id, version: c.version, style: c.style, plan: c.plan, edited: c.edited }));
  if (!cfg) {
    // No steps saved yet: version 0 is what a first PUT sends as If-Match.
    return ok({ id: null, customerId: customer.id, scopeType: 'CUSTOMER', scopeId: customer.id, style: 'CUSTOM', plan: 'STANDARD', edited: false, steps: [], repeatCount: 1, version: 0, sentence: sentence([], 1), overrides }, { etag: '"0"' });
  }
  return ok({ ...view(cfg, world, deps.now()), overrides }, { etag: `"${cfg.version}"` });
}

async function putConfig(req: ApiRequest, deps: Deps, auth: AuthContext, customerId: string, scopeType: ScopeLevel, scopeId: string): Promise<ApiResponse> {
  requireRole(auth, 'ADMIN');
  const version = ifMatch(req);
  const { configs, world } = await deps.repo.pagingContext(customerId);
  const cur = configs.find((c) => c.scopeType === scopeType && c.scopeId === scopeId);
  const id = cur?.id ?? `pc_${scopeType.toLowerCase()}_${scopeId}`;
  const next = await buildConfig(req.body, { id, customerId, scopeType, scopeId }, deps, world);
  // Create: If-Match must be 0. Replace: the version the editor started from (§8.8 drafts carry it).
  if ((cur?.version ?? 0) !== version) throw versionConflict('The call order', cur?.version ?? 0);
  const now = deps.now();
  const saved = await deps.repo.savePagingConfig({ ...next, renotifyAfterAckSec: cur?.renotifyAfterAckSec ?? null }, cur ? cur.version : null,
    audit(req, auth, now, cur ? 'paging.update' : 'paging.create', id, customerId, cur ? { version: cur.version, steps: stepsOut(cur.steps), repeatCount: cur.repeatCount } : null, { steps: stepsOut(next.steps), repeatCount: next.repeatCount, style: next.style, plan: next.plan }));
  if (saved === 'CONFLICT') throw versionConflict('The call order');
  return ok(view(saved, world, now), { etag: `"${saved.version}"` }, cur ? 200 : 201);
}

/** PUT /customers/{id}/paging (If-Match). Changes apply to incidents opened afterwards; open incidents keep their frozen order (R3-1). */
export async function putCustomerPaging(req: ApiRequest, deps: Deps, customerId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const { customer } = await visibleCustomer(deps, auth, customerId, 'CUSTOMER');
  return putConfig(req, deps, auth, customer.id, 'CUSTOMER', customer.id);
}

function overrideTarget(tree: OrgTree, scope: ScopeFilter, customerId: string, scopeType: string, scopeId: string): { scopeType: 'PROJECT' | 'SERVICE'; scopeId: string } {
  if (scopeType !== 'PROJECT' && scopeType !== 'SERVICE') throw invalid('scopeType', 'scopeType must be PROJECT or SERVICE.');
  // The project/service must belong to THIS customer (and be visible): another customer's id is the same 404 as a made-up one.
  const project = scopeType === 'PROJECT' ? tree.projects.find((p) => p.id === scopeId && p.customerId === customerId) : undefined;
  const service = scopeType === 'SERVICE' ? tree.services.find((s) => s.id === scopeId && s.customerId === customerId) : undefined;
  const hit = project ?? service;
  if (!hit) throw notFound();
  // R-6: only inside the caller's own subtree. The tree also shows the PARENT project of a granted service (so the
  // console can draw the path); that parent is visible, not editable — its override is the same 404.
  if (!inScope(scope, { customerId, projectId: project?.id ?? service!.projectId, serviceId: service?.id ?? null })) throw notFound();
  return { scopeType, scopeId: hit.id };
}

/** PUT /customers/{id}/paging-overrides/{scopeType}/{scopeId} */
export async function putPagingOverride(req: ApiRequest, deps: Deps, customerId: string, scopeType: string, scopeId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const { tree, customer, scope } = await visibleCustomer(deps, auth, customerId);
  const t = overrideTarget(tree, scope, customer.id, scopeType, scopeId);
  return putConfig(req, deps, auth, customer.id, t.scopeType, t.scopeId);
}

/** DELETE /customers/{id}/paging-overrides/{scopeType}/{scopeId} — the scope goes back to inheriting. */
export async function deletePagingOverride(req: ApiRequest, deps: Deps, customerId: string, scopeType: string, scopeId: string): Promise<ApiResponse> {
  const auth = requireAuth(req);
  const { tree, customer, scope } = await visibleCustomer(deps, auth, customerId);
  const t = overrideTarget(tree, scope, customer.id, scopeType, scopeId);
  requireRole(auth, 'ADMIN');
  const version = ifMatch(req);
  const { configs } = await deps.repo.pagingContext(customer.id);
  const cur = configs.find((c) => c.scopeType === t.scopeType && c.scopeId === t.scopeId);
  if (!cur) throw notFound();
  if (cur.version !== version) throw versionConflict('The call order', cur.version);
  const r = await deps.repo.deletePagingConfig(cur.id, version, audit(req, auth, deps.now(), 'paging.delete', cur.id, customer.id, { version: cur.version, steps: stepsOut(cur.steps) }, null));
  if (r === 'CONFLICT') throw versionConflict('The call order');
  return ok({ deleted: true });
}

/**
 * GET /oncall/paging-path — "Who gets paged for…". Asked by `serviceId` / `resourceId` / `q` (contract) or by
 * `projectId` / `customerId` / slugs `customer[&project[&service]]` (PROPOSED: the console panel asks by scope).
 * Same resolution function as incident paging (known-bugs 7-3): what this says is what the tick does.
 *
 * INTERNAL only (security Q-1): the answer is the MSP's call order with staff, rotation and config ids. For portal
 * users the route does not exist — the one 404, before any parameter is looked at.
 */
export async function getPagingPath(req: ApiRequest, deps: Deps): Promise<ApiResponse> {
  const auth = requireAuth(req);
  if (auth.kind !== 'INTERNAL') throw notFound();
  const scope = scopeOf(auth);
  const tree = await deps.repo.orgTree(scope);
  const lv = (level: 'RESOURCE' | ScopeLevel, n: { id: string; name: string }) => ({ level, id: n.id, name: n.name });
  let customerId: string | undefined;
  let projectId: string | undefined;
  let serviceId: string | undefined;
  let resource: { id: string; name: string } | undefined;

  const term = q(req, 'q');
  if (term !== undefined) {
    const needle = term.toLowerCase();
    const starts = (n: { name: string }) => n.name.toLowerCase().startsWith(needle);
    const cName = (id: string) => tree.customers.find((c) => c.id === id)?.name ?? '';
    const candidates = [
      ...tree.services.filter(starts).map((s) => ({ ...lv('SERVICE', s), customer: { id: s.customerId, name: cName(s.customerId) } })),
      ...tree.projects.filter(starts).map((p) => ({ ...lv('PROJECT', p), customer: { id: p.customerId, name: cName(p.customerId) } })),
      ...tree.customers.filter(starts).map((c) => ({ ...lv('CUSTOMER', c), customer: { id: c.id, name: c.name } })),
    ].slice(0, 20);
    if (candidates.length !== 1) return ok({ candidates });
    const only = candidates[0]!;
    if (only.level === 'SERVICE') serviceId = only.id; else if (only.level === 'PROJECT') projectId = only.id; else customerId = only.id;
  } else if (q(req, 'resourceId') !== undefined) {
    const r = await deps.repo.findResource(scope, q(req, 'resourceId')!);
    if (!r) throw notFound();
    resource = { id: r.id, name: r.name };
    customerId = r.customerId;
    if (r.serviceId) serviceId = r.serviceId;
  } else if (q(req, 'customer') !== undefined || q(req, 'project') !== undefined || q(req, 'service') !== undefined) {
    const node = resolveSlugs(tree, { customer: q(req, 'customer'), project: q(req, 'project'), service: q(req, 'service') })!;
    customerId = node.customer.id; projectId = node.project?.id; serviceId = node.service?.id;
  } else {
    serviceId = q(req, 'serviceId'); projectId = q(req, 'projectId'); customerId = q(req, 'customerId');
    if (!serviceId && !projectId && !customerId) throw invalid('serviceId', 'Ask by q, resourceId, serviceId, projectId, customerId or scope slugs.');
  }

  // Every id is looked up in the scoped tree only: out-of-scope = unknown = 404.
  const service = serviceId ? tree.services.find((s) => s.id === serviceId) : undefined;
  if (serviceId && !service) throw notFound();
  const project = service ? tree.projects.find((p) => p.id === service.projectId) : projectId ? tree.projects.find((p) => p.id === projectId) : undefined;
  if ((serviceId || projectId) && !project) throw notFound();
  const customer = tree.customers.find((c) => c.id === (project?.customerId ?? customerId));
  if (!customer) throw notFound();
  // R-6: staff narrowed to a project/service ask about that subtree only. The tree shows the parent project of a
  // granted service and the customer node above it; asking for THEIR call order is the same 404.
  if (!inScope(scope, { customerId: customer.id, projectId: project?.id ?? null, serviceId: service?.id ?? null })) throw notFound();

  const now = deps.now();
  const { configs, world } = await deps.repo.pagingContext(customer.id);
  const pathIds = { customerId: customer.id, projectId: project?.id ?? null, serviceId: service?.id ?? null };
  const hit = resolvePagingConfig(configs, pathIds);
  const p = pagingPath(configs, pathIds, world, now);
  const path = [...(resource ? [lv('RESOURCE', resource)] : []), ...(service ? [lv('SERVICE', service)] : []), ...(project ? [lv('PROJECT', project)] : []), lv('CUSTOMER', customer)];
  const customerNotified = await deps.repo.notifiedPeople(customer.id, pathIds);
  const base = { path, customer: { id: customer.id, name: customer.name }, customerNotified };
  if (!p || !hit) {
    // Nothing configured anywhere up the chain: say so instead of pretending something is inherited (7-3, 7-5).
    return ok({ ...base, inheritedFrom: null, own: false, style: null, plan: null, edited: false, pagingConfigId: null, version: 0, steps: [], repeatCount: 0, stopAtMin: 0,
      sentence: 'Nobody is paged: no call order is configured for this customer.', warning: 'NO_CALL_ORDER' });
  }
  const from = hit.inheritedFrom === 'SERVICE' ? lv('SERVICE', service!) : hit.inheritedFrom === 'PROJECT' ? lv('PROJECT', project!) : lv('CUSTOMER', customer);
  const asked = service ? 'SERVICE' : project ? 'PROJECT' : 'CUSTOMER';
  const first = hit.config.steps[0];
  return ok({
    ...base, inheritedFrom: from, own: hit.inheritedFrom === asked, style: p.style, plan: p.plan, edited: p.edited, pagingConfigId: p.pagingConfigId, version: p.version,
    ...(p.style === 'SHARED_ROTATION' && first?.targetType === 'ROTATION' && first.targetId ? { sharedRotationId: first.targetId } : {}),
    steps: p.steps.map((s) => {
      const person = s.targetType === 'PERSON' && s.targetId ? world.contacts.get(s.targetId) : undefined;
      const targetName = s.targetType === 'ROTATION' ? world.rotations.get(s.targetId ?? '')?.name : person?.name;
      return { atMin: s.atMin, targetType: s.targetType, ...(s.targetId ? { targetId: s.targetId } : {}), nowIds: s.nowIds, names: s.names, channels: s.channels,
        ...(targetName ? { targetName } : {}), ...(person ? { targetIsCustomerPerson: person.kind === 'CUSTOMER' } : {}) };
    }),
    repeatCount: p.repeatCount, stopAtMin: p.stopAtMin, sentence: p.sentence,
    ...(p.steps.every((s) => s.nowIds.length === 0 && !s.channels.includes('SLACK_CHANNEL')) ? { warning: 'NOBODY_REACHABLE' } : {}),
  });
}
