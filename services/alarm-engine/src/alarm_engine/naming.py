"""Alarm name, description metadata and ownership (alarm-sync.md §1–3, D-08).

Name (D-08, DATA-MODEL ManagedAlarm.alarmName): `[{type}] {label} {metricDisplay} (TagName: {shortId})` — the legacy
format minus ` {dir} {threshold}{unit}`. The name depends only on resource + metric, so a threshold / M-of-N / period
change never renames (and never re-creates) the alarm, and the ingest fingerprint stays stable.

Description: `{human prefix} | {json}`; the JSON is what `packages/core/src/normalize/cloudwatch.ts`
`parseAlarmMetadata` reads (camelCase: managedBy, resourceId, resourceType, metricKey, severity, resourceName). The
1024-char limit is met by trimming the prefix, never the JSON.

Ownership (f376969, known-bugs 4-6): an alarm is ours only if its description JSON parses with resourceId+metricKey
AND its `ManagedBy` tag is `AlarmOps`. The name format is never used for ownership.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from alarm_engine.registry import _METRIC_DISPLAY, is_valid_severity

MANAGED_BY = "AlarmOps"
LEGACY_MANAGED_BY = "AlarmManager"
MAX_NAME = 255
MAX_DESCRIPTION = 1024
_ELLIPSIS = "..."


def shorten_resource_id(resource_id: str, resource_type: str, resource_tags: dict | None = None) -> str:
    """Ported `_shorten_elb_resource_id` (ALB/NLB/TG short id, ACM domain, APIGW v2 name/id)."""
    tags = resource_tags or {}
    if resource_type == "ACM":
        return tags.get("Name", "") or resource_id
    if resource_type == "APIGW":
        if tags.get("_api_type", "REST") in ("HTTP", "WEBSOCKET") and tags.get("Name"):
            return f"{tags['Name']}/{resource_id}"
        return resource_id
    if resource_type not in ("ALB", "NLB", "TG") or not resource_id:
        return resource_id
    if resource_type in ("ALB", "NLB"):
        for prefix in ("loadbalancer/app/", "loadbalancer/net/"):
            idx = resource_id.find(prefix)
            if idx >= 0:
                return resource_id[idx + len(prefix):]
    else:
        idx = resource_id.find(":targetgroup/")
        if idx >= 0:
            return resource_id[idx + len(":targetgroup/"):]
        if resource_id.startswith("targetgroup/"):
            return resource_id[len("targetgroup/"):]
    return resource_id


def metric_display_name(metric_key: str) -> str:
    """Display metric for a key. `Disk_{suffix}` → `disk_used_percent(/{path})`; unknown (dynamic) → the key."""
    if metric_key.startswith("Disk_"):
        suffix = metric_key[len("Disk_"):]
        return "disk_used_percent(/)" if suffix == "root" else f"disk_used_percent(/{suffix})"
    entry = _METRIC_DISPLAY.get(metric_key)
    return entry[0] if entry else metric_key


def alarm_name(resource_type: str, resource_id: str, resource_name: str, metric_key: str,
               resource_tags: dict | None = None) -> str:
    """Name without threshold. Truncates label, then metric; never the `(TagName: …)` suffix."""
    display = metric_display_name(metric_key)
    label = resource_name or resource_id
    prefix = f"[{resource_type}] "
    suffix = f" (TagName: {shorten_resource_id(resource_id, resource_type, resource_tags)})"
    available = MAX_NAME - len(prefix) - len(suffix)
    if len(label) + 1 + len(display) <= available:
        return f"{prefix}{label} {display}{suffix}"
    label_budget = available - 1 - len(display)
    if label_budget >= len(_ELLIPSIS) + 1:
        return f"{prefix}{label[: label_budget - len(_ELLIPSIS)]}{_ELLIPSIS} {display}{suffix}"
    metric_budget = available - len(_ELLIPSIS) - 1
    if metric_budget >= len(_ELLIPSIS) + 1:
        return f"{prefix}{_ELLIPSIS} {display[: metric_budget - len(_ELLIPSIS)]}{_ELLIPSIS}{suffix}"
    return f"{prefix}{_ELLIPSIS} {_ELLIPSIS}{suffix}"[:MAX_NAME]


def build_description(resource_type: str, resource_id: str, metric_key: str, severity: str,
                      resource_name: str = "", human_prefix: str = "") -> str:
    meta: dict[str, str] = {
        "managedBy": MANAGED_BY,
        "resourceId": resource_id,
        "resourceType": resource_type,
        "metricKey": metric_key,
        "severity": severity,
    }
    if resource_name:
        meta["resourceName"] = resource_name
    js = json.dumps(meta, separators=(",", ":"), ensure_ascii=False)
    if len(js) > MAX_DESCRIPTION and "resourceName" in meta:
        meta.pop("resourceName")
        js = json.dumps(meta, separators=(",", ":"), ensure_ascii=False)
    prefix = human_prefix or f"Managed by AlarmOps for {resource_type} {resource_id}"
    # Readers (core `parseAlarmMetadata`, `parse_metadata`) take the JSON from the FIRST '{' — keep braces out.
    prefix = prefix.replace("{", "(").replace("}", ")")
    room = MAX_DESCRIPTION - len(js) - 3
    if room <= 0:
        return js[:MAX_DESCRIPTION]
    return f"{prefix[:room]} | {js}"


@dataclass(frozen=True)
class AlarmMetadata:
    resource_id: str
    resource_type: str
    metric_key: str
    severity: str | None   # None when missing/invalid (untrusted, alarm-sync §3-3)
    managed_by: str | None
    resource_name: str | None


def parse_metadata(description: str | None) -> AlarmMetadata | None:
    """Accepts our camelCase and the legacy snake_case JSON (migration). Same rule as core `parseAlarmMetadata`."""
    if not description:
        return None
    start = description.find("{")
    if start < 0:
        return None
    try:
        o = json.loads(description[start:])
    except ValueError:
        return None
    if not isinstance(o, dict):
        return None

    def s(a: str, b: str) -> str | None:
        v = o.get(a, o.get(b))
        return v if isinstance(v, str) else None

    rid, mk = s("resourceId", "resource_id"), s("metricKey", "metric_key")
    if not rid or not mk:
        return None
    sev = s("severity", "severity")
    return AlarmMetadata(rid, s("resourceType", "resource_type") or "", mk,
                         sev if is_valid_severity(sev) else None, s("managedBy", "managed_by"),
                         s("resourceName", "resource_name"))


def is_ours(alarm: dict, alarm_tags: dict[str, str]) -> bool:
    """Ownership: metadata + `ManagedBy=AlarmOps` tag. Legacy `AlarmManager` alarms are handled by migration only."""
    return alarm_tags.get("ManagedBy") == MANAGED_BY and parse_metadata(alarm.get("AlarmDescription")) is not None


def alarm_arn_region_account(arn: str) -> tuple[str, str]:
    parts = arn.split(":")
    return (parts[3], parts[4]) if len(parts) > 5 else ("", "")
