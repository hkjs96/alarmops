"""Tests for .github/scripts/check_trust_principals.py (trust principal check after apply in deploy-central)."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "check_trust_principals.py"
ACCT = "123456789012"
PROVIDER = f"arn:aws:iam::{ACCT}:oidc-provider/oidc.vercel.com/team"
SERVICES = "lambda.amazonaws.com"


def doc(*principals, **extra):
    return {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": p, "Action": "sts:AssumeRole", **extra}
                                                    for p in principals]}


class Check(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def run_check(self, *docs, provider=PROVIDER, account=ACCT):
        args = []
        for n, d in enumerate(docs):
            p = self.tmp / f"r{n}.json"
            p.write_text(d if isinstance(d, str) else json.dumps(d))
            args.append(f"role{n}={p}")
        return subprocess.run([sys.executable, "-I", str(SCRIPT), account, provider, SERVICES, *args],
                              capture_output=True, text=True)

    def assert_fail(self, *docs, **kw):
        cp = self.run_check(*docs, **kw)
        self.assertEqual(cp.returncode, 1, cp.stdout)
        self.assertIn("::error::", cp.stdout)
        return cp

    def test_the_three_real_shapes_pass(self):
        cp = self.run_check(doc({"Service": "lambda.amazonaws.com"}),
                            doc({"AWS": f"arn:aws:iam::{ACCT}:role/AlarmOpsCentral-Engine"}),
                            doc({"Federated": PROVIDER}))
        self.assertEqual(cp.returncode, 0, cp.stdout)
        self.assertNotIn("::error::", cp.stdout)
        self.assertIn("| role0 |", cp.stdout)
        self.assertEqual(cp.stdout.count("ok:"), 3)

    def test_same_account_role_list_passes(self):
        cp = self.run_check(doc({"AWS": [f"arn:aws:iam::{ACCT}:role/x", f"arn:aws:iam::{ACCT}:role/path/y"]}))
        self.assertEqual(cp.returncode, 0, cp.stdout)

    def test_same_account_root_or_user_fails(self):
        # ":root" trusts every IAM identity of the account that has sts:AssumeRole; only exact roles are expected.
        self.assert_fail(doc({"AWS": f"arn:aws:iam::{ACCT}:root"}))
        self.assert_fail(doc({"AWS": f"arn:aws:iam::{ACCT}:user/alice"}))

    def test_other_account_fails_even_when_mixed_with_good_ones(self):
        cp = self.assert_fail(doc({"AWS": [f"arn:aws:iam::{ACCT}:role/x", "arn:aws:iam::999999999999:role/x"]}))
        self.assertIn("999999999999", cp.stdout)

    def test_account_prefix_is_exact(self):
        self.assert_fail(doc({"AWS": f"arn:aws:iam::{ACCT}0:root"}))
        self.assert_fail(doc({"AWS": ACCT}))
        self.assert_fail(doc({"AWS": "AROAEXAMPLEUNIQUEID"}))
        self.assert_fail(doc({"AWS": f"arn:aws:sts::{ACCT}:assumed-role/x/y"}))

    def test_wildcards_and_empty(self):
        for d in (doc("*"), doc({"AWS": "*"}), doc({}), {"Statement": []}, {"Version": "x"},
                  {"Statement": [{"Effect": "Allow", "NotPrincipal": {"AWS": f"arn:aws:iam::{ACCT}:root"}}]},
                  {"Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole"}]}):
            with self.subTest(doc=d):
                self.assert_fail(d)

    def test_services(self):
        self.assert_fail(doc({"Service": "ec2.amazonaws.com"}))
        self.assert_fail(doc({"Service": ["lambda.amazonaws.com", "events.amazonaws.com"]}))
        self.assertEqual(self.run_check(doc({"Service": ["lambda.amazonaws.com"]})).returncode, 0)

    def test_federated_must_equal_the_vercel_provider(self):
        self.assert_fail(doc({"Federated": f"arn:aws:iam::{ACCT}:oidc-provider/token.actions.githubusercontent.com"}))
        self.assert_fail(doc({"Federated": PROVIDER + "/x"}))
        self.assert_fail(doc({"Federated": "accounts.google.com"}))
        self.assert_fail(doc({"Federated": PROVIDER}), provider="")

    def test_unknown_principal_type_and_second_statement(self):
        self.assert_fail(doc({"CanonicalUser": "abc"}))
        self.assert_fail(doc({"Service": "lambda.amazonaws.com"}, {"AWS": "arn:aws:iam::999999999999:root"}))

    def test_unreadable_or_invalid_file_fails(self):
        self.assert_fail("not json")
        cp = subprocess.run([sys.executable, "-I", str(SCRIPT), ACCT, PROVIDER, SERVICES, f"x={self.tmp / 'none.json'}"],
                            capture_output=True, text=True)
        self.assertEqual(cp.returncode, 1)

    def test_bad_account_and_usage(self):
        self.assertEqual(self.run_check(doc({"Service": "lambda.amazonaws.com"}), account="123").returncode, 1)
        cp = subprocess.run([sys.executable, "-I", str(SCRIPT), ACCT], capture_output=True, text=True)
        self.assertEqual(cp.returncode, 2)

    def test_every_failing_role_is_reported(self):
        cp = self.assert_fail(doc("*"), doc({"AWS": "arn:aws:iam::999999999999:root"}))
        self.assertIn("role0", cp.stdout)
        self.assertIn("role1", cp.stdout)


if __name__ == "__main__":
    unittest.main()
