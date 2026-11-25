/**
 * Contract suite of the Monitoring API (API-CONTRACT §8.5, D-16, D-33): GET /resources, GET /resources/{id},
 * POST /resources/{id}/monitoring, GET /managed-alarms — the SAME tests against MemoryApiStore and the SQL store.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryApiStore, type ApiDeps, type ApiResponse, type AuthContext } from '../../src/index.js';
import { USERS, body, wire } from '../helpers.js';
import { cworld, type CWorld, type MakeApiFixture } from './apiContract.js';

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../fixtures/${name}.command.json`, import.meta.url), 'utf8'));
const T = new Date('2026-11-10T00:00:00.000Z');

const baseMeta = (aws: string) => ({
  alias: null, environment: null, regions: ['ap-northeast-2'], externalId: `ext-${aws}`, readerRoleArn: `arn:aws:iam::${aws}:role/AlarmOps-Reader`, eventForwarderRoleArn: `arn:aws:iam::${aws}:role/AlarmOps-EventForwarder`,
  alarmWriterRoleArn: null, tagWriterRoleArn: null, remediatorRoleArn: null, alarmWriterEnabled: false, tagWriterEnabled: false, remediatorEnabled: false,
  readerStatus: 'UNKNOWN', eventForwarderStatus: 'UNKNOWN', alarmWriterStatus: 'UNKNOWN', tagWriterStatus: 'UNKNOWN', remediatorStatus: 'UNKNOWN',
  lastCheckedAt: null, firstEventAt: null, lastEventAt: null, stackVersion: null, createdAt: T,
}) as const;

const res = (id: string, customerId: string, awsAccountId: string, resourceType: string, name: string | null, monitoringState: 'MONITORED' | 'NEEDS_REVIEW' | 'NOT_MONITORED' | 'DELETED', extra: Record<string, unknown> = {}) => ({
  id, customerId, awsAccountId, region: 'ap-northeast-2', resourceType, resourceKey: `key-${id}`, name, tags: { Name: name ?? '', env: 'prd' }, monitoringState,
  needsReviewSince: monitoringState === 'NEEDS_REVIEW' ? T : null, needsReviewReason: monitoringState === 'NEEDS_REVIEW' ? 'tag_removed' : null, lastSeenAt: T, ...extra,
}) as never;
const alarm = (id: string, resourceId: string, metricKey: string, alarmName: string, state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA' | null, severity = 'SEV_3') => ({
  id, resourceId, metricKey, alarmName, severity, threshold: 80.5, thresholdSource: 'CODE', evalM: 3, evalN: 5, comparison: 'GreaterThanThreshold', statistic: 'Average', period: 60, state, driftStatus: 'IN_SYNC', lastSyncedAt: T,
}) as never;

/**
 * Mirae Pay (111111111111 -> svc_pay, project core): api-1 EC2 NEEDS_REVIEW (2 alarms, one in ALARM), db-1 RDS MONITORED, old-1 EC2 NOT_MONITORED. AlarmWriter on, TagWriter off.
 * Hanbit (222222222222 -> svc_web): shop-web EC2 NEEDS_REVIEW, shop-db RDS MONITORED (alarm in ALARM). AlarmWriter off, TagWriter on.
 */
export function seedMonitoring(s: MemoryApiStore): void {
  s.resources.clear(); // the minimal rows of the base world (findResource) would be real Resource rows in SQL: this suite brings its own
  s.accountMeta.set('111111111111', { ...baseMeta('111111111111'), alias: 'mirae-prd', alarmWriterEnabled: true } as never);
  s.accountMeta.set('222222222222', { ...baseMeta('222222222222'), tagWriterEnabled: true } as never);
  for (const r of [
    res('res_a', 'cus_mirae', '111111111111', 'EC2', 'api-1', 'NEEDS_REVIEW'),
    res('res_b', 'cus_mirae', '111111111111', 'RDS', 'db-1', 'MONITORED'),
    res('res_c', 'cus_mirae', '111111111111', 'EC2', 'old-1', 'NOT_MONITORED'),
    res('res_h', 'cus_hanbit', '222222222222', 'EC2', 'shop-web', 'NEEDS_REVIEW'),
    res('res_h2', 'cus_hanbit', '222222222222', 'RDS', null, 'MONITORED'),
  ] as Array<{ id: string }>) s.resourceSeeds.set(r.id, r as never);
  for (const a of [
    alarm('alm_a1', 'res_a', 'CPUUtilization', 'api-1 CPUUtilization', 'ALARM', 'SEV_2'),
    alarm('alm_a2', 'res_a', 'StatusCheckFailed', 'api-1 StatusCheckFailed', 'OK'),
    alarm('alm_b1', 'res_b', 'FreeStorageSpace', 'db-1 FreeStorageSpace', 'OK'),
    alarm('alm_h1', 'res_h2', 'CPUUtilization', 'key-res_h2 CPUUtilization', 'ALARM', 'SEV_1'),
  ] as Array<{ id: string }>) s.alarmSeeds.set(a.id, a as never);
}

const ids = (r: ApiResponse): string[] => body(r).items.map((x: { id: string }) => x.id);

export function monitoringContract(make: MakeApiFixture): void {
  let w: CWorld;
  const open = async (deps: Partial<ApiDeps> = {}): Promise<CWorld> => (w = await cworld(make, seedMonitoring, deps));
  afterEach(async () => { await w?.fx.close(); });
  const haeun = USERS.haeun;
  const stop = (who: AuthContext | null, id: string, action: unknown = 'stop', requestId?: string) => w.call(who, 'POST', `/resources/${id}/monitoring`, { body: { action }, requestId });

  describe('GET /resources', () => {
    it('lists the resources of every customer for staff with the contract fields, sorted by name', async () => {
      await open();
      const r = await w.call(haeun, 'GET', '/resources');
      expect(r.status).toBe(200);
      const b = body(r);
      expect(b.outside).toBeNull();
      expect(b.nextCursor).toBeNull();
      expect(ids(r)).toEqual(['res_a', 'res_b', 'res_h2', 'res_c', 'res_h']); // api-1, db-1, key-res_h2, old-1, shop-web (byte order)
      const a = b.items.find((i: any) => i.id === 'res_a');
      expect(a).toMatchObject({
        id: 'res_a', name: 'api-1', resourceKey: 'key-res_a', resourceType: 'EC2', region: 'ap-northeast-2', monitoringState: 'NEEDS_REVIEW', needsReviewReason: 'tag_removed',
        needsReviewSince: T.toISOString(), alarmCount: 2, lastSeenAt: T.toISOString(),
        account: { alias: 'mirae-prd', awsAccountId: '111111111111', alarmWriterEnabled: true, tagWriterEnabled: false },
        org: { customer: { id: 'cus_mirae', slug: 'mirae' }, project: { id: 'prj_core', slug: 'core' }, service: { id: 'svc_pay', slug: 'payments-api' } },
      });
      expect(b.items.find((i: any) => i.id === 'res_h2').name).toBe('key-res_h2'); // no Name tag -> the resource key
    });

    it('a portal user sees only its own customer and never an AWS account id; the other customer leaves no trace', async () => {
      await open();
      const r = await w.call(USERS.yuna, 'GET', '/resources');
      expect(ids(r).sort()).toEqual(['res_a', 'res_b', 'res_c']);
      expect(body(r).items[0].account.awsAccountId).toBeNull();
      const text = JSON.stringify(r.body);
      for (const leak of ['hanbit', 'Hanbit', 'cus_hanbit', 'res_h', 'shop', '222222222222']) expect(text).not.toContain(leak);
    });

    it('scope filter: customer / project / service narrow the list, `outside` counts what is hidden (needs review, alarms in ALARM)', async () => {
      await open();
      const mirae = await w.call(haeun, 'GET', '/resources', { query: { customer: 'mirae' } });
      expect(ids(mirae).sort()).toEqual(['res_a', 'res_b', 'res_c']);
      expect(body(mirae).outside).toEqual({ needsReview: 1, inAlarm: 1 }); // shop-web; alm_h1
      const dataProject = await w.call(haeun, 'GET', '/resources', { query: { customer: 'mirae', project: 'data-platform' } });
      expect(ids(dataProject)).toEqual([]);
      expect(body(dataProject).outside).toEqual({ needsReview: 2, inAlarm: 2 }); // api-1 and shop-web; alm_a1 and alm_h1
      const svc = await w.call(haeun, 'GET', '/resources', { query: { customer: 'mirae', project: 'core', service: 'payments-api' } });
      expect(ids(svc).sort()).toEqual(['res_a', 'res_b', 'res_c']);
      expect(body(svc).outside).toEqual({ needsReview: 1, inAlarm: 1 });
      const hanbit = await w.call(haeun, 'GET', '/resources', { query: { customer: 'hanbit' } });
      expect(ids(hanbit).sort()).toEqual(['res_h', 'res_h2']);
      expect(body(hanbit).outside).toEqual({ needsReview: 1, inAlarm: 1 });
      // outside never reaches into what the caller cannot see: a portal user's "outside" stays inside its customer
      const portal = await w.call(USERS.yuna, 'GET', '/resources', { query: { customer: 'mirae', project: 'data-platform' } });
      expect(body(portal).outside).toEqual({ needsReview: 1, inAlarm: 1 });
      expect(JSON.stringify(portal.body)).not.toContain('hanbit');
    });

    it('mine=1 follows the session user (Haeun is a Mirae Pay responder)', async () => {
      await open();
      const r = await w.call(haeun, 'GET', '/resources', { query: { mine: '1' } });
      expect(ids(r).sort()).toEqual(['res_a', 'res_b', 'res_c']);
      expect(body(r).outside).toEqual({ needsReview: 1, inAlarm: 1 });
    });

    it('monitoringState and type filters; `outside` ignores them', async () => {
      await open();
      expect(ids(await w.call(haeun, 'GET', '/resources', { query: { monitoringState: 'NEEDS_REVIEW' } })).sort()).toEqual(['res_a', 'res_h']);
      expect(ids(await w.call(haeun, 'GET', '/resources', { query: { type: 'RDS' } })).sort()).toEqual(['res_b', 'res_h2']);
      const both = await w.call(haeun, 'GET', '/resources', { query: { customer: 'mirae', monitoringState: 'NOT_MONITORED', type: 'EC2' } });
      expect(ids(both)).toEqual(['res_c']);
      expect(body(both).outside).toEqual({ needsReview: 1, inAlarm: 1 });
      expect(ids(await w.call(haeun, 'GET', '/resources', { query: { monitoringState: 'DELETED' } }))).toEqual([]);
      expect(ids(await w.call(haeun, 'GET', '/resources', { query: { monitoringState: '' } })).length).toBe(5); // blank filters are ignored (9-6)
      for (const bad of [{ monitoringState: 'nope' }, { type: 'a b' }, { limit: '0' }, { cursor: 'x' }, { project: 'core' }]) {
        expect((await w.call(haeun, 'GET', '/resources', { query: bad })).status).toBe(400);
      }
    });

    it('unknown slug and another tenant\'s slug are the same 404 (bytes), for staff narrowed to one customer and for portal users', async () => {
      await open();
      const narrowed: AuthContext = { userId: 'usr_hb', kind: 'INTERNAL', customerIds: ['cus_hanbit'], role: 'OPERATOR' };
      for (const who of [USERS.yuna, narrowed]) {
        const other = who === USERS.yuna ? 'hanbit' : 'mirae';
        const a = await w.call(who, 'GET', '/resources', { query: { customer: other }, requestId: 'req_same' });
        const b = await w.call(who, 'GET', '/resources', { query: { customer: 'no-such-customer' }, requestId: 'req_same' });
        expect(a.status).toBe(404);
        expect(wire(a)).toBe(wire(b));
      }
    });

    it('pages by cursor without gaps or repeats', async () => {
      await open();
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 6; i++) {
        const r = await w.call(haeun, 'GET', '/resources', { query: { limit: '2', cursor } });
        seen.push(...ids(r));
        cursor = body(r).nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(seen).toEqual(ids(await w.call(haeun, 'GET', '/resources')));
    });
  });

  describe('GET /resources/{id}', () => {
    it('returns the resource, its tags and its managed alarms', async () => {
      await open();
      const r = await w.call(haeun, 'GET', '/resources/res_a');
      expect(r.status).toBe(200);
      const b = body(r);
      expect(b).toMatchObject({ id: 'res_a', name: 'api-1', monitoringState: 'NEEDS_REVIEW', alarmCount: 2, tags: { Name: 'api-1', env: 'prd' } });
      expect(b.alarms.map((a: any) => [a.id, a.alarmName, a.metricKey, a.state, a.severity, a.threshold])).toEqual([
        ['alm_a1', 'api-1 CPUUtilization', 'CPUUtilization', 'ALARM', 'SEV_2', 80.5],
        ['alm_a2', 'api-1 StatusCheckFailed', 'StatusCheckFailed', 'OK', 'SEV_3', 80.5],
      ]);
    });

    it('D-33: another customer\'s id and an unknown id are byte-identical 404s (GET and POST), for every kind of caller', async () => {
      await open();
      const narrowed: AuthContext = { userId: 'usr_hb', kind: 'INTERNAL', customerIds: ['cus_hanbit'], role: 'ADMIN' };
      for (const [who, foreign] of [[USERS.yuna, 'res_h'], [USERS.dohyun, 'res_a'], [narrowed, 'res_a']] as const) {
        const get = [await w.call(who, 'GET', `/resources/${foreign}`, { requestId: 'req_same' }), await w.call(who, 'GET', '/resources/res_missing', { requestId: 'req_same' })];
        expect(get[0]!.status).toBe(404);
        expect(wire(get[0]!)).toBe(wire(get[1]!));
        const post = [await stop(who, foreign, 'stop', 'req_same'), await stop(who, 'res_missing', 'stop', 'req_same')];
        expect(post[0]!.status).toBe(404);
        expect(wire(post[0]!)).toBe(wire(post[1]!));
      }
      expect(w.commands.sent).toEqual([]);
      expect(body(await w.call(USERS.yuna, 'GET', '/resources/res_h'))).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.', details: {}, requestId: expect.any(String) } });
    });
  });

  describe('POST /resources/{id}/monitoring', () => {
    it('stop on a NEEDS_REVIEW resource queues STOP_MONITORING { resourceId, deleteAlarms: true } and answers 202', async () => {
      await open();
      const r = await stop(haeun, 'res_a');
      expect(r.status).toBe(202);
      expect(body(r)).toEqual({ commandId: expect.stringMatching(/^cmd_[0-9a-f]{24}$/), status: 'queued' });
      expect(w.commands.sent).toHaveLength(1);
      const cmd = w.commands.sent[0]!;
      expect(cmd).toEqual({ ...fixture('stop-monitoring'), commandId: body(r).commandId, cloudAccountId: expect.any(String), requestedAt: expect.any(String) });
      expect(cmd.payload).toEqual({ resourceId: 'res_a', deleteAlarms: true });
      const audits = await w.fx.audits();
      expect(audits.filter((a) => a.action === 'resource.stop_monitoring')).toMatchObject([{ customerId: 'cus_mirae', actorId: 'usr_haeun', targetType: 'Resource', targetId: 'res_a', after: { commandId: body(r).commandId } }]);
      // the API does not touch the row: the engine does, when it runs the command
      expect(body(await w.call(haeun, 'GET', '/resources/res_a')).monitoringState).toBe('NEEDS_REVIEW');
    });

    it('stop is refused with 409 unless the resource is NEEDS_REVIEW (nothing queued)', async () => {
      await open();
      for (const id of ['res_b', 'res_c']) {
        const r = await stop(haeun, id);
        expect(r.status).toBe(409);
        expect(body(r).error.code).toBe('INVALID_TRANSITION');
      }
      expect(w.commands.sent).toEqual([]);
    });

    it('stop needs AlarmWriter: 403 CAPABILITY_DISABLED when the account has it off', async () => {
      await open();
      const r = await stop(haeun, 'res_h');
      expect(r.status).toBe(403);
      expect(body(r).error).toMatchObject({ code: 'CAPABILITY_DISABLED', details: { role: 'alarmWriter' } });
      expect(w.commands.sent).toEqual([]);
    });

    it('no queue configured: 503 COMMANDS_UNAVAILABLE, nothing written; a failing queue: 502 and the failure is audited', async () => {
      await open({ commands: undefined });
      const r = await stop(haeun, 'res_a');
      expect(r.status).toBe(503);
      expect(body(r).error.code).toBe('COMMANDS_UNAVAILABLE');
      expect((await w.fx.audits()).filter((a) => a.action.startsWith('resource.'))).toEqual([]);
      await w.fx.close();
      await open();
      const accountId = body(await w.call(haeun, 'GET', '/resources/res_a')).account.id;
      w.commands.failFor.add(accountId);
      const f = await stop(haeun, 'res_a');
      expect(f.status).toBe(502);
      expect(body(f).error.code).toBe('COMMAND_PUBLISH_FAILED');
      expect((await w.fx.audits()).map((a) => a.action).filter((a) => a.startsWith('resource.'))).toEqual(['resource.stop_monitoring', 'resource.stop_monitoring_failed']);
    });

    it('roles: a VIEWER and a portal user who can see the resource get 403 ROLE_REQUIRED (not 404); an OPERATOR passes', async () => {
      await open();
      for (const who of [USERS.viewer, USERS.yuna]) {
        const r = await stop(who, 'res_a');
        expect(r.status).toBe(403);
        expect(body(r).error.code).toBe('ROLE_REQUIRED');
      }
      expect(w.commands.sent).toEqual([]);
      expect((await stop(haeun, 'res_a')).status).toBe(202);
    });

    it('tag_on queues SET_MONITORING_TAG { resourceId, value: "on" } when TagWriter is on; 403 CAPABILITY_DISABLED when it is off', async () => {
      await open();
      const off = await stop(haeun, 'res_a', 'tag_on');
      expect(off.status).toBe(403);
      expect(body(off).error).toMatchObject({ code: 'CAPABILITY_DISABLED', details: { role: 'tagWriter' } });
      const r = await stop(haeun, 'res_h', 'tag_on');
      expect(r.status).toBe(202);
      expect(w.commands.sent).toEqual([{ ...fixture('set-monitoring-tag'), commandId: body(r).commandId, cloudAccountId: expect.any(String), requestedAt: expect.any(String) }]);
      expect((await stop(haeun, 'res_h2', 'tag_on')).status).toBe(409); // a MONITORED resource has its tag
    });

    it('D-43: a suspended or terminated customer and a disabled account get 409 ACCOUNT_DISABLED for stop and tag_on; nothing is queued', async () => {
      const disable = async (): Promise<void> => {
        const sql = (w.fx as unknown as { sql?: { query(t: string, p?: unknown[]): Promise<unknown[]> } }).sql;
        if (sql) await sql.query(`UPDATE "CloudAccount" SET "disabled" = true WHERE "id" = 'ca_111111111111'`);
        else (w.fx.repo as unknown as MemoryApiStore).accounts.get('111111111111')!.disabled = true;
      };
      for (const how of ['SUSPENDED', 'TERMINATED', 'disabled'] as const) {
        await open();
        if (how === 'disabled') await disable(); else await w.fx.setCustomerStatus('cus_mirae', how);
        for (const action of ['stop', 'tag_on']) {
          const r = await stop(haeun, 'res_a', action);
          expect(r.status, `${how} ${action}`).toBe(409);
          expect(body(r).error.code).toBe('ACCOUNT_DISABLED');
        }
        expect(w.commands.sent, how).toEqual([]);
        expect((await w.fx.audits()).filter((a) => a.action.startsWith('resource.')), how).toEqual([]);
        await w.fx.close();
      }
    });

    it('keep is not supported yet: 409 NOT_SUPPORTED, nothing queued', async () => {
      await open();
      const r = await stop(haeun, 'res_a', 'keep');
      expect(r.status).toBe(409);
      expect(body(r).error.code).toBe('NOT_SUPPORTED');
      expect(w.commands.sent).toEqual([]);
    });

    it('rejects a bad body with 400 before any lookup', async () => {
      await open();
      for (const b of [undefined, {}, { action: 'delete' }, { action: 1 }, { action: 'stop', deleteAlarms: false }, []]) {
        expect((await w.call(haeun, 'POST', '/resources/res_a/monitoring', { body: b })).status).toBe(400);
      }
      expect(w.commands.sent).toEqual([]);
    });
  });

  describe('GET /managed-alarms', () => {
    it('lists alarms of resource + metric (no threshold in the name, D-08) with threshold, state and severity', async () => {
      await open();
      const r = await w.call(haeun, 'GET', '/managed-alarms');
      expect(ids(r)).toEqual(['alm_a1', 'alm_a2', 'alm_b1', 'alm_h1']);
      expect(body(r).outside).toBeNull();
      expect(body(r).items[0]).toMatchObject({
        id: 'alm_a1', resourceId: 'res_a', resourceName: 'api-1', resourceType: 'EC2', metricKey: 'CPUUtilization', alarmName: 'api-1 CPUUtilization', severity: 'SEV_2',
        threshold: 80.5, thresholdSource: 'CODE', evalM: 3, evalN: 5, state: 'ALARM', driftStatus: 'IN_SYNC', org: { customer: { slug: 'mirae' }, service: { slug: 'payments-api' } },
      });
    });

    it('scope, state and severity filters; `outside` as in /resources; portal users see only their customer', async () => {
      await open();
      const mirae = await w.call(haeun, 'GET', '/managed-alarms', { query: { customer: 'mirae' } });
      expect(ids(mirae)).toEqual(['alm_a1', 'alm_a2', 'alm_b1']);
      expect(body(mirae).outside).toEqual({ needsReview: 1, inAlarm: 1 });
      expect(ids(await w.call(haeun, 'GET', '/managed-alarms', { query: { state: 'ALARM' } }))).toEqual(['alm_a1', 'alm_h1']);
      expect(ids(await w.call(haeun, 'GET', '/managed-alarms', { query: { severity: 'SEV_1' } }))).toEqual(['alm_h1']);
      expect(ids(await w.call(haeun, 'GET', '/managed-alarms', { query: { resourceId: 'res_b' } }))).toEqual(['alm_b1']);
      const portal = await w.call(USERS.yuna, 'GET', '/managed-alarms');
      expect(ids(portal)).toEqual(['alm_a1', 'alm_a2', 'alm_b1']);
      const text = JSON.stringify(portal.body);
      for (const leak of ['hanbit', 'alm_h1', 'res_h', '222222222222']) expect(text).not.toContain(leak);
      expect(ids(await w.call(USERS.yuna, 'GET', '/managed-alarms', { query: { resourceId: 'res_h2' } }))).toEqual([]);
      for (const bad of [{ state: 'x' }, { severity: 'SEV_9' }]) expect((await w.call(haeun, 'GET', '/managed-alarms', { query: bad })).status).toBe(400);
    });

    it('pages by cursor', async () => {
      await open();
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const r = await w.call(haeun, 'GET', '/managed-alarms', { query: { limit: '3', cursor } });
        seen.push(...ids(r));
        cursor = body(r).nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toEqual(['alm_a1', 'alm_a2', 'alm_b1', 'alm_h1']);
    });
  });
}
