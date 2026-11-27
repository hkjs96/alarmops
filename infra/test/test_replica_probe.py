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
from test_replica_check import (CRED_VALUES, POLICY, POLICY_NAME, REPLICA, SCRIPT, TEST_ALARM, UNMANAGED, BRACKET_UNMANAGED,
                                ReplicaBase, alarm_names_of, option, roles)

PROBE_FLAG = "--probe-resource-tag-deny"
PROBE_POLICY = "probe-deny"
VARIANTS = ("null", "stringnotequals")
HEADER = "| 변형 | p1 새 알람 생성 | p2 태그없는 알람 덮어쓰기 | p3 관리 알람 수정 | p4 관리 알람 삭제 | 판정 |"


def probe_names(variant):
    return f"[AlarmOpsRehearsal] probe-{variant}-new", f"[AlarmOpsRehearsal] probe-{variant}-unmanaged"


def all_probe_names(variant):
    return probe_names(variant) + (f"[AlarmOpsRehearsal] probe-{variant}-canary",
                                   f"[AlarmOpsRehearsal] probe-{variant}-other")


def deny_stmt(cond):
    return {"Sid": "DenyOverwriteUnmanaged", "Effect": "Deny", "Action": "cloudwatch:PutMetricAlarm",
            "Resource": f"arn:aws:cloudwatch:*:{ACCT}:alarm:*", "Condition": cond}


NULL_COND = {"Null": {"aws:ResourceTag/ManagedBy": "true"}}
SNE_COND = {"StringNotEquals": {"aws:ResourceTag/ManagedBy": "AlarmOps"}}


class FakeCliListParsing(unittest.TestCase):
    """Like the real CLI, a list argument value starting with `[` must be JSON (hub measured awscli 1.46.3)."""

    def test_bracket_name_is_invalid_json(self):
        _, _, opts = fake_aws.split_argv(["cloudwatch", "delete-alarms", "--alarm-names", "[AlarmOpsRehearsal] replica-test"])
        err = fake_aws.expand_list_params(opts)
        self.assertIn("Error parsing parameter '--alarm-names': Invalid JSON", err)

    def test_json_array_is_accepted_and_expanded(self):
        _, _, opts = fake_aws.split_argv(["cloudwatch", "delete-alarms", "--alarm-names",
                                          '["[A] x","plain"]'])
        self.assertIsNone(fake_aws.expand_list_params(opts))
        self.assertEqual(opts["--alarm-names"], ["[A] x", "plain"])

    def test_plain_names_and_scalar_option_untouched(self):
        _, _, opts = fake_aws.split_argv(["cloudwatch", "put-metric-alarm", "--alarm-name", "[A] x",
                                          "--alarm-names", "plain"])
        self.assertIsNone(fake_aws.expand_list_params(opts))
        self.assertEqual(opts["--alarm-name"], ["[A] x"])


class FakeResourceModel(unittest.TestCase):
    """The fake must match Resource ARNs like IAM (only * and ? wildcards, `[` literal), or the D-63 tests prove nothing."""

    def ev(self, pattern, name):
        pol = {"Statement": [{"Effect": "Allow", "Action": "cloudwatch:PutMetricAlarm", "Resource": pattern}]}
        arn = f"arn:aws:cloudwatch:ap-northeast-2:{ACCT}:alarm:{name}"
        return fake_aws.evaluate(pol, "cloudwatch:PutMetricAlarm", {"request_tags": {}, "resource_tags": {}, "resource_arn": arn})

    def test_bracket_prefix_is_literal(self):
        pat = f"arn:aws:cloudwatch:*:{ACCT}:alarm:[*"
        self.assertTrue(self.ev(pat, "[EC2] web CPUUtilization (TagName: i-1)"))
        self.assertTrue(self.ev(pat, "[x"))
        self.assertFalse(self.ev(pat, "customer-alarm"))
        self.assertFalse(self.ev(pat, "x[EC2] web"))
        self.assertFalse(self.ev(pat, "E"), "`[*` is not a character class")
        self.assertFalse(self.ev(pat, "e"))

    def test_star_and_question_mark(self):
        self.assertTrue(self.ev(f"arn:aws:cloudwatch:*:{ACCT}:alarm:*", "anything"))
        self.assertTrue(self.ev(f"arn:aws:cloudwatch:*:{ACCT}:alarm:a?c", "abc"))
        self.assertFalse(self.ev(f"arn:aws:cloudwatch:*:{ACCT}:alarm:a?c", "abbc"))

    def test_other_account_does_not_match_and_no_arn_means_unchecked(self):
        self.assertFalse(self.ev("arn:aws:cloudwatch:*:999999999999:alarm:*", "x"))
        pol = {"Statement": [{"Effect": "Allow", "Action": "cloudwatch:*", "Resource": "arn:aws:s3:::nope"}]}
        self.assertTrue(fake_aws.evaluate(pol, "cloudwatch:PutMetricAlarm", {"request_tags": {}, "resource_tags": {}}))


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


class ProbeBase(ReplicaBase):
    ENV = {**ReplicaBase.ENV, "REHEARSAL_PROBE_WAIT": "0"}

    def probe(self, hypothesis="request", policy=POLICY, **extra):
        self.scenario(policy=policy, cw_overwrite_unmanaged_denied=False, cw_create_resource_tags=hypothesis,
                      cw_update_ignores_tags=True, **extra)
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
            for n in all_probe_names(v):
                self.assertNotIn(n, st["alarms"])


class Probe(ProbeBase):
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
        # null: the canary (an alarm tagged ManagedBy=Other) is allowed as expected, the missing Deny shows in p2
        self.assertTrue(t["null"][2].startswith("ALLOWED"), res.out)
        self.assertRegex(t["null"][2], r"1\D+2")        # threshold change seen with the person's credentials
        self.assertEqual(t["null"][5], "사용 불가", res.out)
        # stringnotequals: the canary expects DENIED but got ALLOWED -> the Deny is not in effect -> remeasure
        self.assertEqual(t["stringnotequals"][2], "불안정", res.out)
        self.assertEqual(t["stringnotequals"][5], "재측정", res.out)
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
            self.assertEqual(len(p2), 2, "p2 is measured twice")
            self.assertIn("Key=ManagedBy,Value=AlarmOps", p2[0]["argv"])
            self.assertEqual(option(p2[0]["argv"], "--threshold"), "2")
            dels = [alarm_names_of(c) for c in rep if c["op"] == "delete-alarms" and new in alarm_names_of(c)]
            self.assertEqual(dels, [[new]])
            own = [c for c in calls if not c["as_replica"] and c["op"] == "describe-alarms" and un in alarm_names_of(c)]
            self.assertTrue(own, "the person's own credentials verify the unmanaged alarm")
            made = [c for c in calls if not c["as_replica"] and c["op"] == "put-metric-alarm" and un in c["argv"]]
            self.assertEqual(len(made), 1)
            self.assertNotIn("--tags", made[0]["argv"])

    def test_names_are_distinct_and_cleaned(self):
        self.probe("request")
        names = {n for v in VARIANTS for n in all_probe_names(v)}
        self.assertEqual(len(names), 8)
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
            for n in all_probe_names(v):
                self.assertIn(n, names)

    def test_normal_mode_does_not_touch_probe_names(self):
        self.scenario()
        res = self.go()
        self.assertEqual(res.code, 0, res.text)
        names = {n for c in self.sb.calls() if c["op"] == "delete-alarms" and not c["as_replica"]
                 for n in alarm_names_of(c)}
        self.assertEqual(names, {TEST_ALARM, UNMANAGED, BRACKET_UNMANAGED})

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


class Reliability(ProbeBase):
    """Review items: stale Deny between variants, canaries, p2 measured twice, polluted targets."""

    def policy_ops(self):
        out = []
        for c in self.sb.calls():
            if c["op"] in ("put-role-policy", "delete-role-policy") and option(c["argv"], "--policy-name") == PROBE_POLICY:
                out.append(c["op"])
        return out

    def test_old_deny_is_removed_before_the_next_variant(self):
        self.probe("request")
        ops = self.policy_ops()
        self.assertEqual(ops[:4], ["delete-role-policy", "put-role-policy", "delete-role-policy", "put-role-policy"], ops)

    def test_start_deletes_all_probe_alarms_before_creating_any(self):
        self.probe("request")
        calls = [c for c in self.sb.calls() if not c["as_replica"]]
        first_del = next(i for i, c in enumerate(calls) if c["op"] == "delete-alarms")
        first_put = next(i for i, c in enumerate(calls) if c["op"] == "put-metric-alarm")
        self.assertLess(first_del, first_put)
        self.assertEqual(set(alarm_names_of(calls[first_del])), {n for v in VARIANTS for n in all_probe_names(v)})

    def test_tag_on_prepared_alarm_is_a_prep_failure(self):
        res = self.probe("request", cw_person_put_tags={"ManagedBy": "AlarmOps"})
        self.assertEqual(res.code, 1, res.text)
        self.assertIn("준비 실패", res.text)
        self.assertEqual([c for c in self.sb.calls() if c["as_replica"] and c["op"] == "put-metric-alarm"], [])
        self.assertCleanedUpProbe()

    def test_prepared_alarms_are_tag_checked_with_own_credentials(self):
        self.probe("request")
        un = probe_names("null")[1]
        tags = [c for c in self.sb.calls() if c["op"] == "list-tags-for-resource" and not c["as_replica"]
                and un in " ".join(c["argv"])]
        self.assertTrue(tags)

    def test_canary_without_deny_runs_before_each_attach(self):
        self.probe("request")
        calls = self.sb.calls()
        attach = [i for i, c in enumerate(calls) if c["op"] == "put-role-policy"
                  and option(c["argv"], "--policy-name") == PROBE_POLICY]
        self.assertEqual(len(attach), 2)
        for v, a in zip(VARIANTS, attach):
            canary = f"[AlarmOpsRehearsal] probe-{v}-canary"
            idx = [i for i, c in enumerate(calls) if c["as_replica"] and c["op"] == "put-metric-alarm" and canary in c["argv"]]
            self.assertEqual(len(idx), 1, v)
            self.assertIn("Key=ManagedBy,Value=AlarmOps", calls[idx[0]]["argv"])
            self.assertLess(idx[0], a, "the no-Deny canary runs before this variant's Deny is attached")

    def test_stale_deny_makes_the_canary_fail_and_stops(self):
        res = self.probe("request", iam_stale_probe_deny=True)
        self.assertEqual(res.code, 1, res.text)
        self.assertIn("오류:", res.text)
        self.assertIn("카나리", res.text)
        self.assertEqual([l for l in res.out.splitlines() if l.startswith("| stringnotequals |")], [])
        self.assertCleanedUpProbe()

    def test_deny_canary_is_a_person_made_other_tagged_alarm(self):
        self.probe("request")
        calls = self.sb.calls()
        for v in VARIANTS:
            other = f"[AlarmOpsRehearsal] probe-{v}-other"
            made = [c for c in calls if not c["as_replica"] and c["op"] == "put-metric-alarm" and other in c["argv"]]
            self.assertEqual(len(made), 1)
            self.assertIn("Key=ManagedBy,Value=Other", made[0]["argv"])
            tried = [c for c in calls if c["as_replica"] and c["op"] == "put-metric-alarm" and other in c["argv"]]
            self.assertEqual(len(tried), 1)

    def test_p2_that_changes_between_two_measurements_is_unstable(self):
        # the Deny is ignored for the first 3 puts made while it is attached (canary, p1, p2 first try)
        res = self.probe("request", cw_ignore_deny_first_n_puts=3)
        self.assertEqual(res.code, 0, res.text)
        t = self.table(res)
        self.assertEqual(t["null"][2], "불안정", res.out)
        self.assertEqual(t["null"][5], "재측정", res.out)

    def test_stable_results_are_judged(self):
        res = self.probe("request")
        for v in VARIANTS:
            self.assertNotIn("불안정", " ".join(self.table(res)[v]))


class Docs(unittest.TestCase):
    def test_cell_values_and_flow_are_documented(self):
        gl = (REPO / "docs" / "GO-LIVE.md").read_text(encoding="utf-8")
        ct = (REPO / "infra" / "test" / "REHEARSAL-CONTRACT.md").read_text(encoding="utf-8")
        for text in (gl, ct):
            for needle in ("ALLOWED (임계값", "DENIED (확인 필요", "ERROR(준비 실패)", "불안정", "재측정", "카나리"):
                self.assertIn(needle, text, needle)
        for needle in ("REHEARSAL_PROBE_WAIT=60", "사용 가능일 때의 모양(예시)", "오류:", "probe-deny", "[AlarmOpsRehearsal] probe-"):
            self.assertIn(needle, gl, needle)
        self.assertIn("[--probe-resource-tag-deny]", (REPO / "infra/scripts/rehearsal/README.md").read_text(encoding="utf-8"))

    def test_go_live_command_is_one_block_with_sso_login(self):
        lines = [l.strip() for l in (REPO / "docs" / "GO-LIVE.md").read_text(encoding="utf-8").splitlines()]
        want = "bash infra/scripts/rehearsal/replica-check.sh --profile rehearsal-b --confirm-account 12자리 --probe-resource-tag-deny"
        i = lines.index(want)
        self.assertEqual(lines[i - 1], "aws sso login --profile rehearsal-b")
        self.assertEqual(lines[i - 2], "```")
        self.assertEqual(lines[i + 1], "```")

    def test_docs_mention_probe(self):
        for rel in ("docs/GO-LIVE.md", "infra/scripts/rehearsal/README.md", "infra/test/REHEARSAL-CONTRACT.md"):
            self.assertIn(PROBE_FLAG, (REPO / rel).read_text(encoding="utf-8"), rel)
        self.assertIn(HEADER, (REPO / "docs" / "GO-LIVE.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
