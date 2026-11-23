-- Least-privilege login roles for the two AWS services (D-15, API-CONTRACT B10). Guide: docs/SETUP-PROD-DB.md
--
--   alarmops_engine  the alarm engine Lambda (services/alarm-engine, psycopg, secret EngineDbSecret)
--   alarmops_ingest  the ingest Lambdas webhook / eventbridge / consumer (services/ingest -> packages/store-sql
--                    SqlIngestStore, secret IngestDbSecret)
--
-- Run as the TABLE OWNER (Supabase: `postgres`), AFTER `prisma migrate deploy`, in the Supabase SQL Editor or with psql.
-- Safe to run again: it resets both roles' table privileges and grants them anew. Run it again after any migration that
-- adds a table or column one of these services uses. db/scripts/test-roles.mjs pins the exact table- and column-level
-- privileges below (a change here without the same change there fails CI). It does NOT read the service code: it runs
-- copies of its statements, so a service that starts using a new table or column is only caught when someone updates
-- those copies. Review changes to pg_repository.py / ingestRepo.ts against this file.
--
-- NO PASSWORD IS IN THIS FILE. The roles are created with LOGIN but without a password, so nobody can log in as them
-- until a person sets one (docs/SETUP-PROD-DB.md, step 3):  ALTER ROLE alarmops_engine PASSWORD '<generated>';
--
-- RLS (D-40): every table has RLS on, no policies, not FORCEd. Only the owner bypasses that. A login role that is not the
-- owner would read 0 rows and fail every write, grants or not. These roles carry BYPASSRLS so that their GRANTs (below)
-- are the one and only limit. This adds no policy, so D-40 and db/scripts/check-rls.mjs stay true as written. BYPASSRLS
-- does NOT widen anything: it skips row filters, not table privileges. A table not granted below is still "permission
-- denied". The alternative (a policy per table and role, `USING (true)`) would filter nothing, add ~30 policies that
-- check-rls.mjs forbids, and need a new decision. If the host refuses `BYPASSRLS` in CREATE ROLE, stop and ask
-- (docs/SETUP-PROD-DB.md, "막혔을 때").
--
-- No sequence is granted: neither service writes a table with a SERIAL column (Incident, IncidentEvent, NotificationJob,
-- NotificationLog, IdempotencyKey are console / tick tables). No function, no schema CREATE, no DELETE except where listed.

-- ---------------------------------------------------------------------------------------------------------- roles
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['alarmops_engine', 'alarmops_ingest'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
    -- The attributes are stated every time, so a role that was changed by hand is put back.
    -- SUPERUSER / REPLICATION are not named: on Supabase the owner (`postgres`) is not a superuser, and naming either
    -- attribute in ALTER ROLE, even NOSUPERUSER, is refused (42501). CREATE ROLE leaves both off; the check below stops
    -- the script if either is on.
    EXECUTE format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT CONNECTION LIMIT 20', r);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolreplication)) THEN
      RAISE EXCEPTION 'role % has SUPERUSER or REPLICATION; remove it as a superuser, then run this file again', r;
    END IF;
    -- Reset: nothing carried over from an earlier version of this file.
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
    -- A bound for a statement that hangs; the drivers set their own, shorter limits per transaction.
    EXECUTE format('ALTER ROLE %I SET statement_timeout = ''30s''', r);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------------- alarmops_engine (B10, section 7)
-- Source: services/alarm-engine/src/alarm_engine/pg_repository.py (every statement of it is exercised by the CI test).
-- Reads the whole row (`SELECT *`) of the tables below. Writes only what the contract says it writes.
GRANT SELECT ON "Customer", "CloudAccount", "Resource", "ManagedAlarm", "ThresholdDefault", "ThresholdChange",
                "AlarmSyncRun", "RemediationPolicy", "RemediationRequest", "CustomerOffboarding" TO alarmops_engine;
-- CloudAccount: role status and last check only (never roleArn / externalId / enabled flags: the console owns those).
GRANT UPDATE ("readerStatus", "alarmWriterStatus", "tagWriterStatus", "remediatorStatus", "lastCheckedAt", "updatedAt")
  ON "CloudAccount" TO alarmops_engine;
-- Resource and ManagedAlarm: upsert (INSERT ... ON CONFLICT DO UPDATE). ManagedAlarm rows are also removed.
-- Insert is table-wide (a new row is the engine's own). UPDATE is limited to the SET list of the upsert, so id, customerId
-- and cloudAccountId of an existing row cannot be rewritten.
GRANT INSERT ON "Resource", "ManagedAlarm" TO alarmops_engine;
GRANT UPDATE ("resourceArn", "name", "tags", "monitoringTag", "monitoringState", "needsReviewSince", "needsReviewReason",
              "monitoringTagSetBy", "lastSeenAt", "discoveryRunId", "updatedAt") ON "Resource" TO alarmops_engine;
GRANT UPDATE ("alarmName", "alarmArn", "region", "severity", "severityManual", "threshold", "thresholdSource", "consoleThreshold",
              "evalM", "evalN", "evalSource", "comparison", "statistic", "period", "treatMissingData", "driftStatus",
              "driftDetail", "lastSyncedAt", "version") ON "ManagedAlarm" TO alarmops_engine;
GRANT DELETE ON "ManagedAlarm" TO alarmops_engine;
-- ThresholdChange is append-only for everybody: the engine only closes its apply status.
GRANT UPDATE ("applyStatus", "error") ON "ThresholdChange" TO alarmops_engine;
GRANT INSERT ON "AlarmSyncRun" TO alarmops_engine;
GRANT UPDATE ("status", "heartbeatAt", "counts", "error", "finishedAt") ON "AlarmSyncRun" TO alarmops_engine;
-- RemediationRequest: creates NOTIFIED / PENDING_APPROVAL rows, moves EXECUTING -> SUCCEEDED / FAILED.
-- The INSERT is limited to the columns of the engine's INSERT: NOT decidedBy, decidedAt, decisionVia, so a stolen engine
-- credential cannot write an "approved" row. The table's CHECK RemediationRequest_decided_chk (0001_init) rejects status
-- APPROVED / EXECUTING / SUCCEEDED / FAILED while decidedBy / decidedAt are NULL, so those statuses cannot be inserted either.
-- Residual (needs a backend migration, not done here): `status` has to stay insertable and updatable, and the CHECK does not
-- stop an UPDATE of status to APPROVED on a row that a person already decided (for example REJECTED -> APPROVED). A trigger
-- that allows only the engine's transitions (EXECUTING -> SUCCEEDED / FAILED) would close that.
GRANT INSERT ("id", "customerId", "cloudAccountId", "resourceId", "trigger", "action", "status", "requestedAt", "expiresAt")
  ON "RemediationRequest" TO alarmops_engine;
GRANT UPDATE ("status", "result", "version", "executedAt") ON "RemediationRequest" TO alarmops_engine;
-- CustomerOffboarding: the ALARMS_DELETED step and completedAt only (D-43).
GRANT UPDATE ("steps", "completedAt") ON "CustomerOffboarding" TO alarmops_engine;

-- ---------------------------------------------------------------------------------- alarmops_ingest (SqlIngestStore)
-- Source: packages/store-sql/src/ingestRepo.ts (+ tickRepo.ts loadPolicy / maintenanceWindows / closeGroup).
-- Customer and CloudAccount: only the columns the lookups read (no externalId, no role ARNs).
GRANT SELECT ("id", "status") ON "Customer" TO alarmops_ingest;
GRANT SELECT ("id", "customerId", "awsAccountId") ON "CloudAccount" TO alarmops_ingest;
GRANT SELECT ON "IntegrationSource", "SeverityMapping", "SuppressionPolicy", "MaintenanceWindow" TO alarmops_ingest;
GRANT UPDATE ("lastReceivedAt") ON "IntegrationSource" TO alarmops_ingest;
GRANT INSERT ON "IngestRejection" TO alarmops_ingest;
GRANT SELECT, INSERT ON "OffboardResidual" TO alarmops_ingest;
GRANT UPDATE ("firstAt", "lastAt", "count") ON "OffboardResidual" TO alarmops_ingest;
GRANT SELECT, INSERT ON "RawEvent", "Alert", "AlertGroup" TO alarmops_ingest;
GRANT UPDATE ("decision", "decisionReason", "groupId") ON "RawEvent" TO alarmops_ingest;
GRANT UPDATE ("fingerprintVersion", "sourceId", "awsAccountId", "region", "resourceType", "metricKey", "namespace", "title",
              "status", "severity", "severityRaw", "value", "threshold", "comparison", "lastNotifiedAt", "episodeOpen",
              "episodeStartedAt", "episodeNotified", "recentEpisodes", "quarantinedUntil", "fireCount", "lastEventAt", "version")
  ON "Alert" TO alarmops_ingest;
GRANT UPDATE ("status", "closedAt", "sweptReason", "version", "deliveredAt") ON "AlertGroup" TO alarmops_ingest;
