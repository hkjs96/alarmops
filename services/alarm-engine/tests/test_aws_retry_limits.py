"""Issue #88: retry/backoff on alarm list+write paths, "state unknown" never deletes, pagination, region alarm limit.

No real AWS: FakeCloudWatch with injected botocore ClientErrors; sleeps are recorded, not slept.
"""

from __future__ import annotations

import logging

import pytest
from botocore.exceptions import ClientError

from alarm_engine import naming, retry
from alarm_engine.aws import DEFAULT_ALARM_LIMIT, AlarmLimitExceeded, AlarmWriter, TaggingFailed, list_owned_alarms
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


# -- review follow-ups (#88) ---------------------------------------------------------------------------------------

LEAK_ARN = "arn:aws:cloudwatch:ap-northeast-2:999988887777:alarm:LEAK"
LEAK_MSG = f"boom {LEAK_ARN} account 999988887777"


def leaky(code: str = "AccessDenied") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": LEAK_MSG}}, "Op")


def assert_no_leak(text: str) -> None:
    assert "999988887777" not in text and "arn:aws" not in text and "LEAK" not in text


@pytest.mark.parametrize("raw", ["²", "0", "-5", "99999999999999999999", "100001", "abc", "١٢٣", "1.5", "  x "])
def test_alarm_limit_rejects_bad_values(raw, caplog):
    with caplog.at_level(logging.WARNING):
        assert alarm_limit_from_env({"ALARMOPS_ALARM_LIMIT": raw}) == 5000
    assert "ALARMOPS_ALARM_LIMIT" in caplog.text            # the reason is logged


@pytest.mark.parametrize(("raw", "want"), [(" 100 ", 100), ("1", 1), ("100000", 100000), ("   ", 5000), ("", 5000)])
def test_alarm_limit_accepts_range_and_trims(raw, want):
    assert alarm_limit_from_env({"ALARMOPS_ALARM_LIMIT": raw}) == want


def test_unknown_region_skips_resources_without_relisting(world, slept):
    repo, sessions, disc, eng, acc, cw = seeded(world)
    disc.resources = [ec2(), ec2("i-0def")]
    cw.calls.clear()
    inject(cw, "describe_alarms", "Throttling", None)
    counts = eng.sync_account(acc.id, "TAG_RECONCILE")
    assert counts["unknown"] >= 2 and counts["created"] == 0 and cw.writes() == []
    assert len(slept) == retry.MAX_ATTEMPTS - 1                 # one failed listing; nothing re-listed per resource
    assert list(repo.runs.values())[-1].status == "PARTIAL"


@pytest.mark.parametrize("code", ["ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId",
                                  "UnrecognizedClientException", "InvalidSignatureException", "OptInRequired"])
def test_credential_errors_are_unknown_state(slept, code):
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    state = inject(cw, "describe_alarms", code, None)
    with pytest.raises(AwsStateUnknown):
        list_owned_alarms(cw)
    assert state["n"] == 1 and slept == []                  # not retried


def test_scp_code_removed_and_limit_exceeded_is_not_retried(slept):
    assert "SCPDenied" not in retry.DENIED_CODES and "LimitExceededException" not in retry.THROTTLE_CODES
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    inject(cw, "describe_alarms", "LimitExceededException", None)
    with pytest.raises(ClientError):
        list_owned_alarms(cw)
    assert slept == []


def test_expired_credentials_do_not_leave_run_running(world):
    repo, sessions, disc, eng, acc = world

    class Expired:
        def client(self, *a, **k):
            raise err("ExpiredToken", "AssumeRole")

    eng.sessions = Expired()          # type: ignore[assignment]
    disc.resources = [ec2()]
    eng.sync_account(acc.id, "DAILY")
    runs = list(repo.runs.values())
    assert runs and all(r.status in ("FAILED", "PARTIAL") and r.finished_at for r in runs)
    assert sessions.cw(SEOUL).writes() == []


def test_skipped_delete_leaves_db_row_not_deleted(world, slept):
    repo, sessions, disc, eng, acc, cw = seeded(world)
    inject(cw, "describe_alarms", "AccessDenied", None)
    disc.resources, disc.alive_map = [], {"i-0abc": False}
    eng.sync_account(acc.id, "DAILY")
    row = next(r for r in repo.resources.values() if r.resource_key == "i-0abc")
    assert row.monitoring_state == "MONITORED"
    assert len(repo.list_managed_alarms("cus_1", row.id)) == 3


def test_page_cap_of_1000_raises_unknown():
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    n = {"i": 0}

    def endless(**kw):
        n["i"] += 1
        return {"MetricAlarms": [], "NextToken": f"t{n['i']}"}

    cw.describe_alarms = endless  # type: ignore[method-assign]
    with pytest.raises(AwsStateUnknown):
        list_owned_alarms(cw)
    assert n["i"] == 1000


@pytest.mark.parametrize("code", ["Throttling", "AccessDenied"])
def test_list_tags_step_unknown_state(slept, code):
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    cw.add_foreign_alarm("a", naming.build_description("EC2", "i-1", "CPUUtilization", "SEV-3", "n"),
                         tags={"ManagedBy": "AlarmOps"})
    inject(cw, "list_tags_for_resource", code, None)
    with pytest.raises(AwsStateUnknown):
        list_owned_alarms(cw)


def test_write_retry_after_executed_call_is_idempotent(world, slept):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    real = cw.put_metric_alarm
    state = {"n": 0}

    def executes_then_throttles(**kw):
        real(**kw)                    # the write really happened, the response was lost
        state["n"] += 1
        if state["n"] == 1:
            raise err("Throttling", "PutMetricAlarm")
        return {}

    cw.put_metric_alarm = executes_then_throttles  # type: ignore[method-assign]
    disc.resources = [ec2()]
    counts = eng.sync_account(acc.id, "DAILY")
    assert len(ours(cw)) == 3 and len(cw.alarms) == 3 and counts["errors"] == 0
    cw.put_metric_alarm = real  # type: ignore[method-assign]
    assert eng.sync_account(acc.id, "TAG_RECONCILE")["created"] == 0


# leak assertions (the five sites)

def _writer_with(cw):
    return AlarmWriter(cw, ACCOUNT_ID, region=SEOUL)


def test_leak_arn_check_in_arn_helper():                       # aws.py _arn
    cw = FakeCloudWatch("999988887777", SEOUL)
    cw.add_foreign_alarm("x")
    with pytest.raises(TaggingFailed) as ei:
        _writer_with(cw)._arn("x")
    assert_no_leak(str(ei.value))


def test_leak_arn_check_in_existing():                         # aws.py _existing
    cw = FakeCloudWatch("999988887777", SEOUL)
    cw.add_foreign_alarm("x")
    with pytest.raises(TaggingFailed) as ei:
        _writer_with(cw)._existing("x")
    assert_no_leak(str(ei.value))


def test_leak_tag_resource_failure_message():                  # aws.py _tag
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)

    def boom(**kw):
        raise leaky()

    cw.tag_resource = boom  # type: ignore[method-assign]
    with pytest.raises(AwsStateUnknown) as e1:                 # AccessDenied: state unknown, code only
        _writer_with(cw)._tag("x", [{"Key": "Severity", "Value": "SEV-3"}])
    assert_no_leak(str(e1.value))

    def boom2(**kw):
        raise RuntimeError(LEAK_MSG)

    cw.tag_resource = boom2  # type: ignore[method-assign]
    with pytest.raises(TaggingFailed) as e2:
        _writer_with(cw)._tag("x", [{"Key": "Severity", "Value": "SEV-3"}])
    assert_no_leak(str(e2.value))


def test_leak_engine_apply_failure_logs_and_errors(world, caplog, slept):
    repo, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)

    def boom(**kw):
        raise RuntimeError(LEAK_MSG)

    cw.put_metric_alarm = boom  # type: ignore[method-assign]
    disc.resources = [ec2()]
    with caplog.at_level(logging.DEBUG):
        eng.sync_account(acc.id, "DAILY")
    run = next(iter(repo.runs.values()))
    assert_no_leak(caplog.text + repr(run.counts) + str(run.error))
    row = next(iter(repo.resources.values()))
    res = eng.sync_resource(acc, row)
    assert res.errors and all(("RuntimeError" in x) for x in res.errors)
    assert_no_leak(" ".join(res.errors))


def test_leak_discovery_collector_and_read_tags(caplog):
    from alarm_engine.collectors import AwsDiscovery
    from alarm_engine.collectors.groups import GROUP_OF
    from alarm_engine.repository import ResourceRow
    from aws_stubs import REGION as R
    from aws_stubs import StubSessions

    sess = StubSessions()
    stub = sess._get("resourcegroupstaggingapi", R)[1]
    stub.add_client_error("get_resources", "AccessDenied", LEAK_MSG, 400)       # SQS collector
    stub.add_client_error("get_resources", "AccessDenied", LEAK_MSG, 400)       # SNS collector
    stub.add_client_error("get_resources", "AccessDenied", LEAK_MSG, 400)       # read_tags
    disc = AwsDiscovery(sess, (GROUP_OF["SQS"], GROUP_OF["SNS"]))
    from conftest import make_account
    acct = make_account(regions=(R,))
    with caplog.at_level(logging.DEBUG):
        try:
            disc.list_monitored(acct, R)
        except Exception as e:  # noqa: BLE001
            assert_no_leak(str(e))
        row = ResourceRow("r1", acct.customer_id, acct.id, R, "SQS", "arn:aws:sqs:x:1:q", "q")
        assert disc.read_tags(acct, row) is None
    assert "collector" in caplog.text and "read_tags" in caplog.text
    assert_no_leak(caplog.text)


def test_boto3_clients_use_single_retry_layer():
    from alarm_engine.aws import CloudAccount, StsSessionFactory

    class Sts:
        def assume_role(self, **kw):
            return {"Credentials": {"AccessKeyId": "a", "SecretAccessKey": "b", "SessionToken": "c"}}

    acc = CloudAccount("a", "c", ACCOUNT_ID, "ext", "arn:aws:iam::1:role/r")
    client = StsSessionFactory(Sts()).client(acc, "reader", "cloudwatch", SEOUL)
    r = client.meta.config.retries
    assert r["total_max_attempts"] == 1          # botocore: total attempts, i.e. no botocore-level retry
