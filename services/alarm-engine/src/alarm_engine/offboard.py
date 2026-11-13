"""OFFBOARD_ACCOUNT (D-43): delete the alarms AlarmOps created in a terminated customer's account.

Only alarms tagged `ManagedBy=AlarmOps` are deleted — never by name format, never alarms of the customer's own
(`ManagedBy` missing or another value, legacy `AlarmManager` included). Rules, all re-checked in code:

1. The offboarding row exists for THIS customer and the customer is TERMINATED (a destructive command must never act
   on an active customer, whatever the queue says).
2. The account belongs to the customer (the handler checks too) and has the AlarmWriter role enabled. Without it
   nothing is called: the step becomes MANUAL with `CAPABILITY_DISABLED`.
3. Two passes per region. Pass 1 lists the account's alarms and keeps those whose ARN is in this account and region
   and whose tags say `ManagedBy=AlarmOps`. Pass 2 re-reads each batch (describe + tags) right before
   `DeleteAlarms` and deletes only what still passes. An alarm whose ARN is in another account or region is never
   deleted (and counted as `skippedForeign`).
4. Regions: the account's regions plus us-east-1 (alarms of global resource types live there).
5. A failure on a region is recorded (`FAILED`, the step turns MANUAL) and raised so the message is retried; a retry
   lists again, so nothing is deleted twice and a second run with nothing left is OK with `deleted: 0`.

The result of every account is merged into `CustomerOffboarding.steps.ALARMS_DELETED`
(`repository.merge_offboard_result`).
"""

from __future__ import annotations

import logging
from typing import Any

from alarm_engine import naming
from alarm_engine.aws import CapabilityDisabled, SessionFactory, _paginate, assert_arn_in_account
from alarm_engine.repository import Repository

logger = logging.getLogger(__name__)
DELETE_BATCH = 100
GLOBAL_ALARM_REGION = "us-east-1"


class TargetNotFound(LookupError):
    """The offboarding does not exist for this customer: poison (retry cannot help). Other lookup errors are bugs and retry."""


class OffboardFailed(RuntimeError):
    """Some alarms could not be deleted. Raised AFTER the result was recorded, so SQS retries the (idempotent) command."""


def _verified(cw: Any, account: Any, region: str, raw: dict) -> bool | None:
    """True = ours and in this account/region; False = leave alone; None = in another account/region (never touch)."""
    arn = raw.get("AlarmArn") or ""
    try:
        assert_arn_in_account(arn, account, region)
    except PermissionError:
        return None
    tags = {t["Key"]: t["Value"] for t in cw.list_tags_for_resource(ResourceARN=arn).get("Tags", [])}
    return tags.get("ManagedBy") == naming.MANAGED_BY


def run(repo: Repository, sessions: SessionFactory, customer_id: str, cloud_account_id: str,
        offboarding_id: str) -> dict:
    ob = repo.get_offboarding(customer_id, offboarding_id)
    if ob is None:
        raise TargetNotFound(f"offboarding {offboarding_id} not found for customer {customer_id}")
    # The offboarding row belongs to this customer (get_offboarding is scoped), so a refusal may be written on it:
    # the step turns MANUAL and says why, instead of staying PENDING with no trace.
    if ob.customer_status != "TERMINATED":
        reason = "customer is not TERMINATED"
        repo.record_offboard_result(customer_id, offboarding_id, cloud_account_id, {"status": "REFUSED", "deleted": 0, "failed": 0, "reason": reason})
        return {"status": "REFUSED", "reason": reason}
    account = repo.get_account(cloud_account_id)
    if account.customer_id != customer_id:
        reason = "tenant mismatch"
        repo.record_offboard_result(customer_id, offboarding_id, cloud_account_id, {"status": "REFUSED", "deleted": 0, "failed": 0, "reason": reason})
        return {"status": "REFUSED", "reason": reason}

    deleted = failed = foreign = 0
    errors: list[str] = []
    try:
        account.role_arn("alarmWriter")        # missing or disabled → CapabilityDisabled, before any call
        for region in dict.fromkeys((*account.regions, GLOBAL_ALARM_REGION)):
            try:
                cw = sessions.client(account, "alarmWriter", "cloudwatch", region)
                names: list[str] = []
                for raw in _paginate(cw, "describe_alarms", "MetricAlarms", AlarmTypes=["MetricAlarm"]):
                    ok = _verified(cw, account, region, raw)
                    if ok is None:
                        foreign += 1
                    elif ok:
                        names.append(raw["AlarmName"])
                for i in range(0, len(names), DELETE_BATCH):
                    batch = names[i:i + DELETE_BATCH]
                    # pass 2: read again right before the delete
                    again = cw.describe_alarms(AlarmNames=batch).get("MetricAlarms", [])
                    keep = [a["AlarmName"] for a in again if _verified(cw, account, region, a) is True]
                    if keep:
                        cw.delete_alarms(AlarmNames=keep)
                        deleted += len(keep)
            except CapabilityDisabled:
                raise
            except Exception as e:  # noqa: BLE001 — recorded by type name only, never the raw message
                failed += 1
                errors.append(f"{region}: {type(e).__name__}")
                logger.exception("offboard %s account %s region %s failed", offboarding_id, cloud_account_id, region)
    except CapabilityDisabled:
        repo.record_offboard_result(customer_id, offboarding_id, cloud_account_id,
                                    {"status": "CAPABILITY_DISABLED", "deleted": deleted, "failed": 0})
        return {"status": "CAPABILITY_DISABLED", "role": "alarmWriter"}

    result: dict[str, Any] = {"status": "OK" if not failed else "FAILED", "deleted": deleted, "failed": failed}
    if foreign:
        result["skippedForeign"] = foreign
    if errors:
        result["errors"] = errors
    repo.record_offboard_result(customer_id, offboarding_id, cloud_account_id, result)
    if failed:
        raise OffboardFailed(f"{failed} region(s) failed for account {cloud_account_id}")
    return {"status": "OK", "deleted": deleted, "failed": 0, **({"skippedForeign": foreign} if foreign else {})}
