"""SQS `alarm-commands` consumer (API-CONTRACT §6). Lambda entry: `lambda_handler(event, context)`.

Partial-batch response: failed records are returned in `batchItemFailures` so only they are retried (then DLQ).
Idempotency: `commandId` is the dedupe key; state-changing commands also claim their row conditionally
(ThresholdChange PENDING, RemediationRequest APPROVED→EXECUTING), so a redelivered message is a no-op.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Callable
from typing import Any, Protocol

from alarm_engine import events, offboard, remediation
from alarm_engine.aws import CapabilityDisabled
from alarm_engine.engine import Engine, classify_liveness
from alarm_engine.retry import safe_error  # noqa: F401 — shared log-safe formatter

logger = logging.getLogger(__name__)

COMMAND_TYPES = frozenset({
    "SYNC_ACCOUNT", "SYNC_RESOURCE", "APPLY_THRESHOLD", "APPLY_CUSTOMER_DEFAULT", "SET_SEVERITY",
    "SET_MONITORING_TAG", "STOP_MONITORING", "CHECK_ALARM_LIVENESS", "EXECUTE_REMEDIATION", "CHECK_CONNECTION",
    "OFFBOARD_ACCOUNT", "SYNC_ALL_ACCOUNTS",
})
SYSTEM_CUSTOMER = "system"      # customerId of system commands (SYNC_ALL_ACCOUNTS only, API-CONTRACT 6)
SCHEDULED_MODES = ("DAILY", "TAG_RECONCILE")


class CommandSender(Protocol):
    """SQS SendMessageBatch port. `send_batch(entries)` returns the Ids of the entries that failed."""
    def send_batch(self, entries: list[dict]) -> list[str]: ...


class InvalidCommand(ValueError):
    pass


# Per-type required payload keys and their types (API-CONTRACT §6). Missing/mistyped → poison (not retried).
_STR, _BOOL = (str,), (bool,)
_NUM = (int, float)
REQUIRED: dict[str, dict[str, tuple[type, ...]]] = {
    "SYNC_ACCOUNT": {},
    "SYNC_ALL_ACCOUNTS": {"mode": _STR},
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
    "SYNC_ACCOUNT": {"mode": _STR, "deferrals": (int,)},
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


def _check_system_customer(t: str, customer_id: str) -> None:
    """`customerId: "system"` is for SYNC_ALL_ACCOUNTS only, and SYNC_ALL_ACCOUNTS takes nothing else."""
    if (customer_id == SYSTEM_CUSTOMER) != (t == "SYNC_ALL_ACCOUNTS"):
        raise InvalidCommand(f"{t}: customerId not allowed for this type")


def parse(body: str) -> dict[str, Any]:
    try:
        cmd = json.loads(body)
    except (ValueError, RecursionError) as e:
        raise InvalidCommand("body is not JSON") from e
    if not isinstance(cmd, dict) or cmd.get("schemaVersion") != 1:
        raise InvalidCommand("schemaVersion must be 1")
    for k in ("commandId", "type", "customerId"):
        if not isinstance(cmd.get(k), str) or not cmd[k]:
            raise InvalidCommand(f"missing {k}")
    if cmd["type"] not in COMMAND_TYPES:
        raise InvalidCommand(f"unknown type {cmd['type']}")
    _check_system_customer(cmd["type"], cmd["customerId"])
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
    if t == "SYNC_ACCOUNT" and p.get("deferrals") is not None and p["deferrals"] < 0:
        raise InvalidCommand("payload.deferrals must be >= 0")
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


def _sender_or_default(sender: CommandSender | None) -> CommandSender:
    if sender is not None:
        return sender
    from alarm_engine import wiring
    try:
        return wiring.get_command_sender()
    except RuntimeError as e:        # COMMANDS_QUEUE_URL missing: periodic-sync path only (message has no secret)
        raise InvalidCommand(f"periodic sync unavailable: {e}") from e


def _sync_settings():
    """Periodic-sync settings. A bad value rejects only the commands that need them (fan-out, deferral); every other
    command keeps working. The reason names variables and numbers only (no secret) and is logged by the caller."""
    from alarm_engine import wiring
    try:
        return wiring.sync_settings_from_env()
    except ValueError as e:
        raise InvalidCommand(f"periodic sync refused, invalid settings: {e}") from e


def _send_all(sender: CommandSender, entries: list[dict]) -> None:
    """SendMessageBatch in groups of 10; failed entries are sent once more, then the caller gets an exception."""
    for i in range(0, len(entries), 10):
        group = entries[i:i + 10]
        failed = set(sender.send_batch(group))
        if failed:
            failed = set(sender.send_batch([e for e in group if e["Id"] in failed]))
        if failed:
            raise RuntimeError(f"{len(failed)} command(s) could not be queued")


def _entry(i: int, cmd: dict, delay: int) -> dict:
    return {"Id": f"c{i}", "MessageBody": json.dumps(cmd, separators=(",", ":")), "DelaySeconds": delay}


def _fan_out(engine: Engine, cmd: dict, mode: str, sender: CommandSender | None) -> dict:
    settings = _sync_settings()
    accounts = engine.repo.list_active_accounts()
    n = len(accounts)
    step = min(settings.fanout_spread_seconds, 900 / n) if n else 0
    entries = [_entry(i, {"schemaVersion": 1, "commandId": f"{cmd['commandId']}-{a.id}", "type": "SYNC_ACCOUNT",
                          "customerId": a.customer_id, "cloudAccountId": a.id, "payload": {"mode": mode}},
                      int(i * step)) for i, a in enumerate(accounts)]
    if entries:
        _send_all(_sender_or_default(sender), entries)
    return {"status": "OK", "children": n}


def _defer_or_skip(cmd: dict, p: dict, mode: str, sender: CommandSender | None) -> dict:
    settings = _sync_settings()
    deferrals = p.get("deferrals") or 0
    if deferrals >= settings.max_deferrals:
        logger.warning("SYNC_ACCOUNT %s SKIPPED_BUSY: account still busy after %d deferrals", cmd["commandId"], deferrals)
        return {"status": "SKIPPED_BUSY"}
    base = cmd["commandId"]
    if deferrals and base.endswith(f"-d{deferrals}"):
        base = base[:-len(f"-d{deferrals}")]
    copy = {"schemaVersion": 1, "commandId": f"{base}-d{deferrals + 1}", "type": "SYNC_ACCOUNT",
            "customerId": cmd["customerId"], "cloudAccountId": cmd["cloudAccountId"],
            "payload": {"mode": mode, "deferrals": deferrals + 1}}
    _send_all(_sender_or_default(sender), [_entry(0, copy, settings.defer_seconds)])
    return {"status": "DEFERRED", "deferrals": deferrals + 1}


def dispatch(engine: Engine, cmd: dict, liveness_sink: Callable[[str, str, dict], None] | None = None,
             sender: CommandSender | None = None) -> dict:
    t, cus, p = cmd["type"], cmd["customerId"], cmd.get("payload") or {}
    _check_system_customer(t, cus)
    try:
        if t == "SYNC_ALL_ACCOUNTS":
            if p.get("mode") not in SCHEDULED_MODES:
                raise InvalidCommand(f"bad mode {p.get('mode')}")
            return _fan_out(engine, cmd, p["mode"], sender)
        if t == "SYNC_ACCOUNT":
            mode = p.get("mode", "ON_DEMAND")
            if mode not in ("DAILY", "TAG_RECONCILE", "ON_DEMAND"):
                raise InvalidCommand(f"bad mode {mode}")
            started = time.monotonic()
            deferrals = p.get("deferrals") or 0
            base_id = cmd["commandId"]
            if deferrals and base_id.endswith(f"-d{deferrals}"):
                base_id = base_id[:-len(f"-d{deferrals}")]      # a deferred copy dedupes under the original id
            counts = engine.sync_account(_account_of(engine, cmd), mode, base_id)
            logger.info("SYNC_ACCOUNT %s mode=%s took %.1fs", cmd["commandId"], mode, time.monotonic() - started)
            if counts.get("skipped") == "INACTIVE":     # D-43: suspended/terminated/disabled since it was queued
                logger.warning("SYNC_ACCOUNT %s SKIPPED_INACTIVE (customer/account no longer active)", cmd["commandId"])
                return {"status": "SKIPPED_INACTIVE", "counts": counts}
            if counts.get("skipped") == "DUPLICATE":
                logger.info("SYNC_ACCOUNT %s SKIPPED_DUPLICATE (command already finished)", cmd["commandId"])
                return {"status": "SKIPPED_DUPLICATE", "counts": counts}
            if counts.get("skipped") == "BUSY":
                if mode in SCHEDULED_MODES:
                    return _defer_or_skip(cmd, p, mode, sender)
                logger.warning("SYNC_ACCOUNT %s SKIPPED_BUSY (%s)", cmd["commandId"], mode)
                return {"status": "SKIPPED_BUSY", "counts": counts}
            return {"status": "OK", "counts": counts}
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


DEFAULT_TIME_MARGIN_MS = 30_000


def _debug_tb() -> bool:
    """Local debugging only: tracebacks are off unless ALARMOPS_DEBUG_TRACEBACK=1."""
    return os.environ.get("ALARMOPS_DEBUG_TRACEBACK") == "1"


def _margin_ms() -> int:
    try:
        return max(0, int(os.environ.get("ALARMOPS_TIME_MARGIN_MS", DEFAULT_TIME_MARGIN_MS)))
    except ValueError:
        return DEFAULT_TIME_MARGIN_MS


def handle_batch(engine: Engine, event: dict, remaining_ms: Callable[[], int] | None = None,
                 margin_ms: int = DEFAULT_TIME_MARGIN_MS, sender: CommandSender | None = None) -> dict:
    """Process the SQS records in order. With `remaining_ms` (Lambda context), a record is only started while at least
    `margin_ms` is left; the rest are returned in `batchItemFailures` (SQS redelivers them; commands are idempotent)."""
    failures: list[dict[str, str]] = []
    records = event.get("Records", [])
    for i, rec in enumerate(records):
        if remaining_ms is not None and remaining_ms() < margin_ms:
            logger.warning("time budget reached: %d of %d records not started", len(records) - i, len(records))
            failures.extend({"itemIdentifier": r["messageId"]} for r in records[i:])
            break
        try:
            envelope = json.loads(rec["body"])
        except (ValueError, RecursionError):
            envelope = None
        if events.is_cloudtrail_event(envelope):    # forwarded CloudTrail tag event (customer stack TagChangeRule)
            try:
                out = events.handle_tag_event(engine, envelope)
                logger.info("tag event %s → %s", rec.get("messageId"), out.get("status"))
            except Exception as e:  # noqa: BLE001
                logger.error("tag event %s failed: %s", rec.get("messageId"), safe_error(e), exc_info=_debug_tb())
                failures.append({"itemIdentifier": rec["messageId"]})
            continue
        try:
            envelope = json.loads(rec["body"])
        except (ValueError, RecursionError):
            envelope = None
        if events.is_cloudtrail_event(envelope):    # forwarded CloudTrail tag event (customer stack TagChangeRule)
            try:
                out = events.handle_tag_event(engine, envelope)
                logger.info("tag event %s → %s", rec.get("messageId"), out.get("status"))
            except Exception:  # noqa: BLE001
                logger.exception("tag event %s failed", rec.get("messageId"))
                failures.append({"itemIdentifier": rec["messageId"]})
            continue
        try:
            cmd = parse(rec["body"])
        except InvalidCommand as e:
            logger.error("dropping invalid command %s: %s", rec.get("messageId"), e)   # poison: do not retry
            continue
        try:
            out = dispatch(engine, cmd, sender=sender)
            logger.info("command %s %s customer=%s → %s", cmd["commandId"], cmd["type"], cmd["customerId"],
                        out.get("status"))
        except InvalidCommand as e:
            logger.error("invalid command %s customer=%s: %s", cmd["commandId"], cmd["customerId"], e)
        except Exception as e:  # noqa: BLE001
            logger.error("command %s customer=%s failed: %s", cmd["commandId"], cmd["customerId"], safe_error(e),
                         exc_info=_debug_tb())
            failures.append({"itemIdentifier": rec["messageId"]})
    return {"batchItemFailures": failures}


_ENGINE: Engine | None = None


def lambda_handler(event: dict, context: Any) -> dict:
    """SQS entry (template: Handler alarm_engine.handler.lambda_handler). The engine (DB URL from Secrets Manager)
    is built once per container; a failed build is not cached and fails the whole batch so SQS redelivers it."""
    global _ENGINE
    if _ENGINE is None:
        from alarm_engine.wiring import build_engine
        try:
            _ENGINE = build_engine()
        except Exception as e:  # noqa: BLE001
            # Only the exception type: a driver error can carry the connection string.
            logger.error("engine init failed: %s", type(e).__name__)
            return {"batchItemFailures": [{"itemIdentifier": r["messageId"]} for r in event.get("Records", [])]}
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    return handle_batch(_ENGINE, event, remaining, _margin_ms())
