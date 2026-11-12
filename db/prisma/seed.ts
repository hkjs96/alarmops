// Dev seed (fake names only, known-bugs 8-12): MSP org, global suppression policy, D-18/D-25 severity mapping,
// two demo customers (one with a project › service), MSP staff with console users (admin / operator / viewer),
// customer people, Responders, an MSP rotation, Acme's call order, three open incidents, one Prometheus integration.
//
// Plain SQL on `pg` (D-10: Prisma is the migration tool only; the app reads and writes through packages/store-sql),
// so it runs wherever the migration ran — no Prisma Client engine needed. Idempotent: every insert is ON CONFLICT DO
// NOTHING with fixed ids. Run: apply the migrations, then `DATABASE_URL=… npm run seed -w @alarmops/db`.
// The live e2e (apps/console/playwright.live.config.ts) uses it on a throwaway database.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }
if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(1); }

const V = "now() - interval '30 days'";

async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const q = (text: string, params: unknown[] = []) => db.query(text, params);
  try {
    await q('BEGIN');
    await q(`INSERT INTO "MspOrg"("id", "name", "updatedAt") VALUES ('msp', 'Demo MSP', now()) ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO "SuppressionPolicy"("id", "updatedAt") VALUES ('global', now()) ON CONFLICT DO NOTHING`);
    // D-18 single table; D-25: critical → SEV_2 (SEV_1 only when the customer says so explicitly).
    const mapping: Record<string, string> = {
      critical: 'SEV_2', high: 'SEV_2', error: 'SEV_2', warning: 'SEV_3', warn: 'SEV_3', medium: 'SEV_3', low: 'SEV_4', info: 'SEV_5', informational: 'SEV_5', none: 'SEV_5',
    };
    for (const [m, s] of Object.entries(mapping)) await q(`INSERT INTO "SeverityMapping"("id", "matchValue", "severity", "updatedAt") VALUES ($1, $1, $2::"Severity", now()) ON CONFLICT DO NOTHING`, [m, s]);

    await q(`INSERT INTO "Customer"("id", "name", "slug", "updatedAt") VALUES ('cus_acme', 'Acme Demo', 'acme-demo', now()), ('cus_birch', 'Birch Retail', 'birch', now()) ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO "Project"("id", "customerId", "name", "slug") VALUES ('prj_acme_core', 'cus_acme', 'Core', 'core') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO "Service"("id", "customerId", "projectId", "name", "slug") VALUES ('svc_acme_api', 'cus_acme', 'prj_acme_core', 'Public API', 'public-api') ON CONFLICT DO NOTHING`);

    // MSP staff (verified channels) and their console users
    const staff: Array<[string, string, string, string | null, string]> = [
      ['ct_dev_admin', 'Demo Admin', 'admin@msp.example', 'usr_dev_admin', 'ADMIN'],
      ['ct_dev_operator', 'Demo Operator', 'operator@msp.example', 'usr_dev_operator', 'OPERATOR'],
      ['ct_dev_viewer', 'Demo Viewer', 'viewer@msp.example', 'usr_dev_viewer', 'VIEWER'],
      ['ct_oncall', 'Demo Engineer', 'oncall@msp.example', null, ''],
    ];
    for (const [cid, name, email, uid, role] of staff) {
      if (uid) await q(`INSERT INTO "User"("id", "email", "name", "role", "status", "updatedAt") VALUES ($1, $2, $3, $4::"ConsoleRole", 'ACTIVE', now()) ON CONFLICT DO NOTHING`, [uid, email, name, role]);
      await q(
        `INSERT INTO "Contact"("id", "kind", "name", "email", "phone", "slackUserId", "userId", "emailVerifiedAt", "phoneVerifiedAt", "slackVerifiedAt", "emailVerifiedVia", "phoneVerifiedVia", "slackVerifiedVia", "updatedAt")
         VALUES ($1, 'INTERNAL', $2, $3, $4, $5, $6, ${V}, ${V}, ${V}, 'admin:seed', 'admin:seed', 'admin:seed', now()) ON CONFLICT DO NOTHING`,
        [cid, name, email, `+8210000000${10 + (cid.length % 90)}`, `U_${cid.toUpperCase()}`, uid]);
    }
    // SEED PHONES: every seed phone is +82 10-0000-00NN. The 010-0000 exchange is never issued in KR, so these cannot reach a real
    // person. db/scripts/check.mjs fails if a seed phone leaves that pattern. Tick senders (SMS/voice, when added) MUST refuse
    // any number matching /^\+82100000/ and any contact whose phoneVerifiedVia is 'admin:seed'.
    // customer people of Acme: one pageable (verified phone), one notify only
    await q(
      `INSERT INTO "Contact"("id", "kind", "customerId", "name", "email", "phone", "emailVerifiedAt", "phoneVerifiedAt", "updatedAt") VALUES
         ('ct_acme_jisu', 'CUSTOMER', 'cus_acme', 'Jisu Kim', 'jisu@acme.example', '+821000000099', ${V}, ${V}, now()),
         ('ct_acme_minho', 'CUSTOMER', 'cus_acme', 'Minho Lee', 'minho@acme.example', NULL, ${V}, NULL, now())
       ON CONFLICT DO NOTHING`);
    await q(
      `INSERT INTO "Responder"("customerId", "contactId", "role", "order") VALUES
         ('cus_acme', 'ct_oncall', 'PAGEABLE', 0), ('cus_acme', 'ct_dev_admin', 'PAGEABLE', 1), ('cus_acme', 'ct_acme_jisu', 'PAGEABLE', 2), ('cus_acme', 'ct_acme_minho', 'NOTIFY_ONLY', 3),
         ('cus_birch', 'ct_dev_operator', 'PAGEABLE', 0)
       ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO "ContactScope"("id", "customerId", "contactId", "scopeType", "scopeId", "role") VALUES ('cs_acme_minho', 'cus_acme', 'ct_acme_minho', 'CUSTOMER', 'cus_acme', 'NOTIFY') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO "Rotation"("id", "scope", "name", "cadence", "handoverDow", "handoverMin", "anchorAt") VALUES ('rot_msp_day', 'MSP', 'MSP day desk', 'DAILY', 1, 0, date_trunc('day', now())) ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO "RotationMember"("rotationId", "contactId", "order") VALUES ('rot_msp_day', 'ct_oncall', 0), ('rot_msp_day', 'ct_dev_admin', 1) ON CONFLICT DO NOTHING`);

    // Acme's call order: everyone in Responders, Slack → SMS at 2 → call at 7 (version 1)
    await q(
      `INSERT INTO "PagingConfig"("id", "customerId", "scopeType", "scopeId", "style", "plan", "edited", "repeatCount", "version", "updatedAt")
       VALUES ('pc_acme', 'cus_acme', 'CUSTOMER', 'cus_acme', 'ALL_AT_ONCE', 'STANDARD', false, 1, 1, now()) ON CONFLICT DO NOTHING`);
    await q(
      `INSERT INTO "EscalationStep"("id", "pagingConfigId", "index", "atMin", "targetType", "channels") VALUES
         ('stp_acme_0', 'pc_acme', 0, 0, 'ALL_RESPONDERS', ARRAY['SLACK_DM']),
         ('stp_acme_1', 'pc_acme', 1, 2, 'ALL_RESPONDERS', ARRAY['SMS']),
         ('stp_acme_2', 'pc_acme', 2, 7, 'ALL_RESPONDERS', ARRAY['VOICE'])
       ON CONFLICT DO NOTHING`);

    // three open incidents (no frozen call order: the tick has not opened them)
    const inc: Array<[string, string, string | null, string, string, number]> = [
      ['inc-seed00000001-20261112000001', 'cus_acme', 'svc_acme_api', 'public-api 5xx rate high', 'SEV_2', 12],
      ['inc-seed00000002-20261112000002', 'cus_acme', null, 'db-1 disk 85% used', 'SEV_3', 8],
      ['inc-seed00000003-20261112000003', 'cus_birch', null, 'checkout latency p95 high', 'SEV_3', 5],
    ];
    for (const [id, customerId, serviceId, title, sev, ago] of inc) {
      await q(
        `INSERT INTO "Incident"("id", "axis", "customerId", "projectId", "serviceId", "title", "severity", "status", "triggeredAt", "memberCount", "eventCount", "source", "isMergeTarget")
         VALUES ($1, $1, $2, CASE WHEN $3::text IS NULL THEN NULL ELSE 'prj_acme_core' END, $3, $4, $5::"Severity", 'TRIGGERED', now() - make_interval(mins => $6), 1, 1, 'CLOUDWATCH', false)
         ON CONFLICT DO NOTHING`, [id, customerId, serviceId, title, sev, ago]);
    }

    const token = `in_${randomBytes(20).toString('hex')}`;
    const r = await q(
      `INSERT INTO "IntegrationSource"("id", "customerId", "kind", "name", "tokenHash", "tokenPrefix", "tokenRotatedAt") VALUES ('src_acme_prom', 'cus_acme', 'PROMETHEUS', 'prometheus-demo', $1, $2, now())
       ON CONFLICT DO NOTHING RETURNING "id"`, [createHash('sha256').update(token).digest('hex'), token.slice(3, 7)]);
    await q('COMMIT');
    console.log(r.rowCount ? `Seeded. Demo Prometheus ingest token (shown once): ${token}` : 'Seeded (already present).');
  } catch (e) {
    await q('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
