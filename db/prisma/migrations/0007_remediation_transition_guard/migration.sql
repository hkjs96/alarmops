-- RemediationRequest transition guard (D-15, hkjs96/alarmops#69 part 4): a person's decision is never overturned, whatever role
-- or code runs the UPDATE (the table owner included; D-40 bans policies, not triggers).
--
-- Allowed status changes (derived from services/alarm-engine/src/alarm_engine/remediation.py + pg_repository.py and the Slack
-- approval described there; a row that keeps its status may be updated freely, e.g. result / slackMessageId / version):
--
--   created as          NOTIFIED (policy NOTIFY_ONLY)  |  PENDING_APPROVAL (policy APPROVAL_REQUIRED)   -- propose()
--   NOTIFIED         -> (nothing: notify-only never executes)
--   PENDING_APPROVAL -> APPROVED | REJECTED | EXPIRED      -- approval in Slack (sets decidedBy/decidedAt/decisionVia), or time
--   APPROVED         -> EXECUTING | EXPIRED                -- EXECUTING: engine execute(), conditional claim; EXPIRED: not run in time
--   EXECUTING        -> SUCCEEDED | FAILED                 -- engine execute()
--   REJECTED, EXPIRED, SUCCEEDED, FAILED -> (nothing: terminal)
--
-- Therefore: nothing reaches APPROVED except from PENDING_APPROVAL, nothing reaches EXECUTING except from APPROVED, and a
-- REJECTED / EXPIRED / finished request can never be approved or executed.
--
-- INSERT guard: a new request is NOTIFIED or PENDING_APPROVAL with decidedBy, decidedAt, decisionVia and executedAt all NULL
-- (what the engine's create_remediation_request writes), so no row can be born already approved. Every role, owner included.
--
-- decidedBy, decidedAt, decisionVia: once set they never change. The one exception is decidedBy -> NULL when the change is made
-- by the foreign key action (ON DELETE SET NULL of a removed Contact, e.g. retention): that update runs nested inside the
-- Contact's referential trigger (pg_trigger_depth() > 1). A direct UPDATE setting decidedBy to NULL is rejected.
--
-- NOT what this trigger does: it does not stop a role that may UPDATE the table from forging PENDING_APPROVAL -> APPROVED with
-- a made-up decider (that transition is legal). Who may write decidedBy / decidedAt / status is a matter of column grants and
-- database roles (feat/prod-db roles.sql); this trigger only makes the allowed path one-way.

CREATE FUNCTION "remediation_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
         (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED', 'EXPIRED'))
      OR (OLD."status" = 'APPROVED'         AND NEW."status" IN ('EXECUTING', 'EXPIRED'))
      OR (OLD."status" = 'EXECUTING'        AND NEW."status" IN ('SUCCEEDED', 'FAILED'))
    ) THEN
      RAISE EXCEPTION 'RemediationRequest %: status % -> % is not an allowed transition', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'RemediationRequest_transition_guard';
    END IF;
  END IF;
  IF OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
     OR OLD."decisionVia" IS NOT NULL AND NEW."decisionVia" IS DISTINCT FROM OLD."decisionVia"
     OR OLD."decidedBy" IS NOT NULL AND NEW."decidedBy" IS DISTINCT FROM OLD."decidedBy" AND (NEW."decidedBy" IS NOT NULL OR pg_trigger_depth() <= 1) THEN
    RAISE EXCEPTION 'RemediationRequest %: a recorded decision cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'RemediationRequest_decision_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION "remediation_request_insert_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" NOT IN ('NOTIFIED', 'PENDING_APPROVAL')
     OR NEW."decidedBy" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."decisionVia" IS NOT NULL OR NEW."executedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'RemediationRequest %: a new request is NOTIFIED or PENDING_APPROVAL and carries no decision', NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'RemediationRequest_insert_guard';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION "remediation_request_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "remediation_request_insert_guard"() FROM PUBLIC;

CREATE TRIGGER "RemediationRequest_guard" BEFORE UPDATE ON "RemediationRequest"
  FOR EACH ROW EXECUTE FUNCTION "remediation_request_guard"();
CREATE TRIGGER "RemediationRequest_insert_guard" BEFORE INSERT ON "RemediationRequest"
  FOR EACH ROW EXECUTE FUNCTION "remediation_request_insert_guard"();
