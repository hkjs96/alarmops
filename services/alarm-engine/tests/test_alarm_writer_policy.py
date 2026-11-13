"""AlarmWriter IAM policy alignment (D-43, infra/customer-stack/template.yaml). FakeCloudWatch enforces the policy:
create needs request tag ManagedBy=AlarmOps, changes need resource tag ManagedBy=AlarmOps, tag/untag may not name
ManagedBy. Nothing calls AWS."""

from __future__ import annotations

import pytest

from alarm_engine import naming
from alarm_engine.aws import AlarmWriter, ForbiddenTagKey, NotOwned, assert_no_protected_tag_keys
from alarm_engine.thresholds import LayerValues
from conftest import ACCOUNT_ID, FakeCloudWatch, ec2
from test_engine_regressions import SEOUL, first_sync

CPU_NAME = "[EC2] web-1 CPUUtilization (TagName: i-0abc)"


def test_create_sends_tags_in_one_put_and_never_tag_resource(world):
    _, cw = first_sync(world)
    puts = [kw for c, kw in cw.calls if c == "put_metric_alarm"]
    assert len(puts) == 3
    for kw in puts:
        tags = {t["Key"]: t["Value"] for t in kw["Tags"]}
        assert tags["ManagedBy"] == "AlarmOps" and tags["Severity"]
    assert "tag_resource" not in cw.writes()
    assert all(cw.tags[a["AlarmArn"]]["ManagedBy"] == "AlarmOps" for a in cw.alarms.values())
    # existence was checked before the creates
    assert [c for c, _ in cw.calls].count("describe_alarms") >= 3


def test_owned_update_has_no_tags_param_and_tag_resource_without_managedby(world):
    repo, _, _, eng, acc = world
    _, cw = first_sync(world)
    cw.calls.clear()
    repo.defaults[("MSP", None, "EC2", "CPUUtilization")] = LayerValues(threshold=55.0)
    counts = eng.sync_account(acc.id, "DAILY")
    assert counts["updated"] == 1 and counts["errors"] == 0
    puts = [kw for c, kw in cw.calls if c == "put_metric_alarm"]
    assert len(puts) == 1 and "Tags" not in puts[0] and puts[0]["Threshold"] == 55.0
    tag_calls = [kw for c, kw in cw.calls if c == "tag_resource"]
    assert tag_calls
    for kw in tag_calls:
        assert "ManagedBy" not in {t["Key"] for t in kw["Tags"]}
    assert cw.tags[cw.arn(CPU_NAME)]["ManagedBy"] == "AlarmOps"


def test_foreign_same_name_alarm_is_not_touched_and_recorded(world):
    _, sessions, disc, eng, acc = world
    cw = sessions.cw(SEOUL)
    cw.add_foreign_alarm(CPU_NAME, description="customer's own", tags={"Team": "payments"})
    before = dict(cw.alarms[CPU_NAME])
    disc.resources = [ec2()]
    counts = eng.sync_account(acc.id, "DAILY")
    assert cw.alarms[CPU_NAME] == before                       # not overwritten
    assert cw.tags[cw.arn(CPU_NAME)] == {"Team": "payments"}   # not tagged
    assert not any(c in ("delete_alarms", "tag_resource", "untag_resource") for c, _ in cw.calls)
    assert not any(c == "put_metric_alarm" and kw["AlarmName"] == CPU_NAME for c, kw in cw.calls)
    assert counts["nameCollisions"] == 1 and counts["errors"] == 1
    assert len([1 for c, kw in cw.calls if c == "put_metric_alarm"]) == 2   # the other two are still created


@pytest.mark.parametrize("tags", [None, {"ManagedBy": "AlarmManager"}, {"ManagedBy": "SomeoneElse"}])
def test_writer_put_raises_not_owned(world, monkeypatch, tags):
    seen = []
    orig = AlarmWriter.put

    def spy(self, d, **kw):
        seen.append(d)
        return orig(self, d, **kw)

    monkeypatch.setattr(AlarmWriter, "put", spy)
    _, cw = first_sync(world)
    cw.add_foreign_alarm("customer-alarm", tags=tags)
    cw.calls.clear()
    with pytest.raises(NotOwned) as ei:
        orig(AlarmWriter(cw, ACCOUNT_ID), seen[0], name="customer-alarm", severity="SEV-3")
    assert ei.value.alarm_name == "customer-alarm"
    assert cw.writes() == []


def test_guard_rejects_managedby_in_tag_and_untag():
    assert_no_protected_tag_keys(["Severity", "AlarmOps:Console:Threshold"])
    with pytest.raises(ForbiddenTagKey):
        assert_no_protected_tag_keys(["ManagedBy"])
    cw = FakeCloudWatch(ACCOUNT_ID, SEOUL)
    w = AlarmWriter(cw, ACCOUNT_ID)
    with pytest.raises(ForbiddenTagKey):
        w.untag(cw.arn("x"), ["ManagedBy"])
    with pytest.raises(ForbiddenTagKey):
        w._tag(cw.arn("x"), [{"Key": "ManagedBy", "Value": "AlarmOps"}])
    assert cw.calls == []


def test_naming_managed_by_value_matches_iam_policy():
    assert naming.MANAGED_BY == "AlarmOps"   # template.yaml aws:RequestTag/ManagedBy, aws:ResourceTag/ManagedBy
