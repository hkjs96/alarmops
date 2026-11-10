/**
 * One serializer per audience (security review Q-1, R-4). Everything an incident response says about PEOPLE,
 * call-order internals and delivery details goes through here, so "what may a portal user see" is this file:
 *
 * - INTERNAL (MSP staff): everything, as before.
 * - Portal (customer) users: no internal identifier at all — contactId, userId, rotation id/name, pagingConfigId,
 *   provider message id, provider error text, Slack channel ownership. MSP staff are shown as "MSP on-call" unless
 *   `portalShowsStaffNames` (pending decision; default PORTAL_SHOWS_STAFF_NAMES = false). The customer's own
 *   people keep their names. Timeline lines are rebuilt from the event's structured data, never copied from the
 *   internal sentence, so a name that is only in free text cannot leak (anything unknown is treated as staff).
 */
import {
  PORTAL_SHOWS_STAFF_NAMES, STAFF_ALIAS, allowOnlyIfTrue, loadPolicyFlags, nextStep, type AssignmentSnapshot, type DeliveryLog, type IncidentEventInput, type IncidentRow,
  type ResolvedTarget, type SnapshotStep, type StepChannel,
} from '@alarmops/core';
import { hasRole, type AuthContext } from './auth.js';

export interface ApiConfig {
  /** Pending decision Q-1. false → portal users read "MSP on-call" instead of a staff member's name. */
  portalShowsStaffNames: boolean;
}
export const DEFAULT_API_CONFIG: ApiConfig = { portalShowsStaffNames: PORTAL_SHOWS_STAFF_NAMES };

/**
 * ApiConfig from an env-like record (R-15). The adapter calls `loadApiConfig(process.env)` and passes the result
 * to `createApi`; env strings are never passed as flags. 'false', '0', a typo or an object all leave the safe
 * default in place (typos come back as warnings).
 */
export function loadApiConfig(env: Record<string, unknown> = {}): { config: ApiConfig; warnings: string[] } {
  const { flags, warnings } = loadPolicyFlags(env);
  return { config: { portalShowsStaffNames: flags.portalShowsStaffNames }, warnings };
}
/** Whatever was handed to createApi → a config whose flags are real booleans; only `true` switches a name on. */
export const strictApiConfig = (c: { portalShowsStaffNames?: unknown } | undefined): ApiConfig => ({ portalShowsStaffNames: allowOnlyIfTrue(c?.portalShowsStaffNames) });

export interface UserInfo { name: string; kind: 'INTERNAL' | 'CUSTOMER'; customerId: string | null }

type Event = IncidentEventInput & { id: string };
export interface EventCtx { incident: Pick<IncidentRow, 'customerId' | 'assignmentSnapshot'>; snapshot: AssignmentSnapshot | null; users: Map<string, UserInfo> }

export interface IncidentSerializer {
  readonly internal: boolean;
  assignee(t: ResolvedTarget): Record<string, unknown>;
  /** acknowledgedBy / resolvedBy (a session user id). */
  user(userId: string | null, ctx: EventCtx): Record<string, unknown> | null;
  snapshot(snap: AssignmentSnapshot): Record<string, unknown>;
  nextLabel(inc: IncidentRow, internalLabel: string | null): string | null;
  eventMessage(e: Event, ctx: EventCtx): string;
  event(e: Event, ctx: EventCtx): Record<string, unknown>;
  notification(l: DeliveryLog & { id: string }): Record<string, unknown>;
}

const CH: Record<StepChannel, string> = { SLACK_CHANNEL: 'Slack', SLACK_DM: 'Slack DM', SMS: 'SMS', VOICE: 'call', EMAIL: 'email' };
const how = (channels: unknown): string => (Array.isArray(channels) ? channels.map((c) => CH[c as StepChannel]).filter(Boolean).join(' + ') : '') || 'page';

const internalSerializer: IncidentSerializer = {
  internal: true,
  assignee: (t) => ({ contactId: t.contactId, name: t.name, via: t.via }),
  user: (id, ctx) => (id ? { contactId: id, name: ctx.users.get(id)?.name ?? id } : null),
  snapshot: (snap) => ({
    capturedAt: snap.capturedAt, pagingConfigId: snap.pagingConfigId, planLabel: snap.planLabel, level: snap.level, repeatCount: snap.repeatCount,
    steps: snap.steps.map((s) => ({
      index: s.index, atMin: s.atMin, targetType: s.targetType, ...(s.targetId ? { targetId: s.targetId } : {}),
      resolved: s.resolved.map((r) => ({ contactId: r.contactId, name: r.name, via: r.via })), channels: s.channels, ...(s.label ? { label: s.label } : {}),
    })),
  }),
  nextLabel: (_inc, label) => label,
  eventMessage: (e) => e.message,
  event: (e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, actorType: e.actorType, actorId: e.actorId, message: e.message }),
  notification: (l) => ({
    id: l.id, at: l.at.toISOString(), channel: l.channel, status: l.status, targetSummary: l.targetSummary, escalationStep: l.escalationStep,
    reason: l.errorCode ?? null, error: l.error, providerMessageId: l.providerMessageId, attempt: l.attempt, warnings: l.warnings,
  }),
};

function portalSerializer(showStaffNames: boolean): IncidentSerializer {
  const staff = (name: string | undefined): string => (showStaffNames && name ? name : STAFF_ALIAS);
  const target = (t: ResolvedTarget | undefined): string => (t && t.kind === 'CUSTOMER' ? t.name : staff(t?.name));
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  const names = (s: SnapshotStep): string[] => uniq(s.resolved.map(target));
  const who = (ids: unknown, snap: AssignmentSnapshot | null): string => {
    const byId = new Map((snap?.steps ?? []).flatMap((s) => s.resolved.map((r) => [r.contactId, r] as const)));
    const list = uniq((Array.isArray(ids) ? ids : []).map((id) => target(byId.get(String(id)))));
    return list.length ? list.join(', ') : 'nobody (no reachable responder)';
  };
  const userName = (id: string | null, ctx: EventCtx): string => {
    const u = id ? ctx.users.get(id) : undefined;
    // The customer's own person keeps the name; everyone else (and anyone we cannot place) is MSP staff.
    return u && u.kind === 'CUSTOMER' && u.customerId != null && u.customerId === ctx.incident.customerId ? u.name : staff(u?.name);
  };
  const actor = (e: Event, ctx: EventCtx): string =>
    e.actorType === 'USER' ? userName(e.actorId, ctx) : e.actorType === 'CONTACT' ? who([e.actorId], ctx.snapshot) : 'the system';
  const stepLabel = (s: SnapshotStep): string => (s.targetType === 'ALL_RESPONDERS' && s.label ? s.label : names(s).join(', ') || 'nobody');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

  const eventMessage = (e: Event, ctx: EventCtx): string => {
    const d = e.data ?? {};
    switch (e.kind) {
      // System sentences without people in them: alert titles and counts only.
      case 'TRIGGERED': case 'MERGED': return e.actorType === 'SYSTEM' ? e.message : 'Incident updated.';
      case 'ACKED': return `Acknowledged by ${actor(e, ctx)}. Paging stopped.`;
      case 'RESOLVED': return e.actorType === 'SYSTEM' ? 'Resolved automatically: every alert in this incident has cleared.' : `Resolved by ${actor(e, ctx)}.`;
      case 'NOTIFIED': case 'ESCALATED': {
        const i = num(d.stepIndex);
        if (i == null) return 'A paging step was sent.';
        const rep = num(d.repeat) ?? 0;
        const pos = `step ${i + 1}${rep > 0 ? ` (repeat ${rep})` : ''}`;
        const to = `${how(d.channels)} ${who(d.contactIds, ctx.snapshot)}`;
        if (d.manual === true) return `Escalated manually by ${actor(e, ctx)} → ${pos}: ${to}.`;
        return e.kind === 'NOTIFIED' ? `Paged ${pos}: ${to}.` : `No acknowledgement → ${pos}: ${to}.`;
      }
      case 'RENOTIFIED': return `Still unresolved → reminder ${num(d.renotifyCount) ?? ''}: ${who(d.contactIds, ctx.snapshot)}.`.replace('reminder :', 'reminder:');
      case 'NOTE':
        if (d.note === 'PAGING_ORDER') return ctx.snapshot ? `Paging steps at open: ${ctx.snapshot.steps.map(stepLabel).join(' → ')}` : 'Paging steps were set at open.';
        if (d.note === 'NO_OWNER') return 'Nobody is paged: no call order applies to this incident.';
        if (d.note === 'UNDO_ACK') return `Acknowledgement undone by ${actor(e, ctx)}. Paging continues.`;
        if (d.note === 'UNDO_RESOLVE') return `Resolve undone by ${actor(e, ctx)}.`;
        if (d.note === 'DEFERRED_MAINTENANCE') return 'A page is held until the maintenance window ends.';
        if (d.note === 'SEND_CAP_CLAMPED') return 'A send limit was applied to the paging steps of this incident.';
        if (d.note === 'SKIPPED_UNVERIFIED') return `Step ${(num(d.stepIndex) ?? 0) + 1}: ${how([d.channel])} to ${who([d.contactId], ctx.snapshot)} was not sent — the phone number is not verified.`;
        return 'Note added.';
      case 'MUTED': return 'Paging is muted by a maintenance window.';
      case 'SUPPRESSED': return 'A notification was suppressed.';
      case 'REMEDIATION': return 'A remediation step was recorded.';
      default: return 'Incident updated.';
    }
  };

  return {
    internal: false,
    assignee: (t) => ({ name: target(t) }),
    user: (id, ctx) => (id ? { name: userName(id, ctx) } : null),
    snapshot: (snap) => ({
      capturedAt: snap.capturedAt, planLabel: snap.planLabel, level: snap.level, repeatCount: snap.repeatCount,
      steps: snap.steps.map((s) => ({
        index: s.index, atMin: s.atMin, targetType: s.targetType, resolved: names(s).map((name) => ({ name })), channels: s.channels,
        ...(s.targetType === 'ALL_RESPONDERS' && s.label ? { label: s.label } : {}),
      })),
    }),
    nextLabel: (inc, label) => {
      if (!label) return null;
      const next = nextStep(inc);
      const s = next ? inc.assignmentSnapshot?.steps[next.index] : undefined;
      return next && s ? `Step ${next.index + 1} · ${how(s.channels)} ${names(s).join(', ') || 'nobody (no reachable responder)'}` : null;
    },
    eventMessage,
    // actorId is a user/contact id: never sent. actorType stays (USER / SYSTEM tells who acted in general terms).
    event: (e, ctx) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, actorType: e.actorType, actorId: null, message: eventMessage(e, ctx) }),
    notification: (l) => ({
      id: l.id, at: l.at.toISOString(), channel: l.channel, status: l.status,
      // A person of the customer by name; staff by alias (or name); channels without saying whose channel it is.
      targetSummary: l.targetKind === 'CUSTOMER_PERSON' ? l.targetSummary : l.targetKind === 'STAFF' ? staff(l.targetSummary) : l.targetKind === 'CUSTOMER_CHANNEL' || l.targetKind === 'MSP_CHANNEL' ? 'Slack channel' : STAFF_ALIAS,
      escalationStep: l.escalationStep, reason: l.errorCode ?? null, attempt: l.attempt,
    }),
  };
}

const PORTAL_ALIAS = portalSerializer(false);
const PORTAL_NAMES = portalSerializer(true);

/**
 * Internal VIEWER (R-13, D-35): everything staff see EXCEPT the provider's own words. The sanitiser is a second
 * line, not a licence — provider text (`error`) is for OPERATOR and ADMIN. `reason` (the mapped code) stays.
 */
const INTERNAL_VIEWER: IncidentSerializer = {
  ...internalSerializer,
  notification: (l) => ({ ...internalSerializer.notification(l), error: null }),
};

/**
 * Fail closed: only kind === 'INTERNAL' gets an internal serializer, only OPERATOR+ the one with provider text,
 * and only the boolean `true` shows staff names to the portal (R-15: the string 'false' is not true).
 */
export const serializerFor = (auth: Pick<AuthContext, 'kind'> & { role?: unknown }, cfg: ApiConfig = DEFAULT_API_CONFIG): IncidentSerializer =>
  auth.kind === 'INTERNAL' ? (hasRole(auth, 'OPERATOR') ? internalSerializer : INTERNAL_VIEWER) : cfg.portalShowsStaffNames === true ? PORTAL_NAMES : PORTAL_ALIAS;
