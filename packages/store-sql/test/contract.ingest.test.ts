/** The ingest repository contract of services/ingest/test/contract against the SQL store (PGlite, or TEST_DATABASE_URL). */
import { afterAll, beforeAll, describe } from 'vitest';
import { ingestContract } from '../../../services/ingest/test/contract/ingestContract.js';
import { SqlIngestStore } from '../src/index.js';
import { iso, js } from '../src/rows.js';
import { openTestDb, type TestDb } from './db.js';

let db: TestDb;
beforeAll(async () => { db = await openTestDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

describe(`ingest store contract: sql (${process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite'})`, () => {
  ingestContract(async (seed) => {
    await db.reset();
    const q = (t: string, p?: unknown[]) => db.client.query(t, p);
    await q(`INSERT INTO "SuppressionPolicy"("id", "updatedAt") VALUES ('global', now())`);
    for (const [i, c] of seed.customers.entries()) await q(`INSERT INTO "Customer"("id", "name", "slug", "updatedAt") VALUES ($1, $2, $3, now())`, [c, `Customer ${i}`, `c-${i}`]);
    for (const s of seed.sources) {
      await q(`INSERT INTO "IntegrationSource"("id", "customerId", "kind", "name", "tokenHash", "enabled", "allowQueryToken") VALUES ($1, $2, $3::"SourceKind", $1, $4, $5, $6)`,
        [s.id, s.customerId, s.kind, s.tokenHash, s.enabled, s.allowQueryToken]);
    }
    for (const [a, c] of seed.accounts) {
      await q(`INSERT INTO "CloudAccount"("id", "customerId", "awsAccountId", "externalId", "readerRoleArn", "eventForwarderRoleArn", "updatedAt") VALUES ($1, $2, $3, $1, 'arn:r', 'arn:f', now())`, [`ca_${a}`, c, a]);
    }
    for (const [m, s] of Object.entries(seed.severity)) await q(`INSERT INTO "SeverityMapping"("id", "matchValue", "severity", "updatedAt") VALUES ($1, $1, $2::"Severity", now())`, [m, s]);
    for (const w of seed.windows) {
      await q(`INSERT INTO "MaintenanceWindow"("id", "customerId", "scopeType", "scopeId", "resourceType", "startsAt", "endsAt", "reason", "createdBy") VALUES ($1, $2, $3::"MaintenanceScope", $4, $5, $6::timestamptz, $7::timestamptz, 'test', 'seed')`,
        [w.id, w.customerId, w.scopeType, w.scopeId, w.resourceType ?? null, iso(w.startsAt), iso(w.endsAt)]);
    }
    void js;
    const n = async (t: string) => ((await q(`SELECT count(*)::int AS n FROM "${t}"`))[0]!.n as number);
    return {
      repo: new SqlIngestStore(db.client),
      counts: async () => ({ rawEvents: await n('RawEvent'), alerts: await n('Alert'), groups: await n('AlertGroup'), rejections: await n('IngestRejection') }),
      rawEvent: async (id) => { const [r] = await q(`SELECT "decision", "decisionReason", "groupId", "alertId" FROM "RawEvent" WHERE "id" = $1`, [id]); return r ? { decision: r.decision ?? null, decisionReason: r.decisionReason ?? null, groupId: r.groupId ?? null, alertId: r.alertId } : null; },
      sourceLastReceivedAt: async (id) => { const [r] = await q(`SELECT "lastReceivedAt" FROM "IntegrationSource" WHERE "id" = $1`, [id]); return r?.lastReceivedAt ? new Date(r.lastReceivedAt) : null; },
      close: async () => undefined,
    };
  });
});
