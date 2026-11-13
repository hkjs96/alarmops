/**
 * What a store has to offer so that the SAME behavioural tests can run against it (contract suite).
 * - `memoryFixture` (here) wraps a MemoryTickStore.
 * - packages/store-sql/test/sqlFixture.ts loads the same seed into Postgres (PGlite, or a real server when
 *   TEST_DATABASE_URL is set) and reads the tables back.
 * A test never touches a store's internals: it seeds a MemoryTickStore the usual way (world.ts), hands it to
 * `make(seed)`, and from then on uses `repo` plus the methods below.
 */
import type {
  AuditInput, Contact, DeliveryLog, GroupMember, GroupRow, IncidentEventInput, IncidentRow, MaintenanceWindow, MemoryTickStore, NotificationJob, ResolutionInput, TickRepository,
} from '../../src/index.js';

export interface StoreFixture<R extends TickRepository = TickRepository> {
  readonly kind: 'memory' | 'sql';
  /** e.g. 'memory', 'sql:pglite', 'sql:postgres'. */
  readonly label: string;
  readonly repo: R;
  /** Another runner on the same data (its own repository object; on a real server its own connections). */
  secondRunner(): R;
  /** The store's own clock (R-14). */
  setClock(clock: () => Date): void;
  /** True while a store call is in flight (real I/O) — tests on fake timers wait for it. Always false in memory. */
  busy(): boolean;
  /** Can two transactions really run at the same time (a real server)? PGlite and memory run them one after the other. */
  readonly concurrent: boolean;

  // ── seeding after `make` ──
  addContact(c: Contact): Promise<void>;
  patchContact(id: string, patch: Partial<Pick<Contact, 'active' | 'phoneVerifiedAt' | 'customerId' | 'kind'>>): Promise<void>;
  /** A group as ingest leaves it, with its member alerts (episode state = `member.episodeOpen`). */
  addGroup(g: GroupRow, members: GroupMember[]): Promise<void>;
  setEpisode(alertId: string, open: boolean): Promise<void>;
  /** D-43: Customer.status changes after the incident exists (a person did it through PATCH /customers/{id}/status). */
  setCustomerStatus(customerId: string, status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED'): Promise<void>;
  /** D-43: an event that arrived after TERMINATED (OffboardResidual row). */
  addResidual(customerId: string, sourceKey: string, count: number, lastAt: Date): Promise<void>;
  addWindow(w: MaintenanceWindow): Promise<void>;
  revokeWindow(id: string, at: Date): Promise<void>;
  putJob(j: NotificationJob): Promise<void>;
  patchJob(idempotencyKey: string, patch: Partial<Pick<NotificationJob, 'status' | 'attempts' | 'nextAttemptAt' | 'dueAt' | 'lastError' | 'claimSeq'>>): Promise<void>;
  /** Forget which minutes were claimed (so a test can run the same minute again on purpose). */
  clearTickClaims(): Promise<void>;

  // ── reading back ──
  /** In the order they were created. */
  incidents(): Promise<IncidentRow[]>;
  /** In the order they were queued. */
  jobs(incidentId?: string): Promise<NotificationJob[]>;
  events(incidentId: string): Promise<Array<IncidentEventInput & { id: string }>>;
  logs(): Promise<Array<DeliveryLog & { id: string }>>;
  group(id: string): Promise<GroupRow | null>;
  alertAcked(alertId: string): Promise<boolean>;
  resolutions(): Promise<ResolutionInput[]>;
  audits(): Promise<AuditInput[]>;
  close(): Promise<void>;
}

export type MakeFixture<R extends TickRepository = TickRepository> = (seed: MemoryTickStore) => Promise<StoreFixture<R>>;

export function memoryFixture<S extends MemoryTickStore>(store: S): StoreFixture<S> {
  return {
    kind: 'memory', label: 'memory', repo: store, concurrent: false,
    secondRunner: () => store,
    setClock: (clock) => { store.clock = clock; },
    busy: () => false,
    async addContact(c) { store.contacts.set(c.id, { ...c }); },
    async patchContact(id, patch) { Object.assign(store.contacts.get(id)!, patch); },
    async addGroup(g, members) {
      store.groups.set(g.id, structuredClone(g));
      store.members.set(g.id, structuredClone(members));
      for (const m of members) if (!store.episodes.has(m.alertId)) store.episodes.set(m.alertId, m.episodeOpen);
    },
    async setEpisode(alertId, open) { store.episodes.set(alertId, open); },
    async setCustomerStatus(customerId, status) { store.customers.set(customerId, { ...store.customers.get(customerId)!, status }); },
    async addResidual(customerId, sourceKey, count, lastAt) {
      // MemoryApiStore keeps them; the tick store alone has no offboarding.
      const m = (store as unknown as { residuals: Map<string, Array<{ sourceKey: string; lastAt: Date; count: number }>> }).residuals;
      m.set(customerId, [...(m.get(customerId) ?? []), { sourceKey, lastAt, count }]);
    },
    async addWindow(w) { store.windows.push({ ...w }); },
    async revokeWindow(id, at) { store.windows.find((w) => w.id === id)!.revokedAt = at; },
    async putJob(j) { store.jobs.set(j.idempotencyKey, structuredClone(j)); },
    async patchJob(key, patch) { Object.assign(store.jobs.get(key)!, patch); },
    async clearTickClaims() { store.ticks.clear(); },
    async incidents() { return structuredClone([...store.incidents.values()]); },
    async jobs(incidentId) { return structuredClone(store.jobList(incidentId)); },
    async events(incidentId) { return structuredClone(store.eventsOf(incidentId)); },
    async logs() { return structuredClone(store.logs); },
    async group(id) { const g = store.groups.get(id); return g ? structuredClone(g) : null; },
    async alertAcked(alertId) { return store.alertAcked.get(alertId) === true; },
    async resolutions() { return structuredClone(store.resolutions); },
    async audits() { return structuredClone(store.audits); },
    async close() { /* nothing to release */ },
  };
}
