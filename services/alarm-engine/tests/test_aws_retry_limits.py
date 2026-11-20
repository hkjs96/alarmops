"""Issue #88: retry/backoff on alarm list+write paths, "state unknown" never deletes, pagination, region alarm limit.

No real AWS: FakeCloudWatch with injected botocore ClientErrors; sleeps are recorded, not slept.
"""

from __future__ import annotations

import logging

import pytest
from botocore.exceptions import ClientError

from alarm_engine import naming, retry
from alarm_engine.aws import DEFAULT_ALARM_LIMIT, AlarmLimitExceeded, AlarmWriter, list_owned_alarms
from alarm_engine.retry import AwsStateUnknown
from alarm_engine.wiring import alarm_limit_from_env
from conftest import ACCOUNT_ID, FakeCloudWatch, ec2

SEOUL = "ap-northeast-2"


def err(code: str, op: str = "Op") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "SECRET-DETAIL arn:aws:iam::999:role/x"}}, op)


@pytest.fixture
def slept(monkeypatch):
    out: list[float] = []
    monkeypatch.setattr(retry, "_sleep", out.append)
    return out


def inject(cw, method: str, code: str, times: int | None):
    """Make cw.<method> raise `code` `times` times (None = always), then behave normally."""
    real = getattr(cw, method)
    state = {"n": 0}

    def wrapper(*a, **kw):
        if times is None or state["n"] < times:
            state["n"] += 1
            raise err(code, method)
        return real(*a, **kw)

    setattr(cw, method, wrapper)
    return state


def ours(cw):
    return {n for n, a in cw.alarms.items() if cw.tags.get(a["AlarmArn"], {}).get("ManagedBy") == "AlarmOps"}


def seeded(world):
    repo, sessions, disc, eng, acc = world
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "DAILY")
    return repo, sessions, disc, eng, acc, sessions.cw(SEOUL)


# -- retry ---------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("method", ["describe_alarms", "put_metric_alarm"])
def test_throttle_then_success(world, slept, method):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    state = inject(cw, method, "Throttling", 2)
    disc.resources = [ec2()]
    counts = eng.sync_account(acc.id, "DAILY")
    assert state["n"] == 2 and len(slept) >= 2 and all(0 < s <= 8 for s in slept)
    assert counts["created"] == 3 and counts["errors"] == 0 and len(ours(cw)) == 3


def test_persistent_throttle_is_bounded_and_logs_code_only(slept, caplog):
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    inject(cw, "describe_alarms", "TooManyRequestsException", None)
    with caplog.at_level(logging.DEBUG), pytest.raises(AwsStateUnknown) as ei:
        list_owned_alarms(cw)
    assert ei.value.code == "TooManyRequestsException"
    assert len(slept) == retry.MAX_ATTEMPTS - 1
    assert "SECRET-DETAIL" not in caplog.text and "SECRET-DETAIL" not in str(ei.value)


def test_non_throttle_error_not_retried_and_propagates(slept):
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    inject(cw, "describe_alarms", "ValidationError", None)
    with pytest.raises(ClientError):
        list_owned_alarms(cw)
    assert slept == []


# -- state unknown never deletes (4-9) -----------------------------------------------------------------------------

@pytest.mark.parametrize("code", ["Throttling", "RequestLimitExceeded", "AccessDenied"])
def test_gone_resource_with_unknown_alarm_list_deletes_nothing(world, slept, code):
    repo, sessions, disc, eng, acc, cw = seeded(world)
    before = ours(cw)
    assert len(before) == 3
    inject(cw, "describe_alarms", code, None)
    disc.resources, disc.alive_map = [], {"i-0abc": False}
    counts = eng.sync_account(acc.id, "DAILY")
    assert ours(cw) == before and "delete_alarms" not in cw.writes()
    assert counts.get("unknown", 0) >= 1 and counts["deleted"] == 0


@pytest.mark.parametrize("code", ["Throttling", "AccessDenied"])
def test_orphan_cleanup_with_unknown_list_deletes_nothing(world, slept, code):
    repo, sessions, disc, eng, acc, cw = seeded(world)
    before = ours(cw)
    repo.resources.clear()
    inject(cw, "describe_alarms", code, None)
    disc.resources, disc.alive_map = [], {"i-0abc": False}
    counts = eng.sync_account(acc.id, "DAILY")
    assert ours(cw) == before and counts["deleted"] == 0


def test_access_denied_on_delete_call_leaves_alarm(world, slept):
    repo, sessions, disc, eng, acc, cw = seeded(world)
    before = ours(cw)
    inject(cw, "delete_alarms", "AccessDenied", None)
    disc.resources, disc.alive_map = [], {"i-0abc": False}
    counts = eng.sync_account(acc.id, "DAILY")
    assert ours(cw) == before and counts["deleted"] == 0 and counts.get("unknown", 0) >= 1


def test_unknown_alarm_list_does_not_recreate_existing_alarms(world, slept):
    repo, sessions, disc, eng, acc, cw = seeded(world)
    cw.calls.clear()
    inject(cw, "describe_alarms", "Throttling", None)
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    assert cw.writes() == [] and counts["created"] == 0 and counts["deleted"] == 0


# -- pagination (4-7, 9-1) -----------------------------------------------------------------------------------------

def test_list_owned_alarms_follows_every_page():
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL, page_size=2)
    for i in range(7):
        desc = naming.build_description("EC2", f"i-{i}", "CPUUtilization", "SEV-3", "n")
        cw.add_foreign_alarm(f"a{i}", desc, tags={"ManagedBy": "AlarmOps"})
    out = list_owned_alarms(cw)
    assert sorted(out) == [f"i-{i}" for i in range(7)]
    assert sum(1 for c, _ in cw.calls if c == "describe_alarms") == 4


def test_repeating_page_token_is_not_treated_as_complete():
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    cw.describe_alarms = lambda **kw: {"MetricAlarms": [], "NextToken": "same"}  # type: ignore[method-assign]
    with pytest.raises(AwsStateUnknown):
        list_owned_alarms(cw)


def test_throttle_on_second_page_retries_that_page_only(slept):
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL, page_size=1)
    for i in range(3):
        cw.add_foreign_alarm(f"a{i}", naming.build_description("EC2", f"i-{i}", "CPUUtilization", "SEV-3", "n"),
                             tags={"ManagedBy": "AlarmOps"})
    real = cw.describe_alarms
    state = {"hit": False}

    def flaky(**kw):
        if kw.get("NextToken") == "1" and not state["hit"]:
            state["hit"] = True
            raise err("Throttling")
        return real(**kw)

    cw.describe_alarms = flaky  # type: ignore[method-assign]
    assert len(list_owned_alarms(cw)) == 3 and len(slept) == 1


# -- region alarm limit --------------------------------------------------------------------------------------------

def test_default_limit_is_5000_and_configurable():
    assert DEFAULT_ALARM_LIMIT == 5000
    assert alarm_limit_from_env({}) == 5000
    assert alarm_limit_from_env({"ALARMOPS_ALARM_LIMIT": "100"}) == 100
    assert alarm_limit_from_env({"ALARMOPS_ALARM_LIMIT": "bogus"}) == 5000


def test_create_over_limit_creates_nothing_and_records_error(world, caplog):
    repo, sessions, disc, eng, acc = world
    eng.alarm_limit = 2
    cw = sessions.cw(SEOUL)
    disc.resources = [ec2()]
    with caplog.at_level(logging.ERROR):
        counts = eng.sync_account(acc.id, "DAILY")
    assert len(ours(cw)) == 2               # the third of three creates is refused
    assert counts["errors"] == 1
    assert "alarm limit" in caplog.text


def test_existing_alarms_count_toward_limit():
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    for i in range(3):
        cw.add_foreign_alarm(f"customer-{i}")          # not ours, still counts against the quota
    with pytest.raises(AlarmLimitExceeded) as ei:
        AlarmWriter(cw, ACCOUNT_ID, region=SEOUL, alarm_limit=3)._check_limit()
    assert (ei.value.count, ei.value.limit) == (3, 3)
    AlarmWriter(cw, ACCOUNT_ID, region=SEOUL, alarm_limit=4)._check_limit()   # 3 + 1 <= 4


def test_update_of_existing_alarm_is_allowed_at_limit(world):
    repo, sessions, disc, eng, acc, cw = seeded(world)
    eng.alarm_limit = len(cw.alarms)         # exactly full
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    assert counts["errors"] == 0
