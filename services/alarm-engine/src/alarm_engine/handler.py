"""SQS `alarm-commands` consumer (API-CONTRACT §6). Lambda entry: `lambda_handler(event, context)`.

Partial-batch response: failed records are returned in `batchItemFailures` so only they are retried (then DLQ).
Idempotency: `commandId` is the dedupe key; state-changing commands also claim their row conditionally
(ThresholdChange PENDING, RemediationRequest APPROVED→EXECUTING), so a redelivered message is a no-op.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any

from alarm_engine import remediation
from alarm_engine.aws import CapabilityDisabled
from alarm_engine.engine import Engine, classify_liveness

logger = logging.getLogger(__name__)

COMMAND_TYPES = frozenset({
    "SYNC_ACCOUNT", "SYNC_RESOURCE", "APPLY_THRESHOLD", "APPLY_CUSTOMER_DEFAULT", "SET_SEVERITY",
    "SET_MONITORING_TAG", "STOP_MONITORING", "CHECK_ALARM_LIVENESS", "EXECUTE_REMEDIATION", "CHECK_CONNECTION",
})


class InvalidCommand(ValueError):
    pass


def parse(body: str) -> dict[str, Any]:
    try:
        cmd = json.loads(body)
    except ValueError as e:
        raise InvalidCommand("body is not JSON") from e
    if not isinstance(cmd, dict) or cmd.get("schemaVersion") != 1:
        raise InvalidCommand("schemaVersion must be 1")
    for k in ("commandId", "type", "customerId"):
        if not isinstance(cmd.get(k), str) or not cmd[k]:
            raise InvalidCommand(f"missing {k}")
    if cmd["type"] not in COMMAND_TYPES:
        raise InvalidCommand(f"unknown type {cmd['type']}")
    if not isinstance(cmd.get("payload", {}), dict):
        raise InvalidCommand("payload must be an object")
    return cmd


def _account_of(engine: Engine, cmd: dict) -> str:
    acc = cmd.get("cloudAccountId")
    if not acc:
        raise InvalidCommand("cloudAccountId required")
    if engine.repo.get_account(acc).customer_id != cmd["customerId"]:
        raise InvalidCommand("cloudAccountId does not belong to customerId")   # tenant guard
    return str(acc)


def dispatch(engine: Engine, cmd: dict, liveness_sink: Callable[[str, str, dict], None] | None = None) -> dict:
    t, cus, p = cmd["type"], cmd["customerId"], cmd.get("payload") or {}
    try:
        if t == "SYNC_ACCOUNT":
            mode = p.get("mode", "ON_DEMAND")
            if mode not in ("DAILY", "TAG_RECONCILE", "ON_DEMAND"):
                raise InvalidCommand(f"bad mode {mode}")
            return {"status": "OK", "counts": engine.sync_account(_account_of(engine, cmd), mode)}
        if t == "SYNC_RESOURCE":
            r = engine.sync_one(cus, p["resourceId"], restore_external=bool(p.get("restoreDrift")))
            return {"status": "OK" if r else "SKIPPED_NOT_MONITORED", "counts": r.plan.counts() if r else {}}
        if t == "APPLY_THRESHOLD":
            return {"status": engine.apply_threshold(cus, p, cmd["commandId"])}
        if t == "APPLY_CUSTOMER_DEFAULT":
            return {"status": "OK", "resources": engine.apply_customer_default(cus, p["resourceType"], p["metricKey"])}
        if t == "SET_SEVERITY":
            engine.set_severity(cus, p["managedAlarmId"], p["severity"])
            return {"status": "OK"}
        if t == "SET_MONITORING_TAG":
            if p.get("value") != "on":
                raise InvalidCommand("only value 'on' is allowed")
            engine.set_monitoring_tag(cus, p["resourceId"])
            return {"status": "OK"}
        if t == "STOP_MONITORING":
            if p.get("deleteAlarms") is not True:
                raise InvalidCommand("deleteAlarms must be true")
            return {"status": "OK", "deleted": engine.stop_monitoring(cus, p["resourceId"])}
        if t == "CHECK_ALARM_LIVENESS":
            acc = engine.repo.get_account(_account_of(engine, cmd))
            cw = engine.sessions.client(acc, "reader", "cloudwatch", p.get("region", acc.regions[0]))
            result = classify_liveness(cw, list(p.get("alarmNames") or []))
            if liveness_sink:
                liveness_sink(cus, p["incidentId"], result)
            return {"status": "OK", "liveness": result}
        if t == "EXECUTE_REMEDIATION":
            req = engine.repo.get_remediation_request(cus, p["remediationRequestId"])
            if req is None:
                return {"status": "REFUSED", "reason": "not found"}
            ex = remediation.execute(engine.repo, engine.sessions, req.id)
            return {"status": ex.status, "reason": ex.reason}
        if t == "CHECK_CONNECTION":
            return {"status": "OK", "roles": engine.check_connection(_account_of(engine, cmd))}
    except CapabilityDisabled as e:
        return {"status": "CAPABILITY_DISABLED", "role": e.role}
    raise InvalidCommand(t)


def handle_batch(engine: Engine, event: dict) -> dict:
    failures = []
    for rec in event.get("Records", []):
        try:
            cmd = parse(rec["body"])
        except InvalidCommand as e:
            logger.error("dropping invalid command %s: %s", rec.get("messageId"), e)   # poison: do not retry
            continue
        try:
            out = dispatch(engine, cmd)
            logger.info("command %s %s → %s", cmd["commandId"], cmd["type"], out.get("status"))
        except InvalidCommand as e:
            logger.error("invalid command %s: %s", cmd["commandId"], e)
        except Exception:  # noqa: BLE001
            logger.exception("command %s failed", cmd["commandId"])
            failures.append({"itemIdentifier": rec["messageId"]})
    return {"batchItemFailures": failures}


_ENGINE: Engine | None = None


def lambda_handler(event: dict, context: Any) -> dict:  # pragma: no cover - wiring only
    global _ENGINE
    if _ENGINE is None:
        from alarm_engine.wiring import build_engine
        _ENGINE = build_engine()
    return handle_batch(_ENGINE, event)
