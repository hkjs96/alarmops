import {
  FakeSender, MemoryTickStore, runTick, templateSteps, groupKey, groupId,
  type Contact, type EscalationStep, type GroupMember, type PagingConfig, type Severity, type TickJob, type TickResult, type TickSummary,
} from '../src/index.js';

export const T0 = new Date('2026-11-09T03:00:00Z'); // Monday 12:00 KST
export const at = (min: number, sec = 0): Date => new Date(T0.getTime() + min * 60_000 + sec * 1000);
const V = new Date('2026-10-01T00:00:00Z');

const person = (id: string, name: string, kind: Contact['kind'], customerId: string | null, extra: Partial<Contact> = {}): Contact => ({
  id, name, kind, customerId, active: true,
  email: `${id}@example.test`, phone: `+8210000${id.length}${id.charCodeAt(2)}`, slackUserId: `U_${id}`,
  emailVerifiedAt: V, phoneVerifiedAt: V, slackVerifiedAt: V, ...extra,
});

/**
 * Two customers. Mirae Pay: project core › service payments-api (account 111111111111), project data.
 * Hanbit: project shop › service web (account 222222222222). Account 999999999999 is unmapped.
 * Staff: Haeun, Junho (MSP night desk rotation, daily, Haeun first), Minjae. Customer people: Yuna (Mirae, pageable),
 * Seojun (Mirae, notify only), Dohyun + Sora (Hanbit rotation).
 */
export function seedWorld(s: MemoryTickStore = new MemoryTickStore()): MemoryTickStore {
  s.customers.set('cus_mirae', { id: 'cus_mirae', name: 'Mirae Pay', slug: 'mirae' });
  s.customers.set('cus_hanbit', { id: 'cus_hanbit', name: 'Hanbit Retail', slug: 'hanbit' });
  s.projects.set('prj_core', { id: 'prj_core', customerId: 'cus_mirae', name: 'Core', slug: 'core' });
  s.projects.set('prj_data', { id: 'prj_data', customerId: 'cus_mirae', name: 'Data platform', slug: 'data-platform' });
  s.projects.set('prj_shop', { id: 'prj_shop', customerId: 'cus_hanbit', name: 'Shop', slug: 'shop' });
  s.services.set('svc_pay', { id: 'svc_pay', customerId: 'cus_mirae', projectId: 'prj_core', name: 'Payments API', slug: 'payments-api' });
  s.services.set('svc_web', { id: 'svc_web', customerId: 'cus_hanbit', projectId: 'prj_shop', name: 'Web', slug: 'web' });
  s.accounts.set('111111111111', { awsAccountId: '111111111111', customerId: 'cus_mirae', serviceId: 'svc_pay' });
  s.accounts.set('222222222222', { awsAccountId: '222222222222', customerId: 'cus_hanbit', serviceId: 'svc_web' });
  for (const c of [
    person('ct_haeun', 'Haeun Kim', 'INTERNAL', null), person('ct_junho', 'Junho Park', 'INTERNAL', null), person('ct_minjae', 'Minjae Lee', 'INTERNAL', null),
    person('ct_yuna', 'Yuna Seo', 'CUSTOMER', 'cus_mirae'), person('ct_seojun', 'Seojun Bae', 'CUSTOMER', 'cus_mirae'),
    person('ct_dohyun', 'Dohyun Han', 'CUSTOMER', 'cus_hanbit'), person('ct_sora', 'Sora Lim', 'CUSTOMER', 'cus_hanbit'),
  ]) s.contacts.set(c.id, c);
  s.responders.push(
    { customerId: 'cus_mirae', contactId: 'ct_haeun', role: 'PAGEABLE' }, { customerId: 'cus_mirae', contactId: 'ct_junho', role: 'PAGEABLE' },
    { customerId: 'cus_mirae', contactId: 'ct_yuna', role: 'PAGEABLE' }, { customerId: 'cus_mirae', contactId: 'ct_seojun', role: 'NOTIFY_ONLY' },
    { customerId: 'cus_hanbit', contactId: 'ct_minjae', role: 'PAGEABLE' }, { customerId: 'cus_hanbit', contactId: 'ct_dohyun', role: 'PAGEABLE' },
    { customerId: 'cus_hanbit', contactId: 'ct_sora', role: 'PAGEABLE' },
  );
  // Shift 0 starts 2026-11-09 00:00Z (09:00 KST) with Haeun; next day Junho.
  s.rotations.set('rot_night', { id: 'rot_night', scope: 'MSP', customerId: null, name: 'MSP night desk', cadence: 'DAILY', anchorAt: new Date('2026-11-09T00:00:00Z'),
    members: [{ contactId: 'ct_haeun', order: 0 }, { contactId: 'ct_junho', order: 1 }] });
  s.rotations.set('rot_hanbit', { id: 'rot_hanbit', scope: 'CUSTOMER', customerId: 'cus_hanbit', name: 'Hanbit on-call', cadence: 'WEEKLY', anchorAt: new Date('2026-11-09T00:00:00Z'),
    members: [{ contactId: 'ct_dohyun', order: 0 }, { contactId: 'ct_sora', order: 1 }] });
  s.slackChannels.set('msp', ['C_MSP']);
  s.slackChannels.set('customer:cus_mirae', ['C_MIRAE']);
  return s;
}

/** runTick deps whose store clock (R-14) follows the same simulated time as the runner's clock. */
export function on<T extends { repo: MemoryTickStore; now: () => Date }>(deps: T): T {
  deps.repo.clock = deps.now;
  return deps;
}

export const step = (index: number, atMin: number, targetType: EscalationStep['targetType'], targetId: string | null, channels: EscalationStep['channels'], extra: Partial<EscalationStep> = {}): EscalationStep =>
  ({ index, atMin, targetType, targetId, channels, ...extra });

export function config(customerId: string, steps: EscalationStep[], extra: Partial<PagingConfig> = {}): PagingConfig {
  return { id: `pc_${customerId}_${extra.scopeType ?? 'CUSTOMER'}`, customerId, scopeType: 'CUSTOMER', scopeId: customerId, style: 'CUSTOM', plan: 'STANDARD', edited: false, repeatCount: 1, version: 1, steps, ...extra };
}

/** The four sample call orders (D-30). */
export const PATTERNS = {
  /** MSP rotation first, the customer's person by phone at 10 minutes. */
  rotationThenCustomer: () => config('cus_mirae', [step(0, 0, 'ROTATION', 'rot_night', ['SLACK_DM']), step(1, 10, 'PERSON', 'ct_yuna', ['VOICE'])], { style: 'CUSTOM', edited: true }),
  allAtOnce: () => config('cus_mirae', [step(0, 0, 'ALL_RESPONDERS', null, ['SMS'])], { style: 'ALL_AT_ONCE' }),
  customerRotation: () => config('cus_hanbit', templateSteps('URGENT', { targetType: 'ROTATION', targetId: 'rot_hanbit' }, false), { style: 'CUSTOMER_ROTATION', plan: 'URGENT' }),
  templateStandard: () => config('cus_mirae', templateSteps('STANDARD', { targetType: 'ROTATION', targetId: 'rot_night' }, false), { style: 'SHARED_ROTATION', plan: 'STANDARD' }),
};

export interface AlertSeed { id: string; title?: string; severity?: Severity; awsAccountId?: string | null; decision?: 'NOTIFY' | 'DEFER'; eventCount?: number }

/** A group that ingest already filled and closed (grace passed) — what the tick collects. Returns the group id. */
export function closedGroup(s: MemoryTickStore, o: { customerId: string | null; awsAccountId?: string | null; severity?: Severity; at: Date; alerts: AlertSeed[] }): string {
  const severity = o.severity ?? 'SEV_2';
  const account = o.awsAccountId ?? (o.customerId === 'cus_mirae' ? '111111111111' : o.customerId === 'cus_hanbit' ? '222222222222' : '999999999999');
  const key = groupKey({ customerId: o.customerId, awsAccountId: account, severity });
  const openedAt = new Date(o.at.getTime() - 40_000);
  let id = groupId(key, openedAt);
  while (s.groups.has(id)) id += 'x';
  s.groups.set(id, { id, groupKey: key, customerId: o.customerId, severity, status: 'CLOSED', openedAt, groupWaitSec: 30, closeAt: new Date(o.at.getTime() - 10_000),
    closedAt: new Date(o.at.getTime() - 10_000), pauseUntil: null, staleAfter: new Date(o.at.getTime() + 300_000), deliveredAt: null, version: 1 });
  const members: GroupMember[] = o.alerts.map((a) => ({
    alertId: a.id, fingerprint: `fp:${a.id}`, severity: a.severity ?? severity, title: a.title ?? `${a.id} high`, awsAccountId: a.awsAccountId === undefined ? account : a.awsAccountId,
    resourceType: 'EC2', source: 'CLOUDWATCH', decision: a.decision ?? 'NOTIFY', episodeOpen: true, eventCount: a.eventCount ?? 1,
  }));
  s.members.set(id, members);
  for (const m of members) if (!s.episodes.has(m.alertId)) s.episodes.set(m.alertId, true);
  return id;
}

export class Sim {
  store: MemoryTickStore;
  now = T0;
  slack = new FakeSender('slack');
  sms = new FakeSender('sms');
  voice = new FakeSender('voice');
  email = new FakeSender('email');
  results: TickResult[] = [];
  private ticked = new Set<number>();
  constructor(store: MemoryTickStore = seedWorld()) { this.store = store; store.clock = () => this.now; }
  get senders() { return { SLACK: this.slack, SMS: this.sms, VOICE: this.voice, EMAIL: this.email }; }
  async tick(jobs?: TickJob[]): Promise<TickSummary> {
    this.store.clock = () => this.now;
    const r = await runTick({ scheduledAt: this.now, jobs }, { repo: this.store, senders: this.senders, now: () => this.now });
    this.results.push(r);
    this.ticked.add(this.now.getTime());
    if ('skipped' in r) throw new Error('tick skipped as duplicate');
    return r;
  }
  /** Tick now, then once per minute until `untilMin` (inclusive), skipping the minutes in `skip`. */
  async run(untilMin: number, skip: number[] = []): Promise<void> {
    const start = Math.round((this.now.getTime() - T0.getTime()) / 60_000);
    for (let m = start; m <= untilMin; m++) {
      this.now = at(m);
      if (!skip.includes(m) && !this.ticked.has(this.now.getTime())) await this.tick();
    }
  }
  /** "minute channel who" for every page of an incident, in the order they were queued. */
  timeline(incidentId?: string): string[] {
    return this.store.jobList(incidentId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.idempotencyKey.localeCompare(b.idempotencyKey))
      .map((j) => `${Math.round((j.createdAt.getTime() - T0.getTime()) / 60_000)} ${j.channel} ${j.contactName ?? j.targetRef}`);
  }
  incident(i = 0) { return [...this.store.incidents.values()][i]!; }
  allSent() { return [...this.slack.sent, ...this.sms.sent, ...this.voice.sent, ...this.email.sent]; }
}
