"""PR risk classifier (.github/scripts/pr_risk.py) and the pinned shape of the `risk` job in ci.yml.
Expected answers come from the rules in the task (D-62), not from the script's output. Offline.
Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

import yaml

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / ".github" / "scripts" / "pr_risk.py"
CI = REPO / ".github" / "workflows" / "ci.yml"

_spec = importlib.util.spec_from_file_location("pr_risk", SCRIPT)
pr_risk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pr_risk)

DEP = "dependabot[bot]"
MINOR = "Bump left-pad from 1.2.3 to 1.3.0"
PATCH = "Bump left-pad from 1.2.3 to 1.2.4"
MAJOR = "Bump left-pad from 1.9.0 to 2.0.0"


def run(files, author="someone", title="t"):
    """files: list of paths (modified) or (status, path)."""
    fl = [("M", f) if isinstance(f, str) else f for f in files]
    return pr_risk.classify(fl, author, title)


class Low(unittest.TestCase):
    def test_docs_only(self):
        self.assertEqual(run(["docs/specs/alarm-rules.md", "docs/ui/menu.md"])[0], "low")

    def test_docs_qa(self):
        self.assertEqual(run(["docs/qa/results.md"])[0], "low")

    def test_test_files(self):
        for p in ("services/x/test/a.py", "packages/api/tests/b.ts", "apps/console/src/a.test.tsx", "a/b.test.ts",
                  "scripts/c.test.mjs", "packages/z/d.spec.ts", "apps/console/e2e/login.ts", "infra/test/test_x.py"):
            self.assertEqual(run([p])[0], "low", p)

    def test_rehearsal(self):
        self.assertEqual(run(["infra/scripts/rehearsal/run.sh"])[0], "low")

    def test_dependabot_patch_and_minor(self):
        for title in (PATCH, MINOR):
            self.assertEqual(run(["package.json", "package-lock.json"], DEP, title)[0], "low", title)
            self.assertEqual(run(["apps/console/package.json"], DEP, title)[0], "low", title)

    def test_added_test_is_low(self):
        self.assertEqual(run([("A", "services/x/test/new.py")])[0], "low")


class Human(unittest.TestCase):
    def test_empty_list(self):
        self.assertEqual(run([])[0], "human")

    def test_decisions_md(self):
        risk, reasons = run(["docs/decisions/DECISIONS.md"])
        self.assertEqual(risk, "human")
        self.assertIn("decision", reasons[0]["detail"])

    def test_docs_plus_decisions(self):
        self.assertEqual(run(["docs/a.md", "docs/decisions/DECISIONS.md"])[0], "human")

    def test_deleted_test(self):
        risk, reasons = run([("D", "services/x/test/a.py")])
        self.assertEqual(risk, "human")
        self.assertEqual(reasons[0]["rule"], "test-deleted")

    def test_deleted_test_among_edits(self):
        self.assertEqual(run([("M", "docs/a.md"), ("D", "a/b.test.ts")])[0], "human")

    def test_workflow(self):
        risk, reasons = run([".github/workflows/ci.yml"])
        self.assertEqual(risk, "human")
        self.assertIn(".github/**", reasons[0]["detail"])

    def test_always_human_paths(self):
        for p in (".github/scripts/x.test.mjs", ".claude/settings.json", "CLAUDE.md", "infra/aws/central.yaml",
                  "infra/customer-stack/template.yaml", "db/prisma/schema.prisma", "db/test/x.test.ts",
                  "infra/aws/test/a.py"):
            risk, reasons = run([p])
            self.assertEqual(risk, "human", p)
            self.assertEqual(reasons[0]["rule"], "always-human", p)

    def test_package_json_not_dependabot(self):
        self.assertEqual(run(["package.json"])[0], "human")
        self.assertEqual(run(["package-lock.json"], "alice", MINOR)[0], "human")

    def test_dependabot_major(self):
        risk, reasons = run(["package.json", "package-lock.json"], DEP, MAJOR)
        self.assertEqual(risk, "human")
        self.assertEqual({r["rule"] for r in reasons}, {"dependabot-major"})

    def test_dependabot_title_unreadable(self):
        self.assertEqual(run(["package.json"], DEP, "Update stuff")[0], "human")

    def test_dependabot_title_from_other_author(self):
        self.assertEqual(run(["package.json"], "alice", PATCH)[0], "human")

    def test_dependabot_minor_does_not_open_other_paths(self):
        self.assertEqual(run(["package.json", ".github/workflows/ci.yml"], DEP, MINOR)[0], "human")
        self.assertEqual(run(["package.json", "apps/console/src/a.ts"], DEP, MINOR)[0], "human")

    def test_mixed(self):
        risk, reasons = run(["docs/a.md", "services/x/handler.py", "a.test.ts"])
        self.assertEqual(risk, "human")
        self.assertEqual([r["path"] for r in reasons if r["verdict"] == "human"], ["services/x/handler.py"])

    def test_not_listed_default(self):
        self.assertEqual(run(["apps/console/src/page.tsx"])[0], "human")
        self.assertEqual(run(["README.md"])[0], "human")


class Cli(unittest.TestCase):
    def _run(self, stdin, author="x", title="t"):
        env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT")}
        env.update(PR_AUTHOR=author, PR_TITLE=title)
        return subprocess.run([sys.executable, "-I", str(SCRIPT)], input=stdin, capture_output=True, text=True, env=env)

    def test_stdout_is_one_json_line_and_exit_zero(self):
        res = self._run("M\tdocs/a.md\nD\tx/test/b.py\n")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(len(res.stdout.strip().splitlines()), 1)
        data = json.loads(res.stdout)
        self.assertEqual(data["risk"], "human")
        self.assertIn("| file |", res.stderr)

    def test_name_only_input(self):
        self.assertEqual(json.loads(self._run("docs/a.md\n").stdout)["risk"], "low")

    def test_empty_stdin_is_human_exit_zero(self):
        res = self._run("")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout)["risk"], "human")

    def test_dependabot_via_env(self):
        self.assertEqual(json.loads(self._run("package.json\n", DEP, MINOR).stdout)["risk"], "low")
        self.assertEqual(json.loads(self._run("package.json\n", DEP, MAJOR).stdout)["risk"], "human")


class RiskJobInCi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ci = yaml.safe_load(CI.read_text(encoding="utf-8"))
        cls.job = cls.ci["jobs"]["risk"]

    def test_pull_request_only(self):
        self.assertIn("pull_request", str(self.job["if"]))
        self.assertNotIn("needs", self.job)

    def test_permissions_are_contents_read_only(self):
        self.assertEqual(self.job["permissions"], {"contents": "read"})

    def test_never_fails(self):
        steps = self.job["steps"]
        classify = [s for s in steps if s.get("id") == "classify"]
        self.assertEqual(len(classify), 1)
        self.assertIs(classify[0].get("continue-on-error"), True)
        self.assertTrue(classify[0]["run"].rstrip().endswith("exit 0"))
        self.assertNotIn("set -e", classify[0]["run"])
        self.assertNotIn("continue-on-error", self.job)  # job-level would hide a real failure of checkout; only the step is tolerant

    def test_no_label_or_write(self):
        text = yaml.safe_dump(self.job)
        for bad in ("gh pr", "gh api", "label", "GH_TOKEN", "secrets.", "write"):
            self.assertNotIn(bad, text, bad)

    def test_exposes_result(self):
        self.assertIn("steps.classify.outputs.risk", self.job["outputs"]["risk"])

    def test_runs_the_script_isolated(self):
        run_text = [s for s in self.job["steps"] if s.get("id") == "classify"][0]["run"]
        self.assertIn("python3 -I .github/scripts/pr_risk.py", run_text)

    def test_title_goes_through_env_not_the_script_body(self):
        s = [s for s in self.job["steps"] if s.get("id") == "classify"][0]
        self.assertNotIn("github.event.pull_request.title", s["run"])
        self.assertIn("github.event.pull_request.title", s["env"]["PR_TITLE"])

    def test_no_other_job_needs_risk(self):
        for name, job in self.ci["jobs"].items():
            needs = job.get("needs", [])
            needs = [needs] if isinstance(needs, str) else needs
            self.assertNotIn("risk", needs, name)


if __name__ == "__main__":
    unittest.main()
