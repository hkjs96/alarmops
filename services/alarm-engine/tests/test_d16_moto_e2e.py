"""D-16 end to end on moto (real SQS / tagging API / CloudWatch semantics, no AWS): tag on -> sync -> untag."""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from alarm_engine import events
from alarm_engine.collectors import AwsDiscovery
from alarm_engine.collectors.groups import GROUP_OF
from alarm_engine.engine import Engine
from alarm_engine.repository import InMemoryRepository
from conftest import make_account

R = "ap-northeast-2"
MOTO_ACCOUNT = "123456789012"


class MotoSessions:
    def __init__(self) -> None:
        self.roles: list[str] = []

    def client(self, account, role, service, region):
        self.roles.append(role)
        return boto3.client(service, region_name=region)


def _event(name: str, url: str, keys: list[str]) -> dict:
    return {"version": "0", "id": "e", "detail-type": "AWS API Call via CloudTrail", "source": "aws.sqs",
            "account": MOTO_ACCOUNT, "region": R,
            "detail": {"eventName": name, "requestParameters": {"queueUrl": url, "tagKeys": keys}}}


@pytest.fixture
def world(monkeypatch):
    from datetime import timedelta
    monkeypatch.setattr(events, "RESOURCE_DEDUPE", timedelta(0))
    monkeypatch.setattr(events, "RECONCILE_DEBOUNCE", timedelta(0))
    with mock_aws():
        repo = InMemoryRepository()
        acct = make_account(aws_account_id=MOTO_ACCOUNT,
                            reader_role_arn=f"arn:aws:iam::{MOTO_ACCOUNT}:role/AlarmOpsReader",
                            alarm_writer_role_arn=f"arn:aws:iam::{MOTO_ACCOUNT}:role/AlarmOpsAlarmWriter",
                            regions=[R])
        repo.accounts[acct.id] = acct
        sess = MotoSessions()
        eng = Engine(repo, sess, AwsDiscovery(sess))
        sqs = boto3.client("sqs", region_name=R)
        url = sqs.create_queue(QueueName="alarmops-rehearsal-b7",
                               tags={"Monitoring": "on", "AlarmOpsRehearsal": "true"})["QueueUrl"]
        cw = boto3.client("cloudwatch", region_name=R)
        yield repo, eng, acct, sqs, url, cw


def _managed(cw) -> list[str]:
    return sorted(a["AlarmName"] for a in cw.describe_alarms()["MetricAlarms"])


def _state(repo) -> str:
    return next(iter(repo.resources.values())).monitoring_state


def test_untag_event_after_sync_keeps_alarms(world):
    repo, eng, acct, sqs, url, cw = world
    eng.sync_account(acct.id, "TAG_RECONCILE")
    before = _managed(cw)
    assert len(before) == 3
    sqs.untag_queue(QueueUrl=url, TagKeys=["Monitoring"])
    out = events.handle_tag_event(eng, _event("UntagQueue", url, ["Monitoring"]))
    assert out["status"] == "OK", out
    assert _state(repo) == "NEEDS_REVIEW" and _managed(cw) == before


@pytest.mark.parametrize("mode", ["TAG_RECONCILE", "DAILY", "ON_DEMAND"])
def test_untag_then_account_sync_keeps_alarms(world, mode):
    repo, eng, acct, sqs, url, cw = world
    eng.sync_account(acct.id, "TAG_RECONCILE")
    before = _managed(cw)
    sqs.untag_queue(QueueUrl=url, TagKeys=["Monitoring"])
    counts = eng.sync_account(acct.id, mode)
    assert counts["deleted"] == 0 and _state(repo) == "NEEDS_REVIEW" and _managed(cw) == before
    counts = eng.sync_account(acct.id, mode)           # and again, now from NEEDS_REVIEW
    assert counts["deleted"] == 0 and _state(repo) == "NEEDS_REVIEW" and _managed(cw) == before
