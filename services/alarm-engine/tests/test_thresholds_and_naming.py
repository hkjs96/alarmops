"""D-19 / D-27 layer resolution (exhaustive, known-bugs 5-1), legacy tag rules, names (property tests)."""

from __future__ import annotations

import itertools
import json

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from alarm_engine import naming
from alarm_engine import tags as T
from alarm_engine.desired import ResourceRef, build_desired, type_defs
from alarm_engine.registry import _get_alarm_defs_raw
from alarm_engine.resource_types.base import types
from alarm_engine.thresholds import LayerValues, resolve
from conftest import ACCOUNT_ID, FakeCloudWatch

CPU = next(d for d in type_defs("EC2", {}) if d["metric"] == "CPUUtilization")
MEM = next(d for d in type_defs("EC2", {}) if d["metric"] == "mem_used_percent")
VALUES = {"TAG": 91.0, "CONSOLE": 92.0, "CUSTOMER": 93.0, "MSP": 94.0}


@pytest.mark.parametrize("present", list(itertools.product([False, True], repeat=4)))
def test_kb_5_1_threshold_precedence_all_combinations(present):
    tag, con, cus, msp = present
    r = resolve(CPU, {"Threshold_CPUUtilization": "91"} if tag else {},
                console=LayerValues(threshold=92) if con else None,
                customer=LayerValues(threshold=93) if cus else None,
                msp=LayerValues(threshold=94) if msp else None)
    expected = next((s for s, p in zip(("TAG", "CONSOLE", "CUSTOMER", "MSP"), present, strict=True) if p), "CODE")
    assert r.threshold_source == expected
    assert r.threshold == VALUES.get(expected, 80.0)


@pytest.mark.parametrize("off_at", ["TAG", "CONSOLE", "CUSTOMER", "MSP"])
def test_off_follows_the_same_precedence(off_at):
    order = ["TAG", "CONSOLE", "CUSTOMER", "MSP"]
    tags = {"Threshold_CPU": "OFF"} if off_at == "TAG" else {}
    lv = {s: LayerValues(off=True) if s == off_at else LayerValues(threshold=VALUES[s])
          for s in order[order.index(off_at):] if s != "TAG"}
    r = resolve(CPU, tags, console=lv.get("CONSOLE"), customer=lv.get("CUSTOMER"), msp=lv.get("MSP"))
    assert r.off and r.threshold_source == off_at
    # a higher layer with a value beats a lower off
    if off_at != "TAG":
        r2 = resolve(CPU, {"Threshold_CPUUtilization": "50"}, console=lv.get("CONSOLE"),
                     customer=lv.get("CUSTOMER"), msp=lv.get("MSP"))
        assert not r2.off and r2.threshold == 50.0


@pytest.mark.parametrize("raw", ["abc", "0", "-5", "nan", "inf", ""])
def test_invalid_tag_falls_through(raw):
    r = resolve(CPU, {"Threshold_CPUUtilization": raw}, customer=LayerValues(threshold=70))
    assert (r.threshold, r.threshold_source) == (70.0, "CUSTOMER")


def test_no_env_layer(monkeypatch):
    monkeypatch.setenv("DEFAULT_CPUUTILIZATION_THRESHOLD", "11")
    monkeypatch.setenv("DEFAULT_CPU_THRESHOLD", "12")
    assert resolve(CPU, {}).threshold == 80.0


def test_d27_eval_period_statistic_layers_and_sources():
    r = resolve(MEM, {}, console=LayerValues(statistic="Maximum"), customer=LayerValues(period=60, eval_m=1, eval_n=2),
                msp=LayerValues(period=900, statistic="Sum", eval_m=3, eval_n=4))
    assert (r.statistic, r.statistic_source) == ("Maximum", "CONSOLE")
    assert (r.period, r.period_source) == (60, "CUSTOMER")
    assert (r.evaluation_periods, r.datapoints_to_alarm, r.eval_source) == (2, 1, "CUSTOMER")
    r2 = resolve(MEM, {"Threshold_mem_used_percent_Eval": "4/6"}, console=LayerValues(eval_m=1, eval_n=1))
    assert (r2.evaluation_periods, r2.datapoints_to_alarm, r2.eval_source) == (6, 4, "TAG")
    code = resolve(MEM, {})
    assert (code.evaluation_periods, code.datapoints_to_alarm, code.eval_source) == (3, 2, "CODE")


@pytest.mark.parametrize("bad", [LayerValues(period=120), LayerValues(statistic="p99"), LayerValues(eval_m=3, eval_n=2),
                                 LayerValues(eval_m=1, eval_n=11)])
def test_d27_invalid_values_ignored(bad):
    r = resolve(MEM, {}, console=bad)
    assert (r.period, r.statistic, r.eval_source) == (300, "Average", "CODE")


def test_locked_definitions_ignore_eval_overrides():
    sc = next(d for d in type_defs("EC2", {}) if d["metric"] == "StatusCheckFailed")   # SEV-1
    r = resolve(sc, {"Threshold_StatusCheckFailed_Eval": "2/3"}, console=LayerValues(eval_m=2, eval_n=3))
    assert r.eval_locked and (r.evaluation_periods, r.eval_source) == (1, "CODE")
    acm = type_defs("ACM", {})[0]                                                        # period 86400
    assert resolve(acm, {}, customer=LayerValues(eval_m=2, eval_n=3)).eval_locked


def test_breaching_cpu_not_locked_tag_changes_eval():
    r = resolve(CPU, {"Threshold_CPU_Eval": "2/3"})   # legacy key name for _Eval
    assert (r.evaluation_periods, r.datapoints_to_alarm) == (3, 2)


def test_kb_5_3_units_transform_and_aurora_ms():
    rds_mem = next(d for d in type_defs("RDS", {}) if d["metric"] == "FreeableMemory")
    r = resolve(rds_mem, {"Threshold_FreeMemoryGB": "4"})
    assert r.threshold == 4 * 1073741824 and r.threshold_display == 4.0
    lag = next(d for d in _get_alarm_defs_raw("AuroraRDS", {"_is_cluster_writer": "false"})
               if d["metric"] == "ReaderReplicaLag")
    assert resolve(lag, {}).threshold == 2000.0   # ms, not µs (KI-010)


def test_free_memory_percent_rules():
    rds_mem = next(d for d in type_defs("RDS", {}) if d["metric"] == "FreeableMemory")
    total = {"_total_memory_bytes": str(16 * 1073741824)}
    assert resolve(rds_mem, total).threshold == pytest.approx(0.2 * 16 * 1073741824)     # auto 20 %
    assert resolve(rds_mem, {**total, "Threshold_FreeMemoryPct": "10"}).threshold_source == "TAG"
    # deviation: explicit GB from a layer beats the automatic 20 %
    r = resolve(rds_mem, total, console=LayerValues(threshold=3))
    assert (r.threshold, r.threshold_source) == (3 * 1073741824, "CONSOLE")
    sl = resolve(rds_mem, {**total, "_is_serverless_v2": "true"})
    assert sl.threshold == 2 * 1073741824


def test_disk_keys_skip_customer_and_msp_layers():
    disk = next(d for d in type_defs("EC2", {}) if d["metric"] == "disk_used_percent")
    r = resolve(disk, {}, metric_key="Disk_root", customer=LayerValues(threshold=50), msp=LayerValues(threshold=60))
    assert (r.threshold, r.threshold_source) == (80.0, "CODE")
    assert resolve(disk, {"Threshold_Disk_root": "70"}, metric_key="Disk_root").threshold == 70.0


def test_zero_code_default_kept():
    sc = next(d for d in type_defs("EC2", {}) if d["metric"] == "StatusCheckFailed")
    assert resolve(sc, {}).threshold == 0.0


# ── legacy tag helpers (ported tests: tag_resolver / alarm_manager)

def test_parse_eval():
    assert T.parse_eval("2/3") == (3, 2)
    for bad in ("3/2", "0/1", "1/11", "a/b", "2", None, ""):
        assert T.parse_eval(bad) is None


def test_disk_suffix_roundtrip_rules():
    assert T.disk_path_to_tag_suffix("/") == "root"
    assert T.disk_path_to_tag_suffix("/var/log") == "var_log"
    assert T.tag_suffix_to_disk_path("var_log") == "/var_log"   # legacy: no reverse of '_'


def test_monitoring_tag_values():
    assert T.monitoring_tag_value({"Monitoring": "ON"}) == "ON"
    assert T.monitoring_tag_value({"Monitoring": "yes"}) == "OFF"
    assert T.monitoring_tag_value({"monitoring": "on"}) == "ABSENT"


def test_dynamic_tags_filtered():
    defs = type_defs("EC2", {})
    keys = {d["metric"] for d in defs}
    out = T.parse_dynamic_threshold_tags({
        "Threshold_NetworkIn": "10", "Threshold_LT_NetworkOut": "5", "Threshold_CPU": "1",
        "Threshold_CPUUtilization": "1", "Threshold_Disk_root": "1", "Threshold_FreeMemoryPct": "1",
        "Threshold_X_Eval": "1/2", "Threshold_Bad!": "1", "Threshold_Neg": "-1", "Threshold_Off": "off",
        "Threshold_" + "a" * 130: "1"}, keys, keys)
    assert out == {"NetworkIn": (10.0, "GreaterThanThreshold"), "NetworkOut": (5.0, "LessThanThreshold")}


# ── names and metadata

def test_name_format_has_no_threshold():
    assert naming.alarm_name("EC2", "i-1", "web", "CPUUtilization") == "[EC2] web CPUUtilization (TagName: i-1)"
    alb = "arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/my-alb/abc"
    assert naming.alarm_name("ALB", alb, "", "RequestCount").endswith("(TagName: my-alb/abc)")
    assert naming.alarm_name("EC2", "i-1", "", "Disk_var_log") == "[EC2] i-1 disk_used_percent(/var_log) (TagName: i-1)"


def test_description_matches_core_normalizer_contract():
    d = naming.build_description("EC2", "i-1", "CPUUtilization", "SEV-3", "web")
    meta = json.loads(d[d.index("{"):])
    assert meta == {"managedBy": "AlarmOps", "resourceId": "i-1", "resourceType": "EC2", "metricKey": "CPUUtilization",
                    "severity": "SEV-3", "resourceName": "web"}


@settings(max_examples=200, deadline=None)
@given(label=st.text(min_size=0, max_size=400), rid=st.text(alphabet="abcdef0123456789-", min_size=1, max_size=60),
       prefix=st.text(max_size=2000))
def test_name_and_description_limits(label, rid, prefix):
    n = naming.alarm_name("EC2", rid, label, "CPUUtilization")
    assert len(n) <= 255 and n.endswith(f"(TagName: {rid})")
    d = naming.build_description("EC2", rid, "CPUUtilization", "SEV-3", label, prefix)
    assert len(d) <= 1024
    assert naming.parse_metadata(d).resource_id == rid


@settings(max_examples=150, deadline=None)
@given(rtype=st.sampled_from(types()),
       thr=st.floats(min_value=0.001, max_value=1e9, allow_nan=False),
       m=st.integers(1, 10), extra=st.integers(0, 9), period=st.sampled_from([60, 300, 900, 3600]),
       stat=st.sampled_from(["Average", "Sum", "Maximum", "Minimum"]))
def test_property_threshold_eval_period_changes_never_rename(rtype, thr, m, extra, period, stat):
    tags = {"Name": "r", "_lb_arn": "arn:aws:elasticloadbalancing:x:1:loadbalancer/app/a/b"}
    cw = FakeCloudWatch(ACCOUNT_ID, "ap-northeast-2")
    ref = ResourceRef(rtype, "res-1", "ap-northeast-2", ACCOUNT_ID, tags)
    base = {d.metric_key: d.name for d in build_desired(ref, cw).alarms}
    lv = LayerValues(threshold=thr, eval_m=m, eval_n=min(10, m + extra), period=period, statistic=stat)
    keys = list(base)
    tag_over = {f"Threshold_{k}": f"{thr:.6g}" for k in keys}
    changed = build_desired(ResourceRef(rtype, "res-1", "ap-northeast-2", ACCOUNT_ID, {**tags, **tag_over}), cw,
                            lambda k: (lv, lv, lv))
    assert {d.metric_key: d.name for d in changed.alarms} == base
