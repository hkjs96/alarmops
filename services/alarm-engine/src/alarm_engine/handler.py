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

from alarm_engine import offboard, remediation
from alarm_engine.aws import CapabilityDisabled
from alarm_engine.engine import Engine, classify_liveness

logger = logging.getLogger(__name__)

COMMAND_TYPES = frozenset({
    "SYNC_ACCOUNT", "SYNC_RESOURCE", "APPLY_THRESHOLD", "APPLY_CUSTOMER_DEFAULT", "SET_SEVERITY",
    "SET_MONITORING_TAG", "STOP_MONITORING", "CHECK_ALARM_LIVENESS", "EXECUTE_REMEDIATION", "CHECK_CONNECTION",
    "OFFBOARD_ACCOUNT",
})


class InvalidCommand(ValueError):
    pass


# Per-type required payload keys and their types (API-CONTRACT §6). Missing/mistyped → poison (not retried).
_STR, _BOOL = (str,), (bool,)
_NUM = (int, float)
REQUIRED: dict[str, dict[str, tuple[type, ...]]] = {
    "SYNC_ACCOUNT": {},
    "SYNC_RESOURCE": {"resourceId": _STR},
    "APPLY_THRESHOLD": {"thresholdChangeId": _STR, "managedAlarmId": _STR},
    "APPLY_CUSTOMER_DEFAULT": {"resourceType": _STR, "metricKey": _STR},
    "SET_SEVERITY": {"managedAlarmId": _STR, "severity": _STR},
    "SET_MONITORING_TAG": {"resourceId": _STR, "value": _STR},
    "STOP_MONITORING": {"resourceId": _STR, "deleteAlarms": _BOOL},
    "CHECK_ALARM_LIVENESS": {"incidentId": _STR, "alarmNames": (list,)},
    "EXECUTE_REMEDIATION": {"remediationRequestId": _STR},
    "CHECK_CONNECTION": {},
    "OFFBOARD_ACCOUNT": {"offboardingId": _STR},
}
NEEDS_ACCOUNT = frozenset({"SYNC_ACCOUNT", "CHECK_ALARM_LIVENESS", "CHECK_CONNECTION", "OFFBOARD_ACCOUNT"})
OPTIONAL: dict[str, dict[str, tuple[type, ...]]] = {
    "SYNC_ACCOUNT": {"mode": _STR},
    "SYNC_RESOURCE": {"restoreDrift": _BOOL},
    "APPLY_THRESHOLD": {"threshold": _NUM, "off": _BOOL, "evalM": (int,), "evalN": (int,), "periodSec": (int,),
                        "statistic": _STR},
    "CHECK_ALARM_LIVENESS": {"region": _STR},
}
MAX_LIVENESS_ALARMS = 100


def _check_type(name: str, v: Any, types: tuple[type, ...]) -> None:
    # bool is a subclass of int: never accept it where a number is expected
    if not isinstance(v, types) or (isinstance(v, bool) and bool not in types):
        raise InvalidCommand(f"{name} has wrong type")
    if isinstance(v, str) and not v:
        raise InvalidCommand(f"{name} is empty")


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
    p = cmd.get("payload", {})
    if p is None:
        p = cmd["payload"] = {}
    if not isinstance(p, dict):
        raise InvalidCommand("payload must be an object")
    t = cmd["type"]
    for k, types in REQUIRED[t].items():
        if k not in p or p[k] is None:
            raise InvalidCommand(f"{t}: missing payload.{k}")
        _check_type(f"payload.{k}", p[k], types)
    for k, types in OPTIONAL.get(t, {}).items():
        if p.get(k) is not None:
            _check_type(f"payload.{k}", p[k], types)
    if t in NEEDS_ACCOUNT:
        if not isinstance(cmd.get("cloudAccountId"), str) or not cmd["cloudAccountId"]:
            raise InvalidCommand(f"{t}: cloudAccountId required")
    if t == "CHECK_ALARM_LIVENESS":
        names = p["alarmNames"]
        if len(names) > MAX_LIVENESS_ALARMS or not all(isinstance(n, str) and n for n in names):
            raise InvalidCommand(f"alarmNames must be ≤{MAX_LIVENESS_ALARMS} non-empty strings")
    return cmd


def _account_of(engine: Engine, cmd: dict) -> str:
    acc = cmd.get("cloudAccountId")
    if not acc:
        raise InvalidCommand("cloudAccountId required")
    try:
        account = engine.repo.get_account(acc)
    except LookupError as e:   # KeyError included: unknown account is poison, retry cannot help
        raise InvalidCommand(f"unknown cloudAccountId {acc}") from e
    if account.customer_id != cmd["customerId"]:
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
            region = p.get("region") or acc.regions[0]
            if region not in (*acc.regions, "us-east-1"):
                raise InvalidCommand(f"region {region} not enabled for account")
            cw = engine.sessions.client(acc, "reader", "cloudwatch", region)
            result = classify_liveness(cw, list(p["alarmNames"]))
            if liveness_sink:
                liveness_sink(cus, p["incidentId"], result)
            return {"status": "OK", "liveness": result}
        if t == "EXECUTE_REMEDIATION":
            # customer guard is inside get_remediation_request(cus, ...); execute() re-checks tenant on the row
            req = engine.repo.get_remediation_request(cus, p["remediationRequestId"])
            if req is None:
                return {"status": "REFUSED", "reason": "not found"}
            ex = remediation.execute(engine.repo, engine.sessions, req.id, customer_id=cus)
            return {"status": ex.status, "reason": ex.reason}
        if t == "CHECK_CONNECTION":
            return {"status": "OK", "roles": engine.check_connection(_account_of(engine, cmd))}
        if t == "OFFBOARD_ACCOUNT":
            # D-43: deletes only `ManagedBy=AlarmOps` alarms of a TERMINATED customer; every check is inside offboard.run
            return offboard.run(engine.repo, engine.sessions, cus, _account_of(engine, cmd), p["offboardingId"])
    except CapabilityDisabled as e:
        return {"status": "CAPABILITY_DISABLED", "role": e.role}
    except offboard.TargetNotFound as e:   # unknown offboarding for this customer: poison
        raise InvalidCommand(f"not found: {e}") from e
    except (KeyError, LookupError) as e:   # unknown resource/alarm/account for this customer: poison
        if t == "OFFBOARD_ACCOUNT":
            raise   # a KeyError inside the destructive path is a bug: retry / DLQ, never silently dropped
        raise InvalidCommand(f"not found: {e}") from e
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
            logger.info("command %s %s customer=%s → %s", cmd["commandId"], cmd["type"], cmd["customerId"],
                        out.get("status"))
        except InvalidCommand as e:
            logger.error("invalid command %s customer=%s: %s", cmd["commandId"], cmd["customerId"], e)
        except Exception:  # noqa: BLE001
            logger.exception("command %s customer=%s failed", cmd["commandId"], cmd["customerId"])
            failures.append({"itemIdentifier": rec["messageId"]})
    return {"batchItemFailures": failures}


_ENGINE: Engine | None = None


def lambda_handler(event: dict, context: Any) -> dict:  # pragma: no cover - wiring only
    global _ENGINE
    if _ENGINE is None:
        from alarm_engine.wiring import build_engine
        _ENGINE = build_engine()
    return handle_batch(_ENGINE, event)
