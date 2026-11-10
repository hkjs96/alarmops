/**
 * In-memory TickRepository with the same conflict semantics as the Postgres schema: version-checked updates,
 * one merge target per axis, outbox idempotencyKey unique, tick minute claimed once. Tests and local runs only.
 */
import type { NotificationIntent } from './escalation.js';
import type { GroupRow } from './grouping.js';
import type { IncidentRow } from './incident.js';
import type { MaintenanceWindow } from './maintenance.js';
import { MAX_ATTEMPTS, retryAt, type DeliveryLog, type NotificationJob } from './notify.js';
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
  /** Test hooks. */
  dedupeTicks = true;
  failIncidents = new Set<string>();
  failGroups = new Set<string>();
  protected seq = 0;
  protected incidentSeq = 0;
  protected nextId(p: string): string { return `${p}_${++this.seq}`; }

  async claimTick(key: string): Promise<boolean> {
    if (!this.dedupeTicks) return true;
    if (this.ticks.has(key)) return false;
    this.ticks.add(key);
    return true;
  }
  async loadPolicy() { return this.policy; }

  async listGroupsToClose(now: Date, limit: number) {
    return [...this.groups.values()].filter((g) => g.status === 'OPEN' && g.closeAt.getTime() <= now.getTime())
      .sort((a, b) => a.closeAt.getTime() - b.closeAt.getTime()).slice(0, limit).map((g) => structuredClone(g));
  }
  async closeGroup(id: string, at: Date) {
    const g = this.groups.get(id);
    if (!g || g.status !== 'OPEN') return false;
    g.status = 'CLOSED'; g.closedAt = at; g.version++;
    return true;
  }
  async listGroupsToDeliver(closedBefore: Date, limit: number) {
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
  async listEscalationDue(now: Date, limit: number) {
    return [...this.incidents.values()]
      .filter((i) => i.status !== 'RESOLVED' && i.nextEscalationAt != null && i.nextEscalationAt.getTime() <= now.getTime())
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
    this.insertJobs(c.jobs ?? [], new Date(Math.max(...(c.events ?? []).map((e) => e.at.getTime()), 0)));
    if (c.memberEffect) for (const m of this.incidentMembers.get(next.id)?.values() ?? []) this.alertAcked.set(m.alertId, c.memberEffect === 'ACK');
    if (c.resolution) this.resolutions.push(c.resolution);
    if (c.audit) this.audits.push(c.audit);
    return structuredClone(next);
  }
  protected insertEvents(events: IncidentEventInput[]) {
    for (const e of events) this.events.push({ ...e, id: this.nextId('ev') });
  }
  /** INSERT … ON CONFLICT (idempotencyKey) DO NOTHING. */
  protected insertJobs(intents: NotificationIntent[], at: Date) {
    for (const i of intents) {
      if (this.jobs.has(i.idempotencyKey)) continue;
      this.jobs.set(i.idempotencyKey, { ...structuredClone(i), id: this.nextId('job'), status: 'QUEUED', attempts: 0, nextAttemptAt: at, lastError: null, providerMessageId: null, createdAt: at });
    }
  }

  async claimDueJobs(now: Date, limit: number) {
    const due = [...this.jobs.values()]
      .filter((j) => (j.status === 'QUEUED' || j.status === 'SENDING') && j.nextAttemptAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    const out: NotificationJob[] = [];
    for (const j of due) {
      if (out.length >= limit) break;
      if (j.attempts >= MAX_ATTEMPTS) { j.status = 'FAILED'; j.lastError = j.lastError ?? 'gave up after a send that never finished'; continue; }
      j.status = 'SENDING'; j.attempts++; j.nextAttemptAt = retryAt(j.attempts, now);
      out.push(structuredClone(j));
    }
    return out;
  }
  async incidentStatus(id: string) { return this.incidents.get(id)?.status ?? null; }
  async getContact(id: string) { const c = this.contacts.get(id); return c ? { ...c } : null; }
  async slackDestinations(job: NotificationJob) {
    const msp = this.slackChannels.get('msp') ?? [];
    if (job.targetRef === 'msp-default' || !job.customerId) return msp;
    const own = this.slackChannels.get(`customer:${job.customerId}`) ?? [];
    return own.length ? own : msp;
  }
  async completeJob(jobId: string, r: { status: 'SENT' | 'FAILED' | 'SKIPPED' | 'QUEUED'; providerMessageId?: string | null; error?: string | null }, log?: DeliveryLog) {
    const j = [...this.jobs.values()].find((x) => x.id === jobId);
    if (!j) return;
    j.status = r.status;
    if (r.providerMessageId) j.providerMessageId = r.providerMessageId;
    j.lastError = r.error ?? (r.status === 'SENT' ? null : j.lastError);
    if (log) this.logs.push({ ...log, id: this.nextId('log') });
  }

  async writeHeartbeat(hb: HeartbeatWrite) {
    const prev = this.heartbeats.get(hb.name);
    this.heartbeats.set(hb.name, { ...hb, consecutiveFailures: hb.lastStatus === 'ERROR' ? (prev?.consecutiveFailures ?? 0) + 1 : 0 });
  }
  async readHeartbeats() { return [...this.heartbeats.values()]; }

  // ── helpers for tests and local runs ──
  jobList(incidentId?: string): NotificationJob[] { return [...this.jobs.values()].filter((j) => !incidentId || j.incidentId === incidentId); }
  eventsOf(incidentId: string) { return this.events.filter((e) => e.incidentId === incidentId); }
}
