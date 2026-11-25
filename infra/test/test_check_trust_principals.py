"""Tests for .github/scripts/check_trust_principals.py (trust policy check after apply in deploy-central)."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "check_trust_principals.py"
ACCT = "123456789012"
PATH = "oidc.vercel.com/team"
PROVIDER = f"arn:aws:iam::{ACCT}:oidc-provider/{PATH}"
ENGINE_ARN = f"arn:aws:iam::{ACCT}:role/AlarmOpsCentral-Engine"
ENGINE, CALLER, CONSOLE = "AlarmOpsCentral-Engine", "AlarmOpsCentral-RemediatorCaller", "AlarmOpsCentral-VercelConsole"
COND = {"StringEquals": {f"{PATH}:aud": "https://vercel.com/team", f"{PATH}:sub": "owner:team:project:p:environment:production"}}


def stmt(principal, action="sts:AssumeRole", **extra):
    return {"Effect": "Allow", "Principal": principal, "Action": action, **extra}


def doc(*stmts):
    return {"Version": "2012-10-17", "Statement": list(stmts)}


def engine(**kw):
    return doc(stmt({"Service": "lambda.amazonaws.com"}, **kw))


def caller(**kw):
    return doc(stmt({"AWS": ENGINE_ARN}, **kw))


def console(**kw):
    kw.setdefault("Condition", COND)
    return doc(stmt({"Federated": PROVIDER}, "sts:AssumeRoleWithWebIdentity", **kw))


GOOD = {ENGINE: engine(), CALLER: caller(), CONSOLE: console()}


class Check(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def run_check(self, docs=None, provider=PROVIDER, account=ACCT, **override):
        docs = {**(docs or GOOD), **override}
        args = []
        for role, d in docs.items():
            p = self.tmp / (role + ".json")
            p.write_text(d if isinstance(d, str) else json.dumps(d))
            args.append(f"{role}={p}")
        return subprocess.run([sys.executable, "-I", str(SCRIPT), account, provider, *args],
                              capture_output=True, text=True)

    def assert_fail(self, role=None, d=None, **kw):
        cp = self.run_check(**({role: d} if role else {}), **kw)
        self.assertEqual(cp.returncode, 1, cp.stdout)
        self.assertIn("::error::", cp.stdout)
        return cp

    def test_the_three_real_shapes_pass(self):
        cp = self.run_check()
        self.assertEqual(cp.returncode, 0, cp.stdout)
        self.assertNotIn("::error::", cp.stdout)
        self.assertNotIn("FAIL", cp.stdout)

    def test_other_same_account_role_in_engine_fails(self):
        self.assert_fail(ENGINE, doc(stmt({"AWS": f"arn:aws:iam::{ACCT}:role/Other"})))

    def test_other_same_account_role_or_root_in_caller_fails(self):
        for arn in (f"arn:aws:iam::{ACCT}:role/Other", f"arn:aws:iam::{ACCT}:root", f"arn:aws:iam::{ACCT}:user/u",
                    f"arn:aws:iam::999999999999:role/AlarmOpsCentral-Engine", ENGINE_ARN + "\n", ENGINE_ARN + "x"):
            with self.subTest(arn=arn):
                self.assert_fail(CALLER, doc(stmt({"AWS": arn})))

    def test_caller_extra_principal_fails(self):
        self.assert_fail(CALLER, doc(stmt({"AWS": [ENGINE_ARN, f"arn:aws:iam::{ACCT}:role/Other"]})))

    def test_lambda_in_console_fails(self):
        self.assert_fail(CONSOLE, doc(stmt({"Service": "lambda.amazonaws.com"}, "sts:AssumeRoleWithWebIdentity",
                                           Condition=COND)))
        self.assert_fail(CONSOLE, doc(stmt({"Federated": PROVIDER, "Service": "lambda.amazonaws.com"},
                                           "sts:AssumeRoleWithWebIdentity", Condition=COND)))

    def test_console_condition_required(self):
        self.assert_fail(CONSOLE, doc(stmt({"Federated": PROVIDER}, "sts:AssumeRoleWithWebIdentity")))
        for c in ({}, {"StringLike": COND["StringEquals"]},
                  {"StringEquals": {f"{PATH}:aud": "x"}}, {"StringEquals": {f"{PATH}:sub": "x"}},
                  {"StringEquals": {"other:aud": "x", "other:sub": "y"}}, {"StringEquals": {f"{PATH}:aud": "", f"{PATH}:sub": "y"}}):
            with self.subTest(cond=c):
                self.assert_fail(CONSOLE, console(Condition=c))

    def test_console_federated_must_equal_provider(self):
        for f in (f"arn:aws:iam::{ACCT}:oidc-provider/token.actions.githubusercontent.com", PROVIDER + "/x",
                  PROVIDER + "\n", "accounts.google.com"):
            with self.subTest(f=f):
                self.assert_fail(CONSOLE, doc(stmt({"Federated": f}, "sts:AssumeRoleWithWebIdentity", Condition=COND)))
        self.assert_fail(provider="")

    def test_empty_lists_and_values_fail(self):
        for role, ptype in ((ENGINE, "Service"), (CALLER, "AWS"), (CONSOLE, "Federated")):
            for v in ([], "", [""], {}):
                with self.subTest(role=role, v=v):
                    self.assert_fail(role, doc(stmt({ptype: v}, "sts:AssumeRoleWithWebIdentity" if role == CONSOLE else "sts:AssumeRole",
                                                    Condition=COND)))

    def test_newline_in_service_fails(self):
        self.assert_fail(ENGINE, doc(stmt({"Service": "lambda.amazonaws.com\n"})))
        self.assert_fail(ENGINE, doc(stmt({"Service": ["lambda.amazonaws.com", "events.amazonaws.com"]})))

    def test_actions(self):
        self.assert_fail(ENGINE, doc(stmt({"Service": "lambda.amazonaws.com"}, "sts:AssumeRoleWithWebIdentity")))
        self.assert_fail(CONSOLE, doc(stmt({"Federated": PROVIDER}, "sts:AssumeRole", Condition=COND)))
        self.assert_fail(ENGINE, doc(stmt({"Service": "lambda.amazonaws.com"}, "sts:*")))
        self.assert_fail(ENGINE, doc(stmt({"Service": "lambda.amazonaws.com"}, ["sts:AssumeRole", "iam:*"])))
        bad = stmt({"Service": "lambda.amazonaws.com"})
        del bad["Action"]
        self.assert_fail(ENGINE, doc({**bad, "NotAction": "sts:TagSession"}))
        self.assert_fail(ENGINE, doc(bad))
        self.assertEqual(self.run_check(**{ENGINE: doc(stmt({"Service": "lambda.amazonaws.com"}, ["sts:AssumeRole"]))}).returncode, 0)

    def test_effect_and_second_statement(self):
        self.assert_fail(ENGINE, doc({**stmt({"Service": "lambda.amazonaws.com"}), "Effect": "Deny"}))
        self.assert_fail(ENGINE, doc(stmt({"Service": "lambda.amazonaws.com"}), stmt({"AWS": "*"})))
        self.assert_fail(ENGINE, doc(stmt({"Service": "lambda.amazonaws.com"}), stmt("*")))

    def test_wildcards_and_empty_documents(self):
        for d in (doc(stmt("*")), doc(stmt({"AWS": "*"})), doc(stmt({})), {"Statement": []}, {"Version": "x"},
                  {"Statement": [{"Effect": "Allow", "NotPrincipal": {"AWS": ENGINE_ARN}, "Action": "sts:AssumeRole"}]},
                  {"Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole"}]}):
            with self.subTest(doc=d):
                self.assert_fail(ENGINE, d)

    def test_unreadable_missing_and_unexpected(self):
        self.assert_fail(ENGINE, "not json")
        missing = {k: v for k, v in GOOD.items() if k != CALLER}
        cp = self.run_check(missing)
        self.assertEqual(cp.returncode, 1)
        self.assertIn(CALLER, cp.stdout)
        self.assert_fail(**{"AlarmOpsCentral-Other": GOOD[ENGINE]})

    def test_bad_account_and_usage(self):
        self.assertEqual(self.run_check(account="123").returncode, 1)
        self.assertEqual(self.run_check(account=ACCT + "\n").returncode, 1)
        cp = subprocess.run([sys.executable, "-I", str(SCRIPT), ACCT], capture_output=True, text=True)
        self.assertEqual(cp.returncode, 2)

    def test_every_failing_role_is_reported(self):
        cp = self.assert_fail(ENGINE, doc(stmt("*")), **{CALLER: doc(stmt({"AWS": f"arn:aws:iam::{ACCT}:root"}))})
        self.assertIn(f"role of {ENGINE}".replace("role of ", "Trust policy of "), cp.stdout)
        self.assertIn(f"Trust policy of {CALLER}", cp.stdout)


if __name__ == "__main__":
    unittest.main()
