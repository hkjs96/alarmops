"""Acceptance tests for the permission-rehearsal harness (#122): infra/scripts/rehearsal/*.sh.

Expected values come from the issue's acceptance criteria, never from running the scripts.
A fake `aws` (fake_aws.py) is put first in PATH and records every call; see rehearsal_support.py
for the CLI/env/file contract these tests assume.

Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import json
import subprocess
import unittest

from rehearsal_support import (
    ACCT, BAD_ENV, DENIED, EID, PROFILE, REGION, REPO, SCRIPTS, STACK, Sandbox,
    call_blob, mode, option_values,
)

ALL = ["preflight.sh", "install.sh", "verify.sh", "cleanup.sh"]
WRITERS = ["install.sh", "verify.sh", "cleanup.sh"]
RUN = "run-0001"


class Base(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.close)

    def args(self, script, **kw):
        return self.sb.good_args(script, run_id=kw.pop("run_id", RUN), **kw)

    def assertRejected(self, script, res, msg=""):
        self.assertNotEqual(res.code, 0, f"{script} must exit non-zero {msg}\n{res.text}")

    def make_run(self, run_id=RUN, **scen):
        """Run verify under the fake so a run log exists. Returns the queue names it created."""
        self.sb.set_scenario(**scen)
        self.sb.calls_file.unlink(missing_ok=True)
        self.sb.run("verify.sh", self.args("verify.sh", run_id=run_id))
        queues = [q for c in self.sb.calls() if (c["service"], c["op"]) == ("sqs", "create-queue")
                  for q in option_values(c["argv"], "--queue-name")]
        self.sb.calls_file.unlink(missing_ok=True)
        return queues


class ProfileGuard(Base):
    BAD = ["dev", "prod-x", "rehearsal-cust x", "", "Rehearsal-a", "rehearsal-", "rehearsal-a_b", "rehearsal-a;id"]

    def test_bad_profile_makes_no_aws_call(self):
        for script in ALL:
            for bad in self.BAD:
                with self.subTest(script=script, profile=bad):
                    self.sb.calls_file.unlink(missing_ok=True)
                    res = self.sb.run(script, self.args(script, profile=bad))
                    self.assertRejected(script, res)
                    self.assertEqual(self.sb.calls(), [])

    def test_missing_profile_makes_no_aws_call(self):
        for script in ALL:
            with self.subTest(script=script):
                self.sb.calls_file.unlink(missing_ok=True)
                res = self.sb.run(script, self.args(script, profile=None))
                self.assertRejected(script, res)
                self.assertEqual(self.sb.calls(), [])

    def test_valid_profile_is_not_rejected(self):
        """Control: the guard must not reject everything."""
        for script in ALL:
            with self.subTest(script=script):
                self.sb.calls_file.unlink(missing_ok=True)
                self.make_run() if script == "cleanup.sh" else None
                self.sb.run(script, self.args(script))
                self.assertIn(("sts", "get-caller-identity"), [(c["service"], c["op"]) for c in self.sb.calls()])


class AmbientCredentialGuard(Base):
    def test_ambient_credentials_or_agent_markers_are_refused(self):
        for script in ALL:
            for var in BAD_ENV:
                with self.subTest(script=script, var=var):
                    self.sb.calls_file.unlink(missing_ok=True)
                    res = self.sb.run(script, self.args(script), extra_env={var: "x"})
                    self.assertRejected(script, res)
                    self.assertEqual(self.sb.calls(), [])


class AccountGuard(Base):
    def reject_all(self, scripts=ALL, **kw):
        for script in scripts:
            with self.subTest(script=script):
                self.sb.calls_file.unlink(missing_ok=True)
                res = self.sb.run(script, self.args(script))
                self.assertRejected(script, res)
                self.assertEqual(self.sb.writes(), [], "no write call before the account is trusted")

    def test_identity_differs_from_local_table(self):
        self.sb.set_scenario(account="777777777777")   # table says rehearsal-a is ACCT
        self.reject_all()

    def test_profile_missing_from_local_table(self):
        self.sb.set_accounts(profiles={"rehearsal-b": "555555555555"})
        self.reject_all()

    def test_local_table_missing(self):
        self.sb.accounts_file.unlink()
        self.reject_all()

    def test_account_equals_central_dev_or_deny_list(self):
        for label, override in (("central", {"centralAccountId": ACCT}), ("dev", {"devAccountId": ACCT}),
                                ("deny", {"denyAccounts": [DENIED, ACCT]})):
            with self.subTest(case=label):
                self.sb.set_accounts(**override)
                self.reject_all()

    def test_account_equals_central_role_or_bus_arn_account(self):
        self.sb.set_accounts(centralRoleArn=f"arn:aws:iam::{ACCT}:role/AlarmOps-Central-Assume")
        self.reject_all(["install.sh"])
        self.sb.set_accounts(centralEventBusArn=f"arn:aws:events:{REGION}:{ACCT}:event-bus/alarmops-central")
        self.reject_all(["install.sh"])

    def test_confirmation_input_must_be_the_same_12_digits(self):
        for script in WRITERS:
            for bad in ("999999999999", ACCT[:-1], ACCT + "1", "", "abcdefghijkl"):
                with self.subTest(script=script, confirm=bad):
                    self.sb.calls_file.unlink(missing_ok=True)
                    res = self.sb.run(script, self.args(script, confirm=bad))
                    self.assertRejected(script, res)
                    self.assertEqual(self.sb.writes(), [])

    def test_missing_confirmation_is_refused(self):
        for script in WRITERS:
            with self.subTest(script=script):
                self.sb.calls_file.unlink(missing_ok=True)
                res = self.sb.run(script, self.args(script, confirm=None))
                self.assertRejected(script, res)
                self.assertEqual(self.sb.writes(), [])

    def test_matching_account_and_confirmation_proceed(self):
        """Control for the cases above."""
        res = self.sb.run("install.sh", self.args("install.sh"))
        self.assertEqual(res.code, 0, res.text)
        self.assertTrue([c for c in self.sb.writes() if c["service"] == "cloudformation"])


class ProfileAndRegionOnEveryCall(Base):
    def test_every_recorded_call_carries_the_same_profile_and_region(self):
        self.make_run(stacks=[{"StackName": STACK, "StackStatus": "CREATE_COMPLETE",
                               "Tags": [{"Key": "AlarmOpsRehearsal", "Value": "true"}]}])
        self.sb.set_scenario(stacks=[{"StackName": STACK, "StackStatus": "CREATE_COMPLETE",
                                      "Tags": [{"Key": "AlarmOpsRehearsal", "Value": "true"}]}])
        self.sb.run("preflight.sh", self.args("preflight.sh"))
        self.sb.run("install.sh", self.args("install.sh"))
        self.sb.run("verify.sh", self.args("verify.sh", run_id="run-0002"))
        self.sb.run("cleanup.sh", self.args("cleanup.sh", extra=["--stack"]))
        calls = self.sb.calls()
        self.assertGreater(len(calls), 8)
        for c in calls:
            with self.subTest(call=c["argv"]):
                self.assertEqual(option_values(c["argv"], "--profile"), [PROFILE])
                self.assertEqual(option_values(c["argv"], "--region"), [REGION])


class Preflight(Base):
    def test_validates_template_and_only_reads(self):
        res = self.sb.run("preflight.sh", self.args("preflight.sh"))
        self.assertEqual(res.code, 0, res.text)
        ops = [(c["service"], c["op"]) for c in self.sb.calls()]
        self.assertIn(("cloudformation", "validate-template"), ops)
        self.assertIn(("cloudformation", "describe-stacks"), ops)
        self.assertEqual(self.sb.writes(), [])


class SecretHandling(Base):
    STACKS = [{"StackName": STACK, "StackStatus": "CREATE_COMPLETE",
               "StackStatusReason": f"parameter ExternalId={EID} rejected",
               "Tags": [{"Key": "AlarmOpsRehearsal", "Value": "true"}],
               "Parameters": [{"ParameterKey": "ExternalId", "ParameterValue": EID}]}]

    def run_all(self, **scen):
        results = {}
        self.sb.set_scenario(stacks=self.STACKS, **scen)
        results["preflight.sh"] = self.sb.run("preflight.sh", self.args("preflight.sh"))
        results["install.sh"] = self.sb.run("install.sh", self.args("install.sh"))
        results["verify.sh"] = self.sb.run("verify.sh", self.args("verify.sh"))
        results["cleanup.sh"] = self.sb.run("cleanup.sh", self.args("cleanup.sh", extra=["--stack"]))
        return results

    def assert_no_leak(self, results):
        for script, res in results.items():
            with self.subTest(script=script):
                self.assertNotIn(EID, res.out, "stdout")
                self.assertNotIn(EID, res.err, "stderr")
        for c in self.sb.calls():
            self.assertNotIn(EID, " ".join(c["argv"]), f"aws argv of {c['service']} {c['op']}")
        for p in self.sb.log_files():
            self.assertNotIn(EID, p.read_text(encoding="utf-8", errors="replace"), str(p))
            self.assertEqual(mode(p), 0o600, f"{p} must be 600")

    def test_external_id_never_shown_when_aws_echoes_it(self):
        results = self.run_all(leak=EID)
        self.assert_no_leak(results)
        self.assertTrue(self.sb.log_files(), "verify must write a log under rehearsal-logs")

    def test_external_id_never_shown_when_aws_calls_fail_with_it(self):
        results = self.run_all(fail_writes=EID)
        self.assert_no_leak(results)

    def test_external_id_is_still_delivered_to_cloudformation(self):
        """Control: hiding the value must not mean dropping it (it travels in a file or stdin, not argv)."""
        self.sb.set_scenario()
        res = self.sb.run("install.sh", self.args("install.sh"))
        self.assertEqual(res.code, 0, res.text)
        stack_calls = [c for c in self.sb.writes() if c["service"] == "cloudformation"]
        self.assertTrue(stack_calls)
        self.assertTrue(any(EID in call_blob(c) for c in stack_calls), "ExternalId never reached CloudFormation")

    def test_install_requires_external_id(self):
        res = self.sb.run("install.sh", self.args("install.sh"), external_id=None)
        self.assertRejected("install.sh", res)
        self.assertEqual(self.sb.writes(), [])


def alarm(name, queue, tags, dim="QueueName"):
    return {"AlarmName": name, "Namespace": "AWS/SQS", "MetricName": "ApproximateNumberOfMessagesVisible",
            "Dimensions": [{"Name": dim, "Value": queue}], "tags": tags}


class CleanupScope(Base):
    def prepare(self):
        q1 = self.make_run("run-one")
        q2 = self.make_run("run-two")
        self.assertEqual(len(q1), 1, "verify must create exactly one test queue")
        self.assertEqual(len(q2), 1)
        self.assertNotEqual(q1, q2, "queue name must be unique per run id")
        return q1[0], q2[0]

    def scenario(self, q1, q2, q1_tags=None):
        mine = {"AlarmOpsRehearsal": "true"} if q1_tags is None else q1_tags
        return dict(
            queues={q1: {"tags": mine}, q2: {"tags": {"AlarmOpsRehearsal": "true"}},
                    "customer-prod-queue": {"tags": {"Team": "x"}}, "untagged-queue": {}},
            alarms=[
                alarm("alarm-own-q1", q1, {"ManagedBy": "AlarmOps"}),
                alarm("alarm-untagged-q1", q1, {}),
                alarm("alarm-manager-q1", q1, {"ManagedBy": "AlarmManager"}),
                alarm("alarm-own-q2", q2, {"ManagedBy": "AlarmOps"}),
                alarm("alarm-own-otherq", "customer-prod-queue", {"ManagedBy": "AlarmOps"}),
                alarm("alarm-own-instance", "i-0abc", {"ManagedBy": "AlarmOps"}, dim="InstanceId"),
            ])

    def deleted_alarms(self):
        blobs = [call_blob(c) for c in self.sb.calls() if c["op"] == "delete-alarms"]
        names = ["alarm-own-q1", "alarm-untagged-q1", "alarm-manager-q1", "alarm-own-q2",
                 "alarm-own-otherq", "alarm-own-instance"]
        return {n for n in names if any(n in b for b in blobs)}

    def deleted_queues(self):
        return {u.rsplit("/", 1)[-1] for c in self.sb.calls() if c["op"] == "delete-queue"
                for u in option_values(c["argv"], "--queue-url")}

    def test_deletes_only_managedby_alarmops_alarms_of_the_runs_queue(self):
        q1, q2 = self.prepare()
        self.sb.set_scenario(**self.scenario(q1, q2))
        res = self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
        self.assertEqual(res.code, 0, res.text)
        self.assertEqual(self.deleted_alarms(), {"alarm-own-q1"})

    def test_deletes_only_the_tagged_queue_of_the_run(self):
        q1, q2 = self.prepare()
        self.sb.set_scenario(**self.scenario(q1, q2))
        self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
        self.assertEqual(self.deleted_queues(), {q1})

    def test_queue_without_rehearsal_tag_is_kept_even_if_in_the_run_log(self):
        q1, q2 = self.prepare()
        for tags in ({}, {"AlarmOpsRehearsal": "false"}, {"Monitoring": "on"}):
            with self.subTest(tags=tags):
                self.sb.calls_file.unlink(missing_ok=True)
                self.sb.set_scenario(**self.scenario(q1, q2, q1_tags=tags))
                self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
                self.assertEqual(self.deleted_queues(), set())

    def test_unknown_run_id_deletes_nothing(self):
        q1, q2 = self.prepare()
        self.sb.set_scenario(**self.scenario(q1, q2))
        self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="no-such-run"))
        self.assertEqual(self.deleted_alarms(), set())
        self.assertEqual(self.deleted_queues(), set())


class CleanupStackScope(Base):
    def stack(self, name=STACK, tags=None):
        return {"StackName": name, "StackStatus": "CREATE_COMPLETE",
                "Tags": [{"Key": k, "Value": v} for k, v in (tags or {}).items()]}

    def delete_stack_calls(self, stacks, extra):
        self.make_run()
        self.sb.set_scenario(stacks=stacks)
        self.sb.run("cleanup.sh", self.args("cleanup.sh", extra=extra))
        return [c for c in self.sb.calls() if c["op"] == "delete-stack"]

    def test_without_stack_flag_no_delete_stack(self):
        calls = self.delete_stack_calls([self.stack(tags={"AlarmOpsRehearsal": "true"})], [])
        self.assertEqual(calls, [])

    def test_tagged_alarmops_customer_stack_is_deleted_once(self):
        calls = self.delete_stack_calls([self.stack(tags={"AlarmOpsRehearsal": "true"})], ["--stack"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(option_values(calls[0]["argv"], "--stack-name"), [STACK])

    def test_untagged_or_wrongly_tagged_stack_is_kept(self):
        for tags in ({}, {"AlarmOpsRehearsal": "false"}, {"Other": "true"}):
            with self.subTest(tags=tags):
                self.sb.calls_file.unlink(missing_ok=True)
                self.assertEqual(self.delete_stack_calls([self.stack(tags=tags)], ["--stack"]), [])

    def test_other_stack_name_is_kept_even_if_tagged(self):
        other = self.stack(name="someone-elses-stack", tags={"AlarmOpsRehearsal": "true"})
        self.assertEqual(self.delete_stack_calls([other], ["--stack", "--stack-name", "someone-elses-stack"]), [])
        self.assertEqual(self.delete_stack_calls([other], ["--stack"]), [])

    def test_missing_stack_is_not_deleted(self):
        self.assertEqual(self.delete_stack_calls([], ["--stack"]), [])


class VerifySimulation(Base):
    def sim(self, with_tag, without_tag):
        self.sb.calls_file.unlink(missing_ok=True)
        self.sb.set_scenario(simulate={"with_request_tag": with_tag, "without_request_tag": without_tag})
        self.sb.run("verify.sh", self.args("verify.sh"))
        rows = [l for l in self.sb.report(RUN).splitlines() if "(라)" in l]
        return rows

    def test_allowed_control_missing_is_fail(self):
        rows = self.sim("implicitDeny", "implicitDeny")
        self.assertTrue(rows, "report needs a (라) row")
        self.assertTrue(any("FAIL" in r for r in rows), rows)

    def test_allowed_control_present_is_not_fail(self):
        rows = self.sim("allowed", "implicitDeny")
        self.assertTrue(rows, "report needs a (라) row")
        self.assertFalse(any("FAIL" in r for r in rows), rows)
        self.assertTrue(any("PASS" in r for r in rows), rows)

    def test_request_without_managedby_being_allowed_is_fail(self):
        rows = self.sim("allowed", "allowed")
        self.assertTrue(any("FAIL" in r for r in rows), rows)

    def test_both_conditions_are_simulated_on_the_alarm_writer_role(self):
        self.sim("allowed", "implicitDeny")
        calls = [c for c in self.sb.calls() if c["op"] == "simulate-principal-policy"]
        self.assertTrue(any("aws:RequestTag/ManagedBy" in call_blob(c) for c in calls), "control missing")
        self.assertTrue(any("aws:RequestTag/ManagedBy" not in call_blob(c) for c in calls), "negative missing")
        for c in calls:
            self.assertIn("cloudwatch:PutMetricAlarm", call_blob(c))
            src = option_values(c["argv"], "--policy-source-arn")
            self.assertEqual(len(src), 1)
            self.assertTrue(src[0].startswith(f"arn:aws:iam::{ACCT}:role/") and
                            src[0].endswith("AlarmOps-AlarmWriter"), src)

    def test_every_simulate_call_has_resource_arns(self):
        self.sim("allowed", "implicitDeny")
        calls = [c for c in self.sb.calls() if c["op"] == "simulate-principal-policy"]
        self.assertTrue(calls)
        for c in calls:
            self.assertTrue(option_values(c["argv"], "--resource-arns"), c["argv"])

    def test_implicit_and_explicit_deny_are_recorded_distinctly(self):
        rows = " ".join(self.sim("allowed", "implicitDeny"))
        self.assertIn("implicitDeny", rows)
        self.assertNotIn("explicitDeny", rows)
        rows = " ".join(self.sim("allowed", "explicitDeny"))
        self.assertIn("explicitDeny", rows)
        self.assertNotIn("implicitDeny", rows)

    def test_report_says_simulation_is_not_a_real_measurement(self):
        self.sim("allowed", "implicitDeny")
        self.assertIn("정책 시뮬레이션(실측 아님)", self.sb.report(RUN))

    def test_report_file_is_under_log_dir_profile_and_mode_600(self):
        self.sim("allowed", "implicitDeny")
        p = self.sb.log_dir / PROFILE / f"{RUN}.md"
        self.assertTrue(p.is_file(), p)
        self.assertEqual(mode(p), 0o600)


class GitIgnore(unittest.TestCase):
    def ignored(self, path):
        return subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", path]).returncode == 0

    def test_gitignore_lists_both_entries(self):
        lines = [l.strip() for l in (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(l.rstrip("/").endswith("accounts.local.json") for l in lines), lines)
        self.assertTrue(any(l.rstrip("/").endswith("rehearsal-logs") for l in lines), lines)

    def test_check_ignore_succeeds_for_both(self):
        self.assertTrue(self.ignored("infra/scripts/rehearsal/accounts.local.json"))
        self.assertTrue(self.ignored("rehearsal-logs/rehearsal-a/run-0001.md"))

    def test_scripts_exist(self):
        for name in ("common.sh", *ALL):
            self.assertTrue((SCRIPTS / name).is_file(), name)


if __name__ == "__main__":
    unittest.main()
