"""Diff desired vs actual alarms → commands (alarm-sync.md §5, D-08, D-16).

Ported rules: only alarms we own are touched (metadata + ManagedBy=AlarmOps); `off` → delete; threshold diff > 0.001
in CloudWatch units or config drift on `CONFIG_FIELDS` → update; missing severity in description → refresh in place;
manual severity (alarm `Severity` tag differs from the registry default) is preserved (F8); disk-metric lookup failure
or "no CWAgent metrics" never causes delete/recreate (4-1, 4-2); a definition that cannot be built never deletes the
existing alarm (4-8).

Changed by D-08: every update is an in-place `PutMetricAlarm` on the **same name** — there is no delete+recreate path.

External change (P4-5): when an alarm differs from what the engine last applied (`last_applied`) and our desired value
did not change, it was edited outside AlarmOps. Default policy `hold`: record `EXTERNAL_CHANGE`, do not overwrite;
the console's restore action re-runs with `restore_external=True`. (Legacy overwrote silently — see report.)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from alarm_engine import naming
from alarm_engine.desired import DesiredAlarm, DesiredSet
from alarm_engine.registry import get_severity, is_valid_severity

THRESHOLD_EPS = 0.001
#: PutMetricAlarm field ↔ DesiredAlarm attribute. Namespace/MetricName/Dimensions are identity, not compared.
CONFIG_FIELDS: dict[str, str] = {
    "Statistic": "statistic",
    "Period": "period",
    "EvaluationPeriods": "evaluation_periods",
    "ComparisonOperator": "comparison",
    "TreatMissingData": "treat_missing_data",
    "DatapointsToAlarm": "datapoints_to_alarm",
}

Op = Literal["CREATE", "UPDATE", "REFRESH", "DELETE"]


@dataclass(frozen=True)
class ActualAlarm:
    """DescribeAlarms row + its tags (ListTagsForResource)."""
    raw: dict[str, Any]
    tags: dict[str, str]

    @property
    def name(self) -> str:
        return str(self.raw["AlarmName"])

    @property
    def arn(self) -> str:
        return str(self.raw.get("AlarmArn", ""))

    @property
    def metadata(self) -> naming.AlarmMetadata | None:
        return naming.parse_metadata(self.raw.get("AlarmDescription"))


@dataclass(frozen=True)
class Command:
    op: Op
    name: str
    metric_key: str
    desired: DesiredAlarm | None = None
    actual: ActualAlarm | None = None
    changed: tuple[str, ...] = ()
    severity: str | None = None      # severity to write (manual preserved)
    severity_manual: bool = False
    reason: str = ""


@dataclass
class SyncPlan:
    commands: list[Command] = field(default_factory=list)
    in_sync: list[tuple[DesiredAlarm, ActualAlarm, str, bool]] = field(default_factory=list)  # (d, a, sev, manual)
    external_changes: list[tuple[DesiredAlarm, ActualAlarm, dict]] = field(default_factory=list)
    kept: list[ActualAlarm] = field(default_factory=list)   # ours, not desired, intentionally left (disk/dynamic)

    def counts(self) -> dict[str, int]:
        c = {"created": 0, "updated": 0, "refreshed": 0, "deleted": 0, "externalChange": len(self.external_changes)}
        for cmd in self.commands:
            c[{"CREATE": "created", "UPDATE": "updated", "REFRESH": "refreshed", "DELETE": "deleted"}[cmd.op]] += 1
        return c


def _actual_value(a: ActualAlarm, f: str) -> Any:
    v = a.raw.get(f)
    if f == "TreatMissingData" and v is None:
        return "notBreaching"
    if f == "DatapointsToAlarm" and v is None:
        return a.raw.get("EvaluationPeriods")   # unset = same as EvaluationPeriods (alarm-sync §5-7)
    return v


def diff_fields(d: DesiredAlarm, a: ActualAlarm) -> dict[str, tuple[Any, Any]]:
    """{field: (expected, actual)} that differ."""
    out: dict[str, tuple[Any, Any]] = {}
    at = a.raw.get("Threshold")
    if at is None or abs(float(at) - d.threshold) > THRESHOLD_EPS:
        out["Threshold"] = (d.threshold, at)
    for f, attr in CONFIG_FIELDS.items():
        exp = getattr(d, attr)
        if exp is None:
            continue
        act = _actual_value(a, f)
        if act != exp:
            out[f] = (exp, act)
    return out


def effective_severity(metric_key: str, actual: ActualAlarm | None) -> tuple[str, bool]:
    """F8: a valid `Severity` tag that differs from the registry default is a manual severity and wins."""
    default = get_severity(metric_key)
    if actual is not None:
        tag = actual.tags.get("Severity")
        if is_valid_severity(tag) and tag != default:
            return str(tag), True
    return default, False


def plan(
    desired: DesiredSet,
    actual: list[ActualAlarm],
    *,
    last_applied: dict[str, dict[str, Any]] | None = None,
    restore_external: bool = False,
) -> SyncPlan:
    """`actual` must already be filtered to this resource; non-owned alarms are ignored here as a second guard."""
    p = SyncPlan()
    ours = {a.name: a for a in actual if naming.is_ours(a.raw, a.tags)}
    by_key: dict[str, ActualAlarm] = {}
    for owned in ours.values():
        omd = owned.metadata
        if omd:
            by_key.setdefault(omd.metric_key, owned)
    desired_keys = {d.metric_key for d in desired.alarms}
    last = last_applied or {}

    for d in desired.alarms:
        a = ours.get(d.name) or by_key.get(d.metric_key)
        sev, manual = effective_severity(d.metric_key, a)
        if a is None:
            p.commands.append(Command("CREATE", d.name, d.metric_key, desired=d, severity=sev, severity_manual=manual))
            continue
        diffs = diff_fields(d, a)
        if diffs:
            prev = last.get(d.metric_key)
            if prev is not None and not restore_external and _desired_unchanged(prev, d) and _external(prev, a):
                p.external_changes.append((d, a, {k: {"expected": e, "actual": v} for k, (e, v) in diffs.items()}))
                continue
            # In place under the EXISTING name (D-08). A changed `Name` tag does not rename either.
            p.commands.append(Command("UPDATE", a.name, d.metric_key, desired=d, actual=a, changed=tuple(diffs),
                                      severity=sev, severity_manual=manual))
            continue
        md = a.metadata
        if md is None or md.severity is None or md.severity != sev or a.tags.get("Severity") != sev:
            p.commands.append(Command("REFRESH", a.name, d.metric_key, desired=d, actual=a, severity=sev,
                                      severity_manual=manual, reason="description/severity refresh (F3)"))
            continue
        p.in_sync.append((d, a, sev, manual))

    for key, a in by_key.items():
        if key in desired_keys:
            continue
        if key in desired.off_keys:
            p.commands.append(Command("DELETE", a.name, key, actual=a, reason="threshold off"))
        elif key.startswith("Disk_"):
            # 4-1/4-2: missing disk metrics or a failed lookup never deletes disk alarms.
            p.kept.append(a)
        elif key in desired.dynamic_unresolved:
            p.kept.append(a)
        else:
            # Dynamic tag removed, or the definition is no longer produced (variant change) — legacy deletes; kept.
            p.commands.append(Command("DELETE", a.name, key, actual=a, reason="no longer defined"))
    return p


def _desired_unchanged(prev: dict[str, Any], d: DesiredAlarm) -> bool:
    exp = prev.get("expected", {})
    return (abs(float(exp.get("Threshold", d.threshold)) - d.threshold) <= THRESHOLD_EPS
            and all(exp.get(f, getattr(d, attr)) == getattr(d, attr)
                    for f, attr in CONFIG_FIELDS.items() if getattr(d, attr) is not None))


def _external(prev: dict[str, Any], a: ActualAlarm) -> bool:
    """The alarm no longer matches what we last wrote."""
    exp = prev.get("expected", {})
    if "Threshold" in exp and abs(float(a.raw.get("Threshold", 0.0)) - float(exp["Threshold"])) > THRESHOLD_EPS:
        return True
    return any(f in exp and exp[f] is not None and _actual_value(a, f) != exp[f] for f in CONFIG_FIELDS)


def expected_snapshot(d: DesiredAlarm) -> dict[str, Any]:
    """What we wrote — stored as ManagedAlarm fields / driftDetail.expected for external-change detection."""
    return {"Threshold": d.threshold, **{f: getattr(d, attr) for f, attr in CONFIG_FIELDS.items()}}
