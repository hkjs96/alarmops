"""SQS handler, remediation safety (D-15), STS ExternalId (Stubber), moto round trip, CloudTrail routing, migration."""

from __future__ import annotations

import json
import re
from datetime import timedelta
from pathlib import Path

import boto3
import pytest
from botocore.stub import Stubber
from moto import mock_aws

from alarm_engine import remediation
from alarm_engine.aws import AlarmWriter, CapabilityDisabled, StsSessionFactory, TaggingFailed, list_owned_alarms
from alarm_engine.desired import ResourceRef, build_desired
from alarm_engine.handler import InvalidCommand, handle_batch, parse
from alarm_engine.manual_change import route
from alarm_engine.migration import plan_migration, report
from alarm_engine.repository import RemediationPolicyRow, RemediationRequestRow, ResourceRow, now
from alarm_engine.sync import Command
from conftest import ACCOUNT_ID, ec2, make_account

SRC = Path(__file__).resolve().parents[1] / "src" / "alarm_engine"


def msg(type_, payload=None, **kw):
    body = {"schemaVersion": 1, "commandId": f"cmd_{type_}", "type": type_, "customerId": "cus_1",
            "cloudAccountId": "acc_1", "requestedBy": {"type": "USER", "id": "u"}, "requestedAt": "2026-11-12T00:00:00Z",
            "payload": payload or {}, **kw}
    return {"messageId": f"m_{type_}", "body": json.dumps(body)}


# ── handler

@pytest.mark.parametrize("body,err", [
    ("not json", "JSON"), (json.dumps({"schemaVersion": 2}), "schemaVersion"),
    (json.dumps({"schemaVersion": 1, "commandId": "c", "type": "NOPE", "customerId": "x"}), "unknown type"),
    (json.dumps({"schemaVersion": 1, "type": "SYNC_ACCOUNT", "customerId": "x"}), "commandId"),
])
def test_parse_rejects(body, err):
    with pytest.raises(InvalidCommand, match=err):
        parse(body)


def test_sync_account_via_sqs_and_tenant_guard(world):
    repo, sessions, disc, eng, acc = world
    disc.resources = [ec2()]
    out = handle_batch(eng, {"Records": [msg("SYNC_ACCOUNT", {"mode": "DAILY"}),
                                         msg("SYNC_ACCOUNT", {"mode": "DAILY"}, customerId="cus_evil")]})
    assert out == {"batchItemFailures": []}
    assert len(repo.runs) == 1        # the cross-tenant one was dropped


def test_failed_record_reported_for_retry(world, monkeypatch):
    repo, sessions, disc, eng, acc = world
    repo.resources["r1"] = ResourceRow("r1", "cus_1", acc.id, "ap-northeast-2", "EC2", "arn", "i-1",
                                       monitoring_state="MONITORED")

    def boom(*a, **k):
        raise RuntimeError("throttled")
    monkeypatch.setattr(eng, "sync_resource", boom)
    out = handle_batch(eng, {"Records": [msg("SYNC_RESOURCE", {"resourceId": "r1"})]})
    assert out == {"batchItemFailures": [{"itemIdentifier": "m_SYNC_RESOURCE"}]}


def test_unknown_resource_or_account_is_poison_not_retried(world):
    repo, sessions, disc, eng, acc = world
    out = handle_batch(eng, {"Records": [msg("SYNC_RESOURCE", {"resourceId": "missing"}),
                                         msg("CHECK_CONNECTION", cloudAccountId="acc_nope")]})
    assert out == {"batchItemFailures": []}


@pytest.mark.parametrize("type_,payload", [
    ("SYNC_RESOURCE", {}), ("SYNC_RESOURCE", {"resourceId": 5}), ("APPLY_THRESHOLD", {"managedAlarmId": "m"}),
    ("APPLY_THRESHOLD", {"managedAlarmId": "m", "thresholdChangeId": "c", "threshold": "90"}),
    ("APPLY_THRESHOLD", {"managedAlarmId": "m", "thresholdChangeId": "c", "evalM": True}),
    ("SET_SEVERITY", {"managedAlarmId": "m"}), ("STOP_MONITORING", {"resourceId": "r", "deleteAlarms": "yes"}),
    ("EXECUTE_REMEDIATION", {}), ("APPLY_CUSTOMER_DEFAULT", {"resourceType": "EC2"}),
    ("CHECK_ALARM_LIVENESS", {"incidentId": "i"}), ("CHECK_ALARM_LIVENESS", {"incidentId": "i", "alarmNames": "a"}),
    ("CHECK_ALARM_LIVENESS", {"incidentId": "i", "alarmNames": [1]}),
    ("CHECK_ALARM_LIVENESS", {"incidentId": "i", "alarmNames": [f"a{i}" for i in range(101)]}),
])
def test_parse_rejects_bad_payload(type_, payload):
    with pytest.raises(InvalidCommand):
        parse(msg(type_, payload)["body"])


def test_parse_requires_account_for_account_commands():
    body = json.loads(msg("CHECK_CONNECTION")["body"])
    del body["cloudAccountId"]
    with pytest.raises(InvalidCommand, match="cloudAccountId"):
        parse(json.dumps(body))


def test_liveness_region_must_be_enabled(world):
    from alarm_engine.handler import dispatch
    repo, sessions, disc, eng, acc = world
    p = {"incidentId": "i", "alarmNames": ["a"]}
    with pytest.raises(InvalidCommand, match="region"):
        dispatch(eng, parse(msg("CHECK_ALARM_LIVENESS", {**p, "region": "eu-west-1"})["body"]))
    assert dispatch(eng, parse(msg("CHECK_ALARM_LIVENESS", {**p, "region": "us-east-1"})["body"]))["status"] == "OK"
    assert dispatch(eng, parse(msg("CHECK_ALARM_LIVENESS", p)["body"]))["status"] == "OK"


def test_handler_logs_include_customer(world, caplog):
    repo, sessions, disc, eng, acc = world
    caplog.set_level("INFO")
    handle_batch(eng, {"Records": [msg("CHECK_CONNECTION")]})
    assert "customer=cus_1" in caplog.text


def test_capability_disabled_is_a_result_not_a_retry(world):
    from alarm_engine.handler import dispatch
    repo, sessions, disc, eng, acc = world
    repo.resources["r1"] = ResourceRow("r1", "cus_1", acc.id, "ap-northeast-2", "EC2", "arn", "i-1")
    out = dispatch(eng, parse(msg("SET_MONITORING_TAG", {"resourceId": "r1", "value": "on"})["body"]))
    assert out == {"status": "CAPABILITY_DISABLED", "role": "tagWriter"}


def test_check_connection_records_role_status(world):
    repo, sessions, disc, eng, acc = world
    handle_batch(eng, {"Records": [msg("CHECK_CONNECTION")]})
    assert repo.account_status["acc_1"] == {"reader": "OK", "alarmWriter": "OK", "tagWriter": "MISSING",
                                            "remediator": "MISSING"}


def test_liveness_classification(world):
    from alarm_engine.handler import dispatch
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw("ap-northeast-2")
    cw.add_foreign_alarm("a", StateValue="ALARM")
    cw.add_foreign_alarm("b", StateValue="OK")
    out = dispatch(eng, parse(msg("CHECK_ALARM_LIVENESS", {"incidentId": "inc", "alarmNames": ["a", "b", "c"]})["body"]))
    assert out["liveness"] == {"a": "firing", "b": "not_firing", "c": "deleted"}


# ── remediation (D-15)

def _setup_remediation(repo, acc, *, enabled=True, mode="APPROVAL_REQUIRED", remediator=True):
    repo.accounts[acc.id] = make_account(remediator_role_arn="arn:aws:iam::1:role/Rem", remediator_enabled=remediator)
    repo.resources["r1"] = ResourceRow("r1", "cus_1", acc.id, "ap-northeast-2", "EC2",
                                       f"arn:aws:ec2:ap-northeast-2:{ACCOUNT_ID}:instance/i-1", "i-1", monitoring_state="MONITORED")
    repo.policies["cus_1"] = RemediationPolicyRow("cus_1", enabled, mode, ("EC2_STOP",))


DESTRUCTIVE = {"stop_instances", "stop_db_instance", "stop_db_cluster", "delete_load_balancer", "terminate_instances"}


def test_propose_default_policy_is_off(world):
    repo, sessions, disc, eng, acc = world
    repo.resources["r1"] = ResourceRow("r1", "cus_1", acc.id, "ap-northeast-2", "EC2", "arn", "i-1",
                                       monitoring_state="MONITORED")
    assert remediation.propose(repo, acc, repo.resources["r1"], {"event": "ModifyInstanceAttribute"}) is None
    assert sessions.all_calls() == []


def test_propose_notify_only_and_approval_required(world):
    repo, sessions, disc, eng, acc = world
    _setup_remediation(repo, acc, mode="NOTIFY_ONLY")
    r = remediation.propose(repo, acc, repo.resources["r1"], {"event": "x"})
    assert r.status == "NOTIFIED"
    repo.remediations.clear()
    _setup_remediation(repo, acc, mode="APPROVAL_REQUIRED")
    r = remediation.propose(repo, acc, repo.resources["r1"], {"event": "x"})
    assert r.status == "PENDING_APPROVAL"
    assert remediation.propose(repo, acc, repo.resources["r1"], {"event": "x"}) is None   # one active per resource
    assert not any(c in DESTRUCTIVE for c in sessions.all_calls())


@pytest.mark.parametrize("status", ["NOTIFIED", "PENDING_APPROVAL", "REJECTED", "EXPIRED", "EXECUTING", "SUCCEEDED",
                                    "FAILED", "APPROVED_NO_DECIDER", "APPROVED_EXPIRED", "APPROVED_FLAG_OFF",
                                    "APPROVED_POLICY_OFF", "APPROVED_NOTIFY_ONLY", "APPROVED_NO_ROLE"])
def test_no_destructive_call_without_approved_request(world, monkeypatch, status):
    repo, sessions, disc, eng, acc = world
    _setup_remediation(repo, acc, enabled=status != "APPROVED_POLICY_OFF",
                       mode="NOTIFY_ONLY" if status == "APPROVED_NOTIFY_ONLY" else "APPROVAL_REQUIRED",
                       remediator=status != "APPROVED_NO_ROLE")
    if status != "APPROVED_FLAG_OFF":
        monkeypatch.setenv("ALARMOPS_REMEDIATION_EXECUTION", "true")
    real = "APPROVED" if status.startswith("APPROVED") else status
    repo.remediations["rq"] = RemediationRequestRow(
        "rq", "cus_1", acc.id, "r1", "EC2_STOP", real, {},
        decided_by=None if status == "APPROVED_NO_DECIDER" else "contact_1", decided_at=now(),
        expires_at=now() - timedelta(minutes=1) if status == "APPROVED_EXPIRED" else None)
    out = handle_batch(eng, {"Records": [msg("EXECUTE_REMEDIATION", {"remediationRequestId": "rq"})]})
    assert out == {"batchItemFailures": []}
    assert not any(c in DESTRUCTIVE for c in sessions.all_calls())
    assert repo.remediations["rq"].status == real


def test_approved_request_executes_once(world, monkeypatch):
    repo, sessions, disc, eng, acc = world
    _setup_remediation(repo, acc)
    monkeypatch.setenv("ALARMOPS_REMEDIATION_EXECUTION", "true")
    repo.remediations["rq"] = RemediationRequestRow("rq", "cus_1", acc.id, "r1", "EC2_STOP", "APPROVED", {},
                                                    decided_by="contact_1", decided_at=now())
    assert remediation.execute(repo, sessions, "rq").status == "SUCCEEDED"
    assert remediation.execute(repo, sessions, "rq").status == "REFUSED"
    calls = sessions.others[("remediator", "ec2", "ap-northeast-2")].calls
    assert calls == [("stop_instances", {"InstanceIds": ["i-1"]})]


def test_destructive_calls_exist_only_in_remediation_run():
    pat = re.compile(r"\.(stop_instances|stop_db_instance|stop_db_cluster|delete_load_balancer|terminate_instances)\(")
    hits = {p.name for p in SRC.rglob("*.py") if pat.search(p.read_text(encoding="utf-8"))}
    assert hits == {"remediation.py"}
    text = (SRC / "remediation.py").read_text(encoding="utf-8")
    run_body = text[text.index("def _run("):]
    assert len(pat.findall(text)) == len(pat.findall(run_body))
    assert text.count("_run(") == 2      # definition + the single call after the APPROVED→EXECUTING claim


# ── STS ExternalId (Stubber) and moto round trip

def test_sts_assume_role_passes_external_id():
    sts = boto3.client("sts", region_name="ap-northeast-2")
    acc = make_account()
    built = []
    with Stubber(sts) as stub:
        stub.add_response("assume_role", {"Credentials": {"AccessKeyId": "AKIAXXXXXXXXXXXXXXXX", "SecretAccessKey": "s",
                                                          "SessionToken": "t", "Expiration": "2030-01-01T00:00:00Z"}},
                          {"RoleArn": acc.reader_role_arn, "RoleSessionName": "alarmops-engine",
                           "ExternalId": "ext-123", "DurationSeconds": 900})
        f = StsSessionFactory(sts, lambda svc, **kw: built.append((svc, kw)) or object())
        f.client(acc, "reader", "cloudwatch", "ap-northeast-2")
        stub.assert_no_pending_responses()
    assert built[0][0] == "cloudwatch" and built[0][1]["region_name"] == "ap-northeast-2"
    with pytest.raises(CapabilityDisabled):
        f.client(make_account(alarm_writer_enabled=False), "alarmWriter", "cloudwatch", "ap-northeast-2")


@mock_aws
def test_moto_writer_roundtrip_and_ownership():
    cw = boto3.client("cloudwatch", region_name="ap-northeast-2")
    moto_account = "123456789012"
    ds = build_desired(ResourceRef("EC2", "i-1", "ap-northeast-2", moto_account, {"Name": "w"}), cw)
    w = AlarmWriter(cw, moto_account)
    for d in ds.alarms:
        w.apply(Command("CREATE", d.name, d.metric_key, desired=d, severity=d.severity))
    cw.put_metric_alarm(AlarmName="theirs", MetricName="CPUUtilization", Namespace="AWS/EC2", Statistic="Average",
                        Period=60, EvaluationPeriods=1, Threshold=1, ComparisonOperator="GreaterThanThreshold",
                        AlarmDescription='{"resourceId":"i-1","metricKey":"CPUUtilization"}')
    owned = list_owned_alarms(cw)["i-1"]
    assert {a.name for a in owned} == {d.name for d in ds.alarms}
    with pytest.raises(TaggingFailed):
        AlarmWriter(cw, ACCOUNT_ID).apply(Command("CREATE", ds.alarms[0].name, "x", desired=ds.alarms[0],
                                                  severity="SEV-3"))   # ARN not in the expected account


# ── CloudTrail routing

@pytest.mark.parametrize("event,kw,action", [
    ("RunInstances", {"monitored": False, "monitoring_after": "on"}, "SYNC"),
    ("RunInstances", {"monitored": False}, "IGNORE"),
    ("TerminateInstances", {"monitored": True}, "DELETE_RESOURCE"),
    ("CreateTags", {"monitored": False, "tag_keys_changed": {"Monitoring"}, "monitoring_after": "on"}, "SYNC"),
    ("DeleteTags", {"monitored": True, "tag_keys_changed": {"Monitoring"}}, "NEEDS_REVIEW"),
    ("CreateTags", {"monitored": True, "tag_keys_changed": {"Monitoring"}, "monitoring_after": "off"}, "NEEDS_REVIEW"),
    ("CreateTags", {"monitored": True, "tag_keys_changed": {"Threshold_CPU"}}, "SYNC"),
    ("CreateTags", {"monitored": False, "tag_keys_changed": {"Threshold_CPU"}}, "IGNORE"),
    ("ModifyInstanceAttribute", {"monitored": True}, "PROPOSE_REMEDIATION"),
    ("ModifyInstanceAttribute", {"monitored": False}, "IGNORE"),
    ("PutMetricAlarm", {"monitored": True, "principal_arn": "arn:aws:sts::1:assumed-role/Human/x",
                        "engine_role_arn": "arn:aws:iam::1:role/AlarmOpsAlarmWriter"}, "SYNC"),
    ("PutMetricAlarm", {"monitored": True, "principal_arn": "arn:aws:sts::1:assumed-role/AlarmOpsAlarmWriter/s",
                        "engine_role_arn": "arn:aws:iam::1:role/AlarmOpsAlarmWriter"}, "IGNORE"),
])
def test_cloudtrail_routing(event, kw, action):
    assert route(event, **kw).action == action


# ── D-08 migration helper

def test_migration_dry_run_report():
    legacy_desc = '{"metric_key":"CPU","resource_id":"i-1","resource_type":"EC2","severity":"SEV-3"}'
    alarms = [
        {"AlarmName": "[EC2] web CPUUtilization > 80% (TagName: i-1)", "AlarmDescription": "x | " + legacy_desc,
         "Tags": {"ManagedBy": "AlarmManager"}},
        {"AlarmName": "[EC2] web CPUUtilization > 90% (TagName: i-1)", "AlarmDescription": legacy_desc,
         "Tags": {"ManagedBy": "AlarmManager"}},
        {"AlarmName": "[EC2] web disk_used_percent(/data) > 85% (TagName: i-1)",
         "AlarmDescription": '{"metric_key":"Disk_data","resource_id":"i-1","resource_type":"EC2"}',
         "Tags": {"ManagedBy": "AlarmManager"}},
        {"AlarmName": "[EC2] web mem_used_percent (TagName: i-1)",
         "AlarmDescription": '{"metricKey":"mem_used_percent","resourceId":"i-1","resourceType":"EC2"}',
         "Tags": {"ManagedBy": "AlarmOps"}},
        {"AlarmName": "customer alarm", "AlarmDescription": "", "Tags": {}},
    ]
    items = plan_migration(alarms, {"i-1": "web"})
    assert [(i.action, i.new_name) for i in items] == [
        ("RENAME", "[EC2] web CPUUtilization (TagName: i-1)"),
        ("DUPLICATE", "[EC2] web CPUUtilization (TagName: i-1)"),
        ("RENAME", "[EC2] web disk_used_percent(/data) (TagName: i-1)"),
        ("ALREADY_NEW", "[EC2] web mem_used_percent (TagName: i-1)"),
        ("NOT_OURS", None),
    ]
    assert items[0].metric_key == "CPUUtilization"
    text = report(items)
    assert "DRY RUN" in text and "RENAME=2" in text


# ── security review fixes

def _approved(repo, acc, **kw):
    repo.remediations["rq"] = RemediationRequestRow("rq", "cus_1", acc.id, "r1", kw.get("action", "EC2_STOP"),
                                                    "APPROVED", {}, decided_by="contact_1", decided_at=now())


@pytest.mark.parametrize("mutate,reason", [
    (lambda r: setattr(r, "cloud_account_id", "acc_other"), "request account"),
    (lambda r: setattr(r, "resource_arn", "arn:aws:ec2:ap-northeast-2:999999999999:instance/i-1"), "customer account"),
    (lambda r: setattr(r, "resource_arn", f"arn:aws:ec2:us-west-2:{ACCOUNT_ID}:instance/i-1"), "region"),
    (lambda r: setattr(r, "monitoring_state", "NEEDS_REVIEW"), "not monitored"),
])
def test_remediation_refuses_mismatched_resource(world, monkeypatch, mutate, reason):
    repo, sessions, disc, eng, acc = world
    _setup_remediation(repo, acc)
    monkeypatch.setenv("ALARMOPS_REMEDIATION_EXECUTION", "true")
    _approved(repo, acc)
    mutate(repo.resources["r1"])
    out = remediation.execute(repo, sessions, "rq")
    assert out.status == "REFUSED" and reason in out.reason
    assert repo.remediations["rq"].status == "APPROVED"
    assert not DESTRUCTIVE & set(sessions.all_calls())


def test_remediation_wrong_customer_is_refused(world, monkeypatch):
    repo, sessions, disc, eng, acc = world
    _setup_remediation(repo, acc)
    monkeypatch.setenv("ALARMOPS_REMEDIATION_EXECUTION", "true")
    _approved(repo, acc)
    assert remediation.execute(repo, sessions, "rq", customer_id="cus_evil").status == "REFUSED"
    assert repo.transition_remediation("cus_evil", "rq", "APPROVED", "EXECUTING") is False
    assert repo.remediations["rq"].status == "APPROVED"


def test_empty_external_id_is_capability_disabled():
    sts = boto3.client("sts", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="x")
    with Stubber(sts):    # no responses queued: any call would fail the test
        f = StsSessionFactory(sts, client_ctor=lambda *a, **k: None)
        with pytest.raises(CapabilityDisabled):
            f.credentials(make_account(external_id=""), "reader")


def test_sync_run_updates_are_tenant_scoped(world):
    repo, sessions, disc, eng, acc = world
    rid = repo.start_sync_run("cus_1", acc.id, "DAILY")
    repo.finish_sync_run("cus_evil", rid, "FAILED", {})
    assert repo.runs[rid].status == "RUNNING"
    repo.finish_sync_run("cus_1", rid, "SUCCEEDED", {})
    assert repo.runs[rid].status == "SUCCEEDED"
