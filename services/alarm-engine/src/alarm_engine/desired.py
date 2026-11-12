"""Desired alarm definitions for one resource (legacy `create_alarms_for_resource` minus the AWS writes).

Ports alarm_builder `_create_standard_alarm` / `_create_disk_alarms` / `_create_dynamic_alarm` as *pure* builders that
return `DesiredAlarm`s; `sync.py` diffs them against what exists and `apply.py` writes. AWS reads (CWAgent disk
dimensions, dynamic-metric dimensions) go through the customer CloudWatch client passed in (known-bugs 4-2).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from alarm_engine import naming
from alarm_engine import tags as T
from alarm_engine.dimensions import (
    DiskLookupError,
    build_dimensions,
    get_disk_dimensions,
    resolve_metric_dimensions,
    resolve_namespace,
)
from alarm_engine.registry import (
    _GLOBAL_SERVICE_REGION,
    _apply_eval_policy,
    _get_alarm_defs_raw,
    get_dynamic_eval_policy,
    get_severity,
)
from alarm_engine.thresholds import LayerValues, Resolved, resolve

DYNAMIC_PERIOD = 300


@dataclass(frozen=True)
class ResourceRef:
    resource_type: str
    resource_id: str          # engine key (ELB family: full ARN)
    region: str               # resource region (known-bugs 4-3)
    account_id: str           # customer AWS account id
    tags: dict[str, str]
    db_id: str | None = None  # Resource.id

    @property
    def name(self) -> str:
        return self.tags.get("Name", "")


@dataclass(frozen=True)
class DesiredAlarm:
    name: str
    metric_key: str
    region: str
    namespace: str
    metric_name: str
    dimensions: list[dict]
    statistic: str
    period: int
    evaluation_periods: int
    datapoints_to_alarm: int | None
    threshold: float
    comparison: str
    treat_missing_data: str
    severity: str
    description: str
    resolved: Resolved | None
    dynamic: bool = False
    kind: str = "standard"    # standard | disk | dynamic

    def put_params(self, actions: list[str] | None = None) -> dict[str, Any]:
        """PutMetricAlarm parameters. Same field set as `sync.CONFIG_FIELDS` (alarm-sync §4-5: else endless rewrite)."""
        p: dict[str, Any] = {
            "AlarmName": self.name, "AlarmDescription": self.description,
            "Namespace": self.namespace, "MetricName": self.metric_name, "Dimensions": self.dimensions,
            "Statistic": self.statistic, "Period": self.period, "EvaluationPeriods": self.evaluation_periods,
            "Threshold": self.threshold, "ComparisonOperator": self.comparison,
            "TreatMissingData": self.treat_missing_data, "ActionsEnabled": True,
            "AlarmActions": list(actions or []), "OKActions": list(actions or []),
        }
        if self.datapoints_to_alarm is not None:
            p["DatapointsToAlarm"] = self.datapoints_to_alarm
        return p


#: (metric_key) -> (console, customer, msp) layer values for this resource.
LayerLookup = Callable[[str], tuple[LayerValues | None, LayerValues | None, LayerValues | None]]


def _no_layers(_: str) -> tuple[None, None, None]:
    return None, None, None


@dataclass
class DesiredSet:
    alarms: list[DesiredAlarm] = field(default_factory=list)
    off_keys: set[str] = field(default_factory=set)        # resolved off → delete if exists
    disk_unknown: bool = False                               # disk lookup failed → leave disk alarms alone
    dynamic_unresolved: set[str] = field(default_factory=set)  # tag present, metric not found → keep existing


def alarm_region(resource: ResourceRef, alarm_def: dict | None = None) -> str:
    return (alarm_def or {}).get("region") or _GLOBAL_SERVICE_REGION.get(resource.resource_type) or resource.region


def type_defs(resource_type: str, tags: dict) -> list[dict]:
    """Eval-policy-applied definitions (the eval *tag* is applied by the resolver, with provenance)."""
    return _apply_eval_policy(_get_alarm_defs_raw(resource_type, tags))


def build_desired(resource: ResourceRef, cw: Any, layers: LayerLookup = _no_layers) -> DesiredSet:
    out = DesiredSet()
    rt, rid, tags = resource.resource_type, resource.resource_id, resource.tags
    defs = type_defs(rt, tags)
    for d in defs:
        key = d.get("metric_key") or d["metric"]
        if d.get("dynamic_dimensions"):
            _build_disk(out, resource, d, cw, layers)
            continue
        console, customer, msp = layers(key)
        r = resolve(d, tags, metric_key=key, console=console, customer=customer, msp=msp)
        if r.off:
            out.off_keys.add(key)
            continue
        sev = get_severity(key)
        assert r.threshold is not None
        out.alarms.append(DesiredAlarm(
            name=naming.alarm_name(rt, rid, resource.name, key, tags), metric_key=key,
            region=alarm_region(resource, d), namespace=resolve_namespace(d, rt, tags), metric_name=d["metric_name"],
            dimensions=build_dimensions(d, rid, rt, tags, resource.region), statistic=r.statistic, period=r.period,
            evaluation_periods=r.evaluation_periods, datapoints_to_alarm=r.datapoints_to_alarm, threshold=r.threshold,
            comparison=d["comparison"], treat_missing_data=d.get("treat_missing_data", "notBreaching"), severity=sev,
            description=naming.build_description(rt, rid, key, sev, resource.name), resolved=r,
        ))
    _build_dynamic(out, resource, defs, cw)
    return out


def _build_disk(out: DesiredSet, res: ResourceRef, d: dict, cw: Any, layers: LayerLookup) -> None:
    extra = {T.tag_suffix_to_disk_path(k[len("Threshold_Disk_"):])
             for k in res.tags if k.startswith("Threshold_Disk_") and k != "Threshold_Disk_root"}
    try:
        dim_sets = get_disk_dimensions(cw, res.resource_id, extra or None)
    except DiskLookupError:
        out.disk_unknown = True
        return
    for dims in dim_sets:
        path = next((x["Value"] for x in dims if x["Name"] == "path"), "/")
        key = f"Disk_{T.disk_path_to_tag_suffix(path)}"
        console, _, _ = layers(key)
        r = resolve(d, res.tags, metric_key=key, console=console)
        if r.off:
            out.off_keys.add(key)
            continue
        assert r.threshold is not None
        sev = get_severity(key)
        out.alarms.append(DesiredAlarm(
            name=naming.alarm_name(res.resource_type, res.resource_id, res.name, key, res.tags), metric_key=key,
            region=alarm_region(res, d), namespace="CWAgent", metric_name="disk_used_percent", dimensions=dims,
            statistic=r.statistic, period=r.period, evaluation_periods=r.evaluation_periods,
            datapoints_to_alarm=r.datapoints_to_alarm, threshold=r.threshold, comparison=d["comparison"],
            treat_missing_data="notBreaching", severity=sev,
            description=naming.build_description(res.resource_type, res.resource_id, key, sev, res.name,
                                                 f"Managed by AlarmOps for EC2 {res.resource_id} disk {path}"),
            resolved=r, kind="disk",
        ))


def _build_dynamic(out: DesiredSet, res: ResourceRef, defs: list[dict], cw: Any) -> None:
    hard_keys = {d.get("metric_key") or d["metric"] for d in defs}
    hard_cw = {d.get("metric_name") or d["metric"] for d in defs}
    for metric, (thr, comparison) in T.parse_dynamic_threshold_tags(res.tags, hard_keys, hard_cw).items():
        found = resolve_metric_dimensions(cw, res.resource_id, metric, res.resource_type, res.tags)
        if found is None:
            out.dynamic_unresolved.add(metric)
            continue
        ns, dims = found
        ep, dp = get_dynamic_eval_policy(metric)
        sev = get_severity(metric)
        out.alarms.append(DesiredAlarm(
            name=naming.alarm_name(res.resource_type, res.resource_id, res.name, metric, res.tags), metric_key=metric,
            region=alarm_region(res), namespace=ns, metric_name=metric, dimensions=dims, statistic="Average",
            period=DYNAMIC_PERIOD, evaluation_periods=ep, datapoints_to_alarm=dp, threshold=thr, comparison=comparison,
            treat_missing_data="notBreaching", severity=sev,
            description=naming.build_description(res.resource_type, res.resource_id, metric, sev, res.name),
            resolved=None, dynamic=True, kind="dynamic",
        ))
