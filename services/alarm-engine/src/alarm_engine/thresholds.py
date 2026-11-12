"""Layered value resolution with provenance — D-19 (thresholds) and D-27 (statistic, period, M of N).

Order, highest first:  TAG (resource `Threshold_*`, read only)  >  CONSOLE (stored on our alarm, D-08)
                       >  CUSTOMER default  >  MSP default  >  CODE (resource-type spec).
No environment-variable layer (D-19; legacy `DEFAULT_*_THRESHOLD` dropped).

Each field resolves independently and returns its source, so the console can show where every value came from.
`threshold` and `off` are one field: the highest layer that says anything (a value or `off`) decides.

Ported rules (alarm-rules §2, §5):
- eval policy by severity (registry `_apply_eval_policy`) is the CODE value of M/N;
- locked definitions (SEV-1 or period >= 3600) ignore every M/N override;
- FreeableMemory / FreeLocalStorage percent interpretation (threshold_resolver.py). DEVIATION: in the legacy code a
  provisioned instance with `_total_memory_bytes` used 20 % even when a GB tag was set (alarm-rules §5-3, "(추정)").
  Here an explicit `Threshold_*Pct` tag still wins, then any explicit GB value from a layer (TAG/CONSOLE/CUSTOMER/MSP),
  then the 20 % auto default, then the CODE GB default. Otherwise console edits of this metric would never apply.
- `Disk_*` per-path keys skip the CUSTOMER/MSP layers (legacy `customer_thresholds.py:13`; Q-DM-11 still open) and fall
  back to the `Disk` code default.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

from alarm_engine import tags as T
from alarm_engine.registry import eval_locked
from alarm_engine.resource_types.base import hardcoded_defaults

Source = Literal["TAG", "CONSOLE", "CUSTOMER", "MSP", "CODE"]
SOURCES: tuple[Source, ...] = ("TAG", "CONSOLE", "CUSTOMER", "MSP", "CODE")
ALLOWED_PERIODS = (60, 300, 900, 3600)
ALLOWED_STATISTICS = ("Average", "Sum", "Minimum", "Maximum", "SampleCount")
GB = 1073741824

_DEFAULTS = hardcoded_defaults()


@dataclass(frozen=True)
class LayerValues:
    """Values one layer (CONSOLE / CUSTOMER / MSP) sets for one metric. None = this layer says nothing."""
    threshold: float | None = None   # display units (GB, %, ms …), like tags
    off: bool = False
    eval_m: int | None = None
    eval_n: int | None = None
    period: int | None = None
    statistic: str | None = None


@dataclass(frozen=True)
class Resolved:
    off: bool
    threshold_display: float | None
    threshold: float | None          # CloudWatch units
    threshold_source: Source
    statistic: str
    statistic_source: Source
    period: int
    period_source: Source
    evaluation_periods: int
    datapoints_to_alarm: int | None
    eval_source: Source
    eval_locked: bool
    layers: dict[str, dict] = field(default_factory=dict)   # what each layer said (console "layers" list)


def _valid_threshold(v: float | None) -> bool:
    return v is not None and math.isfinite(v) and v > 0


def _valid_eval(m: int | None, n: int | None) -> bool:
    return m is not None and n is not None and 1 <= m <= n <= T.MAX_EVAL_PERIODS


def base_metric(metric_key: str) -> str:
    if metric_key.startswith("Disk_"):
        return "Disk"
    if metric_key.startswith("disk_used_percent_"):
        return "disk_used_percent"
    return metric_key


def code_default(metric_key: str) -> float:
    d = _DEFAULTS.get(base_metric(metric_key))
    return 80.0 if d is None else d   # legacy: warn and 80.0


def resolve(
    alarm_def: dict,
    resource_tags: dict,
    *,
    metric_key: str | None = None,
    console: LayerValues | None = None,
    customer: LayerValues | None = None,
    msp: LayerValues | None = None,
) -> Resolved:
    """Resolve one alarm definition (already eval-policy-applied, see `registry._apply_eval_policy`)."""
    key = metric_key or alarm_def.get("metric_key") or alarm_def["metric"]
    is_disk = key.startswith("Disk_")
    lower: list[tuple[Source, LayerValues | None]] = [("CONSOLE", console)]
    if not is_disk:
        lower += [("CUSTOMER", customer), ("MSP", msp)]

    layers: dict[str, dict] = {}

    # ── threshold / off
    thr_src: Source = "CODE"
    thr_disp: float | None = None
    off = False
    if T.is_threshold_off(resource_tags, key):
        off, thr_src = True, "TAG"
    else:
        tv = T.tag_threshold(resource_tags, key)
        if tv is not None:
            thr_disp, thr_src = tv, "TAG"
    if T.raw_threshold_tag(resource_tags, key):
        layers["TAG"] = {"raw": T.raw_threshold_tag(resource_tags, key)[1]}  # type: ignore[index]
    if not off and thr_disp is None:
        for src, lv in lower:
            if lv is None:
                continue
            layers[src] = {"threshold": lv.threshold, "off": lv.off}
            if lv.off:
                off, thr_src = True, src
                break
            if _valid_threshold(lv.threshold):
                thr_disp, thr_src = float(lv.threshold), src  # type: ignore[arg-type]
                break
    pct_cw: float | None = None
    if not off:
        pct_cw, pct_src = _percent_threshold(key, resource_tags, explicit_gb=thr_disp is not None)
        if pct_cw is not None:
            thr_src = pct_src
            thr_disp = round(pct_cw / GB, 2)
    if not off and thr_disp is None:
        thr_disp, thr_src = code_default(key), "CODE"

    cw_thr: float | None
    if off:
        cw_thr = None
    elif pct_cw is not None:
        cw_thr = pct_cw
    else:
        fwd = alarm_def.get("transform_threshold")
        cw_thr = fwd(thr_disp) if fwd else thr_disp

    # ── statistic / period (no tag layer exists for these)
    stat, period = alarm_def["stat"], alarm_def["period"]
    stat_src: Source = "CODE"
    period_src: Source = "CODE"
    for src, lv in lower:
        if lv and lv.statistic in ALLOWED_STATISTICS:
            stat, stat_src = lv.statistic, src
            break
    for src, lv in lower:
        if lv and lv.period in ALLOWED_PERIODS:
            period, period_src = lv.period, src
            break

    # ── M of N
    locked = eval_locked(alarm_def)
    ep = alarm_def["evaluation_periods"]
    dp = alarm_def.get("datapoints_to_alarm")
    ev_src: Source = "CODE"
    if not locked:
        tag_eval = T.get_eval_override(resource_tags, key)
        if tag_eval is not None:
            (ep, dp), ev_src = tag_eval, "TAG"
        else:
            for src, lv in lower:
                if lv and _valid_eval(lv.eval_m, lv.eval_n):
                    ep, dp, ev_src = lv.eval_n, lv.eval_m, src  # type: ignore[assignment]
                    break

    return Resolved(
        off=off, threshold_display=None if off else thr_disp, threshold=cw_thr, threshold_source=thr_src,
        statistic=stat, statistic_source=stat_src, period=period, period_source=period_src,
        evaluation_periods=ep, datapoints_to_alarm=dp, eval_source=ev_src, eval_locked=locked, layers=layers,
    )


_PCT = {
    "FreeableMemory": ("Threshold_FreeMemoryPct", "_total_memory_bytes", "FreeMemoryPct"),
    "FreeLocalStorage": ("Threshold_FreeLocalStoragePct", "_total_local_storage_bytes", "FreeLocalStoragePct"),
}


def _percent_threshold(key: str, tags: dict, *, explicit_gb: bool) -> tuple[float | None, Source]:
    """Percent-of-total threshold in bytes, or (None, CODE). Serverless v2 never uses percent (ACUUtilization)."""
    if key not in _PCT or tags.get("_is_serverless_v2") == "true":
        return None, "CODE"
    pct_tag, total_key, default_key = _PCT[key]
    total_raw = tags.get(total_key)
    if total_raw is None:
        return None, "CODE"
    try:
        total = float(total_raw)
    except (TypeError, ValueError):
        return None, "CODE"
    raw = tags.get(pct_tag)
    if raw is not None:
        try:
            pct = float(raw)
            if 0 < pct < 100:
                return pct / 100 * total, "TAG"
        except (TypeError, ValueError):
            pass
    if explicit_gb:
        return None, "CODE"
    return _DEFAULTS.get(default_key, 20.0) / 100 * total, "CODE"
