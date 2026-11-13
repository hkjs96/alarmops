"""OFFBOARD_ACCOUNT (D-43): only `ManagedBy=AlarmOps` alarms are deleted, everything is re-verified, nothing real is called."""

from __future__ import annotations

import json

import pytest

from alarm_engine.handler import InvalidCommand, handle_batch, parse
from alarm_engine.repository import OffboardingRow
from conftest import ACCOUNT_ID, ClientError, FakeCloudWatch, make_account

MINE = {"ManagedBy": "AlarmOps", "Severity": "SEV-3"}


def cmd(offboarding_id="ob_1", account="acc_1", customer="cus_1", **kw):
    body = {"schemaVersion": 1, "commandId": f"cmd_ob_{account}", "type": "OFFBOARD_ACCOUNT", "customerId": customer,
            "cloudAccountId": account, "requestedBy": {"type": "SYSTEM", "id": "offboarding"},
            "requestedAt": "2026-11-13T00:00:00Z", "payload": {"offboardingId": offboarding_id}, **kw}
    return {"messageId": f"m_{account}", "body": json.dumps(body)}


def terminated(repo, customer="cus_1", steps=None):
    repo.customer_status[customer] = "TERMINATED"
    repo.offboardings["ob_1"] = OffboardingRow("ob_1", customer, "TERMINATED", steps or {
        "PAGING_STOPPED": {"state": "DONE"}, "ALARMS_DELETED": {"state": "PENDING"},
        "CUSTOMER_STACK_REMOVED": {"state": "MANUAL"}, "ACCOUNTS_DISABLED": {"state": "MANUAL"},
        "BUS_ALLOWLIST_REMOVED": {"state": "MANUAL"}})


def seed_alarms(cw: FakeCloudWatch):
    cw.add_foreign_alarm("[EC2] web-1 CPU (TagName: i-0abc)", tags=MINE)
    cw.add_foreign_alarm("[EC2] web-2 CPU (TagName: i-0def)", tags=MINE)
    cw.add_foreign_alarm("customer-own-alarm", tags={"Team": "payments"})            # the customer's own: no ManagedBy
    cw.add_foreign_alarm("legacy-alarm", tags={"ManagedBy": "AlarmManager"})          # legacy tag: migration only
    cw.add_foreign_alarm("untagged")                                                  # no tags at all
    cw.add_foreign_alarm("looks-like-ours (TagName: i-0xyz)", tags={"ManagedBy": "SomeoneElse"})


def step(repo, key="ALARMS_DELETED"):
    return repo.offboardings["ob_1"].steps[key]


def test_deletes_only_alarms_tagged_managed_by_alarmops(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo)
    seed_alarms(sessions.cw("ap-northeast-2"))
    out = handle_batch(eng, {"Records": [cmd()]})
    assert out == {"batchItemFailures": []}
    left = set(sessions.cw("ap-northeast-2").alarms)
    assert left == {"customer-own-alarm", "legacy-alarm", "untagged", "looks-like-ours (TagName: i-0xyz)"}
    assert step(repo)["state"] == "DONE"
    assert step(repo)["accounts"]["acc_1"] == {"status": "OK", "deleted": 2, "failed": 0}
    # never an AWS write other than DeleteAlarms, and only with the verified names
    writes = [c for c in sessions.cw("ap-northeast-2").calls if c[0] in ("delete_alarms", "put_metric_alarm", "tag_resource", "untag_resource")]
    assert [w[0] for w in writes] == ["delete_alarms"]
    assert sorted(writes[0][1]["AlarmNames"]) == ["[EC2] web-1 CPU (TagName: i-0abc)", "[EC2] web-2 CPU (TagName: i-0def)"]
    # the other steps are not the engine's to touch
    assert step(repo, "CUSTOMER_STACK_REMOVED") == {"state": "MANUAL"}
    assert repo.offboardings["ob_1"].completed_at is None


def test_global_alarm_region_is_included_and_only_the_writer_role_is_used(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo)
    sessions.cw("ap-northeast-2").add_foreign_alarm("a-seoul", tags=MINE)
    sessions.cw("us-east-1").add_foreign_alarm("a-virginia", tags=MINE)
    handle_batch(eng, {"Records": [cmd()]})
    assert not sessions.cw("ap-northeast-2").alarms and not sessions.cw("us-east-1").alarms
    assert {(arn, region) for arn, _ext, region in sessions.assumed} == {
        (acc.alarm_writer_role_arn, "ap-northeast-2"), (acc.alarm_writer_role_arn, "us-east-1")}
    assert all(ext == "ext-123" for _arn, ext, _r in sessions.assumed)      # ExternalId on every AssumeRole (D-07)
    assert set(sessions.all_calls()) <= {"describe_alarms", "list_tags_for_resource", "delete_alarms"}


def test_alarm_in_another_account_or_region_is_never_deleted(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo)
    cw = sessions.cw("ap-northeast-2")
    cw.add_foreign_alarm("mine", tags=MINE)
    other_acct = "arn:aws:cloudwatch:ap-northeast-2:999999999999:alarm:other-acct"
    other_region = f"arn:aws:cloudwatch:eu-west-1:{ACCOUNT_ID}:alarm:other-region"
    for name, arn in (("other-acct", other_acct), ("other-region", other_region)):
        cw.alarms[name] = {"AlarmName": name, "AlarmArn": arn, "AlarmDescription": ""}
        cw.tags[arn] = dict(MINE)                                          # tagged as ours, but not in this account/region
    handle_batch(eng, {"Records": [cmd()]})
    assert set(cw.alarms) == {"other-acct", "other-region"}
    assert step(repo)["accounts"]["acc_1"]["skippedForeign"] == 2


def test_tag_is_checked_again_right_before_the_delete(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo)

    class Racy(FakeCloudWatch):
        """Between the listing and the delete somebody removes the ManagedBy tag from one alarm."""

        def describe_alarms(self, AlarmNames=None, NextToken=None, **kw):
            if AlarmNames is not None:
                self.tags[self.arn("changed-hands")] = {"Team": "payments"}
            return super().describe_alarms(AlarmNames=AlarmNames, NextToken=NextToken, **kw)

    cw = Racy(ACCOUNT_ID, "ap-northeast-2")
    sessions.cws[(ACCOUNT_ID, "ap-northeast-2")] = cw
    cw.add_foreign_alarm("changed-hands", tags=MINE)
    cw.add_foreign_alarm("still-ours", tags=MINE)
    handle_batch(eng, {"Records": [cmd()]})
    assert set(cw.alarms) == {"changed-hands"}
    assert step(repo)["accounts"]["acc_1"]["deleted"] == 1


def test_without_alarm_writer_nothing_is_called_and_the_step_is_manual(world):
    repo, sessions, _disc, eng, acc = world
    repo.accounts["acc_1"] = make_account(alarm_writer_enabled=False)
    terminated(repo)
    seed_alarms(sessions.cw("ap-northeast-2"))
    out = handle_batch(eng, {"Records": [cmd()]})
    assert out == {"batchItemFailures": []}
    assert sessions.assumed == [] and sessions.all_calls() == []
    assert len(sessions.cw("ap-northeast-2").alarms) == 6
    assert step(repo)["state"] == "MANUAL"
    assert step(repo)["accounts"]["acc_1"]["status"] == "CAPABILITY_DISABLED"
    assert "CAPABILITY_DISABLED" in step(repo)["detail"]


def test_no_alarm_writer_role_arn_is_the_same(world):
    repo, sessions, _disc, eng, acc = world
    repo.accounts["acc_1"] = make_account(alarm_writer_role_arn=None, alarm_writer_enabled=True)
    terminated(repo)
    handle_batch(eng, {"Records": [cmd()]})
    assert sessions.assumed == [] and step(repo)["state"] == "MANUAL"


def test_refuses_when_the_customer_is_not_terminated(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo)
    repo.customer_status["cus_1"] = "ACTIVE"               # e.g. a forged or stale command
    seed_alarms(sessions.cw("ap-northeast-2"))
    out = handle_batch(eng, {"Records": [cmd()]})
    assert out == {"batchItemFailures": []}
    assert sessions.assumed == [] and len(sessions.cw("ap-northeast-2").alarms) == 6
    assert step(repo) == {"state": "PENDING"}


def test_tenant_guards_are_poison_not_retried_and_call_nothing(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo)
    repo.accounts["acc_2"] = make_account(id="acc_2", customer_id="cus_2", aws_account_id="999988887777", external_id="e2")
    for bad in (
        cmd(customer="cus_2", account="acc_1"),                 # account of another customer
        cmd(customer="cus_2", account="acc_2"),                 # offboarding of another customer
        cmd(offboarding_id="ob_nope"),                          # unknown offboarding
        cmd(account="acc_nope"),                                # unknown account
    ):
        assert handle_batch(eng, {"Records": [bad]}) == {"batchItemFailures": []}
    assert sessions.assumed == [] and sessions.all_calls() == []
    assert step(repo) == {"state": "PENDING"}


@pytest.mark.parametrize("payload,account", [({}, "acc_1"), ({"offboardingId": ""}, "acc_1"), ({"offboardingId": 7}, "acc_1"),
                                             ({"offboardingId": "ob_1"}, None)])
def test_payload_validation(payload, account):
    body = {"schemaVersion": 1, "commandId": "c", "type": "OFFBOARD_ACCOUNT", "customerId": "cus_1", "payload": payload}
    if account:
        body["cloudAccountId"] = account
    with pytest.raises(InvalidCommand):
        parse(json.dumps(body))


def test_two_accounts_pending_until_both_are_done_and_manual_if_one_cannot(world):
    repo, sessions, _disc, eng, acc = world
    repo.accounts["acc_2"] = make_account(id="acc_2", aws_account_id="444455556666", external_id="e2",
                                          alarm_writer_role_arn="arn:aws:iam::444455556666:role/W")
    terminated(repo)
    sessions.cw("ap-northeast-2").add_foreign_alarm("a1", tags=MINE)
    sessions.cw("ap-northeast-2", "444455556666").add_foreign_alarm("a2", tags=MINE)
    handle_batch(eng, {"Records": [cmd(account="acc_1")]})
    assert step(repo)["state"] == "PENDING" and "1/2 accounts done" in step(repo)["detail"]
    handle_batch(eng, {"Records": [cmd(account="acc_2")]})
    assert step(repo)["state"] == "DONE" and step(repo)["detail"].startswith("2/2 accounts done, 2 alarms deleted")

    # a second customer account without AlarmWriter: the step needs a person, even though the other account is done
    repo2_steps = {"ALARMS_DELETED": {"state": "PENDING"}}
    terminated(repo, steps=repo2_steps)
    repo.accounts["acc_2"] = make_account(id="acc_2", aws_account_id="444455556666", external_id="e2", alarm_writer_enabled=False)
    handle_batch(eng, {"Records": [cmd(account="acc_1"), cmd(account="acc_2")]})
    assert step(repo)["state"] == "MANUAL" and "acc_2: CAPABILITY_DISABLED" in step(repo)["detail"]


def test_every_step_done_completes_the_offboarding(world):
    repo, sessions, _disc, eng, acc = world
    done = {k: {"state": "DONE"} for k in ("PAGING_STOPPED", "CUSTOMER_STACK_REMOVED", "ACCOUNTS_DISABLED", "BUS_ALLOWLIST_REMOVED")}
    terminated(repo, steps={**done, "ALARMS_DELETED": {"state": "PENDING"}})
    handle_batch(eng, {"Records": [cmd()]})
    assert repo.offboardings["ob_1"].completed_at is not None


def test_a_step_a_person_marked_done_is_not_overwritten(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo, steps={"ALARMS_DELETED": {"state": "DONE", "byUserId": "usr_1", "detail": "deleted by hand"}})
    repo.accounts["acc_1"] = make_account(alarm_writer_enabled=False)
    handle_batch(eng, {"Records": [cmd()]})
    assert step(repo) == {"state": "DONE", "byUserId": "usr_1", "detail": "deleted by hand"}


def test_failed_delete_is_recorded_retried_and_idempotent(world):
    repo, sessions, _disc, eng, acc = world
    terminated(repo)
    cw = sessions.cw("ap-northeast-2")
    cw.add_foreign_alarm("a1", tags=MINE)
    real = cw.delete_alarms
    cw.delete_alarms = lambda AlarmNames: (_ for _ in ()).throw(ClientError("Throttling"))   # type: ignore[method-assign]
    out = handle_batch(eng, {"Records": [cmd()]})
    assert out == {"batchItemFailures": [{"itemIdentifier": "m_acc_1"}]}      # SQS retries it
    assert step(repo)["state"] == "MANUAL" and step(repo)["accounts"]["acc_1"]["status"] == "FAILED"
    assert "ClientError" in step(repo)["accounts"]["acc_1"]["errors"][0] and "Throttling" not in json.dumps(step(repo))
    cw.delete_alarms = real                                                    # type: ignore[method-assign]
    assert handle_batch(eng, {"Records": [cmd()]}) == {"batchItemFailures": []}
    assert step(repo)["state"] == "DONE" and not cw.alarms
    assert handle_batch(eng, {"Records": [cmd()]}) == {"batchItemFailures": []}      # redelivery: nothing left, still OK
    assert step(repo)["state"] == "DONE"
