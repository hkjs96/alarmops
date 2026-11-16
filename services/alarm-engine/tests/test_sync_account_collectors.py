"""SYNC_ACCOUNT end to end with the real collectors (Stubber) + CloudTrail tag events. No AWS."""

from __future__ import annotations

import json

import pytest

from alarm_engine import handler
from alarm_engine.collectors import AwsDiscovery
from alarm_engine.collectors.groups import GROUP_OF
from alarm_engine.engine import Engine
from alarm_engine.repository import InMemoryRepository
from alarm_engine.wiring import make_engine
from aws_stubs import ACCOUNT as A
from aws_stubs import REGION as R
from aws_stubs import StubSessions, kv, rgt, tags
from conftest import FakeSessions, ec2, make_account

T = tags(name="web-1")
EC2_F = {"Filters": [{"Name": "tag-key", "Values": ["Monitoring"]}]}
SQS_ARN = f"arn:aws:sqs:{R}:{A}:jobs"
EC2_ARN = f"arn:aws:ec2:{R}:{A}:instance/i-1"


def _inst(state: str = "running") -> dict:
    return {"Reservations": [{"Instances": [{"InstanceId": "i-1", "State": {"Name": state, "Code": 16}, "Tags": kv(T)}]}]}


@pytest.fixture
def env():
    repo = InMemoryRepository()
    acct = make_account()
    repo.accounts[acct.id] = acct
    fake = FakeSessions()
    sess = StubSessions(fallback=fake)
    disc = AwsDiscovery(sess, (GROUP_OF["EC2"], GROUP_OF["SQS"]))
    return repo, fake, sess, disc, Engine(repo, sess, disc), acct


def _first_run(env, extra: list[tuple] | None = None):
    repo, fake, sess, disc, eng, acct = env
    sess.add(("ec2", R, "describe_instances", _inst(), EC2_F))
    sess.add(rgt(R, ["sqs"], [(SQS_ARN, T)]))
    return eng.sync_account(acct.id, "DAILY")


@pytest.mark.parametrize("mode", ["DAILY", "TAG_RECONCILE", "ON_DEMAND"])
def test_sync_account_command_discovers_and_creates_alarms_in_every_mode(env, mode):
    repo, fake, sess, disc, eng, acct = env
    sess.add(("ec2", R, "describe_instances", _inst(), EC2_F))
    sess.add(rgt(R, ["sqs"], [(SQS_ARN, T)]))
    cmd = {"schemaVersion": 1, "commandId": f"c-{mode}", "type": "SYNC_ACCOUNT", "customerId": acct.customer_id,
           "cloudAccountId": acct.id, "payload": {"mode": mode}}
    out = handler.dispatch(eng, cmd)
    assert out["status"] == "OK" and out["counts"]["errors"] == 0 and out["counts"]["created"] >= 6
    run = next(iter(repo.runs.values()))
    assert run.mode == mode and run.status == "SUCCEEDED"
    types = {r.resource_type: r for r in repo.resources.values()}
    assert set(types) == {"EC2", "SQS"} and all(r.monitoring_state == "MONITORED" for r in types.values())
    assert len(fake.cw(R).alarms) == out["counts"]["created"]
    sess.assert_all_consumed()


def test_per_type_failure_is_recorded_and_other_types_still_sync(env):
    repo, fake, sess, disc, eng, acct = env
    sess.add(("ec2", R, "describe_instances", _inst(), EC2_F))
    sess.add(("resourcegroupstaggingapi", R, "get_resources", "AccessDeniedException"))       # SQS listing fails
    counts = eng.sync_account(acct.id, "DAILY")
    run = next(iter(repo.runs.values()))
    assert run.status == "PARTIAL" and counts["errors"] == 1
    assert list(counts["typeErrors"]) == [f"{R}/SQS"] and "AccessDeniedException" in counts["typeErrors"][f"{R}/SQS"]
    assert {r.resource_type for r in repo.resources.values()} == {"EC2"} and counts["created"] > 0


def test_failed_type_leaves_existing_rows_and_alarms_alone(env):
    repo, fake, sess, disc, eng, acct = env
    _first_run(env)
    alarms_before = dict(fake.cw(R).alarms)
    sess.add(("ec2", R, "describe_instances", _inst(), EC2_F))
    sess.add(("resourcegroupstaggingapi", R, "get_resources", "AccessDeniedException"))       # SQS can't be listed now
    eng.sync_account(acct.id, "DAILY")
    sqs = next(r for r in repo.resources.values() if r.resource_type == "SQS")
    assert sqs.monitoring_state == "MONITORED"                 # "could not list" is not "tag removed" / "gone"
    assert fake.cw(R).alarms.keys() == alarms_before.keys()


def test_discovery_wide_failure_fails_the_run_and_changes_nothing(env):
    repo, fake, sess, disc, eng, acct = env
    sess.add(("ec2", R, "describe_instances", "AuthFailure"))
    sess.add(("resourcegroupstaggingapi", R, "get_resources", "AuthFailure"))
    eng.sync_account(acct.id, "DAILY")
    run = next(iter(repo.runs.values()))
    assert run.status == "FAILED" and "all collectors failed" in (run.error or "") and not repo.resources


def test_monitoring_tag_removed_becomes_needs_review_without_deleting_alarms(env):
    repo, fake, sess, disc, eng, acct = env
    _first_run(env)
    writes_before = list(fake.cw(R).writes())
    sess.add(("ec2", R, "describe_instances", {"Reservations": []}, EC2_F))                    # no longer Monitoring-tagged
    sess.add(rgt(R, ["sqs"], [(SQS_ARN, T)]))
    sess.add(("ec2", R, "describe_instances", _inst(), {"InstanceIds": ["i-1"]}))               # alive
    sess.add(("resourcegroupstaggingapi", R, "get_resources",                                   # tags re-read: no Monitoring
              {"ResourceTagMappingList": [{"ResourceARN": EC2_ARN, "Tags": [{"Key": "Name", "Value": "web-1"}]}],
               "PaginationToken": ""}, {"ResourceARNList": [EC2_ARN]}))
    counts = eng.sync_account(acct.id, "TAG_RECONCILE")
    ec2_row = next(r for r in repo.resources.values() if r.resource_type == "EC2")
    assert ec2_row.monitoring_state == "NEEDS_REVIEW" and ec2_row.needs_review_reason == "tag_removed"
    assert counts["needsReview"] == 1 and counts["deleted"] == 0
    assert "delete_alarms" not in fake.cw(R).writes()[len(writes_before):]
    assert any(a["AlarmName"].find("i-1") >= 0 for a in fake.cw(R).alarms.values())


def test_resource_really_gone_is_deleted_with_its_alarms(env):
    repo, fake, sess, disc, eng, acct = env
    _first_run(env)
    sess.add(("ec2", R, "describe_instances", {"Reservations": []}, EC2_F))
    sess.add(rgt(R, ["sqs"], [(SQS_ARN, T)]))
    sess.add(("ec2", R, "describe_instances", "InvalidInstanceID.NotFound", {"InstanceIds": ["i-1"]}))
    counts = eng.sync_account(acct.id, "DAILY")
    ec2_row = next(r for r in repo.resources.values() if r.resource_type == "EC2")
    assert ec2_row.monitoring_state == "DELETED" and counts["deleted"] >= 3
    assert not [a for a in fake.cw(R).alarms.values() if "i-1" in a["AlarmDescription"]]


def test_make_engine_wires_the_real_collectors():
    eng = make_engine(InMemoryRepository(), StubSessions())
    assert isinstance(eng.discovery, AwsDiscovery)


# ── CloudTrail tag events ────────────────────────────────────────────────────────────────────────────────────────

def event(name: str, params: dict, account: str = A, **detail) -> dict:
    return {"version": "0", "id": "e-1", "detail-type": "AWS API Call via CloudTrail", "source": "aws.ec2",
            "account": account, "region": R, "detail": {"eventName": name, "requestParameters": params, **detail}}


def ec2_tags(items: list[tuple[str, str | None]]) -> dict:
    return {"resourcesSet": {"items": [{"resourceId": "i-0abc"}]},
            "tagSet": {"items": [({"key": k, "value": v} if v is not None else {"key": k}) for k, v in items]}}


@pytest.fixture
def synced(world):
    repo, sessions, disc, eng, acct = world
    disc.resources = [ec2()]
    eng.sync_account(acct.id, "ON_DEMAND")
    return repo, sessions, disc, eng, acct


def _state(repo) -> str:
    return next(iter(repo.resources.values())).monitoring_state


def test_tag_removed_event_marks_needs_review_and_keeps_alarms(synced):
    from alarm_engine import events
    repo, sessions, disc, eng, acct = synced
    n = len(sessions.cw("ap-northeast-2").alarms)
    writes = len(sessions.cw("ap-northeast-2").writes())
    disc.tags_map["i-0abc"] = {"Name": "web-1"}
    out = events.handle_tag_event(eng, event("DeleteTags", ec2_tags([("Monitoring", None)])))
    assert out["status"] == "OK" and _state(repo) == "NEEDS_REVIEW"
    assert len(sessions.cw("ap-northeast-2").alarms) == n and len(sessions.cw("ap-northeast-2").writes()) == writes


def test_tag_added_event_restores_monitoring_and_threshold_change_resyncs(synced):
    from alarm_engine import events
    repo, sessions, disc, eng, acct = synced
    disc.tags_map["i-0abc"] = {"Name": "web-1"}
    events.handle_tag_event(eng, event("DeleteTags", ec2_tags([("Monitoring", None)])))
    disc.tags_map["i-0abc"] = {"Monitoring": "on", "Name": "web-1", "Threshold_CPUUtilization": "93"}
    out = events.handle_tag_event(eng, event("CreateTags", ec2_tags([("Monitoring", "on")])))
    assert out["status"] == "OK" and _state(repo) == "MONITORED"
    cpu = next(a for a in sessions.cw("ap-northeast-2").alarms.values() if "CPUUtilization" in a["AlarmName"])
    assert cpu["Threshold"] == 93.0
    disc.tags_map["i-0abc"] = {"Monitoring": "on", "Name": "web-1", "Threshold_CPUUtilization": "70"}
    events.handle_tag_event(eng, event("CreateTags", ec2_tags([("Threshold_CPUUtilization", "70")])))
    cpu = next(a for a in sessions.cw("ap-northeast-2").alarms.values() if "CPUUtilization" in a["AlarmName"])
    assert cpu["Threshold"] == 70.0                             # same alarm, in place (D-08)


def test_irrelevant_tag_change_is_ignored(synced):
    from alarm_engine import events
    repo, sessions, disc, eng, acct = synced
    writes = len(sessions.cw("ap-northeast-2").writes())
    out = events.handle_tag_event(eng, event("CreateTags", ec2_tags([("Team", "x")])))
    assert out["status"] == "IGNORED" and len(sessions.cw("ap-northeast-2").writes()) == writes


def test_only_the_top_level_account_selects_the_tenant(synced):
    from alarm_engine import events
    repo, sessions, disc, eng, acct = synced
    disc.tags_map["i-0abc"] = {"Name": "web-1"}
    other = event("DeleteTags", ec2_tags([("Monitoring", None)]), account="999999999999",
                  recipientAccountId=A, userIdentity={"accountId": A},
                  )
    other["detail"]["requestParameters"]["resourcesSet"] = {"items": [{"resourceId": "i-0abc"}]}
    assert events.handle_tag_event(eng, other)["status"] == "IGNORED"        # body values are not trusted
    assert _state(repo) == "MONITORED"
    forged = event("DeleteTags", ec2_tags([("Monitoring", None)]), recipientAccountId="999999999999",
                   userIdentity={"accountId": "999999999999"})
    assert events.handle_tag_event(eng, forged)["status"] == "OK" and _state(repo) == "NEEDS_REVIEW"
    for bad in ("", "abc", None, 111122223333):
        e = event("DeleteTags", ec2_tags([("Monitoring", None)]))
        e["account"] = bad
        assert events.handle_tag_event(eng, e)["status"] == "IGNORED"


def test_inactive_customer_and_foreign_resource_are_ignored(synced):
    from alarm_engine import events
    repo, sessions, disc, eng, acct = synced
    disc.tags_map["i-0abc"] = {"Name": "web-1"}
    repo.customer_status[acct.customer_id] = "TERMINATED"
    assert events.handle_tag_event(eng, event("DeleteTags", ec2_tags([("Monitoring", None)])))["status"] == "IGNORED"
    repo.customer_status.clear()
    sg = event("CreateTags", {"resourcesSet": {"items": [{"resourceId": "sg-123"}]},
                              "tagSet": {"items": [{"key": "Monitoring", "value": "on"}]}})
    assert events.handle_tag_event(eng, sg)["status"] == "IGNORED"          # unsupported resource: no account run
    assert len(repo.runs) == 1                                                # only the initial sync


def test_monitoring_on_for_unknown_resource_runs_a_tag_reconcile(world):
    from alarm_engine import events
    repo, sessions, disc, eng, acct = world
    disc.resources = [ec2("i-0new")]
    e = event("CreateTags", {"resourcesSet": {"items": [{"resourceId": "i-0new"}]},
                             "tagSet": {"items": [{"key": "Monitoring", "value": "on"}]}})
    out = events.handle_tag_event(eng, e)
    assert out["status"] == "OK" and out["accountSync"]["created"] > 0
    assert next(iter(repo.runs.values())).mode == "TAG_RECONCILE"


def test_other_services_tag_event_shapes(synced):
    from alarm_engine import events
    refs, keys, mon = events.extract("TagResource", {"resourceArn": f"arn:aws:lambda:{R}:{A}:function:fn",
                                                     "tags": {"Monitoring": "on", "x": "y"}})
    assert refs == {f"arn:aws:lambda:{R}:{A}:function:fn"} and keys == {"Monitoring", "x"} and mon == "on"
    refs, keys, mon = events.extract("UntagQueue", {"queueUrl": f"https://sqs.{R}.amazonaws.com/{A}/jobs",
                                                    "tagKeys": ["Monitoring"]})
    assert refs == {"jobs"} and keys == {"Monitoring"} and mon is None
    refs, keys, mon = events.extract("AddTagsToResource", {"resourceName": f"arn:aws:rds:{R}:{A}:db:db1",
                                                           "tags": [{"key": "Monitoring", "value": "on"}]})
    assert refs == {f"arn:aws:rds:{R}:{A}:db:db1"} and mon == "on"
    refs, keys, mon = events.extract("UntagResources", {"resourceARNList": [f"arn:aws:sns:{R}:{A}:t"],
                                                        "tagKeys": ["Monitoring"]})
    assert keys == {"Monitoring"} and mon is None


def test_handler_routes_forwarded_events_and_retries_failures(synced):
    repo, sessions, disc, eng, acct = synced
    disc.tags_map["i-0abc"] = {"Name": "web-1"}
    body = json.dumps(event("DeleteTags", ec2_tags([("Monitoring", None)])))
    assert handler.handle_batch(eng, {"Records": [{"messageId": "m1", "body": body}]}) == {"batchItemFailures": []}
    assert _state(repo) == "NEEDS_REVIEW"

    def boom(*a, **k):
        raise RuntimeError("db down")
    eng.repo.find_active_account_by_aws_id = boom        # type: ignore[method-assign]
    res = handler.handle_batch(eng, {"Records": [{"messageId": "m2", "body": body}]})
    assert res == {"batchItemFailures": [{"itemIdentifier": "m2"}]}      # transient failure → SQS retry
