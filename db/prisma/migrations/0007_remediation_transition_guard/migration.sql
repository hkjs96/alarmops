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
-- REJECTED / EXPIRED / finished request can never be approved or executed. Not guarded here: INSERT (the engine only creates
-- NOTIFIED / PENDING_APPROVAL rows; the existing CHECK "RemediationRequest_decided_chk" already requires a decider for
-- APPROVED / EXECUTING / SUCCEEDED / FAILED).
--
-- decidedBy, decidedAt, decisionVia: once set they never change. The one exception is decidedBy -> NULL with everything else
-- about the decision unchanged: that is what the foreign key (ON DELETE SET NULL, a contact removed by retention) does.

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
     OR OLD."decidedBy" IS NOT NULL AND NEW."decidedBy" IS DISTINCT FROM OLD."decidedBy" AND NEW."decidedBy" IS NOT NULL THEN
    RAISE EXCEPTION 'RemediationRequest %: a recorded decision cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'RemediationRequest_decision_immutable';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION "remediation_request_guard"() FROM PUBLIC;

CREATE TRIGGER "RemediationRequest_guard" BEFORE UPDATE ON "RemediationRequest"
  FOR EACH ROW EXECUTE FUNCTION "remediation_request_guard"();
