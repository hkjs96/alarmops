"""Tests for `replica-check.sh --probe-resource-tag-deny`: measures whether an explicit Deny on aws:ResourceTag/ManagedBy
can block overwriting an untagged alarm without blocking creation of a new alarm. Fake aws only (fake_aws.py models
both hypotheses via the scenario flag cw_create_resource_tags = "request" | "absent").

Run from the repo root:  python -m pytest -q infra/test/test_replica_probe.py
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import fake_aws
from rehearsal_support import ACCT, PROFILE, REPO
from test_replica_check import (CRED_VALUES, POLICY, POLICY_NAME, REPLICA, SCRIPT, TEST_ALARM, UNMANAGED,
                                ReplicaBase, alarm_names_of, option, roles)

PROBE_FLAG = "--probe-resource-tag-deny"
PROBE_POLICY = "probe-deny"
VARIANTS = ("null", "stringnotequals")
HEADER = "| 변형 | p1 새 알람 생성 | p2 태그없는 알람 덮어쓰기 | p3 관리 알람 수정 | p4 관리 알람 삭제 | 판정 |"


def probe_names(variant):
    return f"AlarmOpsRehearsal-probe-{variant}-new", f"AlarmOpsRehearsal-probe-{variant}-unmanaged"


def deny_stmt(cond):
    return {"Sid": "DenyOverwriteUnmanaged", "Effect": "Deny", "Action": "cloudwatch:PutMetricAlarm",
            "Resource": f"arn:aws:cloudwatch:*:{ACCT}:alarm:*", "Condition": cond}


NULL_COND = {"Null": {"aws:ResourceTag/ManagedBy": "true"}}
SNE_COND = {"StringNotEquals": {"aws:ResourceTag/ManagedBy": "AlarmOps"}}


class FakeConditionModel(unittest.TestCase):
    """The fake must evaluate Null / StringNotEquals with real missing-key semantics, or the probe tests prove nothing."""

    def ev(self, cond, resource_tags):
        pol = {"Statement": [{"Effect": "Allow", "Action": "cloudwatch:*", "Resource": "*"}, deny_stmt(cond)]}
        return fake_aws.evaluate(pol, "cloudwatch:PutMetricAlarm", {"request_tags": {}, "resource_tags": resource_tags})

    def test_null_true_denies_only_when_key_absent(self):
        self.assertFalse(self.ev(NULL_COND, {}))
        self.assertTrue(self.ev(NULL_COND, {"ManagedBy": "AlarmOps"}))
        self.assertTrue(self.ev(NULL_COND, {"ManagedBy": "x"}))

    def test_stringnotequals_missing_key_is_true(self):
        self.assertFalse(self.ev(SNE_COND, {}))                 # missing key -> condition true -> deny
        self.assertFalse(self.ev(SNE_COND, {"ManagedBy": "other"}))
        self.assertTrue(self.ev(SNE_COND, {"ManagedBy": "AlarmOps"}))


class Probe(ReplicaBase):
    ENV = {**ReplicaBase.ENV, "REHEARSAL_PROBE_WAIT": "0"}

    def probe(self, hypothesis="request", policy=POLICY, **extra):
        self.scenario(policy=policy, cw_overwrite_unmanaged_denied=False, cw_create_resource_tags=hypothesis, **extra)
        return self.go(extra_args=[PROBE_FLAG])

    def table(self, res):
        out = {}
        for v in VARIANTS:
            rows = [l for l in res.out.splitlines() if l.startswith(f"| {v} |")]
            self.assertEqual(len(rows), 1, f"row {v} in:\n{res.out}")
            out[v] = [c.strip() for c in rows[0].strip().strip("|").split("|")]
        return out

    def assertCleanedUpProbe(self):
        self.assertCleanedUp()
        st = self.state()
        self.assertNotIn(PROBE_POLICY, json.dumps(st["roles"]))
        for v in VARIANTS:
            for n in probe_names(v):
                self.assertNotIn(n, st["alarms"])

    def test_request_tag_hypothesis_is_usable(self):
        res = self.probe("request")
        self.assertEqual(res.code, 0, res.text)
        self.assertIn(HEADER, res.out)
        t = self.table(res)
        for v in VARIANTS:
            self.assertEqual(t[v][1:], ["ALLOWED", "DENIED", "ALLOWED", "ALLOWED", "사용 가능"], res.out)
        self.assertCleanedUpProbe()

    def test_absent_hypothesis_denies_create_and_is_unusable(self):
        res = self.probe("absent")
        self.assertEqual(res.code, 0, "measurement, not a gate: " + res.text)
        t = self.table(res)
        for v in VARIANTS:
            self.assertEqual(t[v][1], "DENIED", res.out)
            self.assertEqual(t[v][2], "DENIED", res.out)
            self.assertTrue(t[v][3].startswith("ALLOWED"), res.out)   # measured on an alarm the person made with the tag
            self.assertTrue(t[v][4].startswith("ALLOWED"), res.out)
            self.assertEqual(t[v][5], "사용 불가", res.out)
        self.assertCleanedUpProbe()

    def test_deny_that_does_not_block_overwrite_is_unusable(self):
        res = self.probe("request", cw_ignore_deny_sid="DenyOverwriteUnmanaged")
        self.assertEqual(res.code, 0, res.text)
        t = self.table(res)
        for v in VARIANTS:
            self.assertTrue(t[v][2].startswith("ALLOWED"), res.out)
            self.assertRegex(t[v][2], r"1\D+2")        # threshold change seen with the person's credentials
            self.assertEqual(t[v][5], "사용 불가", res.out)
        self.assertCleanedUpProbe()

    def test_probe_does_not_run_the_normal_table(self):
        res = self.probe("request")
        for tag in "abcdef":
            self.assertEqual([l for l in res.out.splitlines() if l.startswith(f"| ({tag})")], [], res.out)
        reps = " ".join(a for c in self.sb.calls() if c["as_replica"] for a in c["argv"])
        self.assertNotIn(TEST_ALARM, reps)
        self.assertNotIn(UNMANAGED, reps)

    def test_deny_policy_variants_and_original_untouched(self):
        self.probe("request")
        puts = [c for c in self.sb.calls() if c["op"] == "put-role-policy"]
        by = [(option(c["argv"], "--policy-name"), json.loads(next(iter(c["files"].values())))) for c in puts]
        self.assertEqual(by[0], (POLICY_NAME, POLICY))
        probe = [d for n, d in by if n == PROBE_POLICY]
        self.assertEqual(len(probe), 2, by)
        self.assertEqual(probe[0]["Statement"], [deny_stmt(NULL_COND)])
        self.assertEqual(probe[1]["Statement"], [deny_stmt(SNE_COND)])
        self.assertEqual([n for n, _ in by if n not in (POLICY_NAME, PROBE_POLICY)], [])

    def test_reassume_after_each_policy_change(self):
        self.probe("request")
        calls = self.sb.calls()
        self.assertGreaterEqual(self.ops().count("sts assume-role"), 3)
        puts = [i for i, c in enumerate(calls) if c["op"] == "put-role-policy"
                and option(c["argv"], "--policy-name") == PROBE_POLICY]
        self.assertEqual(len(puts), 2)
        for i in puts:
            self.assertIn("assume-role", [c["op"] for c in calls[i + 1:i + 3]], "re-assume right after the change")

    def test_p1_to_p4_calls(self):
        self.probe("request")
        calls = self.sb.calls()
        for v in VARIANTS:
            new, un = probe_names(v)
            rep = [c for c in calls if c["as_replica"]]
            p1 = [c for c in rep if c["op"] == "put-metric-alarm" and new in c["argv"]]
            self.assertEqual(len(p1), 2, "create + in-place update")
            self.assertIn("Key=ManagedBy,Value=AlarmOps", p1[0]["argv"])
            self.assertNotIn("--tags", p1[1]["argv"])
            self.assertEqual(option(p1[0]["argv"], "--threshold"), "1")
            self.assertEqual(option(p1[1]["argv"], "--threshold"), "2")
            p2 = [c for c in rep if c["op"] == "put-metric-alarm" and un in c["argv"]]
            self.assertEqual(len(p2), 1)
            self.assertIn("Key=ManagedBy,Value=AlarmOps", p2[0]["argv"])
            self.assertEqual(option(p2[0]["argv"], "--threshold"), "2")
            dels = [alarm_names_of(c) for c in rep if c["op"] == "delete-alarms" and new in alarm_names_of(c)]
            self.assertEqual(dels, [[new]])
            own = [c for c in calls if not c["as_replica"] and c["op"] == "describe-alarms" and un in c["argv"]]
            self.assertTrue(own, "the person's own credentials verify the unmanaged alarm")
            made = [c for c in calls if not c["as_replica"] and c["op"] == "put-metric-alarm" and un in c["argv"]]
            self.assertEqual(len(made), 1)
            self.assertNotIn("--tags", made[0]["argv"])

    def test_names_are_distinct_and_cleaned(self):
        self.probe("request")
        names = {n for v in VARIANTS for n in probe_names(v)}
        self.assertEqual(len(names), 4)
        dels = {n for c in self.sb.calls() if c["op"] == "delete-alarms" and not c["as_replica"] for n in alarm_names_of(c)}
        self.assertTrue(names <= dels)

    def test_cleanup_removes_probe_policy_before_main_policy(self):
        self.probe("request")
        dels = [option(c["argv"], "--policy-name") for c in self.sb.calls() if c["op"] == "delete-role-policy"]
        self.assertIn(PROBE_POLICY, dels)
        self.assertLess(dels.index(PROBE_POLICY), dels.index(POLICY_NAME))

    def test_put_probe_policy_failure_cleans_up(self):
        res = self.probe("request", fail_nth={"iam put-role-policy": 2})
        self.assertNotEqual(res.code, 0)
        self.assertCleanedUpProbe()

    def test_reassume_failure_cleans_up(self):
        res = self.probe("request", assume_fail_first=99)
        self.assertNotEqual(res.code, 0)
        self.assertCleanedUpProbe()

    def test_prep_failure_exits_nonzero_and_cleans(self):
        res = self.probe("request", fail_ops=["cloudwatch put-metric-alarm"])
        self.assertNotEqual(res.code, 0, res.text)
        self.assertCleanedUpProbe()

    def test_error_codes_only_in_table(self):
        res = self.probe("request", fail_ops=["cloudwatch delete-alarms"])
        self.assertNotIn("User is not authorized", res.out)
        self.assertNotIn("User is not authorized", self.sb.log_text())

    def test_no_credentials_in_any_output(self):
        res = self.probe("request", leak=fake_aws.REPLICA_TOKEN, fail_ops=["iam delete-role"], assume_crlf=True)
        self.assertTrue(res.out + res.err)
        for where, text in {"stdout": res.out, "stderr": res.err, "log": self.sb.log_text()}.items():
            for v in CRED_VALUES:
                self.assertNotIn(v, text, where)
            self.assertNotRegex(text, r"ASIA[A-Z0-9]{12,}", where)

    def test_crlf_credentials_work(self):
        res = self.probe("request", assume_crlf=True)
        self.assertEqual(res.code, 0, res.text)
        self.assertEqual(self.table(res)["null"][5], "사용 가능")

    def test_wrong_confirm_refuses_before_any_write(self):
        self.scenario()
        res = self.go(confirm="999999999999", extra_args=[PROBE_FLAG])
        self.assertNotEqual(res.code, 0)
        self.assertEqual(self.sb.writes(), [])

    def test_existing_replica_refuses(self):
        self.scenario(iam_roles=roles(extra={REPLICA: {"boundary": None, "policies": {}, "tags": {}}}))
        res = self.go(extra_args=[PROBE_FLAG])
        self.assertEqual(res.code, 5, res.text)

    def test_cleanup_only_also_clears_probe_leftovers(self):
        self.scenario()
        res = self.go(extra_args=["--cleanup-only"])
        self.assertEqual(res.code, 0, res.text)
        names = {n for c in self.sb.calls() if c["op"] == "delete-alarms" for n in alarm_names_of(c)}
        for v in VARIANTS:
            for n in probe_names(v):
                self.assertIn(n, names)

    def test_normal_mode_does_not_touch_probe_names(self):
        self.scenario()
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        names = {n for c in self.sb.calls() if c["op"] == "delete-alarms" and not c["as_replica"]
                 for n in alarm_names_of(c)}
        self.assertEqual(names, {TEST_ALARM, UNMANAGED})

    def test_sighup_runs_cleanup(self):
        import os
        import signal
        import subprocess
        import time
        if os.name != "posix":
            self.skipTest("POSIX signals")
        self.scenario(sleep_ops={"cloudwatch put-metric-alarm": 3}, cw_create_resource_tags="request")
        from rehearsal_support import SCRIPTS
        proc = subprocess.Popen(["bash", str(SCRIPTS / SCRIPT), "--profile", PROFILE, "--confirm-account", ACCT,
                                 PROBE_FLAG], env=self.sb.env(self.ENV), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(self.sb.dir))
        marker = Path(str(self.sb.calls_file) + ".sleeping")
        deadline = time.time() + 30
        while not marker.exists() and time.time() < deadline:
            time.sleep(0.05)
        self.assertTrue(marker.exists())
        proc.send_signal(signal.SIGHUP)
        proc.communicate(timeout=60)
        self.assertNotEqual(proc.returncode, 0)
        self.assertCleanedUpProbe()


class Docs(unittest.TestCase):
    def test_docs_mention_probe(self):
        for rel in ("docs/GO-LIVE.md", "infra/scripts/rehearsal/README.md", "infra/test/REHEARSAL-CONTRACT.md"):
            self.assertIn(PROBE_FLAG, (REPO / rel).read_text(encoding="utf-8"), rel)
        self.assertIn(HEADER, (REPO / "docs" / "GO-LIVE.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
