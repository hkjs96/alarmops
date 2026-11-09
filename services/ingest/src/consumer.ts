import {
  assignGroup, decide, effectiveState, entersGroup, groupId, groupKey, nextAlertStatus, nextState,
  type DecisionResult, type FingerprintState, type NormalizedEvent,
} from '@alarmops/core';
import type { AlertEventsMessage, AlertRepository, AlertRow, QueueSender } from './ports.js';
import { messageAttributes } from './sqs.js';

/** Minimal SQS event shapes (partial batch response enabled on the event source mapping). */
export interface SqsRecord { messageId: string; body: string }
export interface SqsEvent { Records: SqsRecord[] }
export interface SqsBatchResponse { batchItemFailures: Array<{ itemIdentifier: string }> }

export type ProcessOutcome =
  | { kind: 'DUPLICATE' }
  | { kind: 'PROCESSED'; alertId: string; decision: DecisionResult['decision']; reason: string; groupId: string | null; openedGroup: boolean }
  | { kind: 'GROUP_CLOSED'; closed: boolean };

export interface ConsumerDeps {
  repo: AlertRepository;
  queue: QueueSender;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

const MAX_VERSION_RETRIES = 3;

/**
 * alert-consumer λ (API-CONTRACT §3 processing order):
 * RawEvent INSERT (ON CONFLICT dedupKey → stop) → Alert upsert (COALESCE) → suppression (S-3, D-17)
 * → decision recorded → NOTIFY/DEFER join or open the axis group (G-2, G-3).
 * Incident open/merge, finalize and escalation run in the 1-minute tick (apps/console), not here.
 * Failures are fail-open (S-12): state contention → NOTIFY/state_contention.
 */
export async function processMessage(msg: AlertEventsMessage, deps: ConsumerDeps): Promise<ProcessOutcome> {
  if ('type' in msg && msg.type === 'GROUP_CLOSE') {
    return { kind: 'GROUP_CLOSED', closed: await deps.repo.closeGroup(msg.groupId, deps.now?.() ?? new Date()) };
  }
  const ev = msg as NormalizedEvent;
  if (ev.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion ${String((ev as { schemaVersion?: unknown }).schemaVersion)}`);
  const occurredAt = new Date(ev.occurredAt);
  const wallNow = deps.now?.() ?? new Date();

  // 1. Alert row (create or re-read on conflict), needed for RawEvent.alertId.
  let alert = await deps.repo.findAlert(ev.fingerprint);
  if (!alert) {
    const created = await deps.repo.createAlert(freshAlert(ev, occurredAt));
    alert = created === 'EXISTS' ? await deps.repo.findAlert(ev.fingerprint) : created;
    if (!alert) throw new Error('alert vanished after create conflict');
  }

  // 2. RawEvent once (F-3). Duplicate delivery changes nothing.
  const raw = await deps.repo.insertRawEvent(ev, alert.id);
  if (raw === 'DUPLICATE') return { kind: 'DUPLICATE' };

  // 3. Decide + conditional state write, re-deciding on version conflict (F-4).
  const policy = await deps.repo.loadPolicy();
  const windows = await deps.repo.activeMaintenance(ev.customerId, occurredAt);
  let result: DecisionResult | null = null;
  for (let attempt = 0; attempt < MAX_VERSION_RETRIES && !result; attempt++) {
    if (attempt > 0) alert = (await deps.repo.findAlert(ev.fingerprint)) ?? alert;
    const st = effectiveState(alert, alert.lastEventAt, occurredAt);
    const r = decide(
      { eventType: ev.eventType, state: ev.state, previousState: ev.previousState, severity: ev.severity, occurredAt,
        target: { customerId: ev.customerId, awsAccountId: ev.awsAccountId, resourceType: ev.resource?.type ?? null, alertId: alert.id } },
      st, policy, windows,
    );
    const next = applyEvent(alert, ev, occurredAt, nextState(st, toSupInput(ev, occurredAt), r, policy), r);
    const written = await deps.repo.updateAlert(next, alert.version);
    if (written !== 'CONFLICT') { alert = written; result = r; }
  }
  if (!result) {
    deps.log?.('warn', 'state_contention', { fingerprint: ev.fingerprint });
    result = { decision: 'NOTIFY', reason: 'state_contention', opensEpisode: ev.state === 'FIRING', closesEpisode: false };
  }

  // 4. Group (NOTIFY/DEFER state changes only).
  let gid: string | null = null;
  let opened = false;
  if (ev.eventType === 'STATE_CHANGE' && ev.state === 'FIRING' && entersGroup(result.decision)) {
    const key = groupKey(ev);
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES && !gid; attempt++) {
      const open = await deps.repo.findOpenGroup(key);
      const takenIds = new Set<string>();
      for (const c of candidateIds(key, wallNow)) if (await deps.repo.groupIdExists(c)) takenIds.add(c);
      const a = assignGroup(open, key, { customerId: ev.customerId, severity: ev.severity, wallNow, policy, idTaken: (id) => takenIds.has(id) });
      if (a.action === 'JOIN') { gid = a.groupId; break; }
      const g = await deps.repo.createGroup(a.group, a.staleReplaced);
      if (g === 'EXISTS') continue; // someone else opened the axis group first → re-read and join
      gid = g.id;
      opened = true;
      // Q-API-04 proposal: delayed close so group_wait 30s holds despite the 1-minute tick (tick is the safety net).
      await deps.queue.send([{ id: 'close', body: { type: 'GROUP_CLOSE', schemaVersion: 1, groupId: g.id, groupKey: key },
        attributes: messageAttributes(ev.customerId, 'GROUP_CLOSE'), delaySec: Math.min(900, g.groupWaitSec) }]);
    }
  }

  await deps.repo.setRawEventDecision(raw.id, { decision: result.decision, decisionReason: result.reason, groupId: gid });
  return { kind: 'PROCESSED', alertId: alert.id, decision: result.decision, reason: result.reason, groupId: gid, openedGroup: opened };
}

/** Lambda entry: one failing record does not fail the batch (partial batch response → retry/DLQ). */
export function makeConsumerHandler(deps: ConsumerDeps) {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const failures: SqsBatchResponse['batchItemFailures'] = [];
    for (const rec of event.Records) {
      try {
        await processMessage(JSON.parse(rec.body) as AlertEventsMessage, deps);
      } catch (err) {
        deps.log?.('error', 'record_failed', { messageId: rec.messageId, error: String(err) });
        failures.push({ itemIdentifier: rec.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

function toSupInput(ev: NormalizedEvent, occurredAt: Date) {
  return { eventType: ev.eventType, state: ev.state, previousState: ev.previousState, severity: ev.severity, occurredAt, target: { customerId: ev.customerId } };
}

function candidateIds(key: string, now: Date): string[] {
  // assignGroup tries the current second and up to +5s; pre-check those for same-second reopen (G-4).
  const base = Math.floor(now.getTime() / 1000) * 1000;
  return [0, 1, 2, 3, 4, 5].map((s) => groupId(key, new Date(base + s * 1000)));
}

function freshAlert(ev: NormalizedEvent, at: Date): AlertRow {
  return {
    id: newAlertId(), fingerprint: ev.fingerprint, fingerprintVersion: ev.fingerprintVersion,
    customerId: ev.customerId, sourceId: ev.sourceId, source: ev.source, awsAccountId: ev.awsAccountId, region: ev.region,
    resourceType: ev.resource?.type ?? null, metricKey: ev.metric?.key ?? null, namespace: ev.metric?.namespace ?? null,
    title: ev.title, status: ev.state === 'FIRING' ? 'FIRING' : ev.state, severity: ev.severity, severityRaw: ev.severityRaw,
    value: ev.metric?.value ?? null, threshold: ev.metric?.threshold ?? null, comparison: ev.metric?.comparison ?? null,
    lastNotifiedAt: null, episodeOpen: false, episodeStartedAt: null, episodeNotified: false, recentEpisodes: [], quarantinedUntil: null,
    fireCount: 0, firstSeenAt: at, lastEventAt: at, version: 0,
  };
}

/**
 * COALESCE update (known-bugs 1-5): a sparse follow-up never nulls known fields; severity is only replaced
 * when the event carries a real value (V-6 / fd67c37). Status follows sticky ack (S-9).
 */
export function applyEvent(a: AlertRow, ev: NormalizedEvent, at: Date, st: FingerprintState, r: DecisionResult): AlertRow {
  const keepSeverity = ev.source !== 'CLOUDWATCH' && ev.severityRaw == null;
  return {
    ...a,
    lastNotifiedAt: st.lastNotifiedAt, episodeOpen: st.episodeOpen, episodeStartedAt: st.episodeStartedAt,
    episodeNotified: st.episodeNotified, recentEpisodes: st.recentEpisodes, quarantinedUntil: st.quarantinedUntil,
    customerId: a.customerId ?? ev.customerId,
    region: ev.region ?? a.region,
    resourceType: ev.resource?.type ?? a.resourceType,
    metricKey: ev.metric?.key ?? a.metricKey,
    namespace: ev.metric?.namespace ?? a.namespace,
    value: ev.metric?.value ?? a.value,
    threshold: ev.metric?.threshold ?? a.threshold,
    comparison: ev.metric?.comparison ?? a.comparison,
    title: ev.title || a.title,
    severity: keepSeverity ? a.severity : ev.severity,
    severityRaw: keepSeverity ? a.severityRaw : ev.severityRaw ?? a.severityRaw,
    status: ev.eventType === 'STATE_CHANGE' ? nextAlertStatus(a.status, ev.state) : a.status,
    fireCount: a.fireCount + (r.opensEpisode ? 1 : 0),
    lastEventAt: at.getTime() > a.lastEventAt.getTime() ? at : a.lastEventAt,
  };
}

function newAlertId(): string {
  return `al_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
