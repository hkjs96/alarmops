"""Tests for infra/scripts/rehearsal/replica-check.sh (#159): measures AlarmWriter's real tag conditions with a
temporary copy of the role. Uses the fake aws only (fake_aws.py models IAM/STS/CloudWatch with state); nothing here
can reach a real account.

Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import copy
import json
import re
import unittest
from pathlib import Path

import fake_aws
from rehearsal_support import ACCT, PROFILE, REPO, Sandbox, mode
from test_rehearsal_harness import Base

SCRIPT = "replica-check.sh"
ORIG = "AlarmOps-AlarmWriter"
POLICY_NAME = "manage-alarmops-alarms"
REPLICA = fake_aws.REPLICA_NAME
TEST_ALARM = "AlarmOpsRehearsal-replica-test"
UNMANAGED = "AlarmOpsRehearsal-replica-unmanaged"
SSO_ROLE = "AWSReservedSSO_AdminAccess_0123456789abcdef"
SSO_ARN = f"arn:aws:sts::{ACCT}:assumed-role/{SSO_ROLE}/someone"
BOUNDARY = f"arn:aws:iam::{ACCT}:policy/org-boundary"
CRED_VALUES = (fake_aws.REPLICA_KEY, fake_aws.REPLICA_SECRET, fake_aws.REPLICA_TOKEN)

ALARM_RES = f"arn:aws:cloudwatch:*:{ACCT}:alarm:*"
# Hand copy of AlarmWriterRole's inline policy in infra/customer-stack/template.yaml (test_sids_match_template guards drift).
POLICY = {"Version": "2012-10-17", "Statement": [
    {"Sid": "ReadAlarms", "Effect": "Allow", "Action": ["cloudwatch:DescribeAlarms"], "Resource": "*"},
    {"Sid": "ReadAlarmTags", "Effect": "Allow", "Action": ["cloudwatch:ListTagsForResource"], "Resource": ALARM_RES},
    {"Sid": "CreateAlarmWithManagedByTag", "Effect": "Allow", "Action": ["cloudwatch:PutMetricAlarm"],
     "Resource": ALARM_RES, "Condition": {"StringEquals": {"aws:RequestTag/ManagedBy": "AlarmOps"}}},
    {"Sid": "ChangeOwnAlarms", "Effect": "Allow",
     "Action": ["cloudwatch:PutMetricAlarm", "cloudwatch:TagResource", "cloudwatch:UntagResource",
                "cloudwatch:DeleteAlarms"],
     "Resource": ALARM_RES, "Condition": {"StringEquals": {"aws:ResourceTag/ManagedBy": "AlarmOps"}}},
    {"Sid": "DenyManagedByTagEdits", "Effect": "Deny", "Action": ["cloudwatch:TagResource", "cloudwatch:UntagResource"],
     "Resource": "*", "Condition": {"ForAnyValue:StringEquals": {"aws:TagKeys": ["ManagedBy"]}}},
]}
# Wrong: PutMetricAlarm allowed without any tag condition.
WRONG_POLICY = copy.deepcopy(POLICY)
WRONG_POLICY["Statement"][2].pop("Condition")


def roles(policy=POLICY, boundary=None, extra=None):
    r = {ORIG: {"boundary": boundary, "policies": {POLICY_NAME: policy} if policy is not None else {}, "tags": {}}}
    r.update(extra or {})
    return r


class ReplicaBase(Base):
    ENV = {"REHEARSAL_ASSUME_RETRIES": "3", "REHEARSAL_ASSUME_INTERVAL": "0"}

    def scenario(self, policy=POLICY, boundary=None, caller=SSO_ARN, **extra):
        extra.setdefault("iam_roles", roles(policy, boundary))
        self.sb.set_scenario(caller_arn=caller, **extra)

    def go(self, confirm=ACCT, extra_args=(), profile=PROFILE):
        args = ["--profile", profile] + (["--confirm-account", confirm] if confirm is not None else []) + list(extra_args)
        return self.sb.run(SCRIPT, args, extra_env=self.ENV)

    def state(self):
        p = Path(str(self.sb.calls_file) + ".state")
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def ops(self, calls=None):
        return [f'{c["service"]} {c["op"]}' for c in (self.sb.calls() if calls is None else calls)]

    def row(self, res, tag):
        rows = [l for l in res.out.splitlines() if l.startswith("|") and f"({tag})" in l]
        self.assertEqual(len(rows), 1, f"row ({tag}) in:\n{res.out}")
        return rows[0]

    def verdicts(self, res):
        return {t: ("PASS" if "PASS" in self.row(res, t) else "FAIL" if "FAIL" in self.row(res, t) else "?")
                for t in "abcde"}

    def assertCleanedUp(self):
        st = self.state()
        self.assertIsNotNone(st)
        self.assertNotIn(REPLICA, st["roles"], "replica role must be gone")
        self.assertNotIn(TEST_ALARM, st["alarms"])
        self.assertNotIn(UNMANAGED, st["alarms"])


class AllPass(ReplicaBase):
    def test_all_pass(self):
        self.scenario()
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        self.assertIn("| 항목 | 결과 | 비고 |", res.out)
        self.assertEqual(self.verdicts(res), dict.fromkeys("abcde", "PASS"), res.out)
        self.assertCleanedUp()
        self.assertAllScoped([c for c in self.sb.calls() if not c["as_replica"]])

    def test_copy_is_exact_and_trust_is_scoped(self):
        self.scenario(boundary=BOUNDARY)
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        calls = self.sb.calls()
        create = [c for c in calls if c["op"] == "create-role"]
        self.assertEqual(len(create), 1)
        argv = create[0]["argv"]
        self.assertIn(REPLICA, argv)
        self.assertIn(BOUNDARY, argv[argv.index("--permissions-boundary") + 1])
        self.assertIn("Key=AlarmOpsRehearsal,Value=true", argv)
        trust = json.loads(next(iter(create[0]["files"].values())))
        st = trust["Statement"][0]
        self.assertEqual(st["Principal"], {"AWS": f"arn:aws:iam::{ACCT}:root"})
        self.assertEqual(st["Condition"], {"ArnLike": {
            "aws:PrincipalArn": f"arn:aws:iam::{ACCT}:role/aws-reserved/sso.amazonaws.com/*{SSO_ROLE}"}})
        put = [c for c in calls if c["op"] == "put-role-policy"]
        self.assertEqual(len(put), 1)
        self.assertEqual(json.loads(next(iter(put[0]["files"].values()))), POLICY)
        self.assertEqual(option(put[0]["argv"], "--policy-name"), POLICY_NAME)

    def test_no_boundary_flag_without_original_boundary(self):
        self.scenario()
        self.go()
        create = [c for c in self.sb.calls() if c["op"] == "create-role"][0]
        self.assertNotIn("--permissions-boundary", create["argv"])

    def test_managed_alarm_tag_checked_with_own_credentials(self):
        self.scenario()
        self.go()
        calls = self.sb.calls()
        tags = [c for c in calls if c["op"] == "list-tags-for-resource" and not c["as_replica"]]
        self.assertTrue(any(TEST_ALARM in " ".join(c["argv"]) for c in tags), self.ops(calls))
        unmanaged = [c for c in calls if c["op"] == "put-metric-alarm" and UNMANAGED in c["argv"]]
        self.assertEqual(len(unmanaged), 1)
        self.assertFalse(unmanaged[0]["as_replica"], "the unmanaged alarm is created with the person's own credentials")
        self.assertNotIn("--tags", unmanaged[0]["argv"])

    def test_log_is_written_with_mode_600(self):
        self.scenario()
        self.go()
        logs = self.sb.log_files()
        self.assertTrue(logs)
        for p in logs:
            self.assertEqual(mode(p), 0o600)
        self.assertIn("(a)", self.sb.log_text())

    def test_assume_retries_for_propagation(self):
        self.scenario(assume_fail_first=2)
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        self.assertEqual(len([c for c in self.sb.calls() if c["op"] == "assume-role"]), 3)

    def test_crlf_credentials_work(self):
        self.scenario(assume_crlf=True)
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        self.assertEqual(self.verdicts(res), dict.fromkeys("abcde", "PASS"), res.out)

    def test_replica_calls_use_env_credentials_only(self):
        self.scenario()
        self.go()
        replica = [c for c in self.sb.calls() if c["as_replica"]]
        self.assertGreaterEqual(len(replica), 5)
        for c in replica:
            self.assertNotIn("--profile", c["argv"], c["argv"])
            self.assertFalse(c["env_profile"], "AWS_PROFILE must not be set for replica calls")
            self.assertIn("--region", c["argv"])
        for c in self.sb.calls():
            if not c["as_replica"]:
                self.assertIn("--profile", c["argv"])


class Failures(ReplicaBase):
    def test_policy_allowing_untagged_create_fails(self):
        self.scenario(policy=WRONG_POLICY)
        res = self.go()
        self.assertNotEqual(res.code, 0, res.text)
        self.assertEqual(self.verdicts(res)["a"], "FAIL", res.out)
        self.assertCleanedUp()

    def test_cleanup_runs_on_failing_check(self):
        self.scenario(policy=WRONG_POLICY)
        self.go()
        ops = self.ops()
        self.assertIn("iam delete-role-policy", ops)
        self.assertIn("iam delete-role", ops)
        dels = [c for c in self.sb.calls() if c["op"] == "delete-alarms" and not c["as_replica"]]
        names = {n for c in dels for n in alarm_names_of(c)}
        self.assertEqual(names, {TEST_ALARM, UNMANAGED})

    def test_cleanup_runs_when_assume_role_fails(self):
        self.scenario(assume_fail_first=99)
        res = self.go()
        self.assertNotEqual(res.code, 0, res.text)
        self.assertCleanedUp()
        self.assertEqual([c for c in self.sb.calls() if c["as_replica"]], [])
        self.assertEqual(len([c for c in self.sb.calls() if c["op"] == "assume-role"]), 3, "bounded retries")

    def test_cleanup_order(self):
        self.scenario()
        self.go()
        ops = self.ops([c for c in self.sb.calls() if not c["as_replica"]])
        i = ops.index("cloudwatch delete-alarms")
        self.assertLess(ops.index("iam delete-role-policy"), ops.index("iam delete-role"))
        self.assertLess(i, ops.index("iam delete-role"))

    def test_cleanup_failure_is_reported_not_masking(self):
        self.scenario(policy=WRONG_POLICY, fail_ops=["iam delete-role"])
        res = self.go()
        self.assertNotEqual(res.code, 0)
        self.assertEqual(self.verdicts(res)["a"], "FAIL")
        self.assertIn("--cleanup-only", res.text)

    def test_no_credentials_in_any_output(self):
        # leak: the fake echoes this string on stderr of non-sts calls; fail_ops makes the script print aws errors.
        self.scenario(leak=fake_aws.REPLICA_TOKEN, fail_ops=["iam delete-role"], assume_crlf=True)
        res = self.go()
        self.assertTrue(res.out + res.err)
        blobs = {"stdout": res.out, "stderr": res.err, "log": self.sb.log_text()}
        for where, text in blobs.items():
            for v in CRED_VALUES:
                self.assertNotIn(v, text, f"credential value in {where}")
            self.assertNotRegex(text, r"ASIA[A-Z0-9]{12,}", where)

    def test_no_credentials_on_success(self):
        self.scenario(assume_crlf=True)
        res = self.go()
        for text in (res.out, res.err, self.sb.log_text()):
            for v in CRED_VALUES:
                self.assertNotIn(v, text)

    def test_prepare_failure_for_unmanaged_alarm_fails_c_and_d(self):
        self.scenario(fail_ops=["cloudwatch put-metric-alarm"])
        res = self.go()
        self.assertNotEqual(res.code, 0)
        v = self.verdicts(res)
        self.assertEqual((v["c"], v["d"]), ("FAIL", "FAIL"))
        self.assertCleanedUp()


class Refusals(ReplicaBase):
    def assertNoWrites(self, res):
        self.assertNotEqual(res.code, 0, res.text)
        self.assertEqual(self.sb.writes(), [], self.ops())

    def test_wrong_confirm_account_refuses_before_any_write(self):
        self.scenario()
        res = self.go(confirm="555555555555")
        self.assertNoWrites(res)
        self.assertEqual([o for o in self.ops() if o != "sts get-caller-identity"], [])

    def test_missing_confirm_refuses(self):
        self.scenario()
        self.assertNoWrites(self.go(confirm=None))

    def test_bad_profile_refuses(self):
        self.scenario()
        res = self.go(profile="dev")
        self.assertNoWrites(res)
        self.assertEqual(self.sb.calls(), [])

    def test_existing_replica_role_refuses_and_is_untouched(self):
        self.scenario(iam_roles=roles(extra={REPLICA: {"boundary": None, "policies": {POLICY_NAME: POLICY},
                                                       "tags": {"AlarmOpsRehearsal": "true"}}}))
        res = self.go()
        self.assertNoWrites(res)
        self.assertIn("--cleanup-only", res.text)
        self.assertIn(REPLICA, self.state()["roles"] if self.state() else {REPLICA: 1})

    def test_not_sso_caller_refuses_and_explains(self):
        self.scenario(caller=f"arn:aws:sts::{ACCT}:assumed-role/PlainAdmin/someone")
        res = self.go()
        self.assertNoWrites(res)
        self.assertIn("SSO", res.text)

    def test_iam_user_caller_refuses(self):
        self.scenario(caller=f"arn:aws:iam::{ACCT}:user/bob")
        self.assertNoWrites(self.go())

    def test_missing_original_role_refuses(self):
        self.scenario(iam_roles={})
        self.assertNoWrites(self.go())

    def test_missing_original_policy_refuses(self):
        self.scenario(policy=None)
        res = self.go()
        self.assertNoWrites(res)
        self.assertNotIn("iam create-role", self.ops())


class CleanupOnly(ReplicaBase):
    def existing(self, tags=None):
        return {REPLICA: {"boundary": None, "policies": {POLICY_NAME: POLICY},
                          "tags": {"AlarmOpsRehearsal": "true"} if tags is None else tags}}

    def test_cleanup_only_removes_leftovers(self):
        self.scenario(iam_roles=roles(extra=self.existing()))
        res = self.go(extra_args=["--cleanup-only"])
        self.assertEqual(res.code, 0, res.text)
        self.assertNotIn(REPLICA, self.state()["roles"])
        self.assertIn(ORIG, self.state()["roles"], "the original role must never be touched")
        names = {n for c in self.sb.calls() if c["op"] == "delete-alarms" for n in alarm_names_of(c)}
        self.assertEqual(names, {TEST_ALARM, UNMANAGED})
        for forbidden in ("create-role", "put-role-policy", "assume-role", "put-metric-alarm"):
            self.assertNotIn(forbidden, [c["op"] for c in self.sb.calls()])

    def test_cleanup_only_when_nothing_left_succeeds(self):
        self.scenario()
        res = self.go(extra_args=["--cleanup-only"])
        self.assertEqual(res.code, 0, res.text)
        self.assertNotIn("iam delete-role", self.ops())

    def test_cleanup_only_will_not_delete_untagged_role(self):
        self.scenario(iam_roles=roles(extra=self.existing(tags={})))
        res = self.go(extra_args=["--cleanup-only"])
        self.assertNotEqual(res.code, 0, res.text)
        self.assertIn(REPLICA, self.state()["roles"])

    def test_cleanup_only_wrong_confirm_refuses_before_write(self):
        self.scenario(iam_roles=roles(extra=self.existing()))
        res = self.go(confirm="555555555555", extra_args=["--cleanup-only"])
        self.assertNotEqual(res.code, 0)
        self.assertEqual(self.sb.writes(), [])


class Docs(unittest.TestCase):
    def test_sids_match_template(self):
        text = (REPO / "infra" / "customer-stack" / "template.yaml").read_text(encoding="utf-8")
        block = text.split("  AlarmWriterRole:", 1)[1].split("# ----", 1)[0]
        sids = re.findall(r"Sid: (\w+)", block)
        self.assertEqual(sids, [s["Sid"] for s in POLICY["Statement"]])

    def test_go_live_and_readme_mention_script(self):
        for rel in ("docs/GO-LIVE.md", "infra/scripts/rehearsal/README.md", "infra/test/REHEARSAL-CONTRACT.md"):
            self.assertIn("replica-check.sh", (REPO / rel).read_text(encoding="utf-8"), rel)


def option(argv, name):
    return argv[argv.index(name) + 1]


def alarm_names_of(c):
    from rehearsal_support import alarm_names
    return alarm_names(c)


if __name__ == "__main__":
    unittest.main()
