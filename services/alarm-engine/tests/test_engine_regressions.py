"""Engine behaviour + regression tests for every known-bugs.md item tagged for the alarm engine (§4, §5).

Test names carry the known-bugs id (kb_4_1 …) so a grep finds the guard for each item.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from alarm_engine import naming
from alarm_engine.engine import DiscoveredResource, Engine
from alarm_engine.repository import ResourceRow, SyncRunRow, ThresholdChangeRow, now
from alarm_engine.resource_types.base import types
from alarm_engine.thresholds import LayerValues
from conftest import ACCOUNT_ID, FakeDiscovery, FakeSessions, ec2, make_account

SEOUL = "ap-northeast-2"


def ours(cw):
    return {n: a for n, a in cw.alarms.items() if cw.tags.get(a["AlarmArn"], {}).get("ManagedBy") == "AlarmOps"}


def by_metric(cw):
    return {naming.parse_metadata(a["AlarmDescription"]).metric_key: a for a in ours(cw).values()}


def first_sync(world, res=None):
    repo, sessions, disc, eng, acc = world
    disc.resources = [res or ec2()]
    counts = eng.sync_account(acc.id, "DAILY")
    return counts, sessions.cw(SEOUL)


def row_of(repo, key="i-0abc") -> ResourceRow:
    return next(r for r in repo.resources.values() if r.resource_key == key)


# ── basic create / idempotency

def test_create_ec2_alarms_with_new_names_and_metadata(world):
    counts, cw = first_sync(world)
    keys = set(by_metric(cw))
    assert keys == {"CPUUtilization", "mem_used_percent", "StatusCheckFailed"}   # disk: no CWAgent metric
    a = by_metric(cw)["CPUUtilization"]
    assert a["AlarmName"] == "[EC2] web-1 CPUUtilization (TagName: i-0abc)"
    assert a["Threshold"] == 80.0
    md = naming.parse_metadata(a["AlarmDescription"])
    assert (md.resource_id, md.resource_type, md.severity, md.managed_by) == ("i-0abc", "EC2", "SEV-3", "AlarmOps")
    assert counts["created"] == 3


def test_second_sync_is_a_noop(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.calls.clear()
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    assert cw.writes() == []
    assert counts["created"] == counts["updated"] == counts["deleted"] == counts["refreshed"] == 0


# ── D-08: threshold change → same alarm, in place

def test_d08_threshold_tag_change_updates_in_place_same_name(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    name_before = by_metric(cw)["CPUUtilization"]["AlarmName"]
    disc.resources = [ec2(tags={"Monitoring": "on", "Name": "web-1", "Threshold_CPUUtilization": "90"})]
    cw.calls.clear()
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    assert counts["updated"] == 1
    assert [c for c, _ in cw.calls if c == "delete_alarms"] == []
    puts = [kw for c, kw in cw.calls if c == "put_metric_alarm"]
    assert [p["AlarmName"] for p in puts] == [name_before]
    assert puts[0]["Threshold"] == 90.0
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    assert (ma.threshold, ma.threshold_source) == (90.0, "TAG")


def test_name_tag_change_does_not_rename(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    before = set(cw.alarms)
    disc.resources = [ec2(tags={"Monitoring": "on", "Name": "renamed"})]
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert set(cw.alarms) == before


# ── F8 / F3 / 5-2 severity

def test_f8_manual_severity_preserved_on_update(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    a = by_metric(cw)["CPUUtilization"]
    cw.tags[a["AlarmArn"]]["Severity"] = "SEV-1"
    disc.resources = [ec2(tags={"Monitoring": "on", "Name": "web-1", "Threshold_CPUUtilization": "95"})]
    eng.sync_account(acc.id, "TAG_RECONCILE")
    a = by_metric(cw)["CPUUtilization"]
    assert cw.tags[a["AlarmArn"]]["Severity"] == "SEV-1"
    assert naming.parse_metadata(a["AlarmDescription"]).severity == "SEV-1"
    assert repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"].severity_manual


def test_f3_missing_severity_in_description_refreshed_in_place(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    a = by_metric(cw)["CPUUtilization"]
    a["AlarmDescription"] = '{"resourceId":"i-0abc","resourceType":"EC2","metricKey":"CPUUtilization"}'
    cw.calls.clear()
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    assert counts["refreshed"] == 1
    assert naming.parse_metadata(by_metric(cw)["CPUUtilization"]["AlarmDescription"]).severity == "SEV-3"
    cw.calls.clear()
    assert eng.sync_account(acc.id, "TAG_RECONCILE")["refreshed"] == 0


def test_kb_5_2_set_severity_updates_tag_and_description_together(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    eng.set_severity("cus_1", ma.id, "SEV-2")
    a = by_metric(cw)["CPUUtilization"]
    assert cw.tags[a["AlarmArn"]]["Severity"] == naming.parse_metadata(a["AlarmDescription"]).severity == "SEV-2"
    assert a["AlarmName"] == ma.alarm_name


# ── off / dynamic / KI-005

def test_threshold_off_deletes_existing_alarm(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    disc.resources = [ec2(tags={"Monitoring": "on", "Name": "web-1", "Threshold_CPU": "off"})]
    assert eng.sync_account(acc.id, "TAG_RECONCILE")["deleted"] == 1
    assert "CPUUtilization" not in by_metric(sessions.cw(SEOUL))


def test_kb_5_6_legacy_and_cw_name_tags_converge_to_one_alarm(world):
    repo, sessions, disc, eng, acc = world
    disc.resources = [ec2(tags={"Monitoring": "on", "Threshold_CPU": "70", "Threshold_CPUUtilization": "75"})]
    eng.sync_account(acc.id, "DAILY")
    cpu = [a for a in ours(sessions.cw(SEOUL)).values() if "CPUUtilization" in a["AlarmName"]]
    assert len(cpu) == 1 and cpu[0]["Threshold"] == 75.0


def test_dynamic_alarm_created_and_removed_with_tag(world):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.metrics = [{"Namespace": "AWS/EC2", "MetricName": "NetworkIn",
                   "Dimensions": [{"Name": "InstanceId", "Value": "i-0abc"}]}]
    disc.resources = [ec2(tags={"Monitoring": "on", "Threshold_NetworkIn": "1000"})]
    eng.sync_account(acc.id, "DAILY")
    assert by_metric(cw)["NetworkIn"]["Threshold"] == 1000.0
    disc.resources = [ec2(tags={"Monitoring": "on"})]
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert "NetworkIn" not in by_metric(cw)


# ── 4-1 / 4-2 / 4-12 disk

def test_kb_4_1_no_disk_metrics_twice_is_idempotent(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.calls.clear()
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert cw.writes() == []


def test_kb_4_2_all_calls_use_customer_session_with_external_id(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    assert sessions.assumed
    assert all(ext == "ext-123" for _, ext, _ in sessions.assumed)
    assert {arn for arn, _, _ in sessions.assumed} <= {acc.reader_role_arn, acc.alarm_writer_role_arn}
    # disk lookup went to the customer client
    assert ("list_metrics", {"Namespace": "CWAgent", "MetricName": "disk_used_percent"}) in sessions.cw(SEOUL).calls


def test_kb_4_2_disk_lookup_failure_leaves_disk_alarms(world):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.metrics = [{"Namespace": "CWAgent", "MetricName": "disk_used_percent",
                   "Dimensions": [{"Name": "InstanceId", "Value": "i-0abc"}, {"Name": "path", "Value": "/"},
                                  {"Name": "fstype", "Value": "xfs"}, {"Name": "device", "Value": "nvme0n1p1"}]}]
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "DAILY")
    assert "Disk_root" in by_metric(cw)
    cw.fail_list_metrics = True
    cw.calls.clear()
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert "Disk_root" in by_metric(cw)
    assert "delete_alarms" not in cw.writes()


def test_kb_4_12_pseudo_filesystems_excluded(world):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)

    def m(path, fstype):
        return {"Namespace": "CWAgent", "MetricName": "disk_used_percent",
                "Dimensions": [{"Name": "InstanceId", "Value": "i-0abc"}, {"Name": "path", "Value": path},
                               {"Name": "fstype", "Value": fstype}]}
    cw.metrics = [m("/", "xfs"), m("/data", "xfs"), m("/run/user/1000", "tmpfs"), m("/dev", "devtmpfs"),
                  m("/var/lib/docker/overlay2/x", "overlay"), m("/boot", "xfs")]
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "DAILY")
    disks = {k for k in by_metric(cw) if k.startswith("Disk_")}
    assert disks == {"Disk_root", "Disk_data"}


# ── 4-3 / 4-4 regions

def test_kb_4_3_alarm_region_is_resource_region_not_lambda_region(world, monkeypatch):
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    repo, sessions, disc, eng, acc = world
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "DAILY")
    assert ours(sessions.cw(SEOUL))
    assert ("111122223333", "us-west-2") not in sessions.cws
    row = row_of(repo)
    assert row.region == SEOUL
    assert {m.region for m in repo.list_managed_alarms("cus_1", row.id).values()} == {SEOUL}


def test_kb_4_4_global_type_alarms_in_us_east_1(world):
    repo, sessions, disc, eng, acc = world
    disc.resources = [DiscoveredResource("CloudFront", "E123", f"arn:aws:cloudfront::{ACCOUNT_ID}:distribution/E123",
                                         SEOUL, {"Monitoring": "on"})]
    eng.sync_account(acc.id, "DAILY")
    assert len(ours(sessions.cw("us-east-1"))) == 4
    assert not ours(sessions.cw(SEOUL))
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert sessions.cw("us-east-1").writes().count("put_metric_alarm") == 4   # second run: no rewrite


# ── 4-5 ARN / tagging

def test_kb_4_5_arn_in_customer_account_and_managedby_tag(world):
    _, cw = first_sync(world)
    for a in ours(cw).values():
        assert f":{ACCOUNT_ID}:alarm:" in a["AlarmArn"]
        assert cw.tags[a["AlarmArn"]]["ManagedBy"] == "AlarmOps"


def test_kb_4_5_tagging_failure_is_surfaced(world):
    repo, sessions, disc, eng, acc = world
    sessions.cw(SEOUL).fail_tagging = True
    disc.resources = [ec2()]
    counts = eng.sync_account(acc.id, "DAILY")
    assert counts["errors"] == 3
    assert next(iter(repo.runs.values())).status == "PARTIAL"


# ── 4-6 ownership

def test_kb_4_6_lookalike_alarms_without_metadata_or_tag_untouched(world):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.add_foreign_alarm("[EC2] web-1 CPUUtilization  (TagName: i-0abc)")
    cw.add_foreign_alarm("[EC2] web-1 mem_used_percent (TagName: i-0abc)",
                         description='{"resourceId":"i-0abc","metricKey":"mem_used_percent","resourceType":"EC2"}')
    cw.add_foreign_alarm("customer-alarm", description='{"resourceId":"i-gone","metricKey":"CPUUtilization",'
                         '"resourceType":"EC2"}', tags={"ManagedBy": "SomeoneElse"})
    disc.alive_map = {"i-gone": False}
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "DAILY")
    assert {"[EC2] web-1 CPUUtilization  (TagName: i-0abc)", "[EC2] web-1 mem_used_percent (TagName: i-0abc)",
            "customer-alarm"} <= set(cw.alarms)
    deleted = [kw["AlarmNames"] for c, kw in cw.calls if c == "delete_alarms"]
    assert deleted == []


def test_kb_4_6_writer_refuses_to_delete_non_owned():
    from alarm_engine.aws import AlarmWriter
    from alarm_engine.sync import ActualAlarm, Command
    from conftest import FakeCloudWatch
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    a = ActualAlarm({"AlarmName": "x", "AlarmDescription": '{"resourceId":"i","metricKey":"m"}'}, {})
    with pytest.raises(PermissionError):
        AlarmWriter(cw, ACCOUNT_ID).apply(Command("DELETE", "x", "m", actual=a))


# ── 4-7 pagination

def test_kb_4_7_paginated_describe_and_list_metrics(world):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.page_size = 1
    disc.resources = [ec2(f"i-{n}") for n in range(3)]
    eng.sync_account(acc.id, "DAILY")
    assert len(ours(cw)) == 9
    cw.calls.clear()
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert cw.writes() == []      # every page was seen, nothing re-created


# ── 4-8 no delete before definition

def test_kb_4_8_updates_never_delete(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    for a in ours(cw).values():
        a["Period"] = 60
        a["Threshold"] = 1.0
    cw.calls.clear()
    eng.sync_one("cus_1", row_of(repo).id, restore_external=True)
    assert "delete_alarms" not in cw.writes()
    assert all(a["Period"] == 300 for a in ours(cw).values())


# ── 4-9 discovery failure

def test_kb_4_9_discovery_failure_changes_nothing(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    states = {r.id: r.monitoring_state for r in repo.resources.values()}
    disc.fail = True
    cw.calls.clear()
    eng.sync_account(acc.id, "DAILY")
    assert cw.writes() == []
    assert {r.id: r.monitoring_state for r in repo.resources.values()} == states
    assert sorted(r.status for r in repo.runs.values()) == ["FAILED", "SUCCEEDED"]


def test_kb_4_9_zero_resources_listed_but_alive_unknown_deletes_nothing(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    disc.resources = []          # e.g. throttled listing returned nothing
    disc.alive_map = {}          # alive unknown
    cw = sessions.cw(SEOUL)
    cw.calls.clear()
    eng.sync_account(acc.id, "DAILY")
    assert cw.writes() == []
    assert row_of(repo).monitoring_state == "MONITORED"


# ── 4-10 changed by D-16

def test_kb_4_10_d16_monitoring_tag_removed_marks_needs_review_and_keeps_alarms(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    before = set(cw.alarms)
    disc.resources = []
    disc.alive_map = {"i-0abc": True}
    disc.tags_map = {"i-0abc": {"Name": "web-1"}}
    cw.calls.clear()
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    row = row_of(repo)
    assert (row.monitoring_state, row.needs_review_reason, row.monitoring_tag) == ("NEEDS_REVIEW", "tag_removed", "ABSENT")
    assert row.needs_review_since is not None
    assert set(cw.alarms) == before and cw.writes() == []
    assert counts["needsReview"] == 1
    # a threshold tag change while NEEDS_REVIEW is not applied either
    disc.tags_map = {"i-0abc": {"Name": "web-1", "Threshold_CPU": "10"}}
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert cw.writes() == []


def test_kb_4_10_tag_unreadable_changes_nothing(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    disc.resources, disc.alive_map, disc.tags_map = [], {"i-0abc": True}, {"i-0abc": None}
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert row_of(repo).monitoring_state == "MONITORED"


def test_d16_tag_back_returns_to_monitored(world):
    test_kb_4_10_d16_monitoring_tag_removed_marks_needs_review_and_keeps_alarms(world)
    repo, sessions, disc, eng, acc = world
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "TAG_RECONCILE")
    r = row_of(repo)
    assert (r.monitoring_state, r.needs_review_since) == ("MONITORED", None)


def test_d16_stop_monitoring_is_the_only_delete_path_for_needs_review(world):
    test_kb_4_10_d16_monitoring_tag_removed_marks_needs_review_and_keeps_alarms(world)
    repo, sessions, disc, eng, acc = world
    n = eng.stop_monitoring("cus_1", row_of(repo).id)
    assert n == 3 and not ours(sessions.cw(SEOUL))
    assert row_of(repo).monitoring_state == "NOT_MONITORED"


# ── 4-11 tag gate for all 29 types

@pytest.mark.parametrize("rtype", types())
def test_kb_4_11_no_alarm_without_monitoring_on(rtype):
    from alarm_engine.repository import InMemoryRepository
    repo, sessions = InMemoryRepository(), FakeSessions()
    acc = make_account()
    repo.accounts[acc.id] = acc
    disc = FakeDiscovery(resources=[DiscoveredResource(rtype, "r-1", "arn:aws:x", SEOUL, {"Monitoring": "off"})])
    Engine(repo, sessions, disc).sync_account(acc.id, "DAILY")
    assert all(cw.writes() == [] for cw in sessions.cws.values())


# ── 4-13 per-type dimension goldens

@pytest.mark.parametrize("rtype,rid,tags,expect_ns,expect_dims", [
    ("TG", f"arn:aws:elasticloadbalancing:{SEOUL}:{ACCOUNT_ID}:targetgroup/tg1/abc",
     {"_lb_arn": f"arn:aws:elasticloadbalancing:{SEOUL}:{ACCOUNT_ID}:loadbalancer/net/nlb1/def", "_lb_type": "network"},
     "AWS/NetworkELB", [{"Name": "TargetGroup", "Value": "targetgroup/tg1/abc"},
                        {"Name": "LoadBalancer", "Value": "net/nlb1/def"}]),
    ("APIGW", "a1b2c3", {"_api_type": "HTTP"}, "AWS/ApiGateway", [{"Name": "ApiId", "Value": "a1b2c3"}]),
    ("APIGW", "my-rest", {}, "AWS/ApiGateway", [{"Name": "ApiName", "Value": "my-rest"}]),
    ("ALB", f"arn:aws:elasticloadbalancing:{SEOUL}:{ACCOUNT_ID}:loadbalancer/app/alb1/123", {}, "AWS/ApplicationELB",
     [{"Name": "LoadBalancer", "Value": "app/alb1/123"}]),
    ("ECS", "svc", {"_cluster_name": "c1"}, "AWS/ECS",
     [{"Name": "ServiceName", "Value": "svc"}, {"Name": "ClusterName", "Value": "c1"}]),
])
def test_kb_4_13_dimensions(rtype, rid, tags, expect_ns, expect_dims):
    from alarm_engine.desired import ResourceRef, build_desired
    from conftest import FakeCloudWatch
    ds = build_desired(ResourceRef(rtype, rid, SEOUL, ACCOUNT_ID, tags), FakeCloudWatch(ACCOUNT_ID, SEOUL))
    assert ds.alarms
    for d in ds.alarms:
        assert d.namespace == expect_ns
        assert d.dimensions == expect_dims


def test_kb_4_13_aurora_variants():
    from alarm_engine.desired import ResourceRef, build_desired
    from conftest import FakeCloudWatch
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    sl = build_desired(ResourceRef("AuroraRDS", "db1", SEOUL, ACCOUNT_ID, {"_is_serverless_v2": "true",
                                                                         "_is_cluster_writer": "true"}), cw)
    assert {d.metric_key for d in sl.alarms} == {"CPUUtilization", "ACUUtilization", "DatabaseConnections"}
    rd = build_desired(ResourceRef("AuroraRDS", "db2", SEOUL, ACCOUNT_ID, {"_is_cluster_writer": "false"}), cw)
    assert "ReaderReplicaLag" in {d.metric_key for d in rd.alarms}


# ── 4-14 resource deleted

def test_kb_4_14_deleted_resource_alarms_removed(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    disc.resources, disc.alive_map = [], {"i-0abc": False}
    counts = eng.sync_account(acc.id, "DAILY")
    assert counts["deleted"] == 3 and not ours(sessions.cw(SEOUL))
    assert row_of(repo).monitoring_state == "DELETED"
    assert repo.list_managed_alarms("cus_1", row_of(repo).id) == {}


def test_kb_4_14_orphan_alarm_of_unknown_gone_resource_deleted(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    repo.resources.clear()           # engine lost its rows (e.g. new DB)
    disc.resources, disc.alive_map = [], {"i-0abc": False}
    eng.sync_account(acc.id, "DAILY")
    assert not ours(cw)


# ── 4-15 stale runs

def test_kb_4_15_stale_running_run_marked_failed(world):
    repo, sessions, disc, eng, acc = world
    repo.runs["old"] = SyncRunRow("old", "cus_1", acc.id, "DAILY", heartbeat_at=now() - timedelta(hours=1),
                                  started_at=now() - timedelta(hours=1))
    eng.sync_account(acc.id, "DAILY")
    assert repo.runs["old"].status == "FAILED"


# ── 4-17 real tags at creation

def test_kb_4_17_created_alarm_reflects_actual_threshold_tags(world):
    _, cw = first_sync(world, ec2(tags={"Monitoring": "on", "Threshold_mem_used_percent": "65",
                                        "Threshold_CPUUtilization_Eval": "2/4"}))
    m = by_metric(cw)
    assert m["mem_used_percent"]["Threshold"] == 65.0
    assert (m["CPUUtilization"]["EvaluationPeriods"], m["CPUUtilization"]["DatapointsToAlarm"]) == (4, 2)


# ── 5-1 customer default reaches alarms (layers tested exhaustively in test_thresholds)

def test_kb_5_1_customer_and_msp_defaults_applied(world):
    repo, sessions, disc, eng, acc = world
    repo.defaults[("MSP", None, "EC2", "CPUUtilization")] = LayerValues(threshold=85)
    repo.defaults[("CUSTOMER", "cus_1", "EC2", "mem_used_percent")] = LayerValues(threshold=70, period=60)
    _, cw = first_sync(world)
    m = by_metric(cw)
    assert m["CPUUtilization"]["Threshold"] == 85.0
    assert (m["mem_used_percent"]["Threshold"], m["mem_used_percent"]["Period"]) == (70.0, 60)
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)
    assert (ma["CPUUtilization"].threshold_source, ma["mem_used_percent"].threshold_source) == ("MSP", "CUSTOMER")
    # changing the customer default → same alarm updated in place
    repo.defaults[("CUSTOMER", "cus_1", "EC2", "mem_used_percent")] = LayerValues(threshold=60)
    name = m["mem_used_percent"]["AlarmName"]
    assert eng.apply_customer_default("cus_1", "EC2", "mem_used_percent") == 1
    assert cw.alarms[name]["Threshold"] == 60.0


# ── external change (P4-5)

def test_external_change_is_held_then_restored(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    a = by_metric(cw)["CPUUtilization"]
    a["Threshold"] = 99.0
    cw.calls.clear()
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    assert counts["externalChange"] == 1 and cw.writes() == []
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    assert ma.drift_status == "EXTERNAL_CHANGE"
    assert ma.drift_detail["fields"]["Threshold"] == {"expected": 80.0, "actual": 99.0}
    eng.sync_one("cus_1", row_of(repo).id, restore_external=True)
    assert by_metric(cw)["CPUUtilization"]["Threshold"] == 80.0
    assert repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"].drift_status == "IN_SYNC"


def test_deleted_alarm_outside_is_recreated(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.delete_alarms(AlarmNames=[by_metric(cw)["CPUUtilization"]["AlarmName"]])
    assert eng.sync_account(acc.id, "TAG_RECONCILE")["created"] == 1


# ── AlarmWriter optional (D-07)

def test_no_alarm_writer_means_read_only(world):
    repo, sessions, disc, eng, acc = world
    repo.accounts[acc.id] = make_account(alarm_writer_enabled=False)
    disc.resources = [ec2()]
    counts = eng.sync_account(acc.id, "DAILY")
    assert counts["readOnly"] is True
    assert sessions.cw(SEOUL).writes() == []


# ── APPLY_THRESHOLD (D-08)

def _change(repo, ma, **kw):
    c = ThresholdChangeRow(id=f"tc_{len(repo.changes)}", customer_id="cus_1", target="ALARM", field="THRESHOLD",
                           resource_type="EC2", metric_key=ma.metric_key, new_value=kw.get("threshold"),
                           managed_alarm_id=ma.id, resource_id=ma.resource_id)
    repo.changes[c.id] = c
    return c


def test_apply_threshold_in_place_and_stored_on_alarm(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    c = _change(repo, ma, threshold=70)
    cw.calls.clear()
    st = eng.apply_threshold("cus_1", {"managedAlarmId": ma.id, "threshold": 70, "evalM": 2, "evalN": 3,
                                       "periodSec": 60, "thresholdChangeId": c.id}, "cmd_1")
    assert st == "APPLIED" and repo.changes[c.id].apply_status == "APPLIED"
    a = cw.alarms[ma.alarm_name]
    assert (a["Threshold"], a["Period"], a["EvaluationPeriods"], a["DatapointsToAlarm"]) == (70.0, 60, 3, 2)
    assert cw.tags[a["AlarmArn"]]["AlarmOps:Console:Threshold"] == "70"
    assert "delete_alarms" not in cw.writes()
    ma2 = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    assert (ma2.threshold_source, ma2.eval_source, ma2.console_threshold) == ("CONSOLE", "CONSOLE", 70.0)
    # console value survives later syncs (read back from the alarm), and redelivery is ignored
    cw.calls.clear()
    eng.sync_account(acc.id, "TAG_RECONCILE")
    assert cw.writes() == []
    assert eng.apply_threshold("cus_1", {"managedAlarmId": ma.id, "threshold": 70, "thresholdChangeId": c.id},
                               "cmd_1") == "IGNORED"


def test_apply_threshold_tag_wins(world):
    first_sync(world, ec2(tags={"Monitoring": "on", "Threshold_CPU": "88"}))
    repo, sessions, disc, eng, acc = world
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    c = _change(repo, ma, threshold=70)
    st = eng.apply_threshold("cus_1", {"managedAlarmId": ma.id, "threshold": 70, "thresholdChangeId": c.id}, "c")
    assert st == "SKIPPED_TAG_WINS"
    assert sessions.cw(SEOUL).alarms[ma.alarm_name]["Threshold"] == 88.0


def test_apply_threshold_without_alarm_writer(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    repo.accounts[acc.id] = make_account(alarm_writer_enabled=False)
    c = _change(repo, ma, threshold=70)
    assert eng.apply_threshold("cus_1", {"managedAlarmId": ma.id, "threshold": 70, "thresholdChangeId": c.id},
                               "c") == "FAILED"
    assert repo.changes[c.id].error == "CAPABILITY_DISABLED"


def test_apply_threshold_other_customer_cannot_touch(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    c = _change(repo, ma, threshold=70)
    assert eng.apply_threshold("cus_2", {"managedAlarmId": ma.id, "threshold": 70, "thresholdChangeId": c.id},
                               "c") == "IGNORED"


def test_console_off_then_console_value_recreates(world):
    first_sync(world)
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    c = _change(repo, ma)
    c.field, c.new_value = "OFF", True
    assert eng.apply_threshold("cus_1", {"managedAlarmId": ma.id, "off": True, "thresholdChangeId": c.id}, "c") \
        == "APPLIED"
    assert "CPUUtilization" not in by_metric(cw)
    eng.sync_account(acc.id, "TAG_RECONCILE")       # DB copy keeps it off (alarm is gone)
    assert "CPUUtilization" not in by_metric(cw)


# ── TagWriter (D-07)

def test_set_monitoring_tag_only_monitoring_key_and_not_s3(world):
    from alarm_engine.aws import CapabilityDisabled
    repo, sessions, disc, eng, acc = world
    repo.accounts[acc.id] = make_account(tag_writer_role_arn="arn:aws:iam::1:role/TW", tag_writer_enabled=True)
    arn = f"arn:aws:ec2:{SEOUL}:{ACCOUNT_ID}:instance/i-1"
    repo.resources["r1"] = ResourceRow("r1", "cus_1", acc.id, SEOUL, "EC2", arn, "i-1")
    repo.resources["r2"] = ResourceRow("r2", "cus_1", acc.id, SEOUL, "S3", "arn:s3", "b")
    eng.set_monitoring_tag("cus_1", "r1")
    calls = sessions.others[("tagWriter", "resourcegroupstaggingapi", SEOUL)].calls
    assert calls == [("tag_resources", {"ResourceARNList": [arn], "Tags": {"Monitoring": "on"}})]
    with pytest.raises(CapabilityDisabled):
        eng.set_monitoring_tag("cus_1", "r2")


@pytest.mark.parametrize("arn", ["arn:aws:ec2:ap-northeast-2:999999999999:instance/i-1",
                                 "arn:aws:ec2:us-west-2:{acct}:instance/i-1", "garbage"])
def test_set_monitoring_tag_refuses_foreign_arn(world, arn):
    repo, sessions, disc, eng, acc = world
    repo.accounts[acc.id] = make_account(tag_writer_role_arn="arn:aws:iam::1:role/TW", tag_writer_enabled=True)
    repo.resources["r1"] = ResourceRow("r1", "cus_1", acc.id, SEOUL, "EC2", arn.format(acct=ACCOUNT_ID), "i-1")
    with pytest.raises(PermissionError):
        eng.set_monitoring_tag("cus_1", "r1")
    assert "tag_resources" not in sessions.all_calls()


@pytest.mark.parametrize("bad", [{"threshold": "90"}, {"threshold": float("nan")}, {"evalM": 3, "evalN": 2},
                                 {"evalM": 0}, {"periodSec": 45}, {"periodSec": 90}, {"statistic": "p99x"}])
def test_apply_threshold_rejects_bad_values(world, bad):
    repo, sessions, disc, eng, acc = world
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "DAILY")
    ma = repo.list_managed_alarms("cus_1", row_of(repo).id)["CPUUtilization"]
    c = _change(repo, ma)
    before = sessions.cw(SEOUL).writes()
    out = eng.apply_threshold("cus_1", {"managedAlarmId": ma.id, "thresholdChangeId": c.id, **bad}, "c")
    assert out == "FAILED"
    assert sessions.cw(SEOUL).writes() == before
