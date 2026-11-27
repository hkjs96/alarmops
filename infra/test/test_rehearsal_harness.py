"""Acceptance tests for the permission-rehearsal harness (#122): infra/scripts/rehearsal/*.sh.

Expected values come from the issue's acceptance criteria, never from running the scripts.
A fake `aws` (fake_aws.py) is put first in PATH and records every call; see rehearsal_support.py
for the CLI/env/file contract these tests assume.

Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import re
import subprocess
import unittest

from rehearsal_support import (
    ACCT, BAD_ENV, DENIED, EID, PROFILE, REGION, REPO, SCRIPTS, STACK, Sandbox,
    alarm_names, call_blob, mode, option_values,
)

ALL = ["preflight.sh", "install.sh", "verify.sh", "cleanup.sh"]
WRITERS = ["install.sh", "verify.sh", "cleanup.sh"]
RUN = "run-0001"


def alarm(name, queue, tags, dim="QueueName"):
    return {"AlarmName": name, "Namespace": "AWS/SQS", "MetricName": "ApproximateNumberOfMessagesVisible",
            "Dimensions": [{"Name": dim, "Value": queue}], "tags": tags}


def rich_scenario(q1, q2, q1_tags=None, stack_tags=None):
    """Customer account holding the run's queues next to things cleanup must never touch.

    Only alarm-own-q1 may be deleted for run-one. alarm-own-instance carries the SAME VALUE as the
    queue name but under dimension InstanceId, so only a check of the dimension NAME can exclude it.
    """
    mine = {"AlarmOpsRehearsal": "true", "AlarmOpsRehearsalRun": "run-one"} if q1_tags is None else q1_tags
    return dict(
        stacks=[{"StackName": STACK, "StackStatus": "CREATE_COMPLETE",
                 "Tags": [{"Key": "AlarmOpsRehearsal", "Value": "true"}] if stack_tags is None else stack_tags}],
        queues={q1: {"tags": mine}, q2: {"tags": {"AlarmOpsRehearsal": "true", "AlarmOpsRehearsalRun": "run-two"}},
                "customer-prod-queue": {"tags": {"Team": "x"}}, "untagged-queue": {}},
        alarms=[
            alarm("alarm-own-q1", q1, {"ManagedBy": "AlarmOps"}),
            alarm("alarm-untagged-q1", q1, {}),
            alarm("alarm-manager-q1", q1, {"ManagedBy": "AlarmManager"}),
            alarm("alarm-own-q2", q2, {"ManagedBy": "AlarmOps"}),
            alarm("alarm-own-otherq", "customer-prod-queue", {"ManagedBy": "AlarmOps"}),
            alarm("alarm-own-instance", q1, {"ManagedBy": "AlarmOps"}, dim="InstanceId"),
        ])


class Base(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.close)
        self.addCleanup(self.assert_queries_supported)

    def assert_queries_supported(self):
        """The fake aws implements a JMESPath subset; an expression outside it must fail the test
        (not silently return unfiltered data) regardless of what the script does with the exit code."""
        marker = self.sb.calls_file.with_name(self.sb.calls_file.name + ".unsupported-query")
        if marker.exists():
            self.fail("fake aws met an unsupported --query expression:\n" + marker.read_text(encoding="utf-8"))

    def args(self, script, **kw):
        return self.sb.good_args(script, run_id=kw.pop("run_id", RUN), **kw)

    def assertAllScoped(self, calls=None, expect_some=True):
        """Every recorded aws call (sts identity checks included) names this profile and ap-northeast-2."""
        calls = self.sb.calls() if calls is None else calls
        if expect_some:
            self.assertTrue(calls, "no aws call recorded; the check would be vacuous")
        for c in calls:
            self.assertEqual(option_values(c["argv"], "--profile"), [PROFILE], c["argv"])
            self.assertEqual(option_values(c["argv"], "--region"), [REGION], c["argv"])

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
    """Every script is armed so that, were the guard missing, it WOULD write or delete: cleanup gets a real
    run log plus a customer account holding that run's queue/alarms/stack; verify/install have normal inputs.
    Each rejection is therefore only explainable by the account/confirmation check itself."""

    def setUp(self):
        super().setUp()
        q1, q2 = self.make_run("run-one"), self.make_run("run-two")   # run logs exist; accounts still valid
        self.assertEqual((len(q1), len(q2)), (1, 1), "verify must create one test queue per run")
        self.q1, self.q2 = q1[0], q2[0]

    def arm(self, **overrides):
        """Scenario for the next runs: deletable things exist for run-one (account may be overridden)."""
        self.sb.set_scenario(**{**rich_scenario(self.q1, self.q2), **overrides})

    def args_for(self, script, **kw):
        return self.args(script, run_id="run-one" if script == "cleanup.sh" else RUN,
                         extra=["--stack"] if script == "cleanup.sh" else [], **kw)

    def test_armed_cleanup_really_deletes_with_valid_inputs(self):
        """Control: without this, the rejection tests below could pass because cleanup has nothing to do."""
        self.arm()
        self.sb.calls_file.unlink(missing_ok=True)
        res = self.sb.run("cleanup.sh", self.args_for("cleanup.sh"))
        self.assertEqual(res.code, 0, res.text)
        ops = {c["op"] for c in self.sb.writes()}
        self.assertTrue({"delete-alarms", "delete-queue", "delete-stack"} <= ops, ops)

    def reject_all(self, scripts=ALL, confirm=ACCT):
        for script in scripts:
            with self.subTest(script=script):
                self.sb.calls_file.unlink(missing_ok=True)
                res = self.sb.run(script, self.args_for(script, confirm=confirm))
                self.assertRejected(script, res)
                self.assertEqual(self.sb.writes(), [], "no write or delete call before the account is trusted")
                self.assertAllScoped(expect_some=False)   # the sts call made before rejecting counts too

    def test_identity_differs_from_local_table(self):
        self.arm(account="777777777777")   # table says rehearsal-a is ACCT
        self.reject_all()
        self.assertIn(("sts", "get-caller-identity"), [(c["service"], c["op"]) for c in self.sb.calls()])
        self.assertAllScoped()

    def test_profile_missing_from_local_table(self):
        self.sb.set_accounts(profiles={"rehearsal-b": "555555555555"})
        self.arm()
        self.reject_all()

    def test_local_table_missing(self):
        self.sb.accounts_file.unlink()
        self.arm()
        self.reject_all()

    def test_account_equals_central_dev_or_deny_list(self):
        for label, override in (("central", {"centralAccountId": ACCT}), ("dev", {"devAccountId": ACCT}),
                                ("deny", {"denyAccounts": [DENIED, ACCT]})):
            with self.subTest(case=label):
                self.sb.set_accounts(**override)
                self.arm()
                self.reject_all()

    def test_account_equals_central_role_or_bus_arn_account(self):
        """All four scripts, not just install."""
        self.sb.set_accounts(centralRoleArn=f"arn:aws:iam::{ACCT}:role/AlarmOps-Central-Assume")
        self.arm()
        self.reject_all(ALL)
        self.sb.set_accounts(centralEventBusArn=f"arn:aws:events:{REGION}:{ACCT}:event-bus/alarmops-central")
        self.arm()
        self.reject_all(ALL)

    def test_confirmation_input_must_be_the_same_12_digits(self):
        self.arm()
        for bad in ("999999999999", ACCT[:-1], ACCT + "1", "", "abcdefghijkl"):
            with self.subTest(confirm=bad):
                self.reject_all(WRITERS, confirm=bad)

    def test_missing_confirmation_is_refused(self):
        self.arm()
        self.reject_all(WRITERS, confirm=None)

    def test_matching_account_and_confirmation_proceed(self):
        """Control for the cases above."""
        self.arm()
        res = self.sb.run("install.sh", self.args("install.sh"))
        self.assertEqual(res.code, 0, res.text)
        self.assertTrue([c for c in self.sb.writes() if c["service"] == "cloudformation"])


class ProfileAndRegionOnEveryCall(Base):
    def test_every_recorded_call_carries_the_same_profile_and_region(self):
        """Runs the destructive paths too: delete-alarms, delete-queue, delete-stack must be exercised."""
        runs = [self.make_run("run-one"), self.make_run("run-two")]
        self.assertTrue(all(len(r) == 1 for r in runs), "verify must create one test queue per run")
        (q1,), (q2,) = runs
        self.sb.set_scenario(**rich_scenario(q1, q2))
        self.sb.run("preflight.sh", self.args("preflight.sh"))
        self.sb.run("install.sh", self.args("install.sh"))
        self.sb.run("verify.sh", self.args("verify.sh", run_id="run-0002"))
        self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one", extra=["--stack"]))
        calls = self.sb.calls()
        self.assertGreater(len(calls), 8)
        ops = {c["op"] for c in calls}
        for needed in ("delete-alarms", "delete-queue", "delete-stack", "create-queue"):
            self.assertIn(needed, ops, f"scenario did not reach {needed}; the sweep would miss it")
        self.assertAllScoped(calls)


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
        results, self.calls_by = {}, {}
        self.sb.set_scenario(stacks=self.STACKS, **scen)
        for script, extra in (("preflight.sh", []), ("install.sh", []), ("verify.sh", []),
                              ("cleanup.sh", ["--stack"])):
            before = len(self.sb.calls())
            results[script] = self.sb.run(script, self.args(script, extra=extra))
            self.calls_by[script] = self.sb.calls()[before:]
        return results

    def assert_scenario_really_ran(self, channel):
        """Contrast check, before the absence check: the secret-echoing path was executed for every script
        and each writer got as far as a write call. Otherwise an early exit on input validation would
        make `EID not in output` pass vacuously."""
        for script, calls in self.calls_by.items():
            with self.subTest(contrast=script):
                self.assertTrue(calls, f"{script} made no aws call")
                self.assertTrue(any(channel in c["echo"] for c in calls),
                                f"{script}: the {channel} path of the fake aws never ran")
        want = {"install.sh": ("cloudformation", ("create-stack", "update-stack", "deploy", "create-change-set")),
                "verify.sh": ("sqs", ("create-queue",)),
                "cleanup.sh": ("cloudformation", ("delete-stack",))}
        for script, (svc, ops) in want.items():
            with self.subTest(write=script):
                self.assertTrue([c for c in self.calls_by[script] if c["service"] == svc and c["op"] in ops],
                                f"{script} never reached its write call ({svc} {ops})")
        self.assertIn(("cloudformation", "describe-stacks"),
                      [(c["service"], c["op"]) for c in self.calls_by["preflight.sh"]])

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
        self.assert_scenario_really_ran("stderr-warning")
        self.assert_describe_stacks_returned_secret()
        self.assert_no_leak(results)
        self.assertTrue(self.sb.log_files(), "verify must write a log under rehearsal-logs")

    def test_external_id_never_shown_when_aws_calls_fail_with_it(self):
        results = self.run_all(fail_writes=EID, fail_reads=EID)   # preflight has no writes: reads must fail too
        self.assert_scenario_really_ran("error-response")
        self.assert_describe_stacks_returned_secret()
        self.assert_no_leak(results)

    def assert_describe_stacks_returned_secret(self):
        """The fake marks 'describe-stacks' only when the response body it printed (after --query) really
        contained the secret, so this proves a script received it, not merely that it called describe-stacks."""
        hits = [(s, c) for s, calls in self.calls_by.items() for c in calls
                if (c["service"], c["op"]) == ("cloudformation", "describe-stacks") and "describe-stacks" in c["echo"]]
        self.assertTrue(hits, "no describe-stacks response carried the ExternalId to any script")

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


class CleanupScope(Base):
    def prepare(self):
        q1 = self.make_run("run-one")
        q2 = self.make_run("run-two")
        self.assertEqual(len(q1), 1, "verify must create exactly one test queue")
        self.assertEqual(len(q2), 1)
        self.assertNotEqual(q1, q2, "queue name must be unique per run id")
        return q1[0], q2[0]

    def scenario(self, q1, q2, q1_tags=None):
        return rich_scenario(q1, q2, q1_tags)

    def deleted_alarms(self):
        """Exact set of names passed to delete-alarms (verbatim, so '*' or unknown names are visible)."""
        out = set()
        for c in self.sb.calls():
            if c["op"] == "delete-alarms":
                names = alarm_names(c)
                self.assertTrue(names, f"delete-alarms without recognisable --alarm-names: {c['argv']}")
                out.update(names)
        return out

    def deleted_queues(self):
        return {u.rsplit("/", 1)[-1] for c in self.sb.calls() if c["op"] == "delete-queue"
                for u in option_values(c["argv"], "--queue-url")}

    def test_deletes_only_managedby_alarmops_alarms_of_the_runs_queue(self):
        q1, q2 = self.prepare()
        self.sb.set_scenario(**self.scenario(q1, q2))
        res = self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
        self.assertEqual(res.code, 0, res.text)
        self.assertEqual(self.deleted_alarms(), {"alarm-own-q1"})
        self.assertAllScoped()

    def test_deletes_only_the_tagged_queue_of_the_run(self):
        q1, q2 = self.prepare()
        self.sb.set_scenario(**self.scenario(q1, q2))
        self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
        self.assertEqual(self.deleted_queues(), {q1})
        self.assertAllScoped()

    def test_queue_without_rehearsal_tag_is_kept_even_if_in_the_run_log(self):
        q1, q2 = self.prepare()
        for tags in ({}, {"AlarmOpsRehearsal": "false"}, {"Monitoring": "on"},
                     {"AlarmOpsRehearsal": "true"}, {"AlarmOpsRehearsal": "true", "AlarmOpsRehearsalRun": "other"}):
            with self.subTest(tags=tags):
                self.sb.calls_file.unlink(missing_ok=True)
                self.sb.set_scenario(**self.scenario(q1, q2, q1_tags=tags))
                self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
                self.assertEqual(self.deleted_queues(), set())
                self.assertEqual(self.deleted_alarms(), set(), "not owned: its alarms must stay too")

    def test_ownership_is_checked_before_any_alarm_is_deleted(self):
        q1, q2 = self.prepare()
        self.sb.set_scenario(**self.scenario(q1, q2))
        self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
        ops = [c["op"] for c in self.sb.calls()]
        self.assertIn("list-queue-tags", ops)
        self.assertLess(ops.index("list-queue-tags"), ops.index("delete-alarms"))

    def test_alarm_lookup_failure_stops_deleting_and_exits_nonzero(self):
        q1, q2 = self.prepare()
        for failing in ("cloudwatch describe-alarms", "cloudwatch list-tags-for-resource"):
            with self.subTest(failing=failing):
                self.sb.calls_file.unlink(missing_ok=True)
                self.sb.set_scenario(**self.scenario(q1, q2), fail_ops=[failing])
                res = self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
                self.assertNotEqual(res.code, 0, res.text)
                self.assertEqual(self.deleted_alarms(), set())
                self.assertEqual(self.deleted_queues(), set())

    def test_alarm_lookup_is_retried_once(self):
        q1, q2 = self.prepare()
        self.sb.calls_file.unlink(missing_ok=True)
        self.sb.set_scenario(**self.scenario(q1, q2), fail_nth={"cloudwatch describe-alarms": 1})
        res = self.sb.run("cleanup.sh", self.args("cleanup.sh", run_id="run-one"))
        self.assertEqual(res.code, 0, res.text)
        self.assertTrue(self.deleted_alarms(), "the second lookup succeeded, so the run's alarms are deleted")

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


class TempFiles(Base):
    def test_no_tmp_file_holding_the_external_id_survives(self):
        for script, extra in (("preflight.sh", []), ("install.sh", []), ("verify.sh", []), ("cleanup.sh", ["--stack"])):
            with self.subTest(script=script):
                self.sb.set_scenario(stacks=[{"StackName": STACK, "StackStatus": "CREATE_COMPLETE",
                                              "Tags": [{"Key": "AlarmOpsRehearsal", "Value": "true"}]}],
                                     fail_writes=EID, leak=EID)
                self.sb.run(script, self.args(script, extra=extra))
                self.sb.set_scenario()
                self.sb.run(script, self.args(script, extra=extra))
                left = [p for p in (self.sb.dir / "tmp").rglob("*") if p.is_file()]
                self.assertEqual([p for p in left if EID in p.read_text(errors="replace")], [], left)
                self.assertEqual(left, [], "no temp file of any kind may remain")

    def test_install_really_wrote_the_input_file_before_it_was_removed(self):
        """Control: the file existed (its content was captured by the fake) and is gone afterwards."""
        self.sb.set_scenario()
        self.sb.run("install.sh", self.args("install.sh"))
        stack_calls = [c for c in self.sb.writes() if c["service"] == "cloudformation"]
        self.assertTrue(any(EID in call_blob(c) for c in stack_calls))


class VerifyInteractive(Base):
    """Feed y to the human gates through stdin."""
    YES = "y\n" * 6

    def run_verify(self, stdin="", **scen):
        self.sb.set_scenario(**scen)
        res = self.sb.run("verify.sh", self.args("verify.sh"), stdin_text=stdin)
        return res, self.sb.report(RUN)

    @staticmethod
    def row(report, label):
        return [l for l in report.splitlines() if label in l]

    def test_noninteractive_skip_exits_2_and_says_so(self):
        res, rep = self.run_verify()
        self.assertEqual(res.code, 2, res.text)
        self.assertIn("SKIP 있음", rep)
        self.assertIn("SKIP 있음", res.out)

    def test_baseline_prior_failures_alone_are_not_pass(self):
        """Failures that existed before tag-queue (constant counters) must not satisfy (가)."""
        res, rep = self.run_verify("y\ny\n", metric_sums={"Invocations": {"start": 5, "step": 0},
                                                           "FailedInvocations": {"start": 3, "step": 0}})
        row = self.row(rep, "(가)")
        self.assertTrue(row)
        self.assertFalse(any("PASS" in r for r in row), row)
        self.assertTrue(any("TIMEOUT" in r for r in row), row)

    def test_only_failed_growing_without_invocations_is_not_pass(self):
        res, rep = self.run_verify("y\ny\n", metric_sums={"Invocations": {"start": 5, "step": 0},
                                                           "FailedInvocations": {"start": 3, "step": 1}})
        self.assertFalse(any("PASS" in r for r in self.row(rep, "(가)")))

    def test_both_metrics_growing_after_tag_is_pass(self):
        res, rep = self.run_verify("y\ny\n", metric_sums={"Invocations": {"start": 5, "step": 1},
                                                           "FailedInvocations": {"start": 3, "step": 1}})
        self.assertTrue(any("PASS" in r for r in self.row(rep, "(가)")), rep)

    def test_already_allowed_skips_a_and_runs_b(self):
        """11/25 rehearsal-b rerun: answering N to (가) must still offer (나) when the account is already allowed."""
        res, rep = self.run_verify("n\ny\n" + "y\n" * 4)
        self.assertTrue(any("SKIP" in r for r in self.row(rep, "(가)")), rep)
        self.assertFalse(any("허용 목록 추가 확인 없음" in r for r in self.row(rep, "(나)")), rep)
        ops = [(c["service"], c["op"]) for c in self.sb.calls()]
        self.assertIn(("sqs", "tag-queue"), ops)

    def test_already_allowed_no_still_skips_b(self):
        res, rep = self.run_verify("n\nn\n")
        self.assertTrue(any("허용 목록 추가 확인 없음" in r for r in self.row(rep, "(나)")), rep)

    def test_no_datapoints_is_zero_not_a_shell_error(self):
        """11/25 rehearsal-b: a rule with no datapoints gave an empty value and `[: : integer expression expected`."""
        res, rep = self.run_verify("y\ny\n")
        self.assertNotIn("integer expression expected", res.text)
        row = self.row(rep, "(가)")
        self.assertTrue(any("TIMEOUT" in r for r in row), row)
        self.assertIn("기준 0/0", " ".join(row))

    def test_empty_baseline_then_growth_is_pass(self):
        res, rep = self.run_verify("y\ny\n", metric_sums={"Invocations": {"start": 0, "step": 1, "empty_first": True},
                                                           "FailedInvocations": {"start": 0, "step": 1, "empty_first": True}})
        self.assertNotIn("integer expression expected", res.text)
        self.assertTrue(any("PASS" in r for r in self.row(rep, "(가)")), rep)

    def test_baseline_is_measured_before_tag_queue(self):
        self.run_verify("y\n", metric_sums={"Invocations": {"start": 1, "step": 1},
                                            "FailedInvocations": {"start": 1, "step": 1}})
        ops = [(c["service"], c["op"]) for c in self.sb.calls()]
        self.assertLess(ops.index(("cloudwatch", "get-metric-statistics")), ops.index(("sqs", "tag-queue")))

    def test_metric_lookup_failure_is_fail_not_zero(self):
        res, rep = self.run_verify("y\ny\n", fail_ops=["cloudwatch get-metric-statistics"])
        row = self.row(rep, "(가)")
        self.assertTrue(any("FAIL" in r for r in row), row)
        self.assertFalse(any("PASS" in r for r in row), row)

    GROW = {"Invocations": {"start": 5, "step": 1}, "FailedInvocations": {"start": 3, "step": 1}}

    def test_alarm_lookup_failure_is_not_reported_as_absent_or_pass(self):
        for failing in ("cloudwatch describe-alarms", "cloudwatch list-tags-for-resource"):
            with self.subTest(failing=failing):
                alarms = [alarm("a1", "alarmops-rehearsal-" + RUN, {"ManagedBy": "AlarmOps"})]
                res, rep = self.run_verify(self.YES, metric_sums=self.GROW, alarms=alarms, fail_ops=[failing])
                row = self.row(rep, "(나)")
                self.assertTrue(any("FAIL" in r and "오류" in r for r in row), row)
                self.assertFalse(any("PASS" in r or "TIMEOUT" in r for r in row), row)
                self.assertNotEqual(res.code, 0)

    def test_untag_keeps_the_queues_alarm_set_and_other_alarms_do_not_matter(self):
        q = "alarmops-rehearsal-" + RUN
        alarms = [alarm("a1", q, {"ManagedBy": "AlarmOps"}), alarm("other", "x", {"ManagedBy": "AlarmOps"})]
        res, rep = self.run_verify(self.YES, metric_sums=self.GROW, alarms=alarms)
        row = self.row(rep, "(다)")
        self.assertTrue(row, rep)
        self.assertTrue(any("SKIP" in r or "TIMEOUT" in r for r in row), row)   # fake never deletes; no PASS
        self.assertFalse(any("D-16" in r for r in row), row)

    def test_untag_tells_the_person_not_to_press_stop_while_waiting(self):
        # 11/26 b7: Stop pressed during the keep window deleted the alarms and read as a D-16 violation.
        q = "alarmops-rehearsal-" + RUN
        res, _ = self.run_verify(self.YES, metric_sums=self.GROW, alarms=[alarm("a1", q, {"ManagedBy": "AlarmOps"})])
        self.assertIn("Stop monitoring 을 누르지 마세요", res.err)
        notice, ask = res.err.find("누르지 마세요"), res.err.find("(다) 대기 끝")
        self.assertTrue(0 <= notice < ask, res.err)       # the warning comes first, the ask only after the wait
        self.assertNotIn("누르지 마세요", res.out)          # human guidance stays out of the report table


class GoLiveDoc(unittest.TestCase):
    """D-16: a tag that disappears must not delete the alarm; the console shows it as needing review."""

    def sentences(self):
        text = (REPO / "docs" / "GO-LIVE.md").read_text(encoding="utf-8")
        return [s for s in re.split(r"(?<=[.!?。])\s+|\n", text) if "태그를 떼" in s]

    def test_tag_removal_sentence_follows_d16(self):
        found = self.sentences()
        self.assertTrue(found, "GO-LIVE.md should still say what happens when the tag is removed")
        for s in found:
            with self.subTest(sentence=s):
                self.assertIsNone(re.search(r"태그를 떼면\s*(맞춰서\s*)?(정리|삭제|지운|지워)", s),
                                  "old behaviour (delete on untag) contradicts D-16")
                self.assertTrue("확인 필요" in s or "NEEDS_REVIEW" in s, "must mention the review state")
                self.assertTrue("남" in s or "지우지 않" in s, "must say the alarm stays")


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
