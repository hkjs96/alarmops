"""CloudTrail-driven immediate reactions (legacy `remediation_handler` routing, alarm-sync §6-4), source stubbed.

Ported rule, with D-16 / D-15 applied:
- CREATE → sync if the new resource has Monitoring=on.
- DELETE → resource gone: mark DELETED and delete its alarms (unchanged).
- TAG_CHANGE → Monitoring added `on` → sync. Monitoring removed / other value → **NEEDS_REVIEW** (was: delete +
  MONITORING_REMOVED). Only Threshold_* changed on a monitored resource → sync.
  Removal events are the explicit list; every other tag event is treated as add/change.
- MODIFY on a monitored resource → remediation **proposal** only (D-15).
- (new) CloudWatch `PutMetricAlarm` / `DeleteAlarms` on one of our alarms by a principal other than the engine's
  AlarmWriter role → re-sync the resource; the sync records EXTERNAL_CHANGE / MISSING.

The event source (EventBridge forwarder → SQS) is not built here; `route()` takes the CloudTrail `detail` dict.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from alarm_engine.resource_types.base import CREATE, DELETE, MODIFY, TAG_CHANGE, event_to_type

REMOVE_TAG_EVENTS = frozenset({"DeleteTags", "RemoveTagsFromResource", "RemoveTags", "UntagQueue", "UntagResource"})
ALARM_EVENTS = frozenset({"PutMetricAlarm", "DeleteAlarms"})

Action = Literal["SYNC", "DELETE_RESOURCE", "NEEDS_REVIEW", "PROPOSE_REMEDIATION", "IGNORE"]


@dataclass(frozen=True)
class Reaction:
    action: Action
    kind: str = ""
    resource_type: str = ""
    reason: str = ""


def _kinds() -> dict[str, str]:
    from alarm_engine.resource_types.base import monitored_api_events
    return {ev: kind for kind, evs in monitored_api_events().items() for ev in evs}


def route(event_name: str, *, monitored: bool, tag_keys_changed: set[str] | None = None,
          monitoring_after: str | None = None, principal_arn: str = "", engine_role_arn: str = "") -> Reaction:
    """Pure routing. `monitoring_after` = Monitoring tag value after the event (None if unknown/removed)."""
    if event_name in ALARM_EVENTS:
        role_name = engine_role_arn.rsplit("/", 1)[-1] if engine_role_arn else ""
        if role_name and f":assumed-role/{role_name}/" in principal_arn:
            return Reaction("IGNORE", reason="our own write")
        return Reaction("SYNC", reason="alarm changed outside AlarmOps")
    kind = _kinds().get(event_name)
    rtype = event_to_type().get(event_name, "")
    if kind is None:
        return Reaction("IGNORE", reason="unmonitored event")
    if kind == CREATE:
        return Reaction("SYNC" if (monitoring_after or "").lower() == "on" else "IGNORE", kind, rtype)
    if kind == DELETE:
        return Reaction("DELETE_RESOURCE", kind, rtype)
    if kind == TAG_CHANGE:
        keys = tag_keys_changed or set()
        if "Monitoring" in keys:
            removed = event_name in REMOVE_TAG_EVENTS
            if not removed and (monitoring_after or "").strip().lower() == "on":
                return Reaction("SYNC", kind, rtype, "Monitoring=on added")
            return Reaction("NEEDS_REVIEW" if monitored else "IGNORE", kind, rtype, "Monitoring tag removed (D-16)")
        if monitored and any(k.startswith("Threshold_") for k in keys):
            return Reaction("SYNC", kind, rtype, "Threshold_* changed")
        return Reaction("IGNORE", kind, rtype)
    if kind == MODIFY:
        return Reaction("PROPOSE_REMEDIATION" if monitored else "IGNORE", kind, rtype)
    return Reaction("IGNORE")
