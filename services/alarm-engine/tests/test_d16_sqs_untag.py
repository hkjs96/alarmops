"""D-16 regression (rehearsal b7): removing `Monitoring` from an SQS queue must leave its alarms alone (NEEDS_REVIEW).

Same wiring as test_sync_account_collectors (real collectors on Stubber clients, CloudWatch on the in-memory fake). No AWS.
"""

from __future__ import annotations

import pytest

from alarm_engine import events
from alarm_engine.collectors import AwsDiscovery
from alarm_engine.collectors.groups import GROUP_OF
from alarm_engine.engine import Engine
from alarm_engine.repository import InMemoryRepository
from aws_stubs import ACCOUNT as A
from aws_stubs import REGION as R
from aws_stubs import StubSessions, rgt, tags
from conftest import FakeSessions, make_account

T = tags(name="jobs")
SQS_ARN = f"arn:aws:sqs:{R}:{A}:jobs"
SQS_URL = f"https://sqs.{R}.amazonaws.com/{A}/jobs"


@pytest.fixture
def env():
    repo = InMemoryRepository()
    acct = make_account()
    repo.accounts[acct.id] = acct
    fake = FakeSessions()
    sess = StubSessions(fallback=fake)
    eng = Engine(repo, sess, AwsDiscovery(sess, (GROUP_OF["SQS"],)))
    sess.add(rgt(R, ["sqs"], [(SQS_ARN, T)]))
    eng.sync_account(acct.id, "DAILY")
    assert len(fake.cw(R).alarms) == 3
    return repo, fake, sess, eng, acct


def _untag_event() -> dict:
    return {"version": "0", "id": "e-1", "detail-type": "AWS API Call via CloudTrail", "source": "aws.sqs",
            "account": A, "region": R,
            "detail": {"eventName": "UntagQueue", "requestParameters": {"queueUrl": SQS_URL, "tagKeys": ["Monitoring"]}}}


def _tags_without_monitoring(sess) -> None:
    sess.add(("resourcegroupstaggingapi", R, "get_resources",
              {"ResourceTagMappingList": [{"ResourceARN": SQS_ARN, "Tags": [{"Key": "AlarmOpsRehearsal", "Value": "true"}]}],
               "PaginationToken": ""}, {"ResourceARNList": [SQS_ARN]}))


def _row(repo):
    return next(iter(repo.resources.values()))


def test_sqs_untag_event_keeps_alarms_and_marks_needs_review(env, monkeypatch):
    from datetime import timedelta
    monkeypatch.setattr(events, "RESOURCE_DEDUPE", timedelta(0))
    repo, fake, sess, eng, acct = env
    _tags_without_monitoring(sess)
    out = events.handle_tag_event(eng, _untag_event())
    assert out["status"] == "OK", out
    assert _row(repo).monitoring_state == "NEEDS_REVIEW" and len(fake.cw(R).alarms) == 3
    assert "delete_alarms" not in fake.cw(R).writes()


def test_sqs_missing_from_list_but_get_queue_url_ok_keeps_alarms(env):
    """ListQueues alone must never delete alarms: the queue is still there per GetQueueUrl."""
    repo, fake, sess, eng, acct = env
    sess.add(rgt(R, ["sqs"], []))
    sess.add(("sqs", R, "list_queues", {}))                                   # list omits the queue
    sess.add(("sqs", R, "get_queue_url", {"QueueUrl": SQS_URL}, {"QueueName": "jobs"}))
    _tags_without_monitoring(sess)
    counts = eng.sync_account(acct.id, "TAG_RECONCILE")
    assert counts["deleted"] == 0 and len(fake.cw(R).alarms) == 3


def test_sqs_really_gone_deletes_alarms(env):
    repo, fake, sess, eng, acct = env
    sess.add(rgt(R, ["sqs"], []))
    sess.add(("sqs", R, "list_queues", {}))
    sess.add(("sqs", R, "get_queue_url", "QueueDoesNotExist", {"QueueName": "jobs"}))
    counts = eng.sync_account(acct.id, "TAG_RECONCILE")
    assert counts["deleted"] == 3 and not fake.cw(R).alarms


def test_sqs_untag_then_account_sync_keeps_alarms_and_marks_needs_review(env):
    repo, fake, sess, eng, acct = env
    sess.add(rgt(R, ["sqs"], []))                                     # Monitoring tag gone: not listed any more
    sess.add(("sqs", R, "list_queues", {"QueueUrls": [SQS_URL]}))     # the queue still exists
    _tags_without_monitoring(sess)
    counts = eng.sync_account(acct.id, "TAG_RECONCILE")
    assert _row(repo).monitoring_state == "NEEDS_REVIEW" and counts["deleted"] == 0
    assert len(fake.cw(R).alarms) == 3 and "delete_alarms" not in fake.cw(R).writes()
