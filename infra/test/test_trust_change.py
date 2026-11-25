"""Tests for infra/scripts/trust-change.sh (grant/revoke of the temporary TrustChange policy). Offline, fake aws."""
from __future__ import annotations

import json
import subprocess
import unittest
from datetime import datetime, timedelta, timezone

from rehearsal_support import ACCT, INFRA, REGION, Sandbox

SCRIPT = INFRA / "scripts" / "trust-change.sh"
ROLE = "AlarmOpsCentral-Engine"
POLICY = "AlarmOpsDeployCentral-TrustChange"


def opt(argv, name):
    return argv[argv.index(name) + 1]


class Base(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.close)
        self.logdir = self.sb.dir / "tc-logs"

    def run_tc(self, args, stdin=ACCT + "\n", extra_env=None):
        env = self.sb.env({"TRUST_CHANGE_LOG_DIR": str(self.logdir), **(extra_env or {})})
        return subprocess.run(["bash", str(SCRIPT), *args], env=env, input=stdin, capture_output=True, text=True,
                              timeout=60, cwd=str(self.sb.dir))

    def grant(self, role=ROLE, profile="dev", **kw):
        return self.run_tc(["grant", "--profile", profile, "--role", role], **kw)

    def revoke(self, role=ROLE, profile="dev", **kw):
        return self.run_tc(["revoke", "--profile", profile, "--role", role], **kw)

    def log_text(self):
        return "\n".join(p.read_text() for p in self.logdir.glob("*")) if self.logdir.exists() else ""


class RoleNames(Base):
    def test_rejected_roles_make_no_aws_call(self):
        for bad in ("AlarmOpsDeployCentral", "AlarmOpsDeployBus", "AlarmOps-Reader", "AlarmOps-Remediator",
                    "AlarmOpsCentral-*", "alarmops-central-*", "AlarmOpsCentral-", "AlarmOpsCentral-a/../b",
                    "AlarmOpsCentral-x y", "xAlarmOpsCentral-Engine", "AlarmOpsCentral-Engine\n*", "", "*"):
            with self.subTest(role=bad):
                for fn in (self.grant, self.revoke):
                    cp = fn(role=bad)
                    self.assertNotEqual(cp.returncode, 0, cp.stdout)
                self.assertEqual(self.sb.calls(), [])

    def test_allowed_roles_pass_the_name_check(self):
        for ok in ("AlarmOpsCentral-Engine", "AlarmOpsCentral-RemediatorCaller",
                   "alarmops-central-AlertConsumerFunctionRole-AB12"):
            with self.subTest(role=ok):
                self.assertEqual(self.grant(role=ok).returncode, 0)

    def test_profile_pattern(self):
        for bad in ("rehearsal-a", "prod", "", "dev;x", "Dev"):
            with self.subTest(profile=bad):
                self.assertNotEqual(self.grant(profile=bad).returncode, 0)
        self.assertEqual(self.sb.calls(), [])
        self.assertEqual(self.grant(profile="central-ops").returncode, 0)


class Guards(Base):
    def test_agent_and_ambient_credentials_refused_before_any_aws_call(self):
        for var in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                    "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE"):
            with self.subTest(var=var):
                cp = self.grant(extra_env={var: "1"})
                self.assertEqual(cp.returncode, 2)
                self.assertIn(var, cp.stderr)
        self.assertEqual(self.sb.calls(), [])

    def test_profile_only_by_argument(self):
        for args in (["grant", "--role", ROLE], ["grant", "--profile"],
                     ["grant", "--profile", "dev", "--role", ROLE, "--x", "1"],
                     ["delete", "--profile", "dev", "--role", ROLE], []):
            with self.subTest(args=args):
                self.assertNotEqual(self.run_tc(args).returncode, 0)
        self.assertEqual(self.sb.calls(), [])

    def test_wrong_or_missing_reentry_blocks_writes(self):
        for stdin in ("999999999999\n", "\n", "", ACCT[:-1] + "\n", ACCT + "0\n"):
            with self.subTest(stdin=stdin):
                for fn in (self.grant, self.revoke):
                    self.assertNotEqual(fn(stdin=stdin).returncode, 0)
                self.assertEqual(self.sb.writes(), [])

    def test_account_shown_and_reentry_recorded(self):
        cp = self.grant()
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertIn(ACCT, cp.stdout)
        self.assertIn("다시 입력", cp.stderr)
        self.assertIn("계정 재입력 일치: " + ACCT, self.log_text())
        calls = self.sb.calls()
        ops = [c["op"] for c in calls]
        self.assertEqual(calls[0]["op"], "get-caller-identity")
        self.assertLess(ops.index("get-caller-identity"), ops.index("put-role-policy"))

    def test_mismatch_is_logged_and_nothing_written(self):
        self.grant(stdin="1\n")
        self.assertIn("불일치", self.log_text())
        self.assertNotIn("재입력 일치", self.log_text())
        self.assertEqual(self.sb.writes(), [])

    def test_every_call_pins_profile_and_region(self):
        self.sb.set_scenario(stacks=[{"StackName": "alarmops-central", "StackStatus": "UPDATE_COMPLETE"}])
        self.grant()
        self.revoke()
        self.assertGreater(len(self.sb.calls()), 3)
        for c in self.sb.calls():
            self.assertEqual(opt(c["argv"], "--region"), REGION)
            self.assertEqual(opt(c["argv"], "--profile"), "dev")


class Grant(Base):
    def test_policy_has_one_resource_and_utc_expiry_in_an_hour(self):
        before = datetime.now(timezone.utc).replace(microsecond=0)
        cp = self.grant()
        self.assertEqual(cp.returncode, 0, cp.stderr)
        puts = [c for c in self.sb.writes() if c["op"] == "put-role-policy"]
        self.assertEqual(len(puts), 1)
        self.assertEqual(self.sb.writes(), puts)
        argv = puts[0]["argv"]
        self.assertEqual(opt(argv, "--role-name"), "AlarmOpsDeployCentral")
        self.assertEqual(opt(argv, "--policy-name"), POLICY)
        doc = json.loads(next(iter(puts[0]["files"].values())))
        self.assertEqual(len(doc["Statement"]), 1)
        st = doc["Statement"][0]
        self.assertEqual((st["Sid"], st["Effect"], st["Action"]),
                         ("TrustChangeOneRole", "Allow", "iam:UpdateAssumeRolePolicy"))
        self.assertEqual(st["Resource"], f"arn:aws:iam::{ACCT}:role/{ROLE}")
        stamp = st["Condition"]["DateLessThan"]["aws:CurrentTime"]
        self.assertRegex(stamp, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        exp = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        self.assertGreaterEqual(exp, before + timedelta(minutes=59))
        self.assertLessEqual(exp, datetime.now(timezone.utc) + timedelta(minutes=61))
        self.assertEqual(list(st["Condition"]), ["DateLessThan"])

    def test_prints_current_trust_policy_after_put(self):
        trust = {"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Principal": {"AWS": f"arn:aws:iam::{ACCT}:root"}, "Action": "sts:AssumeRole"}]}
        self.sb.set_scenario(role_trust={ROLE: trust})
        cp = self.grant()
        self.assertEqual(cp.returncode, 0, cp.stderr)
        calls = self.sb.calls()
        ops = [c["op"] for c in calls]
        self.assertLess(ops.index("put-role-policy"), ops.index("get-role"))
        self.assertEqual(opt(calls[ops.index("get-role")]["argv"], "--role-name"), ROLE)
        self.assertIn("sts:AssumeRole", cp.stdout)
        self.assertIn(f"{ACCT}:root", cp.stdout)

    def test_temp_policy_file_is_removed(self):
        self.grant()
        self.assertEqual(list((self.sb.dir / "tmp").iterdir()), [])


class Revoke(Base):
    def stack(self, status, policies=(POLICY,)):
        self.sb.set_scenario(stacks=[{"StackName": "alarmops-central", "StackStatus": status}],
                             role_policies={"AlarmOpsDeployCentral": list(policies)})

    def test_refused_while_in_progress_or_rollback_failed(self):
        for status in ("UPDATE_IN_PROGRESS", "CREATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
                       "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
                       "REVIEW_IN_PROGRESS", "UPDATE_ROLLBACK_FAILED"):
            with self.subTest(status=status):
                self.stack(status)
                cp = self.revoke()
                self.assertNotEqual(cp.returncode, 0)
                self.assertIn(status, cp.stderr)
                self.assertEqual(self.sb.writes(), [])

    def test_deleted_in_other_states(self):
        for status in ("UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "CREATE_COMPLETE"):
            with self.subTest(status=status):
                self.stack(status)
                self.assertEqual(self.revoke().returncode, 0)
        dels = [c for c in self.sb.writes() if c["op"] == "delete-role-policy"]
        self.assertEqual(len(dels), 3)
        self.assertEqual((opt(dels[0]["argv"], "--role-name"), opt(dels[0]["argv"], "--policy-name")),
                         ("AlarmOpsDeployCentral", POLICY))

    def test_unknown_stack_state_fails_closed(self):
        self.sb.set_scenario(stacks=[], role_policies={"AlarmOpsDeployCentral": [POLICY]})
        self.assertNotEqual(self.revoke().returncode, 0)
        self.assertEqual(self.sb.writes(), [])

    def test_already_absent_is_success_without_delete(self):
        self.stack("UPDATE_COMPLETE", policies=())
        cp = self.revoke()
        self.assertEqual(cp.returncode, 0)
        self.assertIn("이미 없다", cp.stdout)
        self.assertEqual(self.sb.writes(), [])

    def test_other_inline_policy_names_are_not_matched(self):
        self.stack("UPDATE_COMPLETE", policies=(POLICY + "-x", "x" + POLICY))
        self.assertEqual(self.revoke().returncode, 0)
        self.assertEqual(self.sb.writes(), [])


if __name__ == "__main__":
    unittest.main()
