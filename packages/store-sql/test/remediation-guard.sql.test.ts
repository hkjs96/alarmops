/**
 * Migration 0007: RemediationRequest transition guard (D-15, #69 part 4). A person's decision is not overturned by any UPDATE,
 * whoever runs it (the test connects as the table owner — the app's role).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type TestDb } from './db.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });
const q = (t: string, p?: unknown[]) => db.client.query(t, p);

beforeEach(async () => {
  await db.reset();
  await q(`INSERT INTO "Customer"("id", "name", "slug", "updatedAt") VALUES ('cus_a', 'A', 'a', now())`);
  await q(`INSERT INTO "CloudAccount"("id", "customerId", "awsAccountId", "externalId", "readerRoleArn", "eventForwarderRoleArn", "updatedAt") VALUES ('ca_a', 'cus_a', '111111111111', 'ext', 'arn:r', 'arn:f', now())`);
  await q(`INSERT INTO "Resource"("id", "customerId", "cloudAccountId", "region", "resourceType", "resourceArn", "resourceKey", "lastSeenAt", "updatedAt") VALUES ('res_a', 'cus_a', 'ca_a', 'ap-northeast-2', 'ec2', 'arn:x', 'i-1', now(), now())`);
  await q(`INSERT INTO "Contact"("id", "kind", "customerId", "name", "updatedAt") VALUES ('ct_1', 'CUSTOMER', 'cus_a', 'Approver', now()), ('ct_2', 'CUSTOMER', 'cus_a', 'Other', now())`);
});

const ADD = async (id: string, status: string, extra: { by?: string; at?: boolean; via?: string } = {}) => {
  // one resource per request: at most one ACTIVE request per resource and action (partial unique index)
  await q(`INSERT INTO "Resource"("id", "customerId", "cloudAccountId", "region", "resourceType", "resourceArn", "resourceKey", "lastSeenAt", "updatedAt") VALUES ($1, 'cus_a', 'ca_a', 'ap-northeast-2', 'ec2', 'arn:x', $1, now(), now())`, [`res_${id}`]);
  await q(`INSERT INTO "RemediationRequest"("id", "customerId", "cloudAccountId", "resourceId", "trigger", "action", "status", "requestedAt", "decidedBy", "decidedAt", "decisionVia")
    VALUES ($1, 'cus_a', 'ca_a', 'res_' || $1, '{}'::jsonb, 'EC2_STOP', $2::"RemediationStatus", now(), $3, ${extra.at ? 'now()' : 'NULL'}, $4)`, [id, status, extra.by ?? null, extra.via ?? null]);
};
const set = (id: string, sql: string) => q(`UPDATE "RemediationRequest" SET ${sql} WHERE "id" = $1`, [id]);
const status = async (id: string) => (await q(`SELECT "status" FROM "RemediationRequest" WHERE "id" = $1`, [id]))[0]!.status;

describe('RemediationRequest transition guard (0007)', () => {
  it('the legal path works: PENDING_APPROVAL -> APPROVED (decider set at once) -> EXECUTING -> SUCCEEDED; also -> FAILED, -> REJECTED, -> EXPIRED', async () => {
    await ADD('r1', 'PENDING_APPROVAL');
    await set('r1', `"status" = 'APPROVED', "decidedBy" = 'ct_1', "decidedAt" = now(), "decisionVia" = 'SLACK', "version" = "version" + 1`);
    await set('r1', `"status" = 'EXECUTING', "version" = "version" + 1`);
    await set('r1', `"status" = 'SUCCEEDED', "executedAt" = now(), "result" = '{"ok":1}'::jsonb`);
    expect(await status('r1')).toBe('SUCCEEDED');
    await ADD('r2', 'PENDING_APPROVAL'); await set('r2', `"status" = 'REJECTED', "decidedBy" = 'ct_1', "decidedAt" = now(), "decisionVia" = 'SLACK'`);
    await ADD('r3', 'PENDING_APPROVAL'); await set('r3', `"status" = 'EXPIRED'`);
    await ADD('r4', 'APPROVED', { by: 'ct_1', at: true }); await set('r4', `"status" = 'EXPIRED'`);
    await ADD('r5', 'EXECUTING', { by: 'ct_1', at: true }); await set('r5', `"status" = 'FAILED', "result" = '{"error":"x"}'::jsonb`);
    expect([await status('r2'), await status('r3'), await status('r4'), await status('r5')]).toEqual(['REJECTED', 'EXPIRED', 'EXPIRED', 'FAILED']);
  });

  it('a rejected, expired or finished request can never be approved or executed again', async () => {
    for (const from of ['REJECTED', 'EXPIRED', 'SUCCEEDED', 'FAILED']) {
      for (const to of ['APPROVED', 'EXECUTING', 'PENDING_APPROVAL', 'NOTIFIED']) {
        const id = `t_${from}_${to}`;
        await ADD(id, from, { by: 'ct_1', at: true });
        await expect(set(id, `"status" = '${to}'`), `${from} -> ${to}`).rejects.toThrow(/not an allowed transition/);
        expect(await status(id)).toBe(from);
      }
    }
  });

  it('nothing skips the approval: NOTIFIED / PENDING_APPROVAL cannot jump to EXECUTING, NOTIFIED cannot be approved, APPROVED cannot be rejected or go back', async () => {
    const cases: Array<[string, string]> = [['NOTIFIED', 'APPROVED'], ['NOTIFIED', 'EXECUTING'], ['PENDING_APPROVAL', 'EXECUTING'], ['PENDING_APPROVAL', 'SUCCEEDED'],
      ['APPROVED', 'REJECTED'], ['APPROVED', 'PENDING_APPROVAL'], ['APPROVED', 'SUCCEEDED'], ['EXECUTING', 'APPROVED'], ['EXECUTING', 'REJECTED']];
    for (const [from, to] of cases) {
      const id = `s_${from}_${to}`;
      await ADD(id, from, from === 'NOTIFIED' || from === 'PENDING_APPROVAL' ? {} : { by: 'ct_1', at: true });
      await expect(set(id, `"status" = '${to}', "decidedBy" = COALESCE("decidedBy", 'ct_1'), "decidedAt" = COALESCE("decidedAt", now())`), `${from} -> ${to}`).rejects.toThrow(/not an allowed transition/);
    }
  });

  it('a recorded decision cannot be changed: decider, time and channel stay; filling them the first time is fine', async () => {
    await ADD('d1', 'APPROVED', { by: 'ct_1', at: true, via: 'SLACK' });
    await expect(set('d1', `"decidedBy" = 'ct_2'`)).rejects.toThrow(/decision cannot be changed/);
    await expect(set('d1', `"decidedAt" = now() + interval '1 day'`)).rejects.toThrow(/decision cannot be changed/);
    await expect(set('d1', `"decisionVia" = 'API'`)).rejects.toThrow(/decision cannot be changed/);
    await expect(set('d1', `"decisionVia" = NULL`)).rejects.toThrow(/decision cannot be changed/);
    await set('d1', `"result" = '{"note":1}'::jsonb, "slackMessageId" = 'm1', "version" = "version" + 1`); // other columns are free
    await ADD('d2', 'PENDING_APPROVAL');
    await set('d2', `"decidedBy" = 'ct_1', "decidedAt" = now(), "decisionVia" = 'SLACK'`);
    await expect(set('d2', `"decidedBy" = 'ct_2'`)).rejects.toThrow(/decision cannot be changed/);
  });

  it('removing the approver\'s Contact (ON DELETE SET NULL) is not blocked for a decided request that is not subject to the decided-CHECK', async () => {
    await ADD('f1', 'REJECTED', { by: 'ct_2', at: true, via: 'SLACK' });
    await q(`DELETE FROM "Contact" WHERE "id" = 'ct_2'`);
    expect((await q(`SELECT "decidedBy", "decidedAt" IS NOT NULL AS "at" FROM "RemediationRequest" WHERE "id" = 'f1'`))[0]).toEqual({ decidedBy: null, at: true });
    expect(await status('f1')).toBe('REJECTED');
  });
});
