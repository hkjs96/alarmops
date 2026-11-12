"""Resource tag contract (alarm-rules.md §4) — pure functions, no AWS.

Ported from aws-alert-manager `backend/common/tag_resolver.py` (legacy map, off, _Eval, disk suffix, Monitoring) and
`alarm_manager._parse_threshold_tags` (dynamic alarms, KI-005) @4eafce9. Not ported (D-19): the environment-variable
default layer and `get_resource_tags` (tag reads go through the Reader-role port in `aws.py`).

Tags are **read only** (D-08). Nothing in this package writes `Threshold_*` to a customer resource.
"""

from __future__ import annotations

import logging
import math
import re

logger = logging.getLogger(__name__)

# CW metric name → legacy friendly tag name (backwards compat for Threshold_ tags)
LEGACY_TAG_MAP: dict[str, str] = {
    "CPUUtilization": "CPU",
    "mem_used_percent": "Memory",
    "disk_used_percent": "Disk",
    "FreeableMemory": "FreeMemoryGB",
    "FreeStorageSpace": "FreeStorageGB",
    "DatabaseConnections": "Connections",
    "HTTPCode_ELB_5XX_Count": "ELB5XX",
    "TCP_Client_Reset_Count": "TCPClientReset",
    "TCP_Target_Reset_Count": "TCPTargetReset",
    "TargetResponseTime": "TGResponseTime",
    "FreeLocalStorage": "FreeLocalStorageGB",
}

EVAL_TAG_SUFFIX = "_Eval"
MAX_EVAL_PERIODS = 10
MONITORING_KEY = "Monitoring"
_TAG_ALLOWED_CHARS = re.compile(r"^[a-zA-Z0-9 _.:/=+\-@]+$")
PCT_TAG_KEYS = ("Threshold_FreeMemoryPct", "Threshold_FreeLocalStoragePct")


def _names(metric_key: str) -> list[str]:
    """Tag suffixes to look at for a metric key: the key itself, then its legacy friendly name."""
    out = [metric_key]
    legacy = LEGACY_TAG_MAP.get(metric_key)
    if legacy:
        out.append(legacy)
    return out


def is_threshold_off(resource_tags: dict, metric_key: str) -> bool:
    return any(resource_tags.get(f"Threshold_{n}", "").strip().lower() == "off" for n in _names(metric_key))


def raw_threshold_tag(resource_tags: dict, metric_key: str) -> tuple[str, str] | None:
    """(tag key, raw value) of the first present `Threshold_{key}` / legacy tag, or None."""
    for n in _names(metric_key):
        k = f"Threshold_{n}"
        if k in resource_tags:
            return k, resource_tags[k]
    return None


def tag_threshold(resource_tags: dict, metric_key: str) -> float | None:
    """Positive finite numeric tag value, else None (warn and fall through to the next layer, alarm-rules §4-3)."""
    found = raw_threshold_tag(resource_tags, metric_key)
    if found is None:
        return None
    key, raw = found
    try:
        val = float(raw)
    except (TypeError, ValueError):
        if str(raw).strip().lower() != "off":
            logger.warning("Invalid threshold tag %s=%r (non-numeric): falling back", key, raw)
        return None
    if not math.isfinite(val) or val <= 0:
        logger.warning("Invalid threshold tag %s=%r (not positive): falling back", key, raw)
        return None
    return val


def eval_tag_key(metric_name: str) -> str:
    return f"Threshold_{metric_name}{EVAL_TAG_SUFFIX}"


def parse_eval(value: object) -> tuple[int, int] | None:
    """'M/N' → (N, M) = (evaluation_periods, datapoints_to_alarm). Wrong format → None."""
    m_str, sep, n_str = str(value or "").strip().partition("/")
    if not sep:
        return None
    try:
        m, n = int(m_str), int(n_str)
    except ValueError:
        return None
    if not 1 <= m <= n <= MAX_EVAL_PERIODS:
        return None
    return n, m


def get_eval_override(resource_tags: dict, metric_name: str) -> tuple[int, int] | None:
    for name in _names(metric_name):
        raw = resource_tags.get(eval_tag_key(name))
        if raw is None:
            continue
        parsed = parse_eval(raw)
        if parsed is None:
            logger.warning("Ignoring %s=%s: expected M/N with 1 <= M <= N <= %d", eval_tag_key(name), raw, MAX_EVAL_PERIODS)
        return parsed
    return None


def disk_path_to_tag_suffix(path: str) -> str:
    """'/' → 'root', '/data' → 'data', '/var/log' → 'var_log'."""
    if path == "/":
        return "root"
    return path.lstrip("/").replace("/", "_")


def tag_suffix_to_disk_path(suffix: str) -> str:
    """'root' → '/', 'data' → '/data'. Underscores are NOT turned back into slashes (legacy behaviour, kept)."""
    if suffix == "root":
        return "/"
    return f"/{suffix}"


def monitoring_tag_value(resource_tags: dict | None) -> str:
    """`ON` / `OFF` / `ABSENT` (DATA-MODEL Resource.monitoringTag). Key exact, value case-insensitive."""
    if resource_tags is None or MONITORING_KEY not in resource_tags:
        return "ABSENT"
    return "ON" if str(resource_tags[MONITORING_KEY]).strip().lower() == "on" else "OFF"


def has_monitoring_tag(resource_tags: dict | None) -> bool:
    return monitoring_tag_value(resource_tags) == "ON"


def parse_dynamic_threshold_tags(
    resource_tags: dict,
    hardcoded_keys: set[str],
    hardcoded_cw_names: set[str],
) -> dict[str, tuple[float, str]]:
    """`Threshold_{MetricName}` tags that are not hard-coded metrics → {metric_name: (threshold, comparison)}.

    `Threshold_LT_{MetricName}` → LessThanThreshold. KI-005: CloudWatch-name aliases and legacy names of hard-coded
    metrics are not dynamic (else `Threshold_CPU` and `Threshold_CPUUtilization` made two alarms).
    """
    legacy_hardcoded = {v for k, v in LEGACY_TAG_MAP.items() if k in hardcoded_cw_names or k in hardcoded_keys}
    result: dict[str, tuple[float, str]] = {}
    for key, value in resource_tags.items():
        if not key.startswith("Threshold_") or key.startswith("Threshold_Disk_") or key in PCT_TAG_KEYS:
            continue
        if key.endswith(EVAL_TAG_SUFFIX):
            continue
        raw_metric = key[len("Threshold_"):]
        if raw_metric.startswith("LT_"):
            metric_name, comparison = raw_metric[3:], "LessThanThreshold"
        else:
            metric_name, comparison = raw_metric, "GreaterThanThreshold"
        if not metric_name:
            continue
        if metric_name in hardcoded_keys or metric_name in hardcoded_cw_names or metric_name in legacy_hardcoded:
            continue
        if len(key) > 128:
            logger.warning("Skipping dynamic tag %s: key exceeds 128 chars", key)
            continue
        if not _TAG_ALLOWED_CHARS.match(metric_name):
            logger.warning("Skipping dynamic tag %s: invalid characters in metric name", key)
            continue
        if str(value).strip().lower() == "off":
            continue
        try:
            val = float(value)
        except (TypeError, ValueError):
            logger.warning("Skipping dynamic tag %s=%s: non-numeric value", key, value)
            continue
        if not math.isfinite(val) or val <= 0:
            logger.warning("Skipping dynamic tag %s=%s: not a positive number", key, value)
            continue
        result[metric_name] = (val, comparison)
    return result
