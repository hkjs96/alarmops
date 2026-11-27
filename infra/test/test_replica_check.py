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
from rehearsal_support import ACCT, EID, PROFILE, REPO, Sandbox, mode
from test_rehearsal_harness import Base

SCRIPT = "replica-check.sh"
LONG_ALARM = "AlarmOps-SQS-ApproximateAgeOfOldestMessage-alarmopsRehearsalQueueB8Xyz123"
LONG_RUN = "AlarmOpsRehearsalRunB8Xyz123abcDEF456ghiJKL789"
ORIG = "AlarmOps-AlarmWriter"
POLICY_NAME = "manage-alarmops-alarms"
REPLICA = fake_aws.REPLICA_NAME
# D-63: managed test alarms start with `[` (the engine's name shape); customer-like unmanaged alarms do not.
TEST_ALARM = "[AlarmOpsRehearsal] replica-test"
UNMANAGED = "AlarmOpsRehearsal-replica-unmanaged"
BRACKET_UNMANAGED = "[AlarmOpsRehearsal] replica-unmanaged-bracket"
SSO_ROLE = "AWSReservedSSO_AdministratorAccess_0123456789abcdef"
SSO_ARN = f"arn:aws:sts::{ACCT}:assumed-role/{SSO_ROLE}/someone"
BOUNDARY = f"arn:aws:iam::{ACCT}:policy/org-boundary"
CRED_VALUES = (fake_aws.REPLICA_KEY, fake_aws.REPLICA_SECRET, fake_aws.REPLICA_TOKEN)

ALARM_RES = f"arn:aws:cloudwatch:*:{ACCT}:alarm:*"
BRACKET_RES = f"arn:aws:cloudwatch:*:{ACCT}:alarm:[*"
# Hand copy of AlarmWriterRole's inline policy in infra/customer-stack/template.yaml (test_sids_match_template guards drift).
POLICY = {"Version": "2012-10-17", "Statement": [
    {"Sid": "ReadAlarms", "Effect": "Allow", "Action": ["cloudwatch:DescribeAlarms"], "Resource": "*"},
    {"Sid": "ReadAlarmTags", "Effect": "Allow", "Action": ["cloudwatch:ListTagsForResource"], "Resource": ALARM_RES},
    {"Sid": "CreateAlarmWithManagedByTag", "Effect": "Allow", "Action": ["cloudwatch:PutMetricAlarm"],
     "Resource": BRACKET_RES, "Condition": {"StringEquals": {"aws:RequestTag/ManagedBy": "AlarmOps"}}},
    {"Sid": "ChangeOwnAlarms", "Effect": "Allow",
     "Action": ["cloudwatch:PutMetricAlarm", "cloudwatch:TagResource", "cloudwatch:UntagResource",
                "cloudwatch:DeleteAlarms"],
     "Resource": ALARM_RES, "Condition": {"StringEquals": {"aws:ResourceTag/ManagedBy": "AlarmOps"}}},
    {"Sid": "DenyManagedByTagEdits", "Effect": "Deny", "Action": ["cloudwatch:TagResource", "cloudwatch:UntagResource"],
     "Resource": "*", "Condition": {"ForAnyValue:StringEquals": {"aws:TagKeys": ["ManagedBy"]}}},
]}
# The policy before D-63: the create statement covers every alarm name (overwrite hole measured on 11/26-27).
OLD_POLICY = copy.deepcopy(POLICY)
OLD_POLICY["Statement"][2]["Resource"] = ALARM_RES
# Wrong: PutMetricAlarm allowed without any tag condition.
WRONG_POLICY = copy.deepcopy(POLICY)
WRONG_POLICY["Statement"][2].pop("Condition")


SSO_PATH = "/aws-reserved/sso.amazonaws.com/ap-northeast-2/"
SSO_FULL_ARN = f"arn:aws:iam::{ACCT}:role{SSO_PATH}{SSO_ROLE}"


def roles(policy=POLICY, boundary=None, extra=None, sso=True):
    r = {ORIG: {"boundary": boundary, "policies": {POLICY_NAME: policy} if policy is not None else {}, "tags": {}}}
    if sso:   # the caller's own SSO role, whose real ARN carries the aws-reserved path
        r[SSO_ROLE] = {"path": SSO_PATH, "policies": {}, "tags": {}}
    r.update(extra or {})
    return r


class ReplicaBase(Base):
    ENV = {"REHEARSAL_ASSUME_RETRIES": "3", "REHEARSAL_ASSUME_INTERVAL": "0"}

    def scenario(self, policy=POLICY, boundary=None, caller=SSO_ARN, **extra):
        extra.setdefault("iam_roles", roles(policy, boundary))
        # Real CloudWatch does not deny an overwrite of an untagged alarm by itself (measured 11/26-27): only the policy's
        # Resource/Condition decide, so cw_overwrite_unmanaged_denied is NOT set by default (D-63).
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
        rows = [l for l in res.out.splitlines() if l.startswith(f"| ({tag})")]
        self.assertEqual(len(rows), 1, f"row ({tag}) in:\n{res.out}")
        return rows[0]

    def verdicts(self, res):
        return {t: ("PASS" if "PASS" in self.row(res, t) else "FAIL" if "FAIL" in self.row(res, t) else "?")
                for t in "abcdef"}

    def info_row(self, res):
        rows = [l for l in res.out.splitlines() if l.startswith("| (g)")]
        self.assertEqual(len(rows), 1, f"row (g) in:\n{res.out}")
        return rows[0]

    def assertCleanedUp(self):
        st = self.state()
        self.assertIsNotNone(st)
        self.assertNotIn(REPLICA, st["roles"], "replica role must be gone")
        self.assertNotIn(TEST_ALARM, st["alarms"])
        self.assertNotIn(UNMANAGED, st["alarms"])
        self.assertNotIn(BRACKET_UNMANAGED, st["alarms"])


class AllPass(ReplicaBase):
    def test_all_pass(self):
        self.scenario()
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        self.assertIn("| 항목 | 결과 | 비고 |", res.out)
        self.assertEqual(self.verdicts(res), dict.fromkeys("abcdef", "PASS"), res.out)
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
        self.assertEqual(st["Condition"], {"StringEquals": {"aws:PrincipalArn": SSO_FULL_ARN}})
        self.assertNotIn("*", json.dumps(trust), "no wildcard anywhere in the trust policy")
        gets = [c for c in calls if c["op"] == "get-role" and option(c["argv"], "--role-name") == SSO_ROLE]
        self.assertEqual(len(gets), 1, "the exact caller role ARN (with path) comes from iam get-role")
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
        unmanaged = [c for c in calls if c["op"] == "put-metric-alarm" and UNMANAGED in c["argv"]
                     and not c["as_replica"]]
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
        self.assertEqual(self.verdicts(res), dict.fromkeys("abcdef", "PASS"), res.out)

    def test_replica_calls_use_env_credentials_only(self):
        self.scenario()
        self.go()
        replica = [c for c in self.sb.calls() if c["as_replica"]]
        self.assertGreaterEqual(len(replica), 6)
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
        self.assertEqual(names, {TEST_ALARM, UNMANAGED, BRACKET_UNMANAGED})

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
        # --cleanup-only also clears --probe-resource-tag-deny leftovers (test_replica_probe.py checks those names)
        self.assertEqual({n for n in names if " probe-" not in n}, {TEST_ALARM, UNMANAGED, BRACKET_UNMANAGED})
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



class TrustPin(ReplicaBase):
    def test_missing_caller_role_refuses_and_creates_nothing(self):
        self.scenario(iam_roles=roles(sso=False))
        res = self.go()
        self.assertNotEqual(res.code, 0, res.text)
        self.assertEqual(self.sb.writes(), [], self.ops())
        self.assertNotIn("iam create-role", self.ops())


class Assume(ReplicaBase):
    def test_assume_asks_only_for_the_three_values_as_text(self):
        self.scenario()
        self.go()
        a = [c for c in self.sb.calls() if c["op"] == "assume-role"][0]
        self.assertEqual(option(a["argv"], "--query"),
                         "[Credentials.AccessKeyId,Credentials.SecretAccessKey,Credentials.SessionToken]")
        self.assertEqual(option(a["argv"], "--output"), "text")
        self.assertLessEqual(int(option(a["argv"], "--duration-seconds")), 3600)


class OverwriteCheck(ReplicaBase):
    def test_f_denied_passes(self):
        self.scenario()
        res = self.go()
        self.assertEqual(self.verdicts(res)["f"], "PASS", res.out)
        self.assertEqual(res.code, 0, res.text)

    def test_f_denied_by_the_name_scope_not_by_cloudwatch(self):
        """D-63: with no CloudWatch-side denial modelled, (f) passes only because the create Resource is `alarm:[*`."""
        self.scenario()
        res = self.go()
        self.assertEqual(self.verdicts(res)["f"], "PASS", res.out)
        puts = [c for c in self.sb.calls() if c["op"] == "put-metric-alarm" and c["as_replica"] and UNMANAGED in c["argv"]]
        self.assertEqual(len(puts), 1)

    def test_f_allowed_fails_with_findings(self):
        self.scenario(policy=OLD_POLICY)   # the pre-D-63 policy: create statement covers every alarm name
        res = self.go()
        self.assertNotEqual(res.code, 0, res.text)
        self.assertEqual(self.verdicts(res)["f"], "FAIL", res.out)
        row = self.row(res, "f")
        self.assertIn("스택 갱신 필요(D-63 이전 템플릿) — 갱신 후에도 FAIL 이면 정책 결함", row)
        self.assertRegex(row, r"1\D+2")                  # threshold 1 -> 2 was observed with the person's credentials
        self.assertIn("ManagedBy=AlarmOps", row)         # the tag was observed
        for k in "abcde":
            self.assertEqual(self.verdicts(res)[k], "PASS", res.out)
        self.assertCleanedUp()
        look = [c for c in self.sb.calls() if c["op"] in ("describe-alarms", "list-tags-for-resource")
                and not c["as_replica"] and UNMANAGED in " ".join(c["argv"])]
        self.assertTrue(look, "the person's own credentials must inspect the alarm after a successful overwrite")

    def test_g_known_limit_is_informational_and_allowed(self):
        """(g) an untagged alarm whose name starts with `[` can still be overwritten (D-63 residual risk). It is shown
        but is not a FAIL and does not change the exit code."""
        self.scenario()
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        row = self.info_row(res)
        self.assertIn("알려진 한계(D-63)", row)
        self.assertIn("ALLOWED", row)
        self.assertNotIn("FAIL", row)
        self.assertNotIn("PASS", row)
        self.assertIn("전부 PASS", res.out)
        puts = [c for c in self.sb.calls() if c["op"] == "put-metric-alarm" and BRACKET_UNMANAGED in c["argv"]]
        self.assertEqual([c["as_replica"] for c in puts], [False, True], "person creates it untagged, replica overwrites")
        self.assertNotIn("--tags", puts[0]["argv"])
        self.assertIn("Key=ManagedBy,Value=AlarmOps", puts[1]["argv"])
        self.assertCleanedUp()

    def test_g_denied_is_reported_without_failing(self):
        self.scenario(cw_overwrite_unmanaged_denied=True)
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        self.assertIn("DENIED", self.info_row(res))

    def test_g_prepare_failure_does_not_fail_the_run(self):
        # put-metric-alarm calls: (a)=1 (b)=2 ALARM_U=3 (f)=4 bracket alarm=5
        self.scenario(fail_nth={"cloudwatch put-metric-alarm": 5})
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        self.assertIn("준비 실패", self.info_row(res))
        self.assertCleanedUp()

    def test_f_overwrites_the_unmanaged_alarm_with_a_request_tag(self):
        self.scenario()
        self.go()
        puts = [c for c in self.sb.calls() if c["op"] == "put-metric-alarm" and c["as_replica"]
                and UNMANAGED in c["argv"]]
        self.assertEqual(len(puts), 1)
        self.assertIn("Key=ManagedBy,Value=AlarmOps", puts[0]["argv"])


class EnvRefusal(ReplicaBase):
    def test_extra_env_is_refused_by_replica_check_only(self):
        self.scenario()
        for var in ("AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_STS", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
                    "AWS_CA_BUNDLE"):
            with self.subTest(var=var):
                self.sb.calls_file.unlink(missing_ok=True)
                res = self.sb.run(SCRIPT, ["--profile", PROFILE, "--confirm-account", ACCT],
                                  extra_env={**self.ENV, var: "x"})
                self.assertNotEqual(res.code, 0)
                self.assertEqual(self.sb.calls(), [])
                self.assertIn(var, res.text)

    def test_other_scripts_still_accept_those_variables(self):
        self.scenario()
        res = self.sb.run("preflight.sh", ["--profile", PROFILE], extra_env={"AWS_CA_BUNDLE": "x"})
        self.assertNotIn("AWS_CA_BUNDLE", res.text)


class Signals(ReplicaBase):
    def test_sighup_runs_cleanup(self):
        import os
        import signal
        import subprocess
        import time
        if os.name != "posix":
            self.skipTest("POSIX signals")
        self.scenario(sleep_ops={"cloudwatch put-metric-alarm": 3})
        from rehearsal_support import SCRIPTS
        proc = subprocess.Popen(["bash", str(SCRIPTS / SCRIPT), "--profile", PROFILE, "--confirm-account", ACCT],
                                env=self.sb.env(self.ENV), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, cwd=str(self.sb.dir))
        marker = Path(str(self.sb.calls_file) + ".sleeping")
        deadline = time.time() + 30
        while not marker.exists() and time.time() < deadline:
            time.sleep(0.05)
        self.assertTrue(marker.exists(), "script never reached the first alarm call")
        proc.send_signal(signal.SIGHUP)
        proc.communicate(timeout=60)
        self.assertNotEqual(proc.returncode, 0)
        self.assertCleanedUp()


class CleanupShWarns(ReplicaBase):
    def run_cleanup(self, **scen):
        self.sb.set_scenario(**scen)
        return self.sb.run("cleanup.sh", self.sb.good_args("cleanup.sh", run_id="run-0001"))

    def test_warns_and_does_not_delete_the_replica(self):
        res = self.run_cleanup(iam_roles=roles(extra={REPLICA: {"boundary": None, "policies": {POLICY_NAME: POLICY},
                                                               "tags": {"AlarmOpsRehearsal": "true"}}}))
        self.assertIn(REPLICA, res.text)
        self.assertIn("replica-check.sh", res.text)
        self.assertIn("--cleanup-only", res.text)
        self.assertNotIn("iam delete-role", self.ops())
        st = self.state()   # None: nothing wrote any state, so the role is untouched
        self.assertTrue(st is None or REPLICA in st["roles"])

    def test_silent_without_replica(self):
        res = self.run_cleanup(iam_roles=roles())
        self.assertNotIn("--cleanup-only", res.text)


class MaskUnit(unittest.TestCase):
    """rh_mask (common.sh) is the single masking point: aws_r, rh_say, rh_die and rh_log all go through it."""
    COMMON = str(REPO / "infra" / "scripts" / "rehearsal" / "common.sh")

    def mask(self, text, eid=None):
        import os
        import subprocess
        env = {"PATH": os.environ["PATH"], "HOME": "/tmp"}
        if eid:
            env["REHEARSAL_EXTERNAL_ID"] = eid
        cp = subprocess.run(["bash", "-c", 'source "$1"; rh_mask "$2"', "_", self.COMMON, text],
                            capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        return cp.stdout

    def test_secret_shapes_are_masked(self):
        tok_pct = "FwoGZXIvYXdzE%2BabcDEFg%2Fhij0123klmNOPqrstUVWXyz4567%2B89ABCDEFghij"
        tok_dash = "IQoJb3JpZ2luX2VjE-abcDEFghij_klmnoPQRSTuvwxYZ0123456789-abc_defGHIjkl-QRSTuvwxYZ0123456789_abcDEFghij"
        cases = {
            "pct": (f"token {tok_pct} end", tok_pct),
            "dash_underscore": (f"x {tok_dash}", tok_dash),
            "query_string": ("GET /?X-Amz-Security-Token=ABCdef123%2Bxyz&X-Amz-Date=1", "ABCdef123%2Bxyz"),
            "json": ('{"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "x": 1}', "wJalrXUtnFEMI/K7MDENG/bPxRfiCY"),
            "env_style": ("AWS_SESSION_TOKEN=shortTok123", "shortTok123"),
            "secret_snake": ("secret_access_key: abc/def", "abc/def"),
            "akia": ("key AKIAIOSFODNN7EXAMPLE used", "AKIAIOSFODNN7EXAMPLE"),
            "asia": ("key ASIAFAKEREPLICAKEY0001", "ASIAFAKEREPLICAKEY0001"),
            "access_token": ('{"accessToken":"abcDEF123xyz"}', "abcDEF123xyz"),
            "bearer": ("Authorization: Bearer abcDEF123xyz.tok", "abcDEF123xyz.tok"),
            "sso_bearer": ("x-amz-sso_bearer_token: abcDEF123xyz", "abcDEF123xyz"),
            "password": ("password=hunter2hunter2", "hunter2hunter2"),
            "secret_key": ('"SecretKey": "abcDEF123xyz"', "abcDEF123xyz"),
            "slash_token": ("tok " + "aB3/" * 12, "aB3/aB3/aB3/"),
        }
        for name, (text, secret) in cases.items():
            with self.subTest(name):
                out = self.mask(text)
                self.assertNotIn(secret, out)
                self.assertIn("****", out)

    def test_external_id_still_masked_and_benign_text_untouched(self):
        self.assertNotIn(EID, self.mask(f"id={EID}", eid=EID))
        for benign in ("https://sqs.ap-northeast-2.amazonaws.com/111111111111/alarmops-rehearsal-run-0001",
                       "arn:aws:iam::111111111111:role/AlarmOps-AlarmWriter",
                       '{"MetricAlarms": [{"AlarmName": "alarm-own-q1", "Threshold": 1.0}]}',
                       "alarmops-rehearsal-averyverylongrunidwithoutuppercase-and-more-0123456789",
                       LONG_ALARM, SSO_ROLE, "alarmops-rehearsal-" + LONG_RUN,
                       f"arn:aws:iam::111111111111:role/{LONG_ALARM}",
                       f"arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/ap-northeast-2/{SSO_ROLE}",
                       f"https://sqs.ap-northeast-2.amazonaws.com/111111111111/alarmops-rehearsal-{LONG_RUN}"):
            with self.subTest(benign):
                self.assertEqual(self.mask(benign).strip(), benign)

    def test_aws_r_and_rh_die_use_it(self):
        import subprocess
        sb = Sandbox()
        self.addCleanup(sb.close)
        secret = "ZZtopSECRET+value0123456789abcdefghijklmnopqrstuvwxyzQWERT"
        sb.set_scenario(leak=secret)
        env = sb.env()
        for script in ('RH_PROFILE=rehearsal-a; aws_r cloudwatch describe-alarms >/dev/null',
                       f'rh_die "boom SessionToken={secret}"'):
            cp = subprocess.run(["bash", "-c", 'source "$1"; ' + script, "_", self.COMMON],
                                capture_output=True, text=True, env=env, timeout=30)
            self.assertNotIn(secret, cp.stdout + cp.stderr, script)



class MaskTwoTiers(unittest.TestCase):
    """Data path (aws_r stdout) masks only ExternalId, key ids and keyword values; the length heuristic is for output
    people see (rh_say/rh_log/rh_die, aws_r stderr, rp_mask)."""
    COMMON = MaskUnit.COMMON

    def run_bash(self, script, *args, env=None):
        import os
        import subprocess
        e = {"PATH": os.environ["PATH"], "HOME": "/tmp", **(env or {})}
        cp = subprocess.run(["bash", "-c", 'source "$1"; ' + script, "_", self.COMMON, *args],
                            capture_output=True, text=True, env=e, timeout=30)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        return cp.stdout

    def test_data_mask_keeps_long_names(self):
        for text in (LONG_ALARM, SSO_ROLE, "x" * 100, "aB3/" * 12,
                     f"arn:aws:iam::111111111111:role/{LONG_ALARM}",
                     f'{{"AlarmName": "{LONG_ALARM}", "Dimensions": [{{"Name": "QueueName", "Value": "alarmops-rehearsal-{LONG_RUN}"}}]}}'):
            with self.subTest(text[:30]):
                self.assertEqual(self.run_bash('rh_mask_data "$2"', text).strip(), text)

    def test_data_mask_still_hides_keys_keywords_and_external_id(self):
        out = self.run_bash('rh_mask_data "$2"', f"a ASIAFAKEREPLICAKEY0001 b X-Amz-Security-Token=abc%2Bdef id={EID}",
                            env={"REHEARSAL_EXTERNAL_ID": EID})
        for secret in ("ASIAFAKEREPLICAKEY0001", "abc%2Bdef", EID):
            self.assertNotIn(secret, out)

    def test_data_mask_json_value_stops_at_the_quote(self):
        out = self.run_bash('rh_mask_data "$2"', '{"Password": "x1", "AlarmName": "keep-me"}')
        self.assertIn("keep-me", out)
        self.assertNotIn("x1", out)

    def test_human_mask_is_narrow(self):
        long_plain = "a" * 100          # a single 80+ char token is still hidden
        self.assertNotIn(long_plain, self.run_bash('rh_mask "$2"', long_plain))
        self.assertEqual(self.run_bash('rh_mask "$2"', LONG_ALARM).strip(), LONG_ALARM)




SECRET40 = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12"      # AWS secret access key shape: 40 chars, [A-Za-z0-9/+], upper+lower+digit
SECRET40_SLASH = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"


class MaskSecretKeyShape(unittest.TestCase):
    """Items 1-3 of #161: human-path secret-key shape rule, narrower bearer/basic rule, URL query values."""
    COMMON = MaskUnit.COMMON

    def run_bash(self, script, *args):
        import os
        import subprocess
        e = {"PATH": os.environ["PATH"], "HOME": "/tmp"}
        cp = subprocess.run(["bash", "-c", 'source "$1"; ' + script, "_", self.COMMON, *args],
                            capture_output=True, text=True, env=e, timeout=30)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        return cp.stdout

    def human(self, text):
        return self.run_bash('rh_mask "$2"', text)

    def data(self, text):
        return self.run_bash('rh_mask_data "$2"', text)

    def test_fixtures_are_40_chars(self):
        self.assertEqual(len(SECRET40), 40)
        self.assertEqual(len(SECRET40_SLASH), 40)

    def test_exactly_40_char_secret_without_plus_or_slash_is_masked(self):
        for text in (f"key {SECRET40} end", SECRET40, f'"{SECRET40}"', f"x={SECRET40}", f"SecretKey: {SECRET40}"):
            with self.subTest(text):
                out = self.human(text)
                self.assertNotIn(SECRET40, out)
                self.assertIn("****", out)

    def test_40_char_secret_with_plus_slash_is_masked(self):
        self.assertNotIn(SECRET40_SLASH, self.human(f"v {SECRET40_SLASH}"))

    def test_names_and_lookalikes_are_not_masked(self):
        lookalikes = (
            "A" + "b1-" * 13 + "z",                          # 40 chars but has -
            ("Ab1_" * 10),                                     # 40 chars but has _
            ("abcdef0123" * 4),                                # 40 chars, no uppercase (git sha shape)
            ("ABCDEF0123" * 4),                                # no lowercase
            ("abcdefghij" * 4).replace("a", "A", 1),           # no digit
            SECRET40[:39],                                      # 39
            SECRET40 + "a",                                     # 41
            f"pre.{SECRET40}", f"{SECRET40}.post",              # adjacent to .
            LONG_ALARM, SSO_ROLE, "alarmops-rehearsal-" + LONG_RUN,
            "AlarmOps-SQS-ApproximateNumberOfMessagesVisible-QueueB8Xyz123",
            "AWSReservedSSO_AdministratorAccess_0123456789abcdef",
            "arn:aws:iam::111111111111:role/AlarmOps-AlarmWriterRole-1ABCDEFGHIJKL",
        )
        for t in lookalikes:
            with self.subTest(t):
                self.assertEqual(self.human(t).strip(), t)

    def test_data_path_is_unchanged_for_the_new_rule(self):
        for t in (f"key {SECRET40} end", SECRET40, SECRET40_SLASH):
            with self.subTest(t):
                self.assertEqual(self.data(t).strip(), t)

    def test_plain_basic_prose_is_not_masked(self):
        for t in ("basic monitoring is enabled for this instance", "Basic monitoring enabled",
                  "detailed monitoring vs basic ec2metrics"):
            with self.subTest(t):
                self.assertEqual(self.data(t).strip(), t)
                self.assertEqual(self.human(t).strip(), t)

    def test_authorization_header_schemes_are_still_masked(self):
        for secret, text in (("dXNlcjpwYXNzd29yZA==", "Authorization: Basic dXNlcjpwYXNzd29yZA=="),
                             ("dXNlcjpwYXNzd29yZA==", "authorization=basic dXNlcjpwYXNzd29yZA=="),
                             ("abcDEF123xyz.tok", "Authorization: Bearer abcDEF123xyz.tok"),
                             ("abcDEF123xyz.tok", '{"Authorization": "Bearer abcDEF123xyz.tok", "x": 1}'),
                             ("abcDEF123xyz.tok", "Proxy-Authorization: Basic abcDEF123xyz.tok")):
            for fn in (self.data, self.human):
                with self.subTest(text, fn=fn.__name__):
                    out = fn(text)
                    self.assertNotIn(secret, out)
                    self.assertIn("****", out)
        self.assertIn('"x": 1', self.data('{"Authorization": "Bearer abcDEF123xyz.tok", "x": 1}'))

    def test_bearer_keyword_value_is_still_masked(self):
        self.assertNotIn("abcDEF123xyz", self.data("got Bearer abcDEF123xyz now"))

    def test_url_path_is_kept_but_query_values_are_checked(self):
        url = f"https://sqs.ap-northeast-2.amazonaws.com/111111111111/alarmops-rehearsal-{LONG_RUN}"
        self.assertEqual(self.human(url).strip(), url)
        sig = "9f8e7d6c5b4a39281716f5e4d3c2b1a09f8e7d6c5b4a39281716f5e4d3c2b1a0"
        signed = f"{url}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature={sig}"
        out = self.human(signed)
        self.assertNotIn(sig, out)
        self.assertIn(url, out)
        pct = "AbC%2Bdef%2Fghi0123456789jklmnopqrstuvwxyzABCDEFG"
        self.assertNotIn(pct, self.human(f"{url}?X-Amz-Credential={pct}"))
        self.assertEqual(self.human("https://example.com/a?b=1").strip(), "https://example.com/a?b=1")

    def test_arn_words_are_still_skipped_whole(self):
        arn = f"arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/ap-northeast-2/{SSO_ROLE}"
        self.assertEqual(self.human(arn).strip(), arn)



FOREIGN = {"Namespace": "Customer", "tags": {}}


class NameCollision(ReplicaBase):
    """#161 item 6: never delete or overwrite an alarm with a probe/test name that this script did not create."""

    def delete_calls_naming(self, name):
        return [c for c in self.sb.calls() if c["op"] == "delete-alarms" and name in alarm_names_of(c)]

    def assertUntouched(self, name):
        st = self.state()
        self.assertIn(name, st["alarms"], "the foreign alarm must still exist")
        self.assertEqual(self.delete_calls_naming(name), [])
        self.assertEqual([c for c in self.sb.calls() if c["op"] == "put-metric-alarm" and name in c["argv"]], [])

    def test_foreign_alarm_with_a_test_name_aborts_before_anything_is_created(self):
        for name in (TEST_ALARM, UNMANAGED, BRACKET_UNMANAGED):
            with self.subTest(name):
                self.setUp()
                self.scenario(cw_preexisting_alarms={name: FOREIGN})
                res = self.go()
                self.assertEqual(res.code, 1, res.text)
                self.assertIn("오류:", res.text)
                self.assertIn(name, res.text)
                self.assertIn("이 스크립트가 만든 것이 아니", res.text)
                self.assertUntouched(name)
                ops = self.ops()
                self.assertNotIn("iam create-role", ops)
                self.assertNotIn("cloudwatch put-metric-alarm", ops)

    def test_lookup_uses_a_json_array(self):
        self.scenario()
        self.go()
        looks = [c for c in self.sb.calls() if c["op"] == "describe-alarms" and "--alarm-names" in c["argv"]]
        self.assertTrue(looks)
        self.assertTrue(option(looks[0]["argv"], "--alarm-names").startswith('["'))

    def test_composite_alarm_with_the_name_is_foreign(self):
        self.scenario(cw_preexisting_alarms={UNMANAGED: {"composite": True}})
        res = self.go()
        self.assertEqual(res.code, 1, res.text)
        self.assertUntouched(UNMANAGED)

    def test_leftover_of_our_own_namespace_is_not_a_collision(self):
        self.scenario(cw_preexisting_alarms={UNMANAGED: {"Namespace": "AlarmOpsRehearsal"}})
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        self.assertCleanedUp()

    def test_lookup_failure_aborts_without_creating(self):
        self.scenario(fail_nth={"cloudwatch describe-alarms": 1})
        res = self.go()
        self.assertEqual(res.code, 1, res.text)
        self.assertNotIn("iam create-role", self.ops())

    def test_cleanup_only_skips_a_foreign_alarm(self):
        self.scenario(cw_preexisting_alarms={UNMANAGED: FOREIGN, TEST_ALARM: {"Namespace": "AlarmOpsRehearsal"}})
        res = self.go(extra_args=["--cleanup-only"])
        self.assertEqual(res.code, 0, res.text)
        st = self.state()
        self.assertIn(UNMANAGED, st["alarms"])
        self.assertNotIn(TEST_ALARM, st["alarms"])
        self.assertIn("건너뜀(이 스크립트가 만든 알람이 아님)", res.text)
        self.assertEqual(self.delete_calls_naming(UNMANAGED), [])

    def test_probe_names_are_checked_too(self):
        from test_replica_probe import PROBE_FLAG
        name = "[AlarmOpsRehearsal] probe-null-unmanaged"
        self.scenario(cw_preexisting_alarms={name: FOREIGN})
        res = self.go(extra_args=[PROBE_FLAG])
        self.assertEqual(res.code, 1, res.text)
        self.assertIn(name, res.text)
        self.assertUntouched(name)
        self.assertNotIn("iam create-role", self.ops())


class FollowUpNotes(ReplicaBase):
    """#161 items 5, 7, 10: row names and note texts."""

    def test_d_row_name_keeps_the_87_marker_when_it_is_a_prep_failure(self):
        # put-metric-alarm calls: (a)=1 (b)=2 ALARM_U=3 -> (c)(d) become prep failures
        self.scenario(fail_nth={"cloudwatch put-metric-alarm": 3})
        res = self.go()
        row = self.row(res, "d")
        self.assertIn("(d) 태그 없는 알람 DeleteAlarms → 거부 (#87 미확인 항목)", row)
        self.assertIn("준비 실패", row)

    def test_d_row_name_is_the_same_in_the_normal_row(self):
        self.scenario()
        res = self.go()
        self.assertIn("(d) 태그 없는 알람 DeleteAlarms → 거부 (#87 미확인 항목)", self.row(res, "d"))

    def test_f_fail_note_asks_for_a_stack_update_first(self):
        self.scenario(policy=OLD_POLICY)
        res = self.go()
        row = self.row(res, "f")
        self.assertIn("스택 갱신 필요(D-63 이전 템플릿) — 갱신 후에도 FAIL 이면 정책 결함", row)
        self.assertNotIn("보완 필요", row)

    def test_g_error_note_differs_from_the_denied_note(self):
        # put-metric-alarm calls: (a)=1 (b)=2 ALARM_U=3 (f)=4 bracket alarm=5 replica overwrite=6
        self.scenario(fail_nth={"cloudwatch put-metric-alarm": 6})
        err = self.info_row(self.go())
        self.assertIn("ERROR(", err)
        self.setUp()
        self.scenario(cw_overwrite_unmanaged_denied=True)
        denied = self.info_row(self.go())
        self.assertIn("DENIED", denied)
        self.assertNotIn("막힘", err)
        self.assertIn("판정하지 못함(거부가 아닌 오류)", err)
        self.assertNotIn("판정하지 못함", denied)
        self.assertIn("덮어쓰기도 막힘", denied)


class CanaryBNote(unittest.TestCase):
    """#161 item 7: null variant + canary B DENIED means PutMetricAlarm evaluation ignores ResourceTag."""

    def test_documented(self):
        gl = (REPO / "docs" / "GO-LIVE.md").read_text(encoding="utf-8")
        ct = (REPO / "infra" / "test" / "REHEARSAL-CONTRACT.md").read_text(encoding="utf-8")
        for text in (gl, ct):
            self.assertIn("PutMetricAlarm 평가에 ResourceTag 가 반영되지 않는 것으로 보임", text)


class DocsFollowUps(unittest.TestCase):
    def read(self, rel):
        return (REPO / rel).read_text(encoding="utf-8")

    def test_update_menu_name_is_identical_in_all_three_places(self):
        label = "Replace existing template"
        for rel in ("docs/GO-LIVE.md", "infra/customer-stack/README.md"):
            text = self.read(rel)
            self.assertIn(label, text, rel)
            for old in ("현재 템플릿 바꾸기", "기존 템플릿 바꾸기"):
                self.assertNotIn(old, text, (rel, old))
        self.assertGreaterEqual(self.read("docs/GO-LIVE.md").count(label), 2)

    def test_go_live_quotes_the_new_note_texts(self):
        gl = self.read("docs/GO-LIVE.md")
        self.assertIn("스택 갱신 필요(D-63 이전 템플릿) — 갱신 후에도 FAIL 이면 정책 결함", gl)
        self.assertIn("판정하지 못함(거부가 아닌 오류)", gl)
        self.assertNotIn("template.yaml CreateAlarmWithManagedByTag 보완 필요", gl)
        self.assertIn("이 스크립트가 만든 것이 아니", gl)
        self.assertIn("건너뜀(이 스크립트가 만든 알람이 아님)", gl)

    def test_go_live_f_sentence_order(self):
        gl = self.read("docs/GO-LIVE.md")
        a = gl.index("(f)는 같은 이름에 `ManagedBy=AlarmOps` 요청 태그를 달아 덮어쓰기를 시도한다.")
        b = gl.index("성공하면 FAIL이고")
        c = gl.index("관리 시험 알람과 (g)용 알람은")
        self.assertLess(a, b)
        self.assertLess(b, c)

    def test_contract_describes_two_masking_tiers(self):
        ct = self.read("infra/test/REHEARSAL-CONTRACT.md")
        self.assertIn("rh_mask_data", ct)
        self.assertIn("aws_r", ct)
        self.assertIn("정확히 40자", ct)
        self.assertNotIn("모든 출력은 `common.sh`의 `rh_mask`(ExternalId + 자격증명 모양)를 거친다", ct)

    def test_decisions_has_the_11_27_measurement(self):
        d = self.read("docs/decisions/DECISIONS.md")
        sec = d.split("### D-63", 1)[1]
        for needle in ("install.sh", "(a)~(f)", "AccessDenied", "ALLOWED", "JSON 배열"):
            self.assertIn(needle, sec, needle)

class DataPaths(ReplicaBase):
    """Long mixed-case names must survive every script that parses aws_r output (#160 review)."""

    def write_run_log(self, run_id, queue):
        d = self.sb.log_dir / PROFILE
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{run_id}.md").write_text(f"QUEUE: {queue}\n", encoding="utf-8")

    def test_cleanup_finds_and_deletes_long_named_alarm_and_queue(self):
        from test_rehearsal_harness import alarm
        q = "alarmops-rehearsal-" + LONG_RUN
        self.write_run_log("run-one", q)
        self.sb.set_scenario(
            queues={q: {"tags": {"AlarmOpsRehearsal": "true", "AlarmOpsRehearsalRun": "run-one"}}},
            alarms=[alarm(LONG_ALARM, q, {"ManagedBy": "AlarmOps"})])
        res = self.sb.run("cleanup.sh", self.sb.good_args("cleanup.sh", run_id="run-one"))
        self.assertEqual(res.code, 0, res.text)
        from rehearsal_support import alarm_names, option_values
        deleted = {n for c in self.sb.calls() if c["op"] == "delete-alarms" for n in alarm_names(c)}
        self.assertEqual(deleted, {LONG_ALARM})
        urls = [u for c in self.sb.calls() if c["op"] == "delete-queue" for u in option_values(c["argv"], "--queue-url")]
        self.assertEqual([u.rsplit("/", 1)[-1] for u in urls], [q])

    def test_cleanup_deletes_engine_alarms_whose_names_start_with_a_bracket(self):
        """The real CLI parses a list argument starting with `[` as JSON, so names like `[SQS] ...` must go as a JSON array."""
        from test_rehearsal_harness import alarm
        from rehearsal_support import alarm_names
        q = "alarmops-rehearsal-" + LONG_RUN
        names = ['[SQS] queue ApproximateAgeOfOldestMessage (TagName: q)', '[SQS] odd "quote" \\ back (TagName: q)']
        self.write_run_log("run-one", q)
        self.sb.set_scenario(
            queues={q: {"tags": {"AlarmOpsRehearsal": "true", "AlarmOpsRehearsalRun": "run-one"}}},
            alarms=[alarm(n, q, {"ManagedBy": "AlarmOps"}) for n in names])
        res = self.sb.run("cleanup.sh", self.sb.good_args("cleanup.sh", run_id="run-one"))
        self.assertEqual(res.code, 0, res.text)
        dels = [c for c in self.sb.calls() if c["op"] == "delete-alarms"]
        self.assertEqual(sorted(n for c in dels for n in alarm_names(c)), sorted(names))
        for c in dels:
            i = c["argv"].index("--alarm-names")
            self.assertIsInstance(json.loads(c["argv"][i + 1]), list, "one JSON array argument")
            self.assertTrue(i + 2 == len(c["argv"]) or c["argv"][i + 2].startswith("--"), "no further bare names")

    def test_json_array_helper_escapes_quote_and_backslash(self):
        import subprocess
        script = 'source "$1"; rh_json_array "[A] x" \'q"uote\' \'b\\s\''
        out = subprocess.run(["bash", "-c", script, "_", str(REPO / "infra/scripts/rehearsal/common.sh")],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), ["[A] x", 'q"uote', "b\\s"])

    def test_verify_keeps_the_long_queue_url(self):
        res = self.sb.run("verify.sh", self.sb.good_args("verify.sh", run_id=LONG_RUN), stdin_text="y\n" * 12)
        queue = "alarmops-rehearsal-" + LONG_RUN
        expect = f"https://sqs.ap-northeast-2.amazonaws.com/{ACCT}/{queue}"
        urls = [a for c in self.sb.calls() if c["service"] == "sqs" and c["op"] in ("tag-queue", "untag-queue")
                for i, a in enumerate(c["argv"]) if i and c["argv"][i - 1] == "--queue-url"]
        self.assertTrue(urls, res.text)
        self.assertEqual(set(urls), {expect})

    def test_verify_alarm_detection_with_long_names(self):
        from test_rehearsal_harness import alarm
        queue = "alarmops-rehearsal-" + LONG_RUN
        self.sb.set_scenario(alarms=[alarm(LONG_ALARM, queue, {"ManagedBy": "AlarmOps"})])
        res = self.sb.run("verify.sh", self.sb.good_args("verify.sh", run_id=LONG_RUN), stdin_text="y\n" * 12)
        self.assertIn(LONG_ALARM, self.sb.report(LONG_RUN) + res.out + res.err, "(나) must see the long-named alarm")

    def test_preflight_shows_long_stack_name(self):
        name = "alarmops-SQS-ApproximateAgeOfOldestMessage-alarmopsRehearsal-B8Xyz123"
        self.sb.set_scenario(stacks=[{"StackName": name, "StackStatus": "CREATE_COMPLETE", "Tags": []}])
        res = self.sb.run("preflight.sh", ["--profile", PROFILE])
        self.assertIn(name, res.text)

    def test_install_updates_existing_stack_with_long_tag_values(self):
        self.sb.set_scenario(stacks=[{"StackName": "alarmops-customer", "StackStatus": "CREATE_COMPLETE",
                                      "Tags": [{"Key": "Note", "Value": LONG_ALARM},
                                               {"Key": "AlarmOpsRehearsal", "Value": "true"}]}])
        res = self.sb.run("install.sh", self.sb.good_args("install.sh"))
        self.assertIn("update-stack", [c["op"] for c in self.sb.calls()], res.text)

    def test_replica_check_prints_the_sso_role_name(self):
        self.scenario()
        res = self.go()
        self.assertIn(f"신뢰: {SSO_ROLE}", res.out)
        self.assertIn(f"신뢰: {SSO_ROLE}", self.sb.log_text())


class FirstThenCD(ReplicaBase):
    """(f) is judged first, on a clean ALARM_U; (c)/(d) must not pollute it and (f) must not pollute (c)/(d)."""
    LOOSE = copy.deepcopy(POLICY)
    LOOSE["Statement"][3].pop("Condition")     # ChangeOwnAlarms without the tag condition: (c)/(d) wrongly allowed
    LOOSE["Statement"].pop()                   # no Deny on ManagedBy tag edits

    def replica_ops_on_u(self):
        return [c["op"] for c in self.sb.calls()
                if c["as_replica"] and UNMANAGED in " ".join(c["argv"])]

    def test_f_runs_before_c_and_d(self):
        self.scenario()
        self.go()
        self.assertEqual(self.replica_ops_on_u(), ["put-metric-alarm", "tag-resource", "delete-alarms"])

    def test_table_rows_stay_in_order(self):
        self.scenario()
        res = self.go()
        order = [m.group(1) for m in re.finditer(r"^\| \(([a-f])\)", res.out, re.M)]
        self.assertEqual(order, list("abcdef"))
        self.assertEqual(re.findall(r"^\| \(([a-g])\)", res.out, re.M), list("abcdefg"))

    def test_overwrite_resets_the_alarm_for_c_and_d(self):
        self.scenario(policy=OLD_POLICY)
        res = self.go()
        v = self.verdicts(res)
        self.assertEqual((v["c"], v["d"], v["f"]), ("PASS", "PASS", "FAIL"), res.out)   # not polluted by (f)'s tag
        ops = [(c["op"], c["as_replica"]) for c in self.sb.calls() if UNMANAGED in " ".join(c["argv"])
               or (c["op"] == "delete-alarms" and UNMANAGED in " ".join(c["argv"]))]
        i_f = ops.index(("put-metric-alarm", True))
        self.assertEqual(ops[i_f + 1], ("describe-alarms", False))
        self.assertIn(("delete-alarms", False), ops[i_f:])
        self.assertIn(("put-metric-alarm", False), ops[i_f:])     # re-created by the person

    def test_c_and_d_allowed_does_not_change_f_denied(self):
        # LOOSE has no tag condition on ChangeOwnAlarms, so (f) is only PASS if the fake models a CloudWatch-side denial
        self.scenario(policy=self.LOOSE, cw_overwrite_unmanaged_denied=True)
        res = self.go()
        v = self.verdicts(res)
        self.assertEqual(v["f"], "PASS", res.out)
        self.assertEqual((v["c"], v["d"]), ("FAIL", "FAIL"), res.out)
        self.assertNotEqual(res.code, 0)

    def test_c_and_d_allowed_does_not_change_f_allowed(self):
        self.scenario(policy=self.LOOSE)
        res = self.go()
        v = self.verdicts(res)
        self.assertEqual(v["f"], "FAIL", res.out)
        self.assertIn("임계값 1→2", self.row(res, "f"))
        self.assertEqual((v["c"], v["d"]), ("FAIL", "FAIL"), res.out)
        self.assertCleanedUp()

    def test_recreate_failure_marks_c_and_d_as_prepare_failures(self):
        # put-metric-alarm calls: (a)=1 (b)=2 ALARM_U=3 (f)=4 re-create=5
        self.scenario(policy=OLD_POLICY, fail_nth={"cloudwatch put-metric-alarm": 5})
        res = self.go()
        v = self.verdicts(res)
        self.assertEqual(v["f"], "FAIL")
        for k in "cd":
            self.assertIn("준비 실패", self.row(res, k))
            self.assertEqual(v[k], "FAIL")
        self.assertEqual([o for o in self.replica_ops_on_u()], ["put-metric-alarm"])
        self.assertCleanedUp()


class Docs(unittest.TestCase):
    def test_sids_match_template(self):
        text = (REPO / "infra" / "customer-stack" / "template.yaml").read_text(encoding="utf-8")
        block = text.split("  AlarmWriterRole:", 1)[1].split("# ----", 1)[0]
        sids = re.findall(r"Sid: (\w+)", block)
        self.assertEqual(sids, [s["Sid"] for s in POLICY["Statement"]])
        # D-63: the hand copy's create Resource is the template's `alarm:[*` (after Sub substitution)
        create = block.split("Sid: CreateAlarmWithManagedByTag", 1)[1].split("Sid:", 1)[0]
        self.assertIn('Resource: !Sub "arn:${AWS::Partition}:cloudwatch:*:${AWS::AccountId}:alarm:[*"', create)
        self.assertEqual(POLICY["Statement"][2]["Resource"], f"arn:aws:cloudwatch:*:{ACCT}:alarm:[*")

    def test_review_docs(self):
        gl = (REPO / "docs" / "GO-LIVE.md").read_text(encoding="utf-8")
        for needle in ("aws sso login --profile rehearsal-b", "REHEARSAL_ASSUME_RETRIES", "--cleanup-only",
                       "(f)", "오류:", "종료 코드", "AlarmOpsRehearsal-WriterReplica", "(준비) 정책 전파(DescribeAlarms)",
                       "AWS_CA_BUNDLE", "unset"):
            self.assertIn(needle, gl, needle)
        self.assertNotIn("`bash infra/scripts/rehearsal/cleanup.sh`가 임시 역할이", gl)
        self.assertIn("5번의 cleanup.sh 명령", gl)
        head = (REPO / "infra" / "scripts" / "rehearsal" / "replica-check.sh").read_text(encoding="utf-8").split("set -e", 1)[0]
        self.assertIn("6개", head)
        self.assertNotIn("5개", head)
        rd = (REPO / "infra" / "scripts" / "rehearsal" / "README.md").read_text(encoding="utf-8")
        self.assertIn("aws sso login --profile rehearsal-b", rd)
        ct = (REPO / "infra" / "test" / "REHEARSAL-CONTRACT.md").read_text(encoding="utf-8")
        for needle in ("replica-check.md", "5개", "태그", "(준비)"):
            self.assertIn(needle, ct, needle)

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
