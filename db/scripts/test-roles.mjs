// Behaviour test of db/sql/roles.sql against a migrated real Postgres (CI db job, `npm run test:db`).
// DATABASE_URL must be the table owner / superuser that ran `prisma migrate deploy`. Needs `pg_hba` password login on the
// connection (the CI service container has it); the test sets throw-away passwords on the roles it creates.
//
// Proves, with real logins as alarmops_engine and alarmops_ingest:
//  (a) each role can run what its service runs. The statements below are copied from the code, with the same SET / column
//      lists, because a column privilege is decided by exactly those lists:
//        engine  services/alarm-engine/src/alarm_engine/pg_repository.py
//        ingest  packages/store-sql/src/ingestRepo.ts  (+ tickRepo.ts: loadPolicy, maintenanceWindows, closeGroup)
//  (b) each role has NO privilege at all on any other table (the exact table lists are fixed here: a change in roles.sql
//      without a change here fails), cannot read the columns held back, cannot DELETE / TRUNCATE, cannot create objects,
//      has no sequence or function privilege of its own;
//  (c) why BYPASSRLS is there: without it the same role reads 0 rows (D-40).
// Everything the test adds (fixtures, roles) is removed at the end, also when it fails.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

// This test inserts fixtures, runs DROP OWNED BY and DROP ROLE. Never against anything but a throw-away database.
const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
if (!['localhost', '127.0.0.1', '::1'].includes(host) && host !== process.env.ROLES_TEST_ALLOW_HOST) {
  throw new Error(`test-roles refuses to run against host "${host}": only localhost / 127.0.0.1 (set ROLES_TEST_ALLOW_HOST to the name of a CI service host)`);
}

const ENGINE = 'alarmops_engine';
const INGEST = 'alarmops_ingest';

// Tables with ANY privilege, per role. Keep in step with db/sql/roles.sql.
const EXPECTED = {
  [ENGINE]: ['AlarmSyncRun', 'CloudAccount', 'Customer', 'CustomerOffboarding', 'ManagedAlarm', 'RemediationPolicy', 'RemediationRequest', 'Resource', 'ThresholdChange', 'ThresholdDefault'],
  [INGEST]: ['Alert', 'AlertGroup', 'CloudAccount', 'Customer', 'IngestRejection', 'IntegrationSource', 'MaintenanceWindow', 'OffboardResidual', 'RawEvent', 'SeverityMapping', 'SuppressionPolicy'],
};

// Exact column-level privileges per role: table -> { select | insert | update: 'all' or [columns] }. 'all' = every column.
// Keep in step with db/sql/roles.sql; the test compares them with has_column_privilege for EVERY column of EVERY table.
const ALL = 'all';
const SPEC = {
  [ENGINE]: {
    Customer: { select: ALL }, CloudAccount: { select: ALL, update: ['readerStatus', 'alarmWriterStatus', 'tagWriterStatus', 'remediatorStatus', 'lastCheckedAt', 'updatedAt', 'firstEventAt', 'lastEventAt'] },
    Resource: { select: ALL, insert: ALL, update: ['resourceArn', 'name', 'tags', 'monitoringTag', 'monitoringState', 'needsReviewSince', 'needsReviewReason', 'monitoringTagSetBy', 'lastSeenAt', 'discoveryRunId', 'updatedAt'] },
    ManagedAlarm: { select: ALL, insert: ALL, update: ['alarmName', 'alarmArn', 'region', 'severity', 'severityManual', 'threshold', 'thresholdSource', 'consoleThreshold', 'evalM', 'evalN', 'evalSource', 'comparison', 'statistic', 'period', 'treatMissingData', 'driftStatus', 'driftDetail', 'lastSyncedAt', 'version'] },
    ThresholdDefault: { select: ALL }, ThresholdChange: { select: ALL, update: ['applyStatus', 'error'] },
    AlarmSyncRun: { select: ALL, insert: ALL, update: ['status', 'heartbeatAt', 'counts', 'error', 'finishedAt'] },
    RemediationPolicy: { select: ALL },
    RemediationRequest: { select: ALL, insert: ['id', 'customerId', 'cloudAccountId', 'resourceId', 'trigger', 'action', 'status', 'requestedAt', 'expiresAt'], update: ['status', 'result', 'version', 'executedAt'] },
    CustomerOffboarding: { select: ALL, update: ['steps', 'completedAt'] },
  },
  [INGEST]: {
    Customer: { select: ['id', 'status'] }, CloudAccount: { select: ['id', 'customerId', 'awsAccountId'] },
    IntegrationSource: { select: ALL, update: ['lastReceivedAt'] }, SeverityMapping: { select: ALL }, SuppressionPolicy: { select: ALL }, MaintenanceWindow: { select: ALL },
    IngestRejection: { insert: ALL }, OffboardResidual: { select: ALL, insert: ALL, update: ['firstAt', 'lastAt', 'count'] },
    RawEvent: { select: ALL, insert: ALL, update: ['decision', 'decisionReason', 'groupId'] },
    Alert: { select: ALL, insert: ALL, update: ['fingerprintVersion', 'sourceId', 'awsAccountId', 'region', 'resourceType', 'metricKey', 'namespace', 'title', 'status', 'severity', 'severityRaw', 'value', 'threshold', 'comparison', 'lastNotifiedAt', 'episodeOpen', 'episodeStartedAt', 'episodeNotified', 'recentEpisodes', 'quarantinedUntil', 'fireCount', 'lastEventAt', 'version'] },
    AlertGroup: { select: ALL, insert: ALL, update: ['status', 'closedAt', 'sweptReason', 'version', 'deliveredAt'] },
  },
};

const owner = new pg.Client({ connectionString: url });
const password = { [ENGINE]: randomBytes(18).toString('hex'), [INGEST]: randomBytes(18).toString('hex') };
const ID = 'rt' + process.pid; // every fixture id starts with this
let engine;
let ingest;

function asRole(role) {
  const u = new URL(url);
  u.username = role;
  u.password = password[role];
  return new pg.Client({ connectionString: u.toString() });
}

async function cleanup() {
  await owner.query('RESET ROLE').catch(() => {});
  for (const t of ['RawEvent', 'Alert', 'AlertGroup', 'RemediationRequest', 'ManagedAlarm', 'AlarmSyncRun', 'ThresholdChange', 'Resource', 'CustomerOffboarding', 'OffboardResidual', 'IngestRejection', 'IntegrationSource', 'CloudAccount']) {
    await owner.query(`DELETE FROM "${t}" WHERE "customerId" = $1`, [ID]).catch(() => {});
  }
  await owner.query('DELETE FROM "IngestRejection" WHERE "id" LIKE $1', [ID + '%']).catch(() => {});
  await owner.query('DELETE FROM "Customer" WHERE "id" = $1', [ID]).catch(() => {});
  await owner.query('DELETE FROM "Contact" WHERE "id" = $1', [ID]).catch(() => {});
  await owner.query('DELETE FROM "MaintenanceWindow" WHERE "id" LIKE $1', [ID + '%']).catch(() => {});
  await owner.query('DELETE FROM "SeverityMapping" WHERE "id" LIKE $1', [ID + '%']).catch(() => {});
}

before(async () => {
  await owner.connect();
  await cleanup();
  // the file under test, exactly as a person would paste it into the SQL editor; run twice to prove it can be re-run
  const sql = fs.readFileSync(new URL('../sql/roles.sql', import.meta.url), 'utf8');
  await owner.query(sql);
  await owner.query(sql);
  for (const role of [ENGINE, INGEST]) {
    const { rows } = await owner.query('SELECT format($1, $2::text, $3::text) AS q', ['ALTER ROLE %I PASSWORD %L', role, password[role]]);
    await owner.query(rows[0].q);
  }
  // fixtures, written by the owner
  await owner.query(`INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ($1, 'Roles test', $1, now())`, [ID]);
  await owner.query(`INSERT INTO "Contact" (id, kind, name, "updatedAt") VALUES ($1, 'INTERNAL', 'Roles test', now())`, [ID]);
  await owner.query(`INSERT INTO "CloudAccount" (id, "customerId", "awsAccountId", "externalId", "readerRoleArn", "eventForwarderRoleArn", "updatedAt")
                     VALUES ($1, $2, '123456789012', 'secret-external-id', 'arn:aws:iam::123456789012:role/r', 'arn:aws:iam::123456789012:role/e', now())`, [ID, ID]);
  await owner.query(`INSERT INTO "IntegrationSource" (id, "customerId", kind, name) VALUES ($1, $2, 'GRAFANA', 'roles test')`, [ID, ID]);
  await owner.query(`INSERT INTO "Resource" (id, "customerId", "cloudAccountId", region, "resourceType", "resourceArn", "resourceKey", "lastSeenAt", "updatedAt")
                     VALUES ($1, $2, $2, 'ap-northeast-2', 'EC2', 'arn:aws:ec2:::i-1', 'i-1', now(), now())`, [ID + 'seed', ID]);
  await owner.query(`INSERT INTO "ThresholdChange" (id, "customerId", target, "resourceType", "metricKey", field, "actorType") VALUES ($1, $2, 'CUSTOMER_DEFAULT', 'EC2', 'CPUUtilization', 'THRESHOLD', 'USER')`, [ID, ID]);
  await owner.query(`INSERT INTO "CustomerOffboarding" (id, "customerId", "startedByUserId", reason, steps) VALUES ($1, $2, 'u', 'test', '{}')`, [ID, ID]);
  await owner.query(`INSERT INTO "SeverityMapping" (id, "matchValue", severity, "updatedAt") VALUES ($1, $1, 'SEV_2', now())`, [ID]);
  await owner.query(`INSERT INTO "MaintenanceWindow" (id, "scopeType", "startsAt", "endsAt", reason, "createdBy") VALUES ($1, 'CUSTOMER', now() - interval '1 hour', now() + interval '1 hour', 'x', 'u')`, [ID]);
  engine = asRole(ENGINE);
  ingest = asRole(INGEST);
  await engine.connect();
  await ingest.connect();
});

after(async () => {
  await engine?.end().catch(() => {});
  await ingest?.end().catch(() => {});
  await cleanup();
  for (const role of [ENGINE, INGEST]) {
    await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
    await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  }
  await owner.end();
});

const denied = (p, what) => assert.rejects(p, (e) => e.code === '42501', `${what}: expected permission denied (42501)`);

test('roles exist with the intended attributes and no password in the file', async () => {
  const sql = fs.readFileSync(new URL('../sql/roles.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
  assert.ok(!/PASSWORD/i.test(sql), 'roles.sql must not set a password');
  const { rows } = await owner.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit
       FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`, [[ENGINE, INGEST]]);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.deepEqual([r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolinherit], [true, false, false, false, false, true, false], r.rolname);
    assert.equal(r.rolconnlimit, 20);
  }
  // no membership in any other role (no pg_read_all_data, no owner role)
  const m = await owner.query(`SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ANY($1)`, [[ENGINE, INGEST]]);
  assert.equal(m.rows[0].n, 0);
});

test('(b) the tables each role can touch are exactly the documented list', async () => {
  const { rows: tables } = await owner.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`);
  assert.ok(tables.length > 30, 'migrations applied');
  for (const role of [ENGINE, INGEST]) {
    const touched = [];
    for (const { relname } of tables) {
      const { rows } = await owner.query(
        `SELECT has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') AS any
           FROM pg_class c WHERE c.relname = $2 AND c.relnamespace = 'public'::regnamespace`, [role, relname]);
      if (rows[0].any) touched.push(relname);
    }
    assert.deepEqual(touched, EXPECTED[role], `${role}: tables with a privilege`);
    // no whole-table DELETE / TRUNCATE / TRIGGER / REFERENCES anywhere, DELETE only where listed
    for (const { relname } of tables) {
      const { rows } = await owner.query(`SELECT has_table_privilege($1, $2, 'TRUNCATE') AS t, has_table_privilege($1, $2, 'TRIGGER') AS g, has_table_privilege($1, $2, 'REFERENCES') AS f, has_table_privilege($1, $2, 'DELETE') AS d`, [role, `public."${relname}"`]);
      assert.deepEqual([rows[0].t, rows[0].g, rows[0].f], [false, false, false], `${role} ${relname}`);
      assert.equal(rows[0].d, role === ENGINE && relname === 'ManagedAlarm', `${role} DELETE on ${relname}`);
    }
    const seq = await owner.query(`SELECT count(*)::int AS n FROM pg_class c WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace AND (has_sequence_privilege($1, c.oid, 'USAGE') OR has_sequence_privilege($1, c.oid, 'SELECT') OR has_sequence_privilege($1, c.oid, 'UPDATE'))`, [role]);
    assert.equal(seq.rows[0].n, 0, `${role} has no sequence privilege`);
    const sch = await owner.query(`SELECT has_schema_privilege($1, 'public', 'USAGE') AS u, has_schema_privilege($1, 'public', 'CREATE') AS c, has_database_privilege($1, current_database(), 'CREATE') AS dc`, [role]);
    assert.deepEqual([sch.rows[0].u, sch.rows[0].c, sch.rows[0].dc], [true, false, false]);
  }
});

test('(b) a table outside the list is permission denied, for reading and for writing', async () => {
  for (const [client, role] of [[engine, ENGINE], [ingest, INGEST]]) {
    for (const t of ['Contact', 'User', 'Incident', 'NotificationJob', 'IdempotencyKey']) {
      await denied(client.query(`SELECT 1 FROM "${t}" LIMIT 1`), `${role} SELECT ${t}`);
      await denied(client.query(`DELETE FROM "${t}"`), `${role} DELETE ${t}`);
    }
    await denied(client.query('CREATE TABLE public.rt_x (a int)'), `${role} CREATE TABLE`);
    await denied(client.query('TRUNCATE "Customer"'), `${role} TRUNCATE`);
    await denied(client.query('DELETE FROM "Customer"'), `${role} DELETE Customer`);
  }
  // the two services do not see each other's tables
  for (const t of ['Alert', 'AlertGroup', 'RawEvent', 'IntegrationSource', 'OffboardResidual', 'IngestRejection', 'SuppressionPolicy', 'MaintenanceWindow', 'SeverityMapping']) {
    await denied(engine.query(`SELECT 1 FROM "${t}" LIMIT 1`), `engine SELECT ${t}`);
  }
  for (const t of ['ManagedAlarm', 'Resource', 'ThresholdChange', 'ThresholdDefault', 'AlarmSyncRun', 'RemediationPolicy', 'RemediationRequest', 'CustomerOffboarding']) {
    await denied(ingest.query(`SELECT 1 FROM "${t}" LIMIT 1`), `ingest SELECT ${t}`);
  }
});

test('(b) held-back columns: ingest cannot read CloudAccount secrets, nobody rewrites ids, approvals or the audit trail', async () => {
  await denied(ingest.query('SELECT "externalId" FROM "CloudAccount"'), 'ingest externalId');
  await denied(ingest.query('SELECT * FROM "CloudAccount"'), 'ingest SELECT *');
  await denied(ingest.query('SELECT "readerRoleArn" FROM "CloudAccount"'), 'ingest readerRoleArn');
  await denied(ingest.query('SELECT * FROM "Customer"'), 'ingest SELECT * Customer');
  await denied(ingest.query(`UPDATE "Alert" SET "fingerprint" = 'x' WHERE false`), 'ingest rewrites an Alert fingerprint');
  await denied(ingest.query(`UPDATE "Alert" SET "customerId" = 'x' WHERE false`), 'ingest rewrites an Alert customer');
  await denied(ingest.query(`UPDATE "RawEvent" SET "raw" = '{}' WHERE false`), 'ingest rewrites a RawEvent payload');
  await denied(ingest.query(`UPDATE "IntegrationSource" SET "tokenHash" = 'x' WHERE false`), 'ingest rewrites a token hash');
  await denied(ingest.query(`UPDATE "Customer" SET "status" = 'ACTIVE' WHERE false`), 'ingest rewrites a customer status');
  await denied(engine.query(`UPDATE "CloudAccount" SET "externalId" = 'x' WHERE false`), 'engine rewrites externalId');
  await denied(engine.query(`UPDATE "CloudAccount" SET "readerRoleArn" = 'x' WHERE false`), 'engine rewrites a role ARN');
  await denied(engine.query(`UPDATE "ThresholdChange" SET "newValue" = '1' WHERE false`), 'engine rewrites the audit trail');
  await denied(engine.query(`INSERT INTO "ThresholdChange" (id, "customerId", target, "resourceType", "metricKey", field, "actorType") VALUES ('x', 'x', 'ALARM', 'EC2', 'm', 'OFF', 'USER')`), 'engine inserts a ThresholdChange');
  await denied(engine.query(`UPDATE "RemediationRequest" SET "decidedBy" = 'x' WHERE false`), 'engine approves a remediation');
  await denied(engine.query(`UPDATE "CustomerOffboarding" SET "reason" = 'x' WHERE false`), 'engine edits an offboarding reason');
  await denied(engine.query(`DELETE FROM "Resource" WHERE false`), 'engine deletes a Resource');
  await denied(engine.query(`DELETE FROM "CloudAccount" WHERE false`), 'engine deletes a CloudAccount');
  await denied(ingest.query(`DELETE FROM "Alert" WHERE false`), 'ingest deletes an Alert');
  await denied(ingest.query(`DELETE FROM "RawEvent" WHERE false`), 'ingest deletes a RawEvent');
});

test('(a) engine: every statement of pg_repository.py runs', async () => {
  const q = (text, params = []) => engine.query(text, params);
  const rows = async (text, params) => (await q(text, params)).rows;
  // reads
  assert.equal((await rows('SELECT * FROM "CloudAccount" WHERE id = $1', [ID])).length, 1);
  assert.equal((await rows(`SELECT a.id FROM "CloudAccount" a JOIN "Customer" c ON c.id = a."customerId" WHERE a.id = $1`, [ID])).length, 1);
  assert.equal((await rows('SELECT * FROM "Resource" WHERE "cloudAccountId" = $1', [ID])).length, 1);
  assert.equal((await rows('SELECT * FROM "Resource" WHERE id = $1 AND "customerId" = $2', [ID + 'seed', ID])).length, 1);
  await rows(`SELECT * FROM "ThresholdDefault" WHERE level = 'CUSTOMER' AND "customerId" = $1`, [ID]);
  await rows(`SELECT * FROM "ThresholdDefault" WHERE level = 'MSP' AND "customerId" IS NULL`);
  await rows(`SELECT DISTINCT ON (field) field, "newValue" FROM "ThresholdChange" WHERE "customerId" = $1 ORDER BY field, at DESC`, [ID]);
  await rows(`SELECT * FROM "ThresholdChange" WHERE id = $1 AND "customerId" = $2`, [ID, ID]);
  await rows('SELECT * FROM "RemediationPolicy" WHERE "customerId" = $1', [ID]);
  await rows(`SELECT 1 AS x FROM "AlarmSyncRun" WHERE "cloudAccountId" = $1 AND "startedAt" > now() - interval '1 hour' LIMIT 1`, [ID]);
  await rows(`SELECT steps, "completedAt" FROM "CustomerOffboarding" WHERE id = $1 AND "customerId" = $2 FOR UPDATE`, [ID, ID]);
  await rows(`SELECT o.id FROM "CustomerOffboarding" o JOIN "Customer" c ON c.id = o."customerId" WHERE c.id = $1`, [ID]);
  await rows('SELECT id FROM "CloudAccount" WHERE "customerId" = $1 ORDER BY id', [ID]);

  // update_account_status
  await q(`UPDATE "CloudAccount" SET "readerStatus" = 'OK'::"RoleStatus", "tagWriterStatus" = 'DENIED'::"RoleStatus", "lastCheckedAt" = now(), "updatedAt" = now() WHERE id = $1`, [ID]);
  assert.equal((await rows('SELECT "readerStatus" FROM "CloudAccount" WHERE id = $1', [ID]))[0].readerStatus, 'OK');

  // record_account_event (#154)
  await q(`UPDATE "CloudAccount" SET "firstEventAt" = COALESCE("firstEventAt", t.at), "lastEventAt" = GREATEST(COALESCE("lastEventAt", t.at), t.at)
             FROM (SELECT LEAST(COALESCE($1::timestamptz, now()), now()) AS at) t
            WHERE "id" = $2 AND "customerId" = $3 AND ("firstEventAt" IS NULL OR "lastEventAt" IS NULL OR "lastEventAt" < t.at - interval '60 seconds')`, [null, ID, ID]);
  assert.ok((await rows('SELECT "firstEventAt" FROM "CloudAccount" WHERE id = $1', [ID]))[0].firstEventAt);

  // upsert_resource: insert, then the ON CONFLICT DO UPDATE path
  const resource = `INSERT INTO "Resource" (id, "customerId", "cloudAccountId", region, "resourceType", "resourceArn", "resourceKey", name, tags, "monitoringTag", "monitoringState",
        "needsReviewSince", "needsReviewReason", "monitoringTagSetBy", "lastSeenAt", "discoveryRunId", "updatedAt")
      VALUES ($1,$2,$3,'ap-northeast-2','EC2','arn:aws:ec2:::i-2','i-2',$4,'{}'::jsonb,'ON'::"MonitoringTag",'MONITORED'::"MonitoringState",NULL,NULL,NULL,now(),NULL,now())
      ON CONFLICT ("cloudAccountId", region, "resourceType", "resourceKey") DO UPDATE SET
        "resourceArn" = EXCLUDED."resourceArn", name = EXCLUDED.name, tags = EXCLUDED.tags, "monitoringTag" = EXCLUDED."monitoringTag", "monitoringState" = EXCLUDED."monitoringState",
        "needsReviewSince" = EXCLUDED."needsReviewSince", "needsReviewReason" = EXCLUDED."needsReviewReason",
        "monitoringTagSetBy" = COALESCE(EXCLUDED."monitoringTagSetBy", "Resource"."monitoringTagSetBy"),
        "lastSeenAt" = EXCLUDED."lastSeenAt", "discoveryRunId" = EXCLUDED."discoveryRunId", "updatedAt" = now()
      WHERE "Resource"."customerId" = EXCLUDED."customerId" RETURNING *`;
  assert.equal((await rows(resource, [ID + 'r2', ID, ID, 'first']))[0].name, 'first');
  assert.equal((await rows(resource, [ID + 'r3', ID, ID, 'second']))[0].name, 'second');

  // upsert_managed_alarm + delete_managed_alarm
  const alarm = `INSERT INTO "ManagedAlarm" (id, "customerId", "resourceId", "cloudAccountId", region, "metricKey", "alarmName", "alarmArn", severity, "severityManual", threshold, "thresholdSource",
        "consoleThreshold", "evalM", "evalN", "evalSource", comparison, statistic, period, "treatMissingData", "driftStatus", "driftDetail", "lastSyncedAt")
      VALUES ($1,$2,$3,$4,'ap-northeast-2','CPUUtilization',$5,'arn:x','SEV_3'::"Severity",false,80,'CODE'::"ValueSource",NULL,3,5,'CODE'::"ValueSource",'>=','Average',300,'missing','IN_SYNC'::"DriftStatus",NULL,now())
      ON CONFLICT ("resourceId", "metricKey") DO UPDATE SET
        "alarmName" = EXCLUDED."alarmName", "alarmArn" = EXCLUDED."alarmArn", region = EXCLUDED.region, severity = EXCLUDED.severity, "severityManual" = EXCLUDED."severityManual",
        threshold = EXCLUDED.threshold, "thresholdSource" = EXCLUDED."thresholdSource", "consoleThreshold" = EXCLUDED."consoleThreshold", "evalM" = EXCLUDED."evalM",
        "evalN" = EXCLUDED."evalN", "evalSource" = EXCLUDED."evalSource", comparison = EXCLUDED.comparison, statistic = EXCLUDED.statistic, period = EXCLUDED.period,
        "treatMissingData" = EXCLUDED."treatMissingData", "driftStatus" = EXCLUDED."driftStatus", "driftDetail" = EXCLUDED."driftDetail", "lastSyncedAt" = EXCLUDED."lastSyncedAt",
        version = "ManagedAlarm".version + 1
      WHERE "ManagedAlarm"."customerId" = EXCLUDED."customerId" RETURNING *`;
  await rows(alarm, [ID + 'a1', ID, ID + 'seed', ID, 'name-1']);
  assert.equal((await rows(alarm, [ID + 'a2', ID, ID + 'seed', ID, 'name-2']))[0].alarmName, 'name-2');
  await rows('SELECT * FROM "ManagedAlarm" WHERE "customerId" = $1 AND "resourceId" = $2', [ID, ID + 'seed']);
  await rows('SELECT * FROM "ManagedAlarm" WHERE id = $1 AND "customerId" = $2', [ID + 'a1', ID]);
  await q('DELETE FROM "ManagedAlarm" WHERE "customerId" = $1 AND "resourceId" = $2 AND "metricKey" = $3', [ID, ID + 'seed', 'CPUUtilization']);
  assert.equal((await rows('SELECT 1 FROM "ManagedAlarm" WHERE "customerId" = $1', [ID])).length, 0);

  // finish_threshold_change
  await q(`UPDATE "ThresholdChange" SET "applyStatus" = 'APPLIED'::"ApplyStatus", error = NULL WHERE id = $1 AND "customerId" = $2 AND "applyStatus" = 'PENDING'`, [ID, ID]);
  assert.equal((await rows('SELECT "applyStatus" FROM "ThresholdChange" WHERE id = $1', [ID]))[0].applyStatus, 'APPLIED');

  // sync runs
  await q(`INSERT INTO "AlarmSyncRun" (id, "customerId", "cloudAccountId", mode, "startedAt", "heartbeatAt") VALUES ($1,$2,$3,'DAILY'::"SyncMode",now(),now())`, [ID, ID, ID]);
  await q(`UPDATE "AlarmSyncRun" SET "heartbeatAt" = now() WHERE id = $1 AND "customerId" = $2`, [ID, ID]);
  await q(`UPDATE "AlarmSyncRun" SET status = 'SUCCEEDED'::"SyncStatus", counts = '{}'::jsonb, error = NULL, "finishedAt" = now() WHERE id = $1 AND "customerId" = $2`, [ID, ID]);
  await q(`UPDATE "AlarmSyncRun" SET status = 'FAILED', error = 'stale: no heartbeat (timeout)', "finishedAt" = now() WHERE status = 'RUNNING' AND COALESCE("heartbeatAt", "startedAt") < now() - interval '1 hour'`);

  // remediation
  const created = await rows(
    `INSERT INTO "RemediationRequest" (id, "customerId", "cloudAccountId", "resourceId", trigger, action, status, "requestedAt", "expiresAt")
     VALUES ($1,$2,$3,$4,'{}'::jsonb,'EC2_STOP'::"RemediationAction",'PENDING_APPROVAL'::"RemediationStatus",now(),now() + interval '1 hour') ON CONFLICT DO NOTHING RETURNING *`,
    [ID, ID, ID, ID + 'seed']);
  assert.equal(created.length, 1);
  // the approval is the console's (a person in Slack, D-07): the owner stands in for it here
  // (migration 0007 allows only PENDING_APPROVAL -> APPROVED here; the engine then moves APPROVED -> EXECUTING itself)
  await owner.query(`UPDATE "RemediationRequest" SET status = 'APPROVED', "decidedBy" = $1, "decidedAt" = now() WHERE id = $1`, [ID]);
  const started = await q(
    `UPDATE "RemediationRequest" SET status = 'EXECUTING'::"RemediationStatus", result = COALESCE(NULL::jsonb, result), version = version + 1,
       "executedAt" = CASE WHEN 'EXECUTING' IN ('SUCCEEDED','FAILED') THEN now() ELSE "executedAt" END
     WHERE id = $1 AND "customerId" = $2 AND status = 'APPROVED'::"RemediationStatus"`, [ID, ID]);
  assert.equal(started.rowCount, 1);
  await rows('SELECT * FROM "RemediationRequest" WHERE id = $1', [ID]);
  await rows('SELECT * FROM "RemediationRequest" WHERE id = $1 AND "customerId" = $2', [ID, ID]);
  const moved = await q(
    `UPDATE "RemediationRequest" SET status = 'SUCCEEDED'::"RemediationStatus", result = COALESCE('{"ok":true}'::jsonb, result), version = version + 1,
       "executedAt" = CASE WHEN 'SUCCEEDED' IN ('SUCCEEDED','FAILED') THEN now() ELSE "executedAt" END
     WHERE id = $1 AND "customerId" = $2 AND status = 'EXECUTING'::"RemediationStatus"`, [ID, ID]);
  assert.equal(moved.rowCount, 1);

  // offboarding step
  await q(`UPDATE "CustomerOffboarding" SET steps = '{"ALARMS_DELETED":{"state":"DONE"}}'::jsonb, "completedAt" = CASE WHEN true AND "completedAt" IS NULL THEN now() ELSE "completedAt" END WHERE id = $1 AND "customerId" = $2`, [ID, ID]);
});

test('(a) ingest: every statement of SqlIngestStore runs', async () => {
  const q = (text, params = []) => ingest.query(text, params);
  const rows = async (text, params) => (await q(text, params)).rows;
  // SourceRepository
  assert.equal((await rows(`SELECT "id", "customerId", "kind", "tokenHash", "enabled", "allowQueryToken" FROM "IntegrationSource" WHERE "tokenHash" = $1`, ['none'])).length, 0);
  await q(`UPDATE "IntegrationSource" SET "lastReceivedAt" = GREATEST(COALESCE("lastReceivedAt", '-infinity'::timestamptz), LEAST($2::timestamptz, now())) WHERE "id" = $1`, [ID, new Date().toISOString()]);
  await q(`INSERT INTO "IngestRejection"("id", "receivedAt", "customerId", "sourceId", "kind", "reason", "awsAccountId", "title") VALUES ($1, now(), $2, $3, 'webhook', 'bad', NULL, NULL)`, [ID + 'rej', ID, ID]);
  assert.equal((await rows(`SELECT "customerId" FROM "CloudAccount" WHERE "awsAccountId" = $1 ORDER BY "id" LIMIT 1`, ['123456789012']))[0].customerId, ID);
  assert.ok((await rows(`SELECT "matchValue", "severity" FROM "SeverityMapping"`)).length >= 1);
  assert.equal((await rows(`SELECT "status" FROM "Customer" WHERE "id" = $1`, [ID]))[0].status, 'ACTIVE');
  const residual = `INSERT INTO "OffboardResidual"("customerId", "sourceKey", "firstAt", "lastAt", "count") VALUES ($1, 'k', $2::timestamptz, $2::timestamptz, $3)
       ON CONFLICT ("customerId", "sourceKey") DO UPDATE SET
         "firstAt" = LEAST("OffboardResidual"."firstAt", EXCLUDED."firstAt"), "lastAt" = GREATEST("OffboardResidual"."lastAt", EXCLUDED."lastAt"),
         "count" = "OffboardResidual"."count" + EXCLUDED."count"`;
  await q(residual, [ID, new Date().toISOString(), 1]);
  await q(residual, [ID, new Date().toISOString(), 2]);
  assert.equal((await rows(`SELECT "count" FROM "OffboardResidual" WHERE "customerId" = $1`, [ID]))[0].count, 3);

  // AlertRepository: alert, raw event, decision
  assert.equal((await rows(`SELECT "id" FROM "Alert" WHERE "customerId" IS NOT DISTINCT FROM $1 AND "fingerprint" = $2`, [ID, 'fp'])).length, 0);
  assert.equal((await rows(`SELECT "id", "customerId" FROM "Alert" WHERE "customerId" IS DISTINCT FROM $1 AND "fingerprint" = $2 ORDER BY "lastEventAt" DESC, "id" LIMIT 1`, [ID, 'fp'])).length, 0);
  const alert = await rows(
    `INSERT INTO "Alert"("id", "fingerprint", "fingerprintVersion", "customerId", "sourceId", "source", "awsAccountId", "region", "resourceType", "metricKey", "namespace", "title",
       "status", "severity", "severityRaw", "value", "threshold", "comparison", "lastNotifiedAt", "episodeOpen", "episodeStartedAt", "episodeNotified",
       "recentEpisodes", "quarantinedUntil", "fireCount", "firstSeenAt", "lastEventAt", "version")
     VALUES ($1,'fp',1,$2,$2,'GRAFANA'::"SourceKind",'123456789012','ap-northeast-2','EC2','m','ns','t','FIRING'::"AlertStatus",'SEV_2'::"Severity",NULL,1,2,'>',NULL,true,now(),false,
       ARRAY(SELECT jsonb_array_elements_text('[]'::jsonb)::timestamptz),NULL,1,now(),now(),0) RETURNING "id", "version"`, [ID + 'al', ID]);
  assert.equal(alert.length, 1);
  await assert.rejects(q(`INSERT INTO "Alert"("id", "fingerprint", "fingerprintVersion", "customerId", "source", "title", "status", "severity", "firstSeenAt", "lastEventAt") VALUES ('dup', 'fp', 1, $1, 'GRAFANA', 't', 'FIRING', 'SEV_2', now(), now())`, [ID]), (e) => e.code === '23505', 'duplicate identity is a unique violation, not a permission error');
  const raw = await rows(
    `INSERT INTO "RawEvent"("id", "dedupKey", "customerId", "sourceId", "source", "awsAccountId", "region", "fingerprint", "fingerprintVersion", "state", "previousState",
       "severity", "severityRaw", "occurredAt", "receivedAt", "alertId", "raw", "parseError")
     SELECT $1, $2, $3, (SELECT s."id" FROM "IntegrationSource" s WHERE s."id" = $3), 'GRAFANA'::"SourceKind", NULL, NULL, 'fp', 1, 'FIRING'::"EventState", NULL, 'SEV_2'::"Severity", NULL, now(), now(), $4, '{}'::jsonb, NULL
     ON CONFLICT ("dedupKey") DO NOTHING RETURNING "id"`, [ID + 'raw', ID + 'dedup', ID, ID + 'al']);
  assert.equal(raw.length, 1);
  const again = await rows(
    `INSERT INTO "RawEvent"("id", "dedupKey", "source", "fingerprint", "fingerprintVersion", "state", "severity", "occurredAt", "receivedAt", "alertId", "raw")
     VALUES ($1, $2, 'GRAFANA', 'fp', 1, 'FIRING', 'SEV_2', now(), now(), $3, '{}') ON CONFLICT ("dedupKey") DO NOTHING RETURNING "id"`, [ID + 'raw2', ID + 'dedup', ID + 'al']);
  assert.equal(again.length, 0, 'duplicate delivery is DUPLICATE');
  const upd = await q(
    `UPDATE "Alert" SET ("fingerprintVersion", "sourceId", "awsAccountId", "region", "resourceType", "metricKey", "namespace", "title", "status", "severity", "severityRaw",
        "value", "threshold", "comparison", "lastNotifiedAt", "episodeOpen", "episodeStartedAt", "episodeNotified", "recentEpisodes", "quarantinedUntil", "fireCount", "lastEventAt", "version")
       = (1, $3, NULL, NULL, NULL, NULL, NULL, 'title2', 'RESOLVED'::"AlertStatus", 'SEV_2'::"Severity", NULL, 1, 2, '>', now(), false, NULL, false, ARRAY[]::timestamptz[], NULL, 2, now(), $4)
      WHERE "id" = $1 AND "fingerprint" = 'fp' AND "customerId" IS NOT DISTINCT FROM $2 AND "version" = $5 RETURNING "id"`, [ID + 'al', ID, ID, 1, 0]);
  assert.equal(upd.rowCount, 1);
  await q(`UPDATE "RawEvent" SET "decision" = 'NOTIFY'::"Decision", "decisionReason" = 'r', "groupId" = $2 WHERE "id" = $1`, [ID + 'raw', null]);
  await rows(`SELECT * FROM "SuppressionPolicy" WHERE "id" = 'global'`);
  await rows(`SELECT "id", "customerId", "scopeType", "scopeId", "resourceType", "startsAt", "endsAt", "revokedAt" FROM "MaintenanceWindow"
               WHERE ("customerId" IS NULL OR "customerId" = $1) AND ("revokedAt" IS NULL OR "revokedAt" > now()) AND "startsAt" <= now() AND now() < "endsAt"`, [ID]);

  // groups, in a transaction like createGroup
  assert.equal((await rows(`SELECT "id" FROM "AlertGroup" WHERE "groupKey" = $1 AND "status" = 'OPEN'`, ['gk'])).length, 0);
  assert.equal((await rows(`SELECT 1 FROM "AlertGroup" WHERE "id" = $1`, [ID + 'g1'])).length, 0);
  await q('BEGIN');
  await q(`UPDATE "AlertGroup" SET "status" = 'CLOSED', "closedAt" = COALESCE("closedAt", now()), "sweptReason" = 'stale', "version" = "version" + 1 WHERE "id" = $1 AND "status" = 'OPEN'`, [ID + 'none']);
  await q(`INSERT INTO "AlertGroup"("id", "groupKey", "customerId", "severity", "status", "openedAt", "groupWaitSec", "closeAt", "closedAt", "pauseUntil", "staleAfter", "deliveredAt", "version")
           VALUES ($1, 'gk', $2, 'SEV_2'::"Severity", 'OPEN'::"GroupStatus", now(), 60, now() + interval '1 minute', NULL, NULL, now() + interval '1 day', NULL, 0)`, [ID + 'g1', ID]);
  await q('COMMIT');
  const closed = await q(`UPDATE "AlertGroup" SET "status" = 'CLOSED', "closedAt" = now(), "version" = "version" + 1 WHERE "id" = $1 AND "status" = 'OPEN' RETURNING "id"`, [ID + 'g1']);
  assert.equal(closed.rowCount, 1);
  await q(`UPDATE "AlertGroup" SET "deliveredAt" = now() WHERE "id" = $1`, [ID + 'g1']);
});

test('(c) why BYPASSRLS: without it the same role reads 0 rows and writes nothing (D-40)', async () => {
  await owner.query(`ALTER ROLE ${INGEST} NOBYPASSRLS`);
  const c = asRole(INGEST);
  await c.connect();
  try {
    const seen = await c.query('SELECT count(*)::int AS n FROM "Customer"');
    assert.equal(seen.rows[0].n, 0, 'a non-owner role without BYPASSRLS sees no row, although the GRANT is there');
    await assert.rejects(c.query(`INSERT INTO "IngestRejection"("id", "kind", "reason") VALUES ($1, 'k', 'r')`, [ID + 'rls']), /row-level security/);
  } finally {
    await c.end();
    await owner.query(`ALTER ROLE ${INGEST} BYPASSRLS`);
  }
  const ok = await ingest.query('SELECT count(*)::int AS n FROM "Customer" WHERE id = $1', [ID]);
  assert.equal(ok.rows[0].n, 1, 'with BYPASSRLS the open connection sees the row again');
});

test('(b) exact column-level privileges: SELECT / INSERT / UPDATE on every column of every table, per role', async () => {
  const { rows: cols } = await owner.query(
    `SELECT c.relname AS t, a.attname AS c FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, a.attnum`);
  for (const role of [ENGINE, INGEST]) {
    for (const priv of ['select', 'insert', 'update']) {
      const expected = [];
      for (const [t, p] of Object.entries(SPEC[role])) {
        const want = p[priv];
        if (!want) continue;
        for (const { c } of cols.filter((x) => x.t === t)) if (want === ALL || want.includes(c)) expected.push(`${t}.${c}`);
        if (want !== ALL) for (const c of want) assert.ok(cols.some((x) => x.t === t && x.c === c), `${t}.${c} exists (typo in the test list?)`);
      }
      const actual = [];
      for (const { t, c } of cols) {
        const r = await owner.query('SELECT has_column_privilege($1, $2, $3, $4) AS ok', [role, `public."${t}"`, c, priv.toUpperCase()]);
        if (r.rows[0].ok) actual.push(`${t}.${c}`);
      }
      assert.deepEqual(actual.sort(), expected.sort(), `${role}: columns with ${priv.toUpperCase()}`);
    }
  }
});

test('(b) engine cannot approve its own remediation, nor rewrite the identity of rows it owns', async () => {
  const ins = (extraCols, extraVals, status = 'PENDING_APPROVAL') => engine.query(
    `INSERT INTO "RemediationRequest" (id, "customerId", "cloudAccountId", "resourceId", trigger, action, status, "requestedAt"${extraCols})
     VALUES ($1, $2, $2, $3, '{}'::jsonb, 'EC2_STOP'::"RemediationAction", $4::"RemediationStatus", now()${extraVals})`, [ID + 'x', ID, ID + 'seed', status]);
  // approval columns are not insertable at all
  await denied(ins(', "decidedBy", "decidedAt"', `, '${ID}', now()`, 'APPROVED'), 'insert with decidedBy / decidedAt');
  await denied(ins(', "decidedBy"', `, '${ID}'`), 'insert with decidedBy');
  await denied(ins(', "decidedAt"', ', now()'), 'insert with decidedAt');
  await denied(ins(', "decisionVia"', ", 'SLACK'"), 'insert with decisionVia');
  // an approved-looking status without those columns is refused by the table's own CHECK, not by a privilege
  for (const status of ['APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED']) {
    await assert.rejects(ins('', '', status), (e) => e.code === '23514', `insert with status ${status} violates RemediationRequest_decided_chk`);
  }
  // identity columns of upserted rows cannot be changed
  await denied(engine.query(`UPDATE "Resource" SET "customerId" = 'x' WHERE false`), 'Resource.customerId');
  await denied(engine.query(`UPDATE "Resource" SET "cloudAccountId" = 'x' WHERE false`), 'Resource.cloudAccountId');
  await denied(engine.query(`UPDATE "Resource" SET id = 'x' WHERE false`), 'Resource.id');
  await denied(engine.query(`UPDATE "ManagedAlarm" SET "customerId" = 'x' WHERE false`), 'ManagedAlarm.customerId');
  await denied(engine.query(`UPDATE "ManagedAlarm" SET "resourceId" = 'x' WHERE false`), 'ManagedAlarm.resourceId');
  await denied(engine.query(`UPDATE "AlarmSyncRun" SET "customerId" = 'x' WHERE false`), 'AlarmSyncRun.customerId');
});
