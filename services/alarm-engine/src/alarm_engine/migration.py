"""D-08 migration helper: legacy alarm names (with threshold) → new names (resource + metric). Dry run only.

Legacy: `[{type}] {label} {metric} {dir} {thr}{unit} (TagName: {id})`, tag `ManagedBy=AlarmManager`, snake_case JSON.
New:    `[{type}] {label} {metric} (TagName: {id})`, tag `ManagedBy=AlarmOps`, camelCase JSON.

The plan never writes. A person (or a later, approved engine command) executes it: create the new alarm with the
resolved values, then delete the legacy one (CloudWatch cannot rename). Alarm state/history of the legacy alarm is
lost once — this is the last rename these alarms get.

    python -m alarm_engine.migration alarms.json   # DescribeAlarms JSON (+ optional "Tags" per alarm) → report
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass

from alarm_engine import naming

LEGACY_KEY_MAP: dict[str, str] = {
    "CPU": "CPUUtilization", "Memory": "mem_used_percent", "Disk": "disk_used_percent",
    "FreeMemoryGB": "FreeableMemory", "FreeStorageGB": "FreeStorageSpace", "Connections": "DatabaseConnections",
    "ELB5XX": "HTTPCode_ELB_5XX_Count", "TCPClientReset": "TCP_Client_Reset_Count",
    "TCPTargetReset": "TCP_Target_Reset_Count", "TGResponseTime": "TargetResponseTime",
    "FreeLocalStorageGB": "FreeLocalStorage",
}
_LEGACY_RE = re.compile(
    r"^(?P<head>\[[^\]]+\]\s+.*?)\s+(?:<=|>=|<|>)\s*[-+]?\d+(?:\.\d+)?\S*\s+(?P<tail>\(TagName:\s*.+\))$")


@dataclass(frozen=True)
class MigrationItem:
    old_name: str
    new_name: str | None
    metric_key: str | None
    resource_id: str | None
    action: str        # RENAME | ALREADY_NEW | NOT_OURS | UNPARSEABLE | DUPLICATE
    note: str = ""


def new_name_for(alarm: dict, resource_name: str | None = None) -> str | None:
    md = naming.parse_metadata(alarm.get("AlarmDescription"))
    if md and md.resource_type:
        key = LEGACY_KEY_MAP.get(md.metric_key, md.metric_key)
        return naming.alarm_name(md.resource_type, md.resource_id, resource_name or md.resource_name or "", key)
    m = _LEGACY_RE.match(alarm.get("AlarmName", ""))
    return f"{m.group('head')} {m.group('tail')}" if m else None


def plan_migration(alarms: list[dict], name_tags: dict[str, str] | None = None) -> list[MigrationItem]:
    """`alarms`: DescribeAlarms rows, each optionally with `Tags` {k: v}. `name_tags`: resourceId → Name tag."""
    out: list[MigrationItem] = []
    taken: dict[str, str] = {}
    for a in alarms:
        name = a.get("AlarmName", "")
        tags = a.get("Tags") or {}
        md = naming.parse_metadata(a.get("AlarmDescription"))
        if md is None or tags.get("ManagedBy") not in (naming.LEGACY_MANAGED_BY, naming.MANAGED_BY, None):
            out.append(MigrationItem(name, None, None, None, "NOT_OURS", "no metadata or foreign ManagedBy"))
            continue
        if tags.get("ManagedBy") is None:
            out.append(MigrationItem(name, None, md.metric_key, md.resource_id, "NOT_OURS",
                                     "metadata but no ManagedBy tag — check by hand (f376969)"))
            continue
        if not _LEGACY_RE.match(name):
            out.append(MigrationItem(name, name, md.metric_key, md.resource_id, "ALREADY_NEW"))
            taken[name] = name
            continue
        new = new_name_for(a, (name_tags or {}).get(md.resource_id))
        if new is None:
            out.append(MigrationItem(name, None, md.metric_key, md.resource_id, "UNPARSEABLE"))
            continue
        key = LEGACY_KEY_MAP.get(md.metric_key, md.metric_key)
        if new in taken:
            out.append(MigrationItem(name, new, key, md.resource_id, "DUPLICATE", f"same new name as {taken[new]}"))
            continue
        taken[new] = name
        out.append(MigrationItem(name, new, key, md.resource_id, "RENAME"))
    return out


def report(items: list[MigrationItem]) -> str:
    counts: dict[str, int] = {}
    for i in items:
        counts[i.action] = counts.get(i.action, 0) + 1
    lines = ["D-08 alarm name migration — DRY RUN (nothing written)",
             "summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))]
    for i in items:
        lines.append(f"{i.action:12} {i.old_name!r} -> {i.new_name!r}" + (f"  # {i.note}" if i.note else ""))
    return "\n".join(lines)


def main(argv: list[str]) -> int:  # pragma: no cover
    data = json.load(open(argv[1], encoding="utf-8"))
    rows = data.get("MetricAlarms", data) if isinstance(data, dict) else data
    items = plan_migration(rows)
    print(report(items))
    if "--json" in argv:
        print(json.dumps([asdict(i) for i in items], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(sys.argv))
