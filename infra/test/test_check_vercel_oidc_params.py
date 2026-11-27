"""Tests for .github/scripts/check_vercel_oidc_params.py (pre-deploy check in deploy-central, #130)."""
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "check_vercel_oidc_params.py"
WORKFLOW = SCRIPT.parents[1] / "workflows" / "deploy-central.yml"
GLOBAL = "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com"
TEAM = GLOBAL + "/acme-team"


def run(*args):
    p = subprocess.run([sys.executable, "-I", str(SCRIPT), *args], capture_output=True, text=True)
    return p.returncode, p.stdout


class CheckVercelOidcParams(unittest.TestCase):
    def test_team_provider_matching_slug_passes(self):
        self.assertEqual(run(TEAM, "acme-team", "alarmops")[0], 0)

    def test_global_provider_passes_with_any_valid_slug(self):
        self.assertEqual(run(GLOBAL, "acme-team", "alarmops")[0], 0)

    def test_team_provider_with_other_slug_blocks(self):
        for slug in ("other-team", "Acme-Team", "acme-team2", "acme"):
            with self.subTest(slug=slug):
                code, out = run(TEAM, slug, "alarmops")
                self.assertEqual(code, 1)
                self.assertIn("does not equal VERCEL_TEAM_SLUG", out)

    def test_bad_values_block(self):
        for args in ((TEAM, 'acme"team', "p"), (TEAM, "acme-team", "p,q"), (TEAM, "acme-team", "p q"),
                     (TEAM, "acme-team", "p\nq"), (GLOBAL, "a\\b", "p"), (GLOBAL, "a b", "p"), (GLOBAL, "a,b", "p"),
                     (GLOBAL + "/", "a", "p"), (GLOBAL + "/Acme", "Acme", "p"), ("", "a", "p"), (GLOBAL, "", "p")):
            with self.subTest(args=args):
                self.assertEqual(run(*args)[0], 1)

    def test_usage(self):
        self.assertEqual(run(TEAM)[0], 2)

    def test_workflow_runs_it_in_plan_before_aws_credentials(self):
        wf = WORKFLOW.read_text()
        call = wf.index("check_vercel_oidc_params.py")
        creds = wf.index("configure-aws-credentials", call)
        self.assertLess(call, creds)
        self.assertEqual(wf.count("check_vercel_oidc_params.py"), 1)


if __name__ == "__main__":
    unittest.main()
