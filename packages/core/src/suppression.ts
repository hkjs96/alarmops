import { coveringWindow, type MaintenanceTarget, type MaintenanceWindow } from './maintenance.js';
import type { SuppressionPolicy } from './policy.js';
import type { Decision, EventState, EventType, Severity } from './types.js';

/** Per-fingerprint state (Alert row subset, fingerprint F-4). */
export interface FingerprintState {
  lastNotifiedAt: Date | null;
  episodeOpen: boolean;
  episodeStartedAt: Date | null;
  episodeNotified: boolean;
  recentEpisodes: Date[];
  quarantinedUntil: Date | null;
}

export const EMPTY_STATE: Readonly<FingerprintState> = Object.freeze({
  lastNotifiedAt: null, episodeOpen: false, episodeStartedAt: null, episodeNotified: false, recentEpisodes: [], quarantinedUntil: null,
});

/** S-13 reason values. `exempt_sev1` added for the D-17 pass-through so the history shows why maintenance didn't apply. */
export type DecisionReason =
  | 'exempt_sev1' | 'silence' | 'flapping' | 'dedup' | 'auto_pause' | 'cleared' | 'not_actionable'
  | 'state_contention' | 'state_error' | 'auto_pause_expired' | 'notify';

export interface DecisionResult {
  decision: Decision;
  reason: DecisionReason;
  deferSec?: number;
  maintenanceWindowId?: string;
  /** true when this event opens a new episode (FIRING transition). */
  opensEpisode: boolean;
  /** true when this event closes the open episode. */
  closesEpisode: boolean;
}

export interface SuppressionInput {
  eventType: EventType;
  state: EventState;
  previousState: string | null;
  severity: Severity;
  occurredAt: Date;
  target: MaintenanceTarget;
}

const RECENT_CAP = 30;
const ALARMISH = new Set(['ALARM', 'FIRING']);

/** Episodes inside the flapping window, current fire included (S-7: "N번째" counted as N). */
export function recentWithCurrent(st: FingerprintState, at: Date, p: SuppressionPolicy): Date[] {
  const from = at.getTime() - p.flappingWindowDays * 86400_000;
  const set = new Map<number, Date>();
  for (const d of [...st.recentEpisodes, at]) if (d.getTime() > from && d.getTime() <= at.getTime()) set.set(d.getTime(), d);
  return [...set.values()].sort((a, b) => a.getTime() - b.getTime()).slice(-RECENT_CAP);
}

/**
 * Pure suppression decision (suppression S-1..S-10, D-17). `now` is the event's occurredAt (S-4).
 * Order is policy (S-3): SEV-1 exemption → maintenance → flapping → dedup → auto-pause → notify.
 */
export function decide(
  ev: SuppressionInput,
  st: FingerprintState,
  p: SuppressionPolicy,
  windows: MaintenanceWindow[],
): DecisionResult {
  const now = ev.occurredAt;
  const base = { opensEpisode: false, closesEpisode: false };
  if (ev.eventType !== 'STATE_CHANGE') return { ...base, decision: 'SUPPRESS', reason: 'not_actionable' };

  if (ev.state !== 'FIRING') {
    // S-2.2 clearing transition. Webhooks carry no previousState: an open episode stands in for "was ALARM".
    const prev = ev.previousState ?? (st.episodeOpen ? 'ALARM' : null);
    if (prev && ALARMISH.has(prev.toUpperCase()) && st.episodeOpen) {
      return { ...base, closesEpisode: true, decision: st.episodeNotified ? 'NOTIFY' : 'SUPPRESS', reason: 'cleared' };
    }
    return { ...base, decision: 'SUPPRESS', reason: prev && ALARMISH.has(prev.toUpperCase()) ? 'cleared' : 'not_actionable' };
  }

  // Re-sent FIRING of an episode that is still open (Alertmanager/Grafana repeat_interval) is not a transition:
  // it must neither re-page nor un-ack (S-9 sticky ack). Applies to SEV-1 too.
  if (st.episodeOpen) return { ...base, decision: 'SUPPRESS', reason: 'not_actionable' };

  const fire = { ...base, opensEpisode: true };
  if (ev.severity === 'SEV_1') return { ...fire, decision: 'NOTIFY', reason: 'exempt_sev1' }; // D-17, S-3 step 1

  const w = coveringWindow(windows, ev.target, now);
  if (w) return { ...fire, decision: 'SUPPRESS', reason: 'silence', maintenanceWindowId: w.id };

  if (st.quarantinedUntil && now.getTime() < st.quarantinedUntil.getTime()) return { ...fire, decision: 'SUPPRESS', reason: 'flapping' };
  const count = recentWithCurrent(st, now, p).length;
  if (count / p.flappingWindowDays >= p.flappingPerDay) return { ...fire, decision: 'SUPPRESS', reason: 'flapping' };

  if (st.lastNotifiedAt) {
    const elapsed = now.getTime() - st.lastNotifiedAt.getTime();
    if (elapsed >= 0 && elapsed < p.repeatIntervalSec * 1000) return { ...fire, decision: 'SUPPRESS', reason: 'dedup' };
  }

  const pause = p.autoPauseSec[ev.severity] ?? 0;
  if (pause > 0) return { ...fire, decision: 'DEFER', reason: 'auto_pause', deferSec: pause };
  return { ...fire, decision: 'NOTIFY', reason: 'notify' };
}

/** State after the decision (F-4, S-7, S-8). Pure. */
export function nextState(st: FingerprintState, ev: SuppressionInput, r: DecisionResult, p: SuppressionPolicy): FingerprintState {
  const now = ev.occurredAt;
  if (r.closesEpisode) return { ...st, episodeOpen: false };
  if (!r.opensEpisode) return st;
  const alreadyQuarantined = st.quarantinedUntil != null && now.getTime() < st.quarantinedUntil.getTime();
  return {
    lastNotifiedAt: r.decision === 'NOTIFY' ? now : st.lastNotifiedAt,
    episodeOpen: true,
    episodeStartedAt: now,
    episodeNotified: r.decision === 'NOTIFY',
    recentEpisodes: recentWithCurrent(st, now, p),
    quarantinedUntil:
      r.reason === 'flapping' && !alreadyQuarantined ? new Date(now.getTime() + p.flappingQuarantineSec * 1000) : st.quarantinedUntil,
  };
}

/** Fail-open wrapper (S-12): any error → NOTIFY so an alert is never lost. */
export function decideSafe(...args: Parameters<typeof decide>): DecisionResult {
  try {
    return decide(...args);
  } catch {
    return { decision: 'NOTIFY', reason: 'state_error', opensEpisode: args[0].state === 'FIRING', closesEpisode: false };
  }
}

export type AlertStatus = 'FIRING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'INSUFFICIENT_DATA';

/** S-9 sticky ack: FIRING/INSUFFICIENT_DATA never undo ACKNOWLEDGED; RESOLVED always applies. */
export function nextAlertStatus(current: AlertStatus | null, incoming: EventState): AlertStatus {
  if (incoming === 'RESOLVED') return 'RESOLVED';
  if (current === 'ACKNOWLEDGED') return 'ACKNOWLEDGED';
  if (incoming === 'FIRING') return 'FIRING';
  return 'INSUFFICIENT_DATA';
}

/** F-4 TTL rule moved to a judgement: 30 quiet days → treat as first fire (row is kept). */
export const QUIET_RESET_MS = 30 * 86400_000;
export function effectiveState(st: FingerprintState, lastEventAt: Date | null, now: Date): FingerprintState {
  return lastEventAt && now.getTime() - lastEventAt.getTime() >= QUIET_RESET_MS ? { ...EMPTY_STATE, recentEpisodes: [] } : st;
}

/** Group finalize for DEFER members (S-10): still open & same episode → NOTIFY/auto_pause_expired. */
export function finalizeDeferred(st: FingerprintState, occurredAt: Date): { decision: Decision; reason: DecisionReason } {
  if (st.episodeOpen && st.episodeStartedAt && st.episodeStartedAt.getTime() <= occurredAt.getTime()) {
    return { decision: 'NOTIFY', reason: 'auto_pause_expired' };
  }
  return { decision: 'SUPPRESS', reason: 'auto_pause' };
}
