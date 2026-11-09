/**
 * Paging path resolution (D-30/D-31 revised, DATA-MODEL §5, API-CONTRACT §8.3 paging-path).
 * One function is shared by alert routing, `/oncall/now`, `/oncall/paging-path` and paging health
 * (known-bugs 7-3: inheritance display and routing must be the same function).
 */
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
export interface Responder { customerId: string; contactId: string; role: 'PAGEABLE' | 'NOTIFY_ONLY' }
export interface EscalationStep { index: number; atMin: number; targetType: TargetType; targetId: string | null; channels: StepChannel[] }
export interface PagingConfig {
  id: string;
  customerId: string;
  scopeType: ScopeLevel;
  scopeId: string;
  style: 'ALL_AT_ONCE' | 'CUSTOMER_ROTATION' | 'SHARED_ROTATION' | 'CUSTOM';
  plan: 'STANDARD' | 'URGENT' | 'QUIET';
  edited: boolean;
  repeatCount: number;
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
  const members = [...r.members].sort((a, b) => a.order - b.order);
  const n = members.length;
  const m = n ? members[((index % n) + n) % n] : undefined;
  return { index, start, end: new Date(start.getTime() + len), scheduledContactId: m?.contactId ?? null };
}

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

export interface ResolvedTarget { contactId: string; name: string; via: string }

/** Resolve one step to concrete people at `at`. Invalid or inactive targets drop out (they show in health). */
export function resolveStep(step: EscalationStep, w: PagingWorld, at: Date): ResolvedTarget[] {
  const out = new Map<string, ResolvedTarget>();
  const push = (id: string | null, via: string) => {
    if (!id || out.has(id) || !isPageableFor(w, id)) return;
    out.set(id, { contactId: id, name: w.contacts.get(id)?.name ?? id, via });
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
    // ALL_RESPONDERS: PAGEABLE responders, leave applied (remove absent, add replacement, no dupes).
    for (const r of w.responders) {
      if (r.customerId !== w.customerId || r.role !== 'PAGEABLE') continue;
      const rep = applyLeave(w.leaves, r.contactId, at);
      push(rep, rep === r.contactId ? 'responders' : 'leave');
    }
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
