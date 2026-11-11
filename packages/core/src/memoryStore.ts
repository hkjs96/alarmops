/**
 * In-memory TickRepository with the same conflict semantics as the Postgres schema: version-checked updates,
 * one merge target per axis, outbox idempotencyKey unique, tick minute claimed once. Tests and local runs only.
 */
import type { NotificationIntent } from './escalation.js';
import type { GroupRow } from './grouping.js';
import type { IncidentRow } from './incident.js';
import type { MaintenanceWindow } from './maintenance.js';
import { CLAIM_LEASE_SEC, CLOCK_SKEW_LIMIT_MS, RELEASE_HOLD_MAX_SEC } from './limits.js';
import { LANE_CHANNELS, MAX_ATTEMPTS, retryAt, sanitizeProviderError, selectForClaim, type DeliveryLog, type DeliveryReason, type NotificationJob, type SenderKind } from './notify.js';
import type { Contact, Leave, Override, PagingConfig, PagingWorld, Responder, Rotation } from './paging.js';
import { DEFAULT_POLICY, type SuppressionPolicy } from './policy.js';
import type {
  AuditInput, GroupDeliveryCommit, GroupMember, HeartbeatRow, HeartbeatWrite, IncidentCommit, IncidentEventInput, ResolutionInput, TickRepository,
} from './tick.js';

export interface OrgCustomer { id: string; name: string; slug: string }
export interface OrgProject { id: string; customerId: string; name: string; slug: string }
export interface OrgService { id: string; customerId: string; projectId: string; name: string; slug: string }
export interface OrgAccount { awsAccountId: string; customerId: string; serviceId: string | null }

export class MemoryTickStore implements TickRepository {
  policy: SuppressionPolicy = { ...DEFAULT_POLICY };
  // org
  customers = new Map<string, OrgCustomer>();
  projects = new Map<string, OrgProject>();
  services = new Map<string, OrgService>();
  accounts = new Map<string, OrgAccount>();
  // paging
  contacts = new Map<string, Contact>();
  responders: Responder[] = [];
  rotations = new Map<string, Rotation>();
  overrides: Override[] = [];
  leaves: Leave[] = [];
  configs: PagingConfig[] = [];
  windows: MaintenanceWindow[] = [];
  /** `customer:<id>` → Slack channel ids; `msp` → MSP default channel. */
  slackChannels = new Map<string, string[]>();
  // alert pipeline
  groups = new Map<string, GroupRow>();
  members = new Map<string, GroupMember[]>();
  /** alertId → episode open (Alert.episodeOpen). */
  episodes = new Map<string, boolean>();
  /** alertId → acknowledged through its incident (D-24). */
  alertAcked = new Map<string, boolean>();
  incidents = new Map<string, IncidentRow>();
  incidentMembers = new Map<string, Map<string, { alertId: string; eventCount: number }>>();
  events: Array<IncidentEventInput & { id: string }> = [];
  jobs = new Map<string, NotificationJob>();
  logs: Array<DeliveryLog & { id: string }> = [];
  resolutions: ResolutionInput[] = [];
  audits: AuditInput[] = [];
  heartbeats = new Map<string, HeartbeatRow>();
  ticks = new Set<string>();
  /**
   * The store's OWN clock (R-14) — what `now()` is for the SQL adapter. Every outbox decision (due, lease, retry
   * time) reads it; the runner's clock is never asked. Tests and simulations point it at their simulated time.
   */
  get clock(): () => Date { return this.ownClock ?? (() => new Date()); }
  set clock(fn: () => Date) { this.ownClock = fn; }
  /** null until `clock` is set: such a store has no clock of its own for the tick's skew check (`now()` → null). */
  protected ownClock: (() => Date) | null = null;
  /** Test hooks. */
  dedupeTicks = true;
  failIncidents = new Set<string>();
  failGroups = new Set<string>();
  protected seq = 0;
  protected incidentSeq = 0;
  protected nextId(p: string): string { return `${p}_${++this.seq}`; }

  async now(): Promise<Date | null> { return this.ownClock ? this.ownClock() : null; }
  async claimTick(key: string, at?: Date): Promise<boolean | 'CLOCK_SKEW'> {
    // Same rule as the SQL store: a runner whose clock is far from the store's does not get the minute (R-2).
    if (this.ownClock && at && Math.abs(at.getTime() - this.ownClock().getTime()) > CLOCK_SKEW_LIMIT_MS) return 'CLOCK_SKEW';
    if (!this.dedupeTicks) return true;
    if (this.ticks.has(key)) return false;
    this.ticks.add(key);
    return true;
  }
  /** Tick claims older than two days (by the store clock). Subclasses add their own expired rows. */
  async purgeExpired(): Promise<number> {
    const before = this.clock().getTime() - 2 * 86_400_000;
    let n = 0;
    for (const k of this.ticks) if (new Date(k.replace(/Z$/, ':00Z')).getTime() < before) { this.ticks.delete(k); n++; }
    return n;
  }
  async loadPolicy() { return this.policy; }

  /** A "due" list never looks past the store's own now (R-2). */
  protected dueLimit(now: Date): number { return this.ownClock ? Math.min(now.getTime(), this.ownClock().getTime()) : now.getTime(); }
  async listGroupsToClose(asked: Date, limit: number) {
    const now = new Date(this.dueLimit(asked));
    return [...this.groups.values()].filter((g) => g.status === 'OPEN' && g.closeAt.getTime() <= now.getTime())
      .sort((a, b) => a.closeAt.getTime() - b.closeAt.getTime()).slice(0, limit).map((g) => structuredClone(g));
  }
  async closeGroup(id: string, at: Date) {
    const g = this.groups.get(id);
    if (!g || g.status !== 'OPEN') return false;
    g.status = 'CLOSED'; g.closedAt = at; g.version++;
    return true;
  }
  async listGroupsToDeliver(asked: Date, limit: number) {
    const closedBefore = new Date(this.dueLimit(asked));
    return [...this.groups.values()]
      .filter((g) => g.status === 'CLOSED' && !g.deliveredAt && (g.closedAt ?? g.closeAt).getTime() <= closedBefore.getTime())
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime()).slice(0, limit).map((g) => structuredClone(g));
  }
  async groupMembers(groupId: string) {
    if (this.failGroups.has(groupId)) throw new Error(`simulated failure reading group ${groupId}`);
    return (this.members.get(groupId) ?? []).map((m) => ({ ...m, episodeOpen: this.episodes.get(m.alertId) ?? m.episodeOpen }));
  }
  async findMergeTarget(axis: string) {
    const t = [...this.incidents.values()].find((i) => i.axis === axis && i.isMergeTarget);
    return t ? structuredClone(t) : null;
  }
  async incidentIdExists(id: string) { return this.incidents.has(id); }
  async incidentFingerprints(id: string) { return [...(this.incidentMembers.get(id)?.keys() ?? [])]; }
  async orgForAccount(customerId: string, awsAccountId: string) {
    const a = this.accounts.get(awsAccountId);
    if (!a || a.customerId !== customerId || !a.serviceId) return null;
    const s = this.services.get(a.serviceId);
    return s && s.customerId === customerId ? { projectId: s.projectId, serviceId: s.id } : null;
  }
  async pagingContext(customerId: string) { return { configs: this.configsOf(customerId), world: this.worldOf(customerId) }; }
  configsOf(customerId: string): PagingConfig[] { return structuredClone(this.configs.filter((c) => c.customerId === customerId)); }
  /** Only this customer's people, responders and rotations (plus INTERNAL staff and shared MSP rotations). */
  worldOf(customerId: string): PagingWorld {
    const rotations = new Map([...this.rotations].filter(([, r]) => r.scope === 'MSP' || r.customerId === customerId));
    return {
      customerId,
      contacts: new Map([...this.contacts].filter(([, c]) => c.kind === 'INTERNAL' || c.customerId === customerId)),
      responders: this.responders.filter((r) => r.customerId === customerId),
      rotations,
      overrides: this.overrides.filter((o) => rotations.has(o.rotationId)),
      leaves: this.leaves,
    };
  }

  async commitGroupDelivery(c: GroupDeliveryCommit) {
    const g = this.groups.get(c.groupId);
    if (!g || g.status !== 'CLOSED' || g.deliveredAt) return 'ALREADY_DELIVERED' as const;
    if (g.version !== c.groupVersion) return 'CONFLICT' as const;
    if (c.incident) {
      const row = c.incident.row;
      if (this.failIncidents.has(row.id)) throw new Error(`simulated failure writing incident ${row.id}`);
      if (c.incident.mode === 'CREATE') {
        const demoteId = c.incident.demoteId;
        if (this.incidents.has(row.id)) return 'CONFLICT' as const;
        if ([...this.incidents.values()].some((i) => i.axis === row.axis && i.isMergeTarget && i.id !== demoteId)) return 'CONFLICT' as const;
        if (demoteId) {
          const old = this.incidents.get(demoteId);
          if (old) { old.isMergeTarget = false; old.version++; }
        }
        this.incidents.set(row.id, { ...structuredClone(row), number: ++this.incidentSeq, version: 0 });
      } else {
        const cur = this.incidents.get(row.id);
        if (!cur || cur.version !== c.incident.expectedVersion) return 'CONFLICT' as const;
        this.incidents.set(row.id, { ...structuredClone(row), number: cur.number, version: cur.version + 1 });
      }
      const set = this.incidentMembers.get(row.id) ?? new Map<string, { alertId: string; eventCount: number }>();
      for (const m of c.members) {
        const known = set.get(m.fingerprint);
        if (known) known.eventCount += m.eventCount;
        else if (set.size < 200) set.set(m.fingerprint, { alertId: m.alertId, eventCount: m.eventCount });
      }
      this.incidentMembers.set(row.id, set);
    }
    this.insertEvents(c.events);
    this.insertJobs(c.jobs, c.deliveredAt);
    g.status = 'DELIVERED'; g.deliveredAt = c.deliveredAt; g.version++;
    return 'OK' as const;
  }

  async listAutoResolvable(limit: number) {
    return [...this.incidents.values()].filter((i) => {
      if (i.status === 'RESOLVED') return false;
      const m = [...(this.incidentMembers.get(i.id)?.values() ?? [])];
      return m.length > 0 && m.every((x) => !(this.episodes.get(x.alertId) ?? true));
    }).sort((a, b) => a.triggeredAt.getTime() - b.triggeredAt.getTime()).slice(0, limit).map((i) => structuredClone(i));
  }
  async listEscalationDue(asked: Date, limit: number, excludeIds: string[] = []) {
    const now = new Date(this.dueLimit(asked));
    return [...this.incidents.values()]
      .filter((i) => !excludeIds.includes(i.id) && i.status !== 'RESOLVED' && i.nextEscalationAt != null && i.nextEscalationAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextEscalationAt!.getTime() - b.nextEscalationAt!.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit).map((i) => structuredClone(i));
  }
  async maintenanceWindows(customerId: string | null, at: Date) {
    return this.windows.filter((w) => (w.customerId == null || w.customerId === customerId)
      && !(w.revokedAt && w.revokedAt.getTime() <= at.getTime()) && w.startsAt.getTime() <= at.getTime() && at.getTime() < w.endsAt.getTime());
  }
  async stepAllFailed(incidentId: string, stepIndex: number, repeat: number) {
    const js = [...this.jobs.values()].filter((j) => j.incidentId === incidentId && j.purpose !== 'RENOTIFY' && j.stepIndex === stepIndex && j.repeat === repeat);
    return js.length > 0 && js.every((j) => j.status === 'FAILED' || j.status === 'SKIPPED');
  }
  async commitIncident(c: IncidentCommit) {
    if (this.failIncidents.has(c.row.id)) throw new Error(`simulated failure writing incident ${c.row.id}`);
    const cur = this.incidents.get(c.row.id);
    if (!cur || cur.version !== c.expectedVersion) return 'CONFLICT' as const;
    const next: IncidentRow = { ...structuredClone(c.row), number: cur.number, version: c.bump ? cur.version + 1 : cur.version };
    this.incidents.set(next.id, next);
    this.insertEvents(c.events ?? []);
    // No event → no time from the caller: the store's now (never 1970).
    this.insertJobs(c.jobs ?? [], c.events?.length ? new Date(Math.max(...c.events.map((e) => e.at.getTime()))) : null);
    if (c.restoreAckSkipped) {
      const r = { ...c.restoreAckSkipped, at: this.notAfterNow(c.restoreAckSkipped.at) };
      for (const j of this.jobs.values()) {
        if (j.incidentId === next.id && j.status === 'SKIPPED' && j.lastError === 'acknowledged' && j.purpose !== 'RENOTIFY' && j.stepIndex === r.stepIndex && j.repeat === r.repeat) {
          j.status = 'QUEUED'; j.lastError = null; j.nextAttemptAt = r.at; j.dueAt = r.at;
        }
      }
    }
    if (c.memberEffect) for (const m of this.incidentMembers.get(next.id)?.values() ?? []) this.alertAcked.set(m.alertId, c.memberEffect === 'ACK');
    if (c.resolution) this.resolutions.push(c.resolution);
    if (c.audit) this.audits.push(c.audit);
    return structuredClone(next);
  }
  protected insertEvents(events: IncidentEventInput[]) {
    for (const e of events) this.events.push({ ...e, id: this.nextId('ev') });
  }
  /** LEAST(at, store now) — "send now" can never mean "later" because the caller's clock is ahead (R-2). Only for a store with its own clock. */
  protected notAfterNow(at: Date | null): Date {
    if (!at) return this.clock();
    return this.ownClock && at.getTime() > this.ownClock().getTime() ? this.ownClock() : at;
  }
  /** INSERT … ON CONFLICT (idempotencyKey) DO NOTHING. Due at LEAST(at, store now). */
  protected insertJobs(intents: NotificationIntent[], when: Date | null) {
    const at = this.notAfterNow(when);
    for (const i of intents) {
      if (this.jobs.has(i.idempotencyKey)) continue;
      this.jobs.set(i.idempotencyKey, { ...structuredClone(i), id: this.nextId('job'), status: 'QUEUED', attempts: 0, claimSeq: 0, nextAttemptAt: at, dueAt: at, lastError: null, providerMessageId: null, createdAt: at });
    }
  }

  private isDue(j: NotificationJob, now: Date): boolean {
    return (j.status === 'QUEUED' || j.status === 'SENDING') && j.nextAttemptAt.getTime() <= now.getTime();
  }
  async claimDueJobs(limit: number, opts: { kinds?: readonly SenderKind[]; rotateAfter?: string | null } = {}) {
    const now = this.clock();
    const channels = opts.kinds ? new Set(opts.kinds.flatMap((k) => LANE_CHANNELS[k])) : null;
    const due: NotificationJob[] = [];
    for (const j of this.jobs.values()) {
      if (!this.isDue(j, now) || (channels && !channels.has(j.channel))) continue;
      if (j.attempts >= MAX_ATTEMPTS) {
        // Every allowed send was started and the last one never reported back: give up, on the record (R-3).
        j.status = 'FAILED'; j.lastError = j.lastError ?? 'gave up after a send that never finished';
        const channel = j.channel === 'SLACK_BOT' || j.channel === 'SLACK_WEBHOOK';
        this.logs.push({
          id: this.nextId('log'), at: now, customerId: j.customerId, incidentId: j.incidentId, jobId: j.id, channel: j.channel, status: 'FAILED',
          targetSummary: channel ? 'Slack channel' : j.contactName ?? 'Unknown person', targetKind: channel ? 'MSP_CHANNEL' : 'STAFF', contactId: channel ? null : j.contactId,
          escalationStep: j.stepIndex, attempt: j.attempts, providerMessageId: null, error: j.lastError, errorCode: 'GAVE_UP', warnings: [],
        });
        continue;
      }
      due.push(j);
    }
    return selectForClaim(due, limit, opts.rotateAfter).map((j) => {
      // dueAt is not touched: the lease lives in nextAttemptAt only (R-11).
      j.status = 'SENDING'; j.claimSeq++; j.nextAttemptAt = new Date(now.getTime() + CLAIM_LEASE_SEC * 1000);
      return structuredClone(j);
    });
  }
  private jobById(jobId: string, claimSeq: number): NotificationJob | null {
    const j = [...this.jobs.values()].find((x) => x.id === jobId);
    return j && j.status === 'SENDING' && j.claimSeq === claimSeq ? j : null;
  }
  async beginSend(jobId: string, claimSeq: number) {
    const j = this.jobById(jobId, claimSeq);
    if (!j) return null;
    j.attempts++; j.nextAttemptAt = retryAt(j.attempts, this.clock()); j.dueAt = j.nextAttemptAt;
    return j.attempts;
  }
  async releaseJob(jobId: string, claimSeq: number, opts: { notBefore?: Date; note?: string; event?: IncidentEventInput } = {}) {
    const j = this.jobById(jobId, claimSeq);
    if (!j) return false;
    j.status = 'QUEUED';
    if (opts.notBefore) {
      // never further ahead than store now + RELEASE_HOLD_MAX_SEC (R-2)
      const cap = this.ownClock ? this.ownClock().getTime() + RELEASE_HOLD_MAX_SEC * 1000 : Infinity;
      const until = new Date(Math.min(opts.notBefore.getTime(), cap));
      j.dueAt = until; j.nextAttemptAt = until;
    } else j.nextAttemptAt = j.dueAt; // original due time, never "now" (R-11)
    if (opts.note !== undefined) j.lastError = opts.note;
    if (opts.event) this.insertEvents([opts.event]);
    return true;
  }
  async outboxBacklog() {
    const now = this.clock();
    const due = [...this.jobs.values()].filter((j) => this.isDue(j, now) && j.attempts === 0);
    return {
      dueUnattempted: due.length, dueSev1Unattempted: due.filter((j) => j.payload.severity === 'SEV_1').length,
      oldestDueAt: due.length ? new Date(Math.min(...due.map((j) => j.dueAt.getTime()))) : null,
    };
  }
  async findIncidentById(id: string) { const i = this.incidents.get(id); return i ? structuredClone(i) : null; }
  async getContact(id: string) { const c = this.contacts.get(id); return c ? { ...c } : null; }
  async slackDestinations(job: NotificationJob) {
    const msp = { channels: this.slackChannels.get('msp') ?? [], owner: 'MSP' as const };
    if (job.targetRef === 'msp-default' || !job.customerId) return msp;
    const own = this.slackChannels.get(`customer:${job.customerId}`) ?? [];
    return own.length ? { channels: own, owner: 'CUSTOMER' as const } : msp;
  }
  async completeJob(
    jobId: string, claimSeq: number,
    r: { status: 'SENT' | 'FAILED' | 'SKIPPED' | 'QUEUED'; providerMessageId?: string | null; error?: string | null; errorCode?: DeliveryReason | null },
    log?: DeliveryLog, event?: IncidentEventInput,
  ) {
    const j = this.jobById(jobId, claimSeq);
    if (!j) return false; // WHERE status='SENDING' AND claimSeq=? matched nothing
    j.status = r.status;
    if (r.providerMessageId) j.providerMessageId = r.providerMessageId;
    j.lastError = r.error != null ? (r.status === 'SKIPPED' ? r.error : sanitizeProviderError(r.error)) : r.status === 'SENT' ? null : j.lastError;
    // R-9: the store masks the provider text itself, whatever the caller did (masking twice only ever masks more).
    if (log) this.logs.push({ ...log, error: log.error == null ? null : sanitizeProviderError(log.error), id: this.nextId('log') });
    if (event) this.insertEvents([event]);
    return true;
  }

  async writeHeartbeat(hb: HeartbeatWrite) {
    const prev = this.heartbeats.get(hb.name);
    const cap = (d: Date | null): Date | null => (d ? new Date(this.dueLimit(d)) : null); // never later than the store's now (R-2)
    hb = { ...hb, lastStartedAt: cap(hb.lastStartedAt), lastFinishedAt: cap(hb.lastFinishedAt) };
    this.heartbeats.set(hb.name, { ...hb, consecutiveFailures: hb.lastStatus !== 'OK' ? (prev?.consecutiveFailures ?? 0) + 1 : 0 });
  }
  async readHeartbeats() { return [...this.heartbeats.values()]; }

  // ── helpers for tests and local runs ──
  jobList(incidentId?: string): NotificationJob[] { return [...this.jobs.values()].filter((j) => !incidentId || j.incidentId === incidentId); }
  eventsOf(incidentId: string) { return this.events.filter((e) => e.incidentId === incidentId); }
}
