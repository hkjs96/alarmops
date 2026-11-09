/**
 * Paging health (D-32, API-CONTRACT §8.3 `/customers/{id}/paging-health`). Computed, never stored.
 * UNREACHABLE: no step reaches any verified contact. AT_RISK: some step relies on an unverified contact,
 * a phone channel without a verified phone, or a rotation gap within the horizon (14 days).
 */
import { onCallAt, resolveStep, shiftAt, type PagingConfig, type PagingWorld, type StepChannel, type Contact, isPageableFor } from './paging.js';

export type HealthLevel = 'OK' | 'AT_RISK' | 'UNREACHABLE';
export type ProblemCode = 'NO_PAGEABLE_RESPONDER' | 'NO_VERIFIED_PHONE' | 'STEP_UNVERIFIED_ONLY' | 'ROTATION_GAP';
export interface Problem { code: ProblemCode; stepIndex?: number; contactIds: string[]; rotationId?: string; from?: string; to?: string; message: string }
export interface PagingHealth { level: HealthLevel; problems: Problem[] }

export const HEALTH_HORIZON_DAYS = 14;

/** A contact is reachable on a step channel only via a verified address (notification R9). SLACK_CHANNEL is a channel, not a person. */
export function reachableVia(c: Contact, ch: StepChannel, slackChannelVerified: boolean): boolean {
  switch (ch) {
    case 'SLACK_CHANNEL': return slackChannelVerified;
    case 'SLACK_DM': return !!(c.slackUserId && c.slackVerifiedAt);
    case 'SMS':
    case 'VOICE': return !!(c.phone && c.phoneVerifiedAt);
    case 'EMAIL': return !!(c.email && c.emailVerifiedAt);
  }
}

export function pagingHealth(
  config: PagingConfig | null,
  w: PagingWorld,
  now: Date,
  opts: { slackChannelVerified?: boolean; horizonDays?: number } = {},
): PagingHealth {
  const problems: Problem[] = [];
  const slackOk = opts.slackChannelVerified ?? false;
  const pageable = w.responders.filter((r) => r.customerId === w.customerId && r.role === 'PAGEABLE' && isPageableFor(w, r.contactId));
  if (pageable.length === 0) {
    problems.push({ code: 'NO_PAGEABLE_RESPONDER', contactIds: [], message: 'No pageable responder is set for this customer.' });
  }
  if (!config || config.steps.length === 0) {
    return { level: 'UNREACHABLE', problems: [...problems, { code: 'STEP_UNVERIFIED_ONLY', contactIds: [], message: 'No paging steps are configured.' }] };
  }

  let anyStepReaches = false;
  for (const step of [...config.steps].sort((a, b) => a.index - b.index)) {
    const targets = resolveStep(step, w, now);
    const reached = targets.filter((t) => step.channels.some((ch) => reachableVia(w.contacts.get(t.contactId)!, ch, slackOk)));
    if (reached.length > 0) anyStepReaches = true;
    if (reached.length === 0) {
      problems.push({
        code: 'STEP_UNVERIFIED_ONLY', stepIndex: step.index, contactIds: targets.map((t) => t.contactId),
        message: targets.length ? `Step ${step.index + 1} only reaches unverified contacts.` : `Step ${step.index + 1} reaches nobody.`,
      });
    }
    if (step.channels.some((c) => c === 'SMS' || c === 'VOICE')) {
      const noPhone = targets.filter((t) => !reachableVia(w.contacts.get(t.contactId)!, 'SMS', false)).map((t) => t.contactId);
      if (noPhone.length) problems.push({ code: 'NO_VERIFIED_PHONE', stepIndex: step.index, contactIds: noPhone, message: `Step ${step.index + 1} calls or texts people without a verified phone.` });
    }
    if (step.targetType === 'ROTATION' && step.targetId) {
      const gap = rotationGap(step.targetId, w, now, opts.horizonDays ?? HEALTH_HORIZON_DAYS);
      if (gap) problems.push({ code: 'ROTATION_GAP', stepIndex: step.index, contactIds: [], rotationId: step.targetId, ...gap, message: `Rotation has nobody on call from ${gap.from}.` });
    }
  }
  const level: HealthLevel = !anyStepReaches ? 'UNREACHABLE' : problems.length ? 'AT_RISK' : 'OK';
  return { level, problems };
}

/** First shift within the horizon whose resolved on-call is nobody/not pageable. */
export function rotationGap(rotationId: string, w: PagingWorld, now: Date, days: number): { from: string; to: string } | null {
  const r = w.rotations.get(rotationId);
  if (!r) return { from: now.toISOString(), to: new Date(now.getTime() + days * 86400_000).toISOString() };
  const end = now.getTime() + days * 86400_000;
  // Sample each shift start plus every override/leave boundary (hourly granularity is enough for leaves/overrides).
  for (let t = now.getTime(); t < end; t += 3600_000) {
    const at = new Date(t);
    const oc = onCallAt(r, w, at);
    if (!oc.contactId || !isPageableFor(w, oc.contactId)) {
      const s = shiftAt(r, at);
      return { from: at.toISOString(), to: new Date(Math.min(s.end.getTime(), end)).toISOString() };
    }
  }
  return null;
}

const ORDER: Record<HealthLevel, number> = { UNREACHABLE: 0, AT_RISK: 1, OK: 2 };
/** Customers list default order: red first (D-32). */
export const byHealth = <T extends { pagingHealth: { level: HealthLevel } }>(a: T, b: T): number => ORDER[a.pagingHealth.level] - ORDER[b.pagingHealth.level];
