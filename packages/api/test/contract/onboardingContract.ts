/**
 * Contract suite of the onboarding API (hkjs96/alarmops#62): POST /customers, accounts (+check, status), contacts and
 * channel verification — the SAME tests against MemoryApiStore and the SQL store. Tenant isolation, role rules, ExternalId,
 * one-time links with only a hash stored, and what a link request does today (no sender: 503, nothing written).
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { T0 } from '../../../core/test/world.js';
import { loggablePath, MemoryApiStore, type AuthContext, type VerificationSender } from '../../src/index.js';
import { USERS, body, wire } from '../helpers.js';
import { cworld, type CWorld, type MakeApiFixture } from './apiContract.js';

const HANBIT_ADMIN: AuthContext = { userId: 'usr_hb', name: 'Hanbit Admin', kind: 'INTERNAL', customerIds: ['cus_hanbit'], role: 'ADMIN' }; // staff narrowed to one customer
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

class FakeVerificationSender implements VerificationSender {
  sent: Array<{ channel: string; to: string; contactId: string; token: string }> = [];
  fail = false;
  async send(m: Parameters<VerificationSender['send']>[0]): Promise<void> {
    if (this.fail) throw new Error('smtp exploded at secret-host.internal');
    this.sent.push({ channel: m.channel, to: m.to, contactId: m.contactId, token: m.token });
  }
}

const SQL_ERR = /secret-host/;

export function onboardingContract(make: MakeApiFixture): void {
  let w: CWorld;
  let sender: FakeVerificationSender;
  const open = async (o: { sender?: boolean; grants?: boolean; resources?: string[] } = {}): Promise<CWorld> => {
    sender = new FakeVerificationSender();
    return (w = await cworld(make, (s: MemoryApiStore) => {
      if (o.grants !== false) s.portalGrantsOf.set('cus_mirae', ['contacts']);
      for (const a of o.resources ?? []) s.accountsWithResources.add(a);
    }, o.sender === false ? {} : { verification: sender }));
  };
  afterEach(async () => { await w?.fx.close(); });
  const admin = USERS.minjae;
  const accounts = async (cid = 'cus_mirae') => body(await w.call(admin, 'GET', `/customers/${cid}/accounts`)).items as any[];
  /** Raw column access for what the API does not return (statuses, tokens). */
  const raw = async (text: string, params: unknown[] = []): Promise<any[] | null> => {
    const sql = (w.fx as unknown as { sql?: { query(t: string, p?: unknown[]): Promise<any[]> } }).sql;
    return sql ? sql.query(text, params) : null;
  };
  const memory = (): MemoryApiStore | null => (w.fx.kind === 'memory' ? (w.fx.repo as unknown as MemoryApiStore) : null);
  const tokenHashes = async (): Promise<string[]> => {
    const rows = await raw(`SELECT "tokenHash" FROM "ChannelVerification"`);
    return rows ? rows.map((r) => r.tokenHash) : [...memory()!.verifications.keys()];
  };
  const mkContact = async (extra: Record<string, unknown> = {}, who: AuthContext = admin) =>
    body(await w.call(who, 'POST', '/contacts', { body: { kind: 'CUSTOMER', customerId: 'cus_mirae', name: 'Ji-ho Kang', email: 'jiho@mirae.example', phone: '+821055556666', ...extra } }));
  const listed = async (who: AuthContext = admin, query: Record<string, string> = {}) => body(await w.call(who, 'GET', '/contacts', { query })).items as any[];

  // ───────────────────────────── customers ─────────────────────────────
  describe('POST /customers', () => {
    it('creates a customer with a slug from the name, appears in the scope tree, audited', async () => {
      await open();
      const r = await w.call(admin, 'POST', '/customers', { body: { name: 'Daon Bank', loginDomains: ['Daon.example', 'daon.co.kr'] } });
      expect(r.status).toBe(201);
      expect(body(r)).toMatchObject({ name: 'Daon Bank', slug: 'daon-bank', status: 'ACTIVE', loginDomains: ['daon.example', 'daon.co.kr'] });
      const tree = body(await w.call(admin, 'GET', '/scope-tree')).customers;
      expect(tree.map((c: any) => c.slug)).toContain('daon-bank');
      const a = (await w.fx.audits()).find((x) => x.action === 'customer.create')!;
      expect(a).toMatchObject({ customerId: body(r).id, targetId: body(r).id, actorType: 'USER', actorId: 'usr_minjae' });
    });

    it('a Korean-only name gets "customer" (+ suffix when taken); reserved or malformed slugs are 400, taken ones 409', async () => {
      await open();
      const a = body(await w.call(admin, 'POST', '/customers', { body: { name: '다온은행' } }));
      const b = body(await w.call(admin, 'POST', '/customers', { body: { name: '미래은행' } }));
      expect([a.slug, b.slug]).toEqual(['customer', 'customer-2']);
      expect((await w.call(admin, 'POST', '/customers', { body: { name: 'X1', slug: 'settings' } })).status).toBe(400);
      expect((await w.call(admin, 'POST', '/customers', { body: { name: 'X2', slug: 'Bad Slug' } })).status).toBe(400);
      expect((await w.call(admin, 'POST', '/customers', { body: { name: 'X3', slug: 'mirae' } })).status).toBe(409);
    });

    it('duplicate name (any case) and duplicate login domain are 409 ALREADY_EXISTS; nothing is written', async () => {
      await open();
      const dup = await w.call(admin, 'POST', '/customers', { body: { name: 'MIRAE PAY' } });
      expect(dup.status).toBe(409);
      expect(body(dup).error.code).toBe('ALREADY_EXISTS');
      await w.call(admin, 'POST', '/customers', { body: { name: 'A One', loginDomains: ['aone.example'] } });
      const d2 = await w.call(admin, 'POST', '/customers', { body: { name: 'A Two', loginDomains: ['aone.example'] } });
      expect([d2.status, body(d2).error.code]).toEqual([409, 'ALREADY_EXISTS']);
      expect(body(await w.call(admin, 'GET', '/scope-tree')).customers.map((c: any) => c.name)).not.toContain('A Two');
    });

    it('validates the body: unknown keys, name, domains', async () => {
      await open();
      for (const b of [{ name: 'Ok', status: 'ACTIVE' }, { name: '' }, { name: 'x'.repeat(81) }, { name: 'Ok', loginDomains: ['not a domain'] }, { name: 'Ok', loginDomains: 'a.example' }, { name: 'Ok', loginDomains: new Array(11).fill('a.example') }, 'text']) {
        const r = await w.call(admin, 'POST', '/customers', { body: b });
        expect([b, r.status]).toEqual([b, 400]);
      }
    });

    it('roles: OPERATOR/VIEWER 403, staff narrowed to some customers 403, portal user 404 (no such route), no session 401', async () => {
      await open();
      const b = { name: 'Nope Co' };
      expect((await w.call(USERS.haeun, 'POST', '/customers', { body: b })).status).toBe(403);
      expect((await w.call(USERS.viewer, 'POST', '/customers', { body: b })).status).toBe(403);
      expect((await w.call(HANBIT_ADMIN, 'POST', '/customers', { body: b })).status).toBe(403);
      expect((await w.call(USERS.yuna, 'POST', '/customers', { body: b })).status).toBe(404);
      expect((await w.call(null, 'POST', '/customers', { body: b })).status).toBe(401);
      expect(body(await w.call(admin, 'GET', '/scope-tree')).customers.map((c: any) => c.name)).not.toContain('Nope Co');
    });

    it('Idempotency-Key replays the first answer: one customer', async () => {
      await open();
      const h = { 'idempotency-key': 'k-cus-1' };
      const a = await w.call(admin, 'POST', '/customers', { body: { name: 'Once Co' }, headers: h });
      const b = await w.call(admin, 'POST', '/customers', { body: { name: 'Once Co' }, headers: h });
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(body(b).id).toBe(body(a).id);
    });
  });

  // ───────────────────────────── accounts ─────────────────────────────
  describe('accounts', () => {
    const newAcc = (extra: Record<string, unknown> = {}) => ({ awsAccountId: '333333333333', alias: 'prd-main', environment: 'PRD', ...extra });

    it('registers an account: server-made ExternalId, derived role ARNs, capability toggles, audit without the ExternalId', async () => {
      await open();
      const r = await w.call(admin, 'POST', '/customers/cus_mirae/accounts', { body: newAcc({ serviceId: 'svc_pay', alarmWriterEnabled: true, remediatorEnabled: false }) });
      expect(r.status).toBe(201);
      const a = body(r);
      expect(a).toMatchObject({
        customerId: 'cus_mirae', serviceId: 'svc_pay', awsAccountId: '333333333333', alias: 'prd-main', environment: 'PRD', regions: ['ap-northeast-2'],
        readerRoleArn: 'arn:aws:iam::333333333333:role/AlarmOps-Reader', eventForwarderRoleArn: 'arn:aws:iam::333333333333:role/AlarmOps-EventForwarder',
        alarmWriterRoleArn: 'arn:aws:iam::333333333333:role/AlarmOps-AlarmWriter', tagWriterRoleArn: null, remediatorRoleArn: null,
        alarmWriterEnabled: true, tagWriterEnabled: false, remediatorEnabled: false,
      });
      expect(a.externalId).toMatch(/^ao-[0-9a-f]{64}$/);
      const b = body(await w.call(admin, 'POST', '/customers/cus_hanbit/accounts', { body: { awsAccountId: '444444444444' } }));
      expect(b.externalId).not.toBe(a.externalId);
      expect(b).toMatchObject({ alarmWriterEnabled: false, tagWriterEnabled: false, remediatorEnabled: false, serviceId: null, regions: ['ap-northeast-2'] });
      // listed with the ExternalId (the customer needs it for the stack) — and nowhere in the audit trail
      expect((await accounts()).find((x) => x.awsAccountId === '333333333333').externalId).toBe(a.externalId);
      const audits = (await w.fx.audits()).filter((x) => x.action === 'account.create');
      expect(audits).toHaveLength(2);
      expect(JSON.stringify(audits)).not.toContain(a.externalId);
      expect(JSON.stringify(audits)).not.toContain('externalId');
    });

    it('never accepts an ExternalId or a role ARN from the client; validates the 12 digits, region, environment', async () => {
      await open();
      const bad: Array<Record<string, unknown>> = [
        newAcc({ externalId: 'mine' }), newAcc({ readerRoleArn: 'arn:aws:iam::999999999999:role/AlarmOps-Reader' }), newAcc({ alarmWriterRoleArn: 'x' }),
        { awsAccountId: '12345678901' }, { awsAccountId: '1234567890123' }, { awsAccountId: 123456789012 }, { awsAccountId: '12345678901a' }, {},
        newAcc({ regions: [] }), newAcc({ regions: ['mars-1'] }), newAcc({ environment: 'PROD' }), newAcc({ tagWriterEnabled: 'yes' }), newAcc({ alias: 'x'.repeat(65) }), newAcc({ extra: 1 }),
      ];
      for (const b of bad) {
        const r = await w.call(admin, 'POST', '/customers/cus_mirae/accounts', { body: b });
        expect([b, r.status]).toEqual([b, 400]);
      }
      expect(await accounts()).toHaveLength(1); // only the seeded one
    });

    it('an AWS account is registered once: the answer for another customer’s account says nothing about that customer', async () => {
      await open();
      const r = await w.call(admin, 'POST', '/customers/cus_hanbit/accounts', { body: { awsAccountId: '111111111111' } }); // Mirae's
      expect(r.status).toBe(409);
      expect(body(r).error).toMatchObject({ code: 'ALREADY_EXISTS', details: {} });
      expect(JSON.stringify(r.body)).not.toMatch(/mirae|cus_mirae/i);
    });

    it('a service of another customer is the same 404 as one that does not exist', async () => {
      await open();
      const foreign = await w.call(admin, 'POST', '/customers/cus_mirae/accounts', { body: newAcc({ serviceId: 'svc_web' }), requestId: 'req_same' });
      const missing = await w.call(admin, 'POST', '/customers/cus_mirae/accounts', { body: newAcc({ serviceId: 'svc_nope' }), requestId: 'req_same' });
      expect(foreign.status).toBe(404);
      expect(wire(foreign)).toBe(wire(missing));
      expect(await accounts()).toHaveLength(1);
    });

    it('roles and isolation: OPERATOR 403, portal 404 on every account route, staff narrowed to Hanbit gets Mirae’s account as an unknown id', async () => {
      await open();
      const accId = (await accounts())[0].id;
      expect((await w.call(USERS.haeun, 'POST', '/customers/cus_mirae/accounts', { body: newAcc() })).status).toBe(403);
      expect((await w.call(USERS.haeun, 'GET', '/customers/cus_mirae/accounts')).status).toBe(403);
      for (const [m, p] of [['GET', '/customers/cus_mirae/accounts'], ['POST', '/customers/cus_mirae/accounts'], ['PATCH', `/accounts/${accId}`], ['DELETE', `/accounts/${accId}`], ['POST', `/accounts/${accId}/check`], ['GET', `/accounts/${accId}/status`]] as const) {
        expect([m, p, (await w.call(USERS.yuna, m, p, { body: newAcc({ alias: 'x' }) })).status]).toEqual([m, p, 404]);
      }
      const snap = await w.snapshot();
      const foreign = [
        await w.call(HANBIT_ADMIN, 'GET', `/accounts/${accId}/status`, { requestId: 'req_same' }), await w.call(HANBIT_ADMIN, 'PATCH', `/accounts/${accId}`, { body: { alias: 'z' }, requestId: 'req_same' }),
        await w.call(HANBIT_ADMIN, 'DELETE', `/accounts/${accId}`, { requestId: 'req_same' }), await w.call(HANBIT_ADMIN, 'POST', `/accounts/${accId}/check`, { requestId: 'req_same' }),
      ];
      const missing = [
        await w.call(HANBIT_ADMIN, 'GET', '/accounts/acc_nope/status', { requestId: 'req_same' }), await w.call(HANBIT_ADMIN, 'PATCH', '/accounts/acc_nope', { body: { alias: 'z' }, requestId: 'req_same' }),
        await w.call(HANBIT_ADMIN, 'DELETE', '/accounts/acc_nope', { requestId: 'req_same' }), await w.call(HANBIT_ADMIN, 'POST', '/accounts/acc_nope/check', { requestId: 'req_same' }),
      ];
      foreign.forEach((r, i) => { expect(r.status).toBe(404); expect(wire(r)).toBe(wire(missing[i]!)); });
      expect((await w.call(HANBIT_ADMIN, 'GET', '/customers/cus_mirae/accounts')).status).toBe(404);
      expect(await w.snapshot()).toBe(snap);
      expect(w.commands.sent).toHaveLength(0);
    });

    it('PATCH: toggles set or clear the derived ARN, alias/environment/regions change, unknown keys and an empty body are 400', async () => {
      await open();
      const id = (await accounts())[0].id;
      const r = await w.call(admin, 'PATCH', `/accounts/${id}`, { body: { tagWriterEnabled: true, alias: 'main', environment: 'STG', regions: ['ap-northeast-2', 'us-east-1'] } });
      expect(body(r)).toMatchObject({ tagWriterEnabled: true, tagWriterRoleArn: 'arn:aws:iam::111111111111:role/AlarmOps-TagWriter', alias: 'main', environment: 'STG', regions: ['ap-northeast-2', 'us-east-1'] });
      const off = await w.call(admin, 'PATCH', `/accounts/${id}`, { body: { tagWriterEnabled: false, alias: null } });
      expect(body(off)).toMatchObject({ tagWriterEnabled: false, tagWriterRoleArn: null, alias: null });
      for (const b of [{}, { externalId: 'x' }, { awsAccountId: '999999999999' }, { remediatorRoleArn: 'arn:x' }, { serviceId: 'svc_web' }]) {
        const x = await w.call(admin, 'PATCH', `/accounts/${id}`, { body: b });
        expect([b, x.status === 400 || x.status === 404]).toEqual([b, true]);
      }
      expect(body(await w.call(admin, 'PATCH', `/accounts/${id}`, { body: { serviceId: null } })).serviceId).toBeNull();
      expect((await w.fx.audits()).filter((a) => a.action === 'account.update')).toHaveLength(3);
      expect(JSON.stringify(await w.fx.audits())).not.toContain('ext-');
    });

    it('a TERMINATED customer cannot get or change accounts', async () => {
      await open();
      const id = (await accounts())[0].id;
      await w.fx.setCustomerStatus('cus_mirae', 'TERMINATED');
      expect((await w.call(admin, 'POST', '/customers/cus_mirae/accounts', { body: newAcc() })).status).toBe(409);
      expect((await w.call(admin, 'PATCH', `/accounts/${id}`, { body: { alias: 'x' } })).status).toBe(409);
      expect((await w.call(admin, 'DELETE', `/accounts/${id}`)).status).toBe(409);
      expect((await w.call(admin, 'POST', `/accounts/${id}/check`)).status).toBe(409);
    });

    it('DELETE removes an account nothing was created for; one with resources is 409 IN_USE', async () => {
      await open({ resources: ['222222222222'] });
      const fresh = body(await w.call(admin, 'POST', '/customers/cus_mirae/accounts', { body: newAcc() }));
      expect((await w.call(admin, 'DELETE', `/accounts/${fresh.id}`)).status).toBe(200);
      expect((await w.call(admin, 'DELETE', `/accounts/${fresh.id}`)).status).toBe(404);
      const used = (await accounts('cus_hanbit'))[0];
      const r = await w.call(admin, 'DELETE', `/accounts/${used.id}`);
      expect([r.status, body(r).error.code]).toEqual([409, 'IN_USE']);
      expect(await accounts('cus_hanbit')).toHaveLength(1);
      expect((await w.fx.audits()).filter((a) => a.action === 'account.delete')).toHaveLength(1);
    });

    it('check: publishes CHECK_CONNECTION for this account and customer, 202 { commandId }, audited; each click is a new command', async () => {
      await open();
      const id = (await accounts())[0].id;
      const r = await w.call(admin, 'POST', `/accounts/${id}/check`);
      expect(r.status).toBe(202);
      expect(Object.keys(body(r))).toEqual(['commandId']);
      const again = await w.call(admin, 'POST', `/accounts/${id}/check`);
      expect(body(again).commandId).not.toBe(body(r).commandId);
      expect(w.commands.sent).toHaveLength(2);
      expect(w.commands.sent[0]).toMatchObject({ schemaVersion: 1, type: 'CHECK_CONNECTION', customerId: 'cus_mirae', cloudAccountId: id, commandId: body(r).commandId, requestedBy: { type: 'USER', id: 'usr_minjae' }, payload: {} });
      expect(JSON.stringify(w.commands.sent)).not.toMatch(/externalId|ao-/);
      expect((await w.fx.audits()).filter((a) => a.action === 'account.check')).toHaveLength(2);
      expect((await w.call(USERS.haeun, 'POST', `/accounts/${id}/check`)).status).toBe(403);
    });

    it('check without a command publisher is 503 COMMANDS_UNAVAILABLE; a failing publisher is 502 with no queue text', async () => {
      await open();
      const id = (await accounts())[0].id;
      const { createApi } = await import('../../src/index.js');
      const bare = createApi({ repo: w.fx.repo, now: () => w.sim.now });
      const r = await bare.handle({ method: 'POST', path: `/accounts/${id}/check`, auth: admin, requestId: 'r1' });
      expect([r.status, (r.body as any).error.code]).toEqual([503, 'COMMANDS_UNAVAILABLE']);
      w.commands.failFor.add(id);
      const f = await w.call(admin, 'POST', `/accounts/${id}/check`);
      expect([f.status, body(f).error.code]).toEqual([502, 'COMMAND_PUBLISH_FAILED']);
      expect(JSON.stringify(f.body)).not.toMatch(/simulated|sqs\.|https:/i);
      expect((await w.fx.audits()).filter((a) => a.action === 'account.check_failed')).toHaveLength(1);
    });

    it('status: five roles with required/enabled, nothing checked yet = UNKNOWN; VIEWER may read; no ExternalId', async () => {
      await open();
      const id = (await accounts())[0].id;
      const r = await w.call(USERS.viewer, 'GET', `/accounts/${id}/status`);
      expect(r.status).toBe(200);
      expect(body(r)).toMatchObject({ accountId: id, customerId: 'cus_mirae', awsAccountId: '111111111111', lastCheckedAt: null });
      expect(body(r).roles).toEqual([
        { key: 'reader', required: true, enabled: true, status: 'UNKNOWN', basis: 'CHECK' }, { key: 'eventForwarder', required: true, enabled: true, status: expect.any(String), basis: expect.any(String) },
        { key: 'alarmWriter', required: false, enabled: false, status: 'UNKNOWN', basis: 'CHECK' }, { key: 'tagWriter', required: false, enabled: false, status: 'UNKNOWN', basis: 'CHECK' },
        { key: 'remediator', required: false, enabled: false, status: 'UNKNOWN', basis: 'CHECK' },
      ]);
      expect(JSON.stringify(r.body)).not.toMatch(/externalId|ao-|ext-/);
    });

    it('status shows what the engine wrote (role results, lastCheckedAt) and the events seen; EventForwarder counts as OK once events arrived', async () => {
      await open();
      const id = (await accounts())[0].id;
      const checked = new Date(T0.getTime() + 60_000);
      const first = new Date(T0.getTime() - 3600_000);
      const m = memory();
      if (m) {
        const meta = m.accountMeta;
        const cur = (await m.listAccounts('cus_mirae'))[0]!;
        const { id: _i, customerId: _c, serviceId: _s, awsAccountId: _a, disabled: _d, connectionPurged: _p, ...rest } = cur;
        meta.set(id, { ...rest, readerStatus: 'OK', alarmWriterStatus: 'DENIED', tagWriterStatus: 'MISSING', lastCheckedAt: checked, firstEventAt: first, lastEventAt: checked });
      } else {
        await raw(`UPDATE "CloudAccount" SET "readerStatus" = 'OK', "alarmWriterStatus" = 'DENIED', "tagWriterStatus" = 'MISSING', "lastCheckedAt" = $2::timestamptz, "firstEventAt" = $3::timestamptz, "lastEventAt" = $2::timestamptz WHERE "id" = $1`, [id, checked.toISOString(), first.toISOString()]);
      }
      const s = body(await w.call(admin, 'GET', `/accounts/${id}/status`));
      expect(s.lastCheckedAt).toBe(checked.toISOString());
      expect(s.firstEventAt).toBe(first.toISOString());
      expect(s.roles.map((r: any) => [r.key, r.status, r.basis])).toEqual([['reader', 'OK', 'CHECK'], ['eventForwarder', 'OK', 'EVENTS'], ['alarmWriter', 'DENIED', 'CHECK'], ['tagWriter', 'MISSING', 'CHECK'], ['remediator', 'UNKNOWN', 'CHECK']]);
    });
  });

  // ───────────────────────────── contacts ─────────────────────────────
  describe('contacts', () => {
    it('creates, lists (masked, never the full value), edits and deletes a customer person; audit rows carry no contact value', async () => {
      await open();
      const r = await w.call(admin, 'POST', '/contacts', { body: { kind: 'CUSTOMER', customerId: 'cus_mirae', name: 'Ji-ho Kang', email: 'jiho@mirae.example', phone: '+821055556666' } });
      expect(r.status).toBe(201);
      const c = body(r);
      expect(c).toMatchObject({ kind: 'CUSTOMER', name: 'Ji-ho Kang', active: true, org: { customer: { id: 'cus_mirae', slug: 'mirae' } }, emailMasked: 'j•••@mirae.example', phoneMasked: '821-••••-6666', canReveal: true, revealRequiresReason: true });
      expect(c.channels.EMAIL.status).toBe('UNVERIFIED');
      expect(JSON.stringify(r.body)).not.toMatch(/jiho@|1055556666/);
      const list = await w.call(admin, 'GET', '/contacts', { query: { customer: 'mirae' } });
      expect(JSON.stringify(list.body)).not.toMatch(/jiho@|1055556666|yuna@|seojun@/); // masked values only
      expect(body(list).items.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Ji-ho Kang', 'Yuna Seo', 'Seojun Bae', 'Haeun Kim', 'Junho Park']));
      expect(body(list).items.map((x: any) => x.name)).not.toContain('Dohyun Han');
      const p = await w.call(admin, 'PATCH', `/contacts/${c.id}`, { body: { name: 'Jiho Kang' } });
      expect(body(p).name).toBe('Jiho Kang');
      const d = await w.call(admin, 'DELETE', `/contacts/${c.id}`);
      expect(d.status).toBe(200);
      expect((await w.call(admin, 'DELETE', `/contacts/${c.id}`)).status).toBe(404);
      const audits = (await w.fx.audits()).filter((a) => a.action.startsWith('contact.'));
      expect(audits.map((a) => a.action)).toEqual(['contact.create', 'contact.update', 'contact.delete']);
      expect(JSON.stringify(audits)).not.toMatch(/jiho@|1055556666/);
    });

    it('INTERNAL staff contacts: MSP ADMIN creates; filters kind / q / needsAction / paging work', async () => {
      await open();
      const s = await w.call(admin, 'POST', '/contacts', { body: { kind: 'INTERNAL', name: 'Night Desk Lead', email: 'lead@msp.example' } });
      expect(s.status).toBe(201);
      expect(body(s)).toMatchObject({ kind: 'INTERNAL', customerCount: 0 });
      expect((await w.call(admin, 'POST', '/contacts', { body: { kind: 'INTERNAL', customerId: 'cus_mirae', name: 'Bad', email: 'b@x.example' } })).status).toBe(400);
      expect((await listed(admin, { kind: 'INTERNAL' })).map((x) => x.name)).toEqual(['Haeun Kim', 'Junho Park', 'Minjae Lee', 'Night Desk Lead']);
      expect((await listed(admin, { q: 'yuna' })).map((x) => x.name)).toEqual(['Yuna Seo']);
      expect((await listed(admin, { needsAction: 'true' })).map((x) => x.name)).toEqual(['Night Desk Lead']); // the seeded people are all verified
      const p1 = body(await w.call(admin, 'GET', '/contacts', { query: { limit: '3' } }));
      expect(p1.items).toHaveLength(3);
      const p2 = body(await w.call(admin, 'GET', '/contacts', { query: { limit: '3', cursor: p1.nextCursor } }));
      expect(p2.items.length).toBeGreaterThan(0);
      expect(new Set([...p1.items, ...p2.items].map((x: any) => x.id)).size).toBe(p1.items.length + p2.items.length);
      expect((await w.call(admin, 'GET', '/contacts', { query: { kind: 'BOSS' } })).status).toBe(400);
      expect((await w.call(admin, 'GET', '/contacts', { query: { customer: 'nope' } })).status).toBe(404);
    });

    it('validation: name, values, at least one channel, unknown keys, bad customer', async () => {
      await open();
      const bads: Array<Record<string, unknown>> = [
        { name: '', email: 'a@b.example' }, { name: 'A', email: 'not-an-email' }, { name: 'A', phone: 'abc' }, { name: 'A', slackUserId: 'nope' }, { name: 'A' },
        { name: 'A', email: 'a@b.example', role: 'ADMIN' }, { name: 'A', email: 'a@b.example', customerId: 5 }, { kind: 'CUSTOMER', name: 'A', email: 'a@b.example' },
      ];
      for (const b of bads) {
        const r = await w.call(admin, 'POST', '/contacts', { body: { kind: 'CUSTOMER', ...(('kind' in b) ? {} : { customerId: 'cus_mirae' }), ...b } });
        expect([b, r.status]).toEqual([b, 400]);
      }
      expect((await w.call(admin, 'POST', '/contacts', { body: { kind: 'CUSTOMER', customerId: 'cus_nope', name: 'A', email: 'a@b.example' } })).status).toBe(404);
    });

    it('a Slack user belongs to one contact (409); roles: OPERATOR 403, no session 401', async () => {
      await open();
      expect((await mkContact({ email: undefined, phone: undefined, slackUserId: 'U0ABCDEF1', name: 'S One' })).id).toBeTruthy();
      const r = await w.call(admin, 'POST', '/contacts', { body: { kind: 'CUSTOMER', customerId: 'cus_hanbit', name: 'S Two', slackUserId: 'U0ABCDEF1' } });
      expect([r.status, body(r).error.code]).toEqual([409, 'ALREADY_EXISTS']);
      expect((await w.call(USERS.haeun, 'GET', '/contacts')).status).toBe(403);
      expect((await w.call(USERS.haeun, 'POST', '/contacts', { body: { kind: 'CUSTOMER', customerId: 'cus_mirae', name: 'A', email: 'a@b.example' } })).status).toBe(403);
      expect((await w.call(null, 'GET', '/contacts')).status).toBe(401);
    });

    it('editing a value clears that channel’s verification; DELETE refuses a responder; deactivating works', async () => {
      await open();
      // Yuna is a verified Pageable responder of Mirae
      const yuna = (await listed(admin, { q: 'yuna' }))[0];
      expect(yuna.channels.EMAIL.status).toBe('VERIFIED');
      const p = await w.call(admin, 'PATCH', `/contacts/${yuna.id}`, { body: { email: 'yuna.new@mirae.example' } });
      expect(body(p).channels.EMAIL.status).toBe('UNVERIFIED');
      expect(body(p).channels.SMS.status).toBe('VERIFIED'); // the phone did not change
      const same = await w.call(admin, 'PATCH', `/contacts/${yuna.id}`, { body: { phone: body(await w.call(admin, 'POST', `/contacts/${yuna.id}/reveal`, { body: { channel: 'PHONE', reason: 'test' } })).value } });
      expect(body(same).channels.SMS.status).toBe('VERIFIED'); // the same value is no change
      const del = await w.call(admin, 'DELETE', `/contacts/${yuna.id}`);
      expect([del.status, body(del).error.code]).toEqual([409, 'IN_USE']);
      expect((await w.call(admin, 'PATCH', `/contacts/${yuna.id}`, { body: { email: null, phone: null, slackUserId: null } })).status).toBe(400); // must keep a channel
      expect(body(await w.call(admin, 'PATCH', `/contacts/${yuna.id}`, { body: { active: false } })).active).toBe(false);
    });

    it('portal user with the contacts grant: only the own customer’s people; no staff; foreign ids are the same 404; without the grant 403', async () => {
      await open();
      const mine = await w.call(USERS.yuna, 'GET', '/contacts');
      expect(mine.status).toBe(200);
      const names = body(mine).items.map((x: any) => x.name).sort();
      expect(names).toEqual(['Seojun Bae', 'Yuna Seo']);
      expect(JSON.stringify(mine.body)).not.toMatch(/Haeun|Junho|Minjae|Dohyun|Sora|hanbit/i);
      const made = await w.call(USERS.yuna, 'POST', '/contacts', { body: { name: 'New Teammate', email: 'nt@mirae.example' } }); // customer is implied (one customer)
      expect(made.status).toBe(201);
      expect(body(made).org.customer.id).toBe('cus_mirae');
      expect((await w.call(USERS.yuna, 'POST', '/contacts', { body: { kind: 'INTERNAL', name: 'Staff', email: 's@x.example' } })).status).toBe(404);
      expect((await w.call(USERS.yuna, 'POST', '/contacts', { body: { customerId: 'cus_hanbit', name: 'X', email: 'x@x.example' } })).status).toBe(404);
      const sora = await w.call(admin, 'GET', '/contacts', { query: { customer: 'hanbit' } });
      const soraId = body(sora).items.find((x: any) => x.name === 'Sora Lim').id;
      const foreign = [await w.call(USERS.yuna, 'PATCH', `/contacts/${soraId}`, { body: { name: 'x' }, requestId: 'req_same' }), await w.call(USERS.yuna, 'DELETE', `/contacts/${soraId}`, { requestId: 'req_same' }), await w.call(USERS.yuna, 'POST', `/contacts/${soraId}/verify`, { body: { channel: 'EMAIL', method: 'link' }, requestId: 'req_same' })];
      const missing = [await w.call(USERS.yuna, 'PATCH', '/contacts/ct_nope', { body: { name: 'x' }, requestId: 'req_same' }), await w.call(USERS.yuna, 'DELETE', '/contacts/ct_nope', { requestId: 'req_same' }), await w.call(USERS.yuna, 'POST', '/contacts/ct_nope/verify', { body: { channel: 'EMAIL', method: 'link' }, requestId: 'req_same' })];
      foreign.forEach((r, i) => { expect(r.status).toBe(404); expect(wire(r)).toBe(wire(missing[i]!)); });
      // staff are not visible to the portal even by id
      const haeun = body(await w.call(admin, 'GET', '/contacts', { query: { kind: 'INTERNAL' } })).items.find((x: any) => x.name === 'Haeun Kim').id;
      expect((await w.call(USERS.yuna, 'PATCH', `/contacts/${haeun}`, { body: { name: 'x' } })).status).toBe(404);
      // Hanbit never granted `contacts`
      const noGrant = await w.call(USERS.dohyun, 'GET', '/contacts');
      expect([noGrant.status, body(noGrant).error.code]).toEqual([403, 'PORTAL_GRANT_REQUIRED']);
      expect((await w.call(USERS.dohyun, 'POST', '/contacts', { body: { name: 'X', email: 'x@x.example' } })).status).toBe(403);
    });

    it('staff narrowed to Hanbit cannot see, list or touch Mirae’s people', async () => {
      await open();
      const mirae = (await listed(admin, { customer: 'mirae' })).find((x) => x.name === 'Yuna Seo');
      const r = await w.call(HANBIT_ADMIN, 'GET', '/contacts');
      expect(JSON.stringify(r.body)).not.toMatch(/Yuna|Seojun/);
      expect((await w.call(HANBIT_ADMIN, 'GET', '/contacts', { query: { customer: 'mirae' } })).status).toBe(404);
      const a = await w.call(HANBIT_ADMIN, 'PATCH', `/contacts/${mirae.id}`, { body: { name: 'x' }, requestId: 'req_same' });
      const b = await w.call(HANBIT_ADMIN, 'PATCH', '/contacts/ct_nope', { body: { name: 'x' }, requestId: 'req_same' });
      expect(a.status).toBe(404);
      expect(wire(a)).toBe(wire(b));
      expect((await w.call(HANBIT_ADMIN, 'POST', '/contacts', { body: { customerId: 'cus_mirae', name: 'X', email: 'x@x.example' } })).status).toBe(404);
    });
  });

  it('the log never sees a verification token in a path', () => {
    expect(loggablePath('/api/v1/verify/vf_abc?x=1')).toBe('/api/v1/verify/[token]?x=1');
    expect(loggablePath('/verify/vf_abc')).toBe('/verify/[token]');
    expect(loggablePath('/contacts/ct_1')).toBe('/contacts/ct_1');
  });

  describe('B-1: staff contacts belong to every customer they serve', () => {
    it('a customer-scoped ADMIN lists only the staff who serve its customers, read-only; every write on any staff contact is a 404 and changes nothing', async () => {
      await open();
      const staff = await listed(admin, { kind: 'INTERNAL' });
      const id = (n: string) => staff.find((x) => x.name === n).id;
      const seen = await w.call(HANBIT_ADMIN, 'GET', '/contacts', { query: { kind: 'INTERNAL' } });
      expect(body(seen).items.map((x: any) => x.name)).toEqual(['Minjae Lee']); // Mirae's engineers are not visible
      expect(JSON.stringify(seen.body)).not.toMatch(/Haeun|Junho/);
      const before = JSON.stringify([await listed(admin, { kind: 'INTERNAL' }), (await w.fx.audits()).length]);
      for (const name of ['Haeun Kim', 'Minjae Lee']) { // another customer's engineer, and one who serves this customer (read-only)
        const calls = [
          await w.call(HANBIT_ADMIN, 'PATCH', `/contacts/${id(name)}`, { body: { phone: '+821000000001' }, requestId: 'req_same' }),
          await w.call(HANBIT_ADMIN, 'POST', `/contacts/${id(name)}/verify`, { body: { channel: 'SMS', method: 'manual' }, requestId: 'req_same' }),
          await w.call(HANBIT_ADMIN, 'POST', `/contacts/${id(name)}/verify`, { body: { channel: 'EMAIL', method: 'link' }, requestId: 'req_same' }),
          await w.call(HANBIT_ADMIN, 'DELETE', `/contacts/${id(name)}`, { requestId: 'req_same' }),
          await w.call(HANBIT_ADMIN, 'POST', '/contacts/verify-bulk', { body: { contactIds: [id(name)] }, requestId: 'req_same' }),
        ];
        const miss = await w.call(HANBIT_ADMIN, 'PATCH', '/contacts/ct_nope', { body: { phone: '+821000000001' }, requestId: 'req_same' });
        for (const c of calls) { expect([name, c.status]).toEqual([name, 404]); }
        expect(wire(calls[0]!)).toBe(wire(miss));
      }
      expect((await w.call(HANBIT_ADMIN, 'POST', '/contacts', { body: { kind: 'INTERNAL', name: 'Fake Engineer', email: 'f@x.example' } })).status).toBe(404);
      const bulk = await w.call(HANBIT_ADMIN, 'POST', '/contacts/verify-bulk', { body: { filter: 'needsAction', kind: 'INTERNAL' } });
      expect(sender.sent).toEqual([]);
      expect(bulk.status === 200 ? body(bulk).sent : 0).toBe(0);
      expect(JSON.stringify([await listed(admin, { kind: 'INTERNAL' }), (await w.fx.audits()).length])).toBe(before);
      expect((await w.fx.audits()).filter((a) => a.action.startsWith('contact.'))).toEqual([]);
    });

    it('an all-customer ADMIN’s staff-contact changes are audited with actor and contact id (customerId stays null)', async () => {
      await open();
      const lead = body(await w.call(admin, 'POST', '/contacts', { body: { kind: 'INTERNAL', name: 'Lead', email: 'lead@msp.example' } }));
      await w.call(admin, 'PATCH', `/contacts/${lead.id}`, { body: { name: 'Lead 2' } });
      const a = (await w.fx.audits()).filter((x) => x.action.startsWith('contact.'));
      expect(a.map((x) => [x.action, x.customerId, x.actorId, x.targetId])).toEqual([['contact.create', null, 'usr_minjae', lead.id], ['contact.update', null, 'usr_minjae', lead.id]]);
    });
  });

  // ───────────────────────────── verification ─────────────────────────────
  describe('verification', () => {
    it('TODAY (no sender configured): a link request is 503 VERIFICATION_UNAVAILABLE; no token, no row, no state change; manual still works', async () => {
      await open({ sender: false });
      const c = await mkContact();
      const before = await tokenHashes();
      const r = await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } });
      expect([r.status, body(r).error.code]).toEqual([503, 'VERIFICATION_UNAVAILABLE']);
      expect(await tokenHashes()).toEqual(before);
      expect((await listed(admin, { q: 'ji-ho' }))[0].channels.EMAIL.status).toBe('UNVERIFIED');
      expect((await w.fx.audits()).filter((a) => a.action.startsWith('contact.verify'))).toEqual([]);
      const bulk = await w.call(admin, 'POST', '/contacts/verify-bulk', { body: { filter: 'needsAction' } });
      expect([bulk.status, body(bulk).error.code]).toEqual([503, 'VERIFICATION_UNAVAILABLE']);
      const manual = await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'manual', note: 'confirmed by phone' } });
      expect(manual.status).toBe(200);
    });

    it('link: only the hash is stored; the token verifies the channel once, with no session; reuse and garbage are the same 404', async () => {
      await open();
      const c = await mkContact();
      const r = await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } });
      expect(r.status).toBe(202);
      expect(body(r)).toMatchObject({ status: 'LINK_SENT', channel: 'EMAIL', method: 'link' });
      expect(sender.sent).toHaveLength(1);
      const { token, to } = sender.sent[0]!;
      expect(to).toBe('jiho@mirae.example');
      expect(token).toMatch(/^vf_[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(r.body)).not.toContain(token);
      // stored: the SHA-256, never the token
      const hashes = await tokenHashes();
      expect(hashes).toContain(sha(token));
      expect(hashes).not.toContain(token);
      expect(JSON.stringify(await w.fx.audits())).not.toContain(token);
      expect((await listed(admin, { q: 'ji-ho' }))[0].channels.EMAIL).toMatchObject({ status: 'LINK_SENT' });

      // GET only looks (mail scanners open links): nothing is consumed
      for (let i = 0; i < 2; i++) expect(body(await w.call(null, 'GET', `/verify/${token}`))).toEqual({ pending: true, channel: 'EMAIL' });
      expect((await listed(admin, { q: 'ji-ho' }))[0].channels.EMAIL.status).toBe('LINK_SENT');
      const used = await w.call(null, 'POST', `/verify/${token}`);
      expect(used.status).toBe(200);
      expect(body(used)).toEqual({ verified: true, channel: 'EMAIL' });
      expect(used.headers['referrer-policy']).toBe('no-referrer');
      expect(used.headers['cache-control']).toBe('no-store');
      const after = (await listed(admin, { q: 'ji-ho' }))[0].channels;
      expect(after.EMAIL).toMatchObject({ status: 'VERIFIED', via: 'link' });
      expect(after.SMS.status).toBe('UNVERIFIED'); // only the channel the link was for
      const audit = (await w.fx.audits()).find((a) => a.action === 'contact.verify.link_used')!;
      expect(audit).toMatchObject({ actorType: 'CONTACT', actorId: c.id, targetId: c.id, customerId: 'cus_mirae' });

      const again = await w.call(null, 'POST', `/verify/${token}`, { requestId: 'req_same' });
      expect((await w.call(null, 'GET', `/verify/${token}`)).status).toBe(404); // used: not pending any more
      const garbage = await w.call(null, 'POST', '/verify/not-a-token', { requestId: 'req_same' });
      const unknown = await w.call(null, 'POST', `/verify/vf_${'A'.repeat(43)}`, { requestId: 'req_same' });
      expect(again.status).toBe(404);
      expect(wire(again)).toBe(wire(garbage));
      expect(wire(again)).toBe(wire(unknown));
    });

    it('a link expires after 24 hours and then verifies nothing', async () => {
      await open();
      const c = await mkContact();
      await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'SMS', method: 'link' } });
      const { token, to } = sender.sent[0]!;
      expect(to).toBe('+821055556666');
      w.sim.now = new Date(w.sim.now.getTime() + 24 * 3600_000 + 1000);
      expect((await w.call(null, 'GET', `/verify/${token}`)).status).toBe(404);
      expect((await w.call(null, 'POST', `/verify/${token}`)).status).toBe(404);
      expect((await listed(admin, { q: 'ji-ho' }))[0].channels.SMS.status).toBe('EXPIRED');
    });

    it('a link meant for an old address cannot verify the new one', async () => {
      await open();
      const c = await mkContact();
      await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } });
      const { token } = sender.sent[0]!;
      await w.call(admin, 'PATCH', `/contacts/${c.id}`, { body: { email: 'other@mirae.example' } });
      expect((await w.call(null, 'POST', `/verify/${token}`)).status).toBe(404);
      expect((await listed(admin, { q: 'ji-ho' }))[0].channels.EMAIL.status).not.toBe('VERIFIED');
    });

    it('a second link within a minute is 429 with Retry-After (nobody can be spammed through the API); a minute later it goes out', async () => {
      await open();
      const c = await mkContact();
      await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } });
      const r = await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } });
      expect([r.status, body(r).error.code]).toEqual([429, 'RATE_LIMITED']);
      expect(r.headers['retry-after']).toBeDefined();
      expect(sender.sent).toHaveLength(1);
      w.sim.now = new Date(w.sim.now.getTime() + 61_000);
      expect((await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } })).status).toBe(202);
      expect(sender.sent).toHaveLength(2);
    });

    it('a sender that fails: 502 without its text, the link is taken back (the token does nothing), the log says no address or token', async () => {
      await open();
      const c = await mkContact();
      sender.fail = true;
      const r = await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } });
      expect([r.status, body(r).error.code]).toEqual([502, 'SEND_FAILED']);
      expect(JSON.stringify(r.body)).not.toMatch(SQL_ERR);
      expect(await tokenHashes()).toEqual([]);
      sender.fail = false;
      expect((await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } })).status).toBe(202); // no cooldown from a failed send
    });

    it('request validation: channel, method, nothing on file, Slack by link, unknown keys', async () => {
      await open();
      const c = await mkContact({ phone: undefined });
      const v = (b: unknown) => w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: b });
      expect((await v({ channel: 'FAX', method: 'link' })).status).toBe(400);
      expect((await v({ channel: 'EMAIL', method: 'carrier-pigeon' })).status).toBe(400);
      expect((await v({ channel: 'EMAIL', method: 'link', extra: 1 })).status).toBe(400);
      expect((await v({ channel: 'SMS', method: 'link' })).status).toBe(422); // no phone on file
      expect((await v({ channel: 'SLACK', method: 'manual' })).status).toBe(422); // no Slack id on file
      const s = await mkContact({ slackUserId: 'U0ZZZZZZ1', email: undefined, phone: undefined, name: 'Slack Only' });
      expect((await w.call(admin, 'POST', `/contacts/${s.id}/verify`, { body: { channel: 'SLACK', method: 'link' } })).status).toBe(400);
      expect(sender.sent).toEqual([]);
    });

    it('manual: MSP ADMIN only, via admin:<name>, note audited; OPERATOR 403; a portal user cannot vouch for its own channel (403)', async () => {
      await open();
      const c = await mkContact();
      expect((await w.call(USERS.haeun, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'SMS', method: 'manual' } })).status).toBe(403);
      const portal = await w.call(USERS.yuna, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'SMS', method: 'manual' } });
      expect([portal.status, body(portal).error.code]).toEqual([403, 'FORBIDDEN']);
      const r = await w.call(admin, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'SMS', method: 'manual', note: 'called her back, number confirmed' } });
      expect(r.status).toBe(200);
      expect((await listed(admin, { q: 'ji-ho' }))[0].channels.SMS).toMatchObject({ status: 'VERIFIED', via: 'admin:Minjae Lee' });
      const a = (await w.fx.audits()).find((x) => x.action === 'contact.verify.manual')!;
      expect(a).toMatchObject({ targetId: c.id, customerId: 'cus_mirae', actorId: 'usr_minjae', after: { channel: 'SMS', via: 'manual', note: 'called her back, number confirmed' } });
    });

    it('a portal user may send a link to its own people (grant), never to another customer’s', async () => {
      await open();
      const c = body(await w.call(USERS.yuna, 'POST', '/contacts', { body: { name: 'Mina Cho', email: 'mina@mirae.example' } }));
      const r = await w.call(USERS.yuna, 'POST', `/contacts/${c.id}/verify`, { body: { channel: 'EMAIL', method: 'link' } });
      expect(r.status).toBe(202);
      expect(sender.sent[0]).toMatchObject({ channel: 'EMAIL', to: 'mina@mirae.example' });
    });

    it('bulk: sends one link per unverified EMAIL/SMS channel, reports channels with no value in notSet, never re-sends within the cooldown', async () => {
      await open();
      const a = await mkContact({ name: 'Bulk A' });
      const b = await mkContact({ name: 'Bulk B', phone: undefined, email: 'b@mirae.example' });
      const r = await w.call(admin, 'POST', '/contacts/verify-bulk', { body: { contactIds: [a.id, b.id] } });
      expect(r.status).toBe(200);
      expect(body(r)).toEqual({ sent: 3, notSet: [{ contactId: b.id, channel: 'SMS' }], throttled: 0, failed: 0 });
      expect(sender.sent.map((s) => `${s.contactId}:${s.channel}`).sort()).toEqual([`${a.id}:EMAIL`, `${a.id}:SMS`, `${b.id}:EMAIL`].sort());
      const again = await w.call(admin, 'POST', '/contacts/verify-bulk', { body: { contactIds: [a.id, b.id] } });
      expect(body(again)).toMatchObject({ sent: 0, throttled: 3 });
      expect(sender.sent).toHaveLength(3);
      const f = await w.call(admin, 'POST', '/contacts/verify-bulk', { body: { filter: 'needsAction', kind: 'CUSTOMER', customerId: 'cus_mirae' } });
      expect(body(f)).toMatchObject({ sent: 0, throttled: 3 }); // exactly the three unverified channels of the two people, all inside the cooldown
      expect((await w.fx.audits()).filter((x) => x.action === 'contact.verify.bulk')).toHaveLength(3);
      expect(JSON.stringify(await w.fx.audits())).not.toMatch(/vf_/);
    });

    it('bulk: one id outside the caller’s range is the whole request’s 404 and nothing is sent; limits and roles', async () => {
      await open();
      const mirae = (await listed(admin, { customer: 'mirae' })).find((x) => x.name === 'Seojun Bae').id;
      const own = body(await w.call(admin, 'POST', '/contacts', { body: { kind: 'CUSTOMER', customerId: 'cus_hanbit', name: 'H One', email: 'h1@hanbit.example' } })).id;
      const r = await w.call(HANBIT_ADMIN, 'POST', '/contacts/verify-bulk', { body: { contactIds: [own, mirae] } });
      expect(r.status).toBe(404);
      expect(sender.sent).toEqual([]);
      expect((await w.call(admin, 'POST', '/contacts/verify-bulk', { body: { contactIds: new Array(201).fill('x') } })).status).toBe(400);
      expect((await w.call(admin, 'POST', '/contacts/verify-bulk', { body: { contactIds: [] } })).status).toBe(400);
      expect((await w.call(admin, 'POST', '/contacts/verify-bulk', { body: {} })).status).toBe(400);
      expect((await w.call(USERS.haeun, 'POST', '/contacts/verify-bulk', { body: { filter: 'needsAction' } })).status).toBe(403);
      expect((await w.call(USERS.yuna, 'POST', '/contacts/verify-bulk', { body: { filter: 'needsAction' } })).status).toBe(404);
    });
  });
}
