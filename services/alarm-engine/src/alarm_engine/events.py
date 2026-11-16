"""CloudTrail tag-change events (customer stack `TagChangeRule` → central bus) → immediate sync of the resource.

Input is the EventBridge envelope as forwarded by the customer account. Trust model:
- the customer account is the envelope's **top-level `account`** only (set by EventBridge, not by the sender's
  payload); `detail.recipientAccountId`, `detail.userIdentity.*` and every ARN inside the request are never used to pick
  the tenant. Unknown account / customer not ACTIVE → ignored.
- the event only says *which* resource changed and *which keys*; the resulting state comes from re-reading the tags
  through the Reader role (`Engine.sync_after_tag_event`, D-16): Monitoring removed → NEEDS_REVIEW (alarms untouched),
  Monitoring=on → MONITORED + sync, `Threshold_*` changed → sync.
- Monitoring added on a resource we have no row for → one TAG_RECONCILE account run (the next hourly run would do it
  anyway).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from alarm_engine.engine import Engine
from alarm_engine.manual_change import REMOVE_TAG_EVENTS, route
from alarm_engine.repository import ResourceRow
from alarm_engine.resource_types.base import all_specs

logger = logging.getLogger(__name__)

TAG_EVENTS = frozenset({
    "CreateTags", "DeleteTags", "AddTagsToResource", "RemoveTagsFromResource", "AddTags", "RemoveTags", "TagResource",
    "UntagResource", "TagResources", "UntagResources", "TagQueue", "UntagQueue",
})
DETAIL_TYPE = "AWS API Call via CloudTrail"
_AWS_ID = re.compile(r"^\d{12}$")
_ID_PREFIXES = ("i-", "nat-", "vpn-")
_EC2_RESOURCES = ("instance/", "natgateway/", "vpn-connection/")


def is_cloudtrail_event(obj: Any) -> bool:
    return isinstance(obj, dict) and obj.get("detail-type") == DETAIL_TYPE


def _walk(v: Any) -> list[Any]:
    out = [v]
    if isinstance(v, dict):
        for x in v.values():
            out += _walk(x)
    elif isinstance(v, list):
        for x in v:
            out += _walk(x)
    return out


def _keys_of(v: Any) -> list[str]:
    """Tag keys from the shapes services use: {k: v}, [{key|Key: k}], [k]."""
    if isinstance(v, dict):
        if "items" in v:
            return _keys_of(v["items"])
        return [k for k in v if isinstance(k, str)]
    out: list[str] = []
    for x in v if isinstance(v, list) else []:
        if isinstance(x, dict):
            k = x.get("key", x.get("Key"))
            if isinstance(k, str):
                out.append(k)
        elif isinstance(x, str):
            out.append(x)
    return out


def _value_of(v: Any, key: str) -> str | None:
    if isinstance(v, dict):
        if "items" in v:
            return _value_of(v["items"], key)
        x = v.get(key)
        return x if isinstance(x, str) else None
    for x in v if isinstance(v, list) else []:
        if isinstance(x, dict) and x.get("key", x.get("Key")) == key:
            val = x.get("value", x.get("Value"))
            return val if isinstance(val, str) else None
    return None


def extract(event_name: str, params: Any) -> tuple[set[str], set[str], str | None]:
    """(resource refs: ARNs / ids / names, tag keys changed, Monitoring value after the event)."""
    if not isinstance(params, dict):
        return set(), set(), None
    refs: set[str] = set()
    for v in _walk(params):
        if isinstance(v, str) and (v.startswith("arn:") or v.startswith(_ID_PREFIXES)):
            refs.add(v)
    url = params.get("queueUrl")
    if isinstance(url, str) and url:
        refs.add(url.rsplit("/", 1)[-1])
    keys: set[str] = set()
    monitoring: str | None = None
    for name in ("tags", "tagSet", "TagList", "tagList", "tagKeys", "TagKeys"):
        if name in params:
            keys |= set(_keys_of(params[name]))
            if monitoring is None and event_name not in REMOVE_TAG_EVENTS:
                monitoring = _value_of(params[name], "Monitoring")
    return refs, keys, monitoring


def _supported(ref: str, event_name: str) -> bool:
    if event_name in ("TagQueue", "UntagQueue"):
        return True
    if ref.startswith(_ID_PREFIXES):
        return True
    parts = ref.split(":", 5)
    if len(parts) < 6:
        return False
    if parts[2] == "ec2":
        return parts[5].startswith(_EC2_RESOURCES)
    services = {s for spec in all_specs() for s in spec.rgt_services} | {"rds", "es", "kafka", "mq"}
    return parts[2] in services


def _rows_for(engine: Engine, account_id: str, refs: set[str]) -> list[ResourceRow]:
    tails = {r.rsplit("/", 1)[-1].rsplit(":", 1)[-1] for r in refs} | refs
    return [r for r in engine.repo.list_resources(account_id)
            if r.resource_arn in refs or r.resource_key in tails or r.resource_key in refs]


def handle_tag_event(engine: Engine, event: dict) -> dict:
    if not is_cloudtrail_event(event):
        return {"status": "IGNORED", "reason": "not a CloudTrail API event"}
    aws_account = event.get("account")                       # top-level only (see module docstring)
    detail = event.get("detail")
    detail = detail if isinstance(detail, dict) else {}
    name = detail.get("eventName")
    if not isinstance(aws_account, str) or not _AWS_ID.match(aws_account):
        return {"status": "IGNORED", "reason": "bad account"}
    if name not in TAG_EVENTS:
        return {"status": "IGNORED", "reason": "not a tag event"}
    account = engine.repo.find_active_account_by_aws_id(aws_account)
    if account is None:
        logger.warning("tag event for unknown/inactive account %s", aws_account)
        return {"status": "IGNORED", "reason": "unknown account"}
    refs, keys, monitoring = extract(name, detail.get("requestParameters"))
    refs = {r for r in refs if _supported(r, name)}
    if not refs:
        return {"status": "IGNORED", "reason": "no supported resource"}
    rows = _rows_for(engine, account.id, refs)
    actions: list[dict] = []
    for row in rows:
        reaction = route(name, monitored=row.monitoring_state in ("MONITORED", "NEEDS_REVIEW"),
                         tag_keys_changed=keys, monitoring_after=monitoring)
        if reaction.action in ("SYNC", "NEEDS_REVIEW"):
            state = engine.sync_after_tag_event(account, row)
            actions.append({"resourceId": row.id, "state": state})
    if not rows and keys & {"Monitoring"} \
            and route(name, monitored=False, tag_keys_changed=keys, monitoring_after=monitoring).action == "SYNC":
        counts = engine.sync_account(account.id, "TAG_RECONCILE")
        return {"status": "OK", "accountSync": counts}
    return {"status": "OK" if actions else "IGNORED", "actions": actions}
