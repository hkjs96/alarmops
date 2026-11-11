/**
 * Paging path resolution (D-30/D-31 revised, DATA-MODEL §5, API-CONTRACT §8.3 paging-path).
 * One function is shared by alert routing, `/oncall/now`, `/oncall/paging-path` and paging health
 * (known-bugs 7-3: inheritance display and routing must be the same function).
 */
import { MAX_ALL_RESPONDERS } from './limits.js';

export type ScopeLevel = 'SERVICE' | 'PROJECT' | 'CUSTOMER';
export type TargetType = 'PERSON' | 'ROTATION' | 'ALL_RESPONDERS';
export type StepChannel = 'SLACK_CHANNEL' | 'SLACK_DM' | 'SMS' | 'VOICE' | 'EMAIL';

export interface Contact {
  id: string;
  kind: 'INTERNAL' | 'CUSTOMER';
  customerId: string | null;
  name: string;
  active: boolean;
  email?: string | null;
  phone?: string | null;
  slackUserId?: string | null;
  emailVerifiedAt?: Date | null;
  phoneVerifiedAt?: Date | null;
  slackVerifiedAt?: Date | null;
}
export interface Responder {
  customerId: string;
  contactId: string;
  role: 'PAGEABLE' | 'NOTIFY_ONLY';
  /**
   * Position in the customer's Responders list, 0 = first (R-19). It decides who an ALL_RESPONDERS step keeps when
   * the list is longer than the limits allow. The store returns responders `ORDER BY "order", "contactId"`; core
   * sorts by the same key again, so the result never depends on the order rows happen to arrive in. A row without
   * `order` sorts after every row that has one.
   */
  order?: number;
}
export interface EscalationStep { index: number; atMin: number; targetType: TargetType; targetId: string | null; channels: StepChannel[]; advanceOnAllFail?: boolean }
export interface PagingConfig {
  id: string;
  customerId: string;
  scopeType: ScopeLevel;
  scopeId: string;
  style: 'ALL_AT_ONCE' | 'CUSTOMER_ROTATION' | 'SHARED_ROTATION' | 'CUSTOM';
  plan: 'STANDARD' | 'URGENT' | 'QUIET';
  edited: boolean;
  repeatCount: number;
  /** Re-notify after ack (seconds). null/undefined → SuppressionPolicy.renotifyAfterSec. 0 = off. */
  renotifyAfterAckSec?: number | null;
  version: number;
  steps: EscalationStep[];
}
export interface Rotation {
  id: string;
  scope: 'MSP' | 'CUSTOMER';
  customerId: string | null;
  name: string;
  cadence: 'DAILY' | 'WEEKLY';
  anchorAt: Date; // start of the shift held by members[0]
  members: Array<{ contactId: string; order: number }>;
}
export interface Override { rotationId: string; contactId: string; startAt: Date; endAt: Date; status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' }
export interface Leave { contactId: string; replacementId: string; startDate: string; endDate: string; cancelledAt?: Date | null } // KST yyyy-mm-dd inclusive

export interface PagingWorld {
  customerId: string;
  contacts: Map<string, Contact>;
  responders: Responder[];
  rotations: Map<string, Rotation>;
  overrides: Override[];
  leaves: Leave[];
}

/** service › project › customer, first existing row wins (no merging). */
export function resolvePagingConfig(
  configs: PagingConfig[],
  path: { customerId: string; projectId?: string | null; serviceId?: string | null },
): { config: PagingConfig; inheritedFrom: ScopeLevel } | null {
  const find = (t: ScopeLevel, id: string | null | undefined) =>
    id ? configs.find((c) => c.scopeType === t && c.scopeId === id && c.customerId === path.customerId) : undefined;
  const s = find('SERVICE', path.serviceId);
  if (s) return { config: s, inheritedFrom: 'SERVICE' };
  const p = find('PROJECT', path.projectId);
  if (p) return { config: p, inheritedFrom: 'PROJECT' };
  const c = find('CUSTOMER', path.customerId);
  return c ? { config: c, inheritedFrom: 'CUSTOMER' } : null;
}

const SHIFT_MS = { DAILY: 86400_000, WEEKLY: 7 * 86400_000 } as const;

/** KST calendar date (Leave dates are KST, inclusive). */
export const kstDate = (at: Date): string => new Date(at.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export function activeLeave(leaves: Leave[], contactId: string, at: Date): Leave | null {
  const d = kstDate(at);
  return leaves.find((l) => !l.cancelledAt && l.contactId === contactId && l.startDate <= d && d <= l.endDate) ?? null;
}

/** Follow leave replacement chains (A→B, B on leave → C), cycle-safe. */
export function applyLeave(leaves: Leave[], contactId: string, at: Date): string {
  let cur = contactId;
  const seen = new Set<string>();
  for (let l = activeLeave(leaves, cur, at); l && !seen.has(cur); l = activeLeave(leaves, cur, at)) {
    seen.add(cur);
    cur = l.replacementId;
  }
  return cur;
}

export interface ShiftInfo { index: number; start: Date; end: Date; scheduledContactId: string | null }

export function shiftAt(r: Rotation, at: Date): ShiftInfo {
  const len = SHIFT_MS[r.cadence];
  const index = Math.floor((at.getTime() - r.anchorAt.getTime()) / len);
  const start = new Date(r.anchorAt.getTime() + index * len);
  const members = [...r.members].sort((a, b) => cmpOrder(a.order, b.order) || (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0));
  const n = members.length;
  const m = n ? members[((index % n) + n) % n] : undefined;
  return { index, start, end: new Date(start.getTime() + len), scheduledContactId: m?.contactId ?? null };
}

/**
 * N-37: an `order` counts only when it is a finite number. NaN, ±Infinity, null, a string or a missing value all
 * mean "no order" and sort after every real one — `NaN - x` is NaN, which made the sort depend on the row order.
 */
export const orderKey = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Infinity);
const cmpOrder = (a: unknown, b: unknown): number => { const x = orderKey(a); const y = orderKey(b); return x < y ? -1 : x > y ? 1 : 0; };

/** On-call = members[shift mod N] → accepted override (latest start wins, R2-3) → active leave (DATA-MODEL §5). */
export function onCallAt(r: Rotation, w: Pick<PagingWorld, 'overrides' | 'leaves'>, at: Date): { contactId: string | null; via: string[] } {
  const via: string[] = [];
  let id = shiftAt(r, at).scheduledContactId;
  if (id) via.push('rotation');
  const ov = w.overrides
    .filter((o) => o.rotationId === r.id && o.status === 'ACCEPTED' && o.startAt.getTime() <= at.getTime() && at.getTime() < o.endAt.getTime())
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime())[0];
  if (ov) { id = ov.contactId; via.push('override'); }
  if (id) {
    const rep = applyLeave(w.leaves, id, at);
    if (rep !== id) { id = rep; via.push('leave'); }
  }
  return { contactId: id, via };
}

/** Is this contact allowed as a pager target for this customer? CUSTOMER contacts only in their own customer, PAGEABLE only. */
export function isPageableFor(w: PagingWorld, contactId: string): boolean {
  const c = w.contacts.get(contactId);
  if (!c || !c.active) return false;
  if (c.kind === 'CUSTOMER') {
    if (c.customerId !== w.customerId) return false;
    return w.responders.some((r) => r.customerId === w.customerId && r.contactId === contactId && r.role === 'PAGEABLE');
  }
  return true;
}

/** `kind` lets a serializer tell MSP staff from the customer's own people without another lookup (absent = treat as staff). */
export interface ResolvedTarget {
  contactId: string; name: string; via: string; kind?: 'INTERNAL' | 'CUSTOMER';
  /**
   * ALL_RESPONDERS only: this person is on shift in one of the customer's rotations right now. Kept before everyone
   * else (R-19) — up to MAX_ALL_RESPONDERS; with more people on shift than that, the last ones in Responder order
   * are cut like anyone else and reported as such.
   */
  onShift?: true;
}

/**
 * Everyone an ALL_RESPONDERS step would reach at `at`, in the order the limits cut from the END of (R-19):
 * people on shift now (in any rotation this customer can use) first, then `Responder.order`, then contactId.
 * PAGEABLE responders only, leave applied (absent person out, replacement in, no duplicates). `kept` is the first
 * MAX_ALL_RESPONDERS; `cut` is who the limit leaves out — reported, never silent. When MORE than MAX_ALL_RESPONDERS
 * people are on shift, `cut` contains on-shift people (they keep their `onShift` mark so the note can say so).
 */
export function allResponders(w: PagingWorld, at: Date): { kept: ResolvedTarget[]; cut: ResolvedTarget[] } {
  const onShift = new Set<string>();
  for (const r of w.rotations.values()) {
    if (r.scope !== 'MSP' && r.customerId !== w.customerId) continue;
    const id = onCallAt(r, w, at).contactId;
    if (id) onShift.add(id);
  }
  const listed = w.responders
    .filter((r) => r.customerId === w.customerId && r.role === 'PAGEABLE')
    .sort((a, b) => cmpOrder(a.order, b.order) || (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0));
  const out = new Map<string, ResolvedTarget>();
  for (const r of listed) {
    const id = applyLeave(w.leaves, r.contactId, at);
    if (out.has(id) || !isPageableFor(w, id)) continue;
    const c = w.contacts.get(id);
    out.set(id, { contactId: id, name: c?.name ?? id, via: id === r.contactId ? 'responders' : 'leave', kind: c?.kind ?? 'INTERNAL', ...(onShift.has(id) ? { onShift: true as const } : {}) });
  }
  const all = [...out.values()];
  const ordered = [...all.filter((t) => t.onShift), ...all.filter((t) => !t.onShift)];
  return { kept: ordered.slice(0, MAX_ALL_RESPONDERS), cut: ordered.slice(MAX_ALL_RESPONDERS) };
}

/** Resolve one step to concrete people at `at`. Invalid or inactive targets drop out (they show in health). */
export function resolveStep(step: EscalationStep, w: PagingWorld, at: Date): ResolvedTarget[] {
  const out = new Map<string, ResolvedTarget>();
  const push = (id: string | null, via: string) => {
    if (!id || out.has(id) || !isPageableFor(w, id)) return;
    const c = w.contacts.get(id);
    out.set(id, { contactId: id, name: c?.name ?? id, via, kind: c?.kind ?? 'INTERNAL' });
  };
  if (step.targetType === 'PERSON') {
    if (step.targetId) {
      const rep = applyLeave(w.leaves, step.targetId, at);
      push(rep, rep === step.targetId ? 'person' : 'leave');
    }
  } else if (step.targetType === 'ROTATION') {
    const r = step.targetId ? w.rotations.get(step.targetId) : undefined;
    const rotationAllowed = r && (r.scope === 'MSP' || r.customerId === w.customerId);
    if (r && rotationAllowed) {
      const oc = onCallAt(r, w, at);
      push(oc.contactId, oc.via.join('+'));
    }
  } else {
    // ALL_RESPONDERS: cut at MAX_ALL_RESPONDERS (R-1) — the API refuses to save such a step, this covers people
    // added afterwards. Who stays is decided by `allResponders` (R-19), not by the order of the rows.
    return allResponders(w, at).kept;
  }
  return [...out.values()];
}

export interface PagingPath {
  pagingConfigId: string;
  inheritedFrom: ScopeLevel;
  style: PagingConfig['style'];
  plan: PagingConfig['plan'];
  edited: boolean;
  version: number;
  repeatCount: number;
  steps: Array<{ index: number; atMin: number; targetType: TargetType; targetId: string | null; nowIds: string[]; names: string[]; channels: StepChannel[] }>;
  stopAtMin: number;
  sentence: string;
}

/** The `/oncall/paging-path` body core. Returns null when nothing is configured (R1-9-style "nobody", known-bugs 7-3). */
export function pagingPath(
  configs: PagingConfig[],
  path: { customerId: string; projectId?: string | null; serviceId?: string | null },
  w: PagingWorld,
  at: Date,
): PagingPath | null {
  const hit = resolvePagingConfig(configs, path);
  if (!hit) return null;
  const steps = [...hit.config.steps].sort((a, b) => a.index - b.index).map((s) => {
    const t = resolveStep(s, w, at);
    return { index: s.index, atMin: s.atMin, targetType: s.targetType, targetId: s.targetId, nowIds: t.map((x) => x.contactId), names: t.map((x) => x.name), channels: s.channels };
  });
  const stopAtMin = steps.length ? Math.max(...steps.map((s) => s.atMin)) : 0;
  return {
    pagingConfigId: hit.config.id, inheritedFrom: hit.inheritedFrom, style: hit.config.style, plan: hit.config.plan,
    edited: hit.config.edited, version: hit.config.version, repeatCount: hit.config.repeatCount, steps, stopAtMin,
    sentence: sentence(steps, hit.config.repeatCount),
  };
}

const CH: Record<StepChannel, string> = { SLACK_CHANNEL: 'Slack', SLACK_DM: 'Slack DM', SMS: 'SMS', VOICE: 'call', EMAIL: 'email' };

/** Real-name preview sentence (D-28 kept, D-30). English UI (D-01). */
export function sentence(steps: PagingPath['steps'], repeatCount: number): string {
  if (!steps.length) return 'Nobody is paged: no paging steps are configured.';
  const parts = steps.map((s) => {
    const who = s.names.length ? joinNames(s.names) : 'nobody (no reachable responder)';
    const how = s.channels.map((c) => CH[c]).join(' + ') || 'no channel';
    return `${s.atMin === 0 ? 'Immediately' : `At ${s.atMin} min`}, ${how} ${who}`;
  });
  const rep = repeatCount > 0 ? ` Then repeat ${repeatCount === 1 ? 'once' : `${repeatCount} times`}.` : '';
  return `${parts.join('. ')}.${rep}`;
}
const joinNames = (n: string[]) => (n.length <= 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);

/** Step-start templates (DATA-MODEL §5 EscalationStep, code constants). P = first target. */
export function templateSteps(plan: PagingConfig['plan'], first: { targetType: TargetType; targetId: string | null }, allAtOnce: boolean): EscalationStep[] {
  const P = first;
  const ALL = { targetType: 'ALL_RESPONDERS' as const, targetId: null };
  const raw: Array<[number, StepChannel, { targetType: TargetType; targetId: string | null }]> =
    plan === 'STANDARD' ? [[0, 'SLACK_CHANNEL', P], [2, 'SMS', P], [7, 'VOICE', P], [12, 'VOICE', ALL]]
      : plan === 'URGENT' ? [[0, 'VOICE', P], [5, 'VOICE', ALL]]
        : [[0, 'SLACK_CHANNEL', P], [15, 'SLACK_CHANNEL', ALL]];
  const list = allAtOnce ? raw.slice(0, -1) : raw;
  return list.map(([atMin, ch, t], index) => ({ index, atMin, targetType: t.targetType, targetId: t.targetId, channels: [ch] }));
}
