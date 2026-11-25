"""Tests for .github/scripts/deploy_gate.py (gate of deploy-central / deploy-console: range since the last deploy)."""
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "deploy_gate.py"
spec = importlib.util.spec_from_file_location("deploy_gate", SCRIPT)
dg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dg)

CENTRAL = r"^(infra/aws/|services/|packages/core/|package[^/]*\.json$)"
A, B = "a" * 40, "b" * 40


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                           "-c", "commit.gpgsign=false", *args], capture_output=True, text=True, check=True).stdout.strip()


class Repo:
    """A real git repo; commit(files) returns the sha."""
    def __init__(self):
        self.dir = Path(tempfile.mkdtemp())
        git(self.dir, "init", "-q", "-b", "main")

    def commit(self, *files):
        for f in files:
            p = self.dir / f
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(p.read_text() + "x" if p.exists() else "x")
        git(self.dir, "add", "-A")
        git(self.dir, "commit", "-q", "-m", "c", "--allow-empty")
        return git(self.dir, "rev-parse", "HEAD")

    def judge(self, base, head):
        old = os.getcwd()
        os.chdir(self.dir)
        try:
            return dg.decide(base, head, dg.git_is_ancestor, dg.git_changed_files, CENTRAL)
        finally:
            os.chdir(old)


class Decide(unittest.TestCase):
    def setUp(self):
        self.r = Repo()
        self.base = self.r.commit("README.md")

    def test_no_base_deploys(self):
        self.assertTrue(self.r.judge(None, self.base)[0])

    def test_base_not_an_ancestor_deploys(self):
        git(self.r.dir, "checkout", "-q", "-b", "side")
        side = self.r.commit("docs/side.md")
        git(self.r.dir, "checkout", "-q", "main")
        head = self.r.commit("docs/a.md")
        deploy, why = self.r.judge(side, head)  # no central path in the diff, still deploys
        self.assertTrue(deploy)
        self.assertIn("not an ancestor", why)

    def test_unknown_base_deploys(self):
        self.assertTrue(self.r.judge("f" * 40, self.base)[0])

    def test_central_path_in_range_deploys(self):
        head = self.r.commit("services/ingest/a.ts")
        self.assertTrue(self.r.judge(self.base, head)[0])

    def test_no_change_in_range_skips(self):
        self.r.commit("docs/a.md")
        head = self.r.commit("apps/console/page.tsx")
        self.assertFalse(self.r.judge(self.base, head)[0])

    def test_same_commit_skips(self):
        self.assertFalse(self.r.judge(self.base, self.base)[0])

    def test_change_in_an_earlier_commit_of_the_range_deploys(self):
        # the 11/25 bug: the cancelled commit touched services/, the last commit only the console
        self.r.commit("services/ingest/a.ts")
        head = self.r.commit("apps/console/page.tsx")
        self.assertTrue(self.r.judge(self.base, head)[0])
        # judging only the last commit (HEAD^..HEAD) would have skipped
        self.assertFalse(self.r.judge(git(self.r.dir, "rev-parse", "HEAD^"), head)[0])

    def test_git_diff_failure_deploys(self):
        deploy, why = dg.decide(A, B, lambda a, b: True, lambda a, b: None, CENTRAL)
        self.assertTrue(deploy)
        self.assertIn("fail-safe", why)


class FindBase(unittest.TestCase):
    def run_(self, sha, conclusion="success"):
        return {"id": int(sha[0]) * 1000, "conclusion": conclusion, "display_title": f"deploy-central {sha}"}

    def test_newest_run_whose_deploy_job_succeeded(self):
        r1, r2, r3 = self.run_("1" * 40), self.run_("2" * 40), self.run_("3" * 40)
        jobs = {r1["id"]: [{"name": "apply", "conclusion": "success"}],
                r2["id"]: [{"name": "gate", "conclusion": "success"}, {"name": "apply", "conclusion": "skipped"}],
                r3["id"]: [{"name": "gate", "conclusion": "success"}, {"name": "build", "conclusion": "skipped"}]}
        # r3 (gate only) and r2 (apply skipped) are not bases
        self.assertEqual(dg.find_base([r3, r2, r1], lambda i: jobs[i], "apply"), "1" * 40)

    def test_deploy_job_name_must_match(self):
        r = self.run_("1" * 40)
        self.assertIsNone(dg.find_base([r], lambda i: [{"name": "deploy", "conclusion": "success"}], "apply"))

    def test_current_run_and_untitled_runs_are_ignored(self):
        cur, old = self.run_("1" * 40), {"id": 7, "conclusion": "success", "display_title": "Merge pull request #1"}
        ok = lambda i: [{"name": "apply", "conclusion": "success"}]
        self.assertIsNone(dg.find_base([cur, old], ok, "apply", current_run_id=cur["id"]))

    def test_no_runs_no_base(self):
        self.assertIsNone(dg.find_base([], lambda i: [], "apply"))

    def test_sha_from_title(self):
        self.assertEqual(dg.sha_from_title(f"deploy-console {A}"), A)
        self.assertIsNone(dg.sha_from_title("deploy-console abc"))
        self.assertIsNone(dg.sha_from_title(None))


class Cli(unittest.TestCase):
    def run_cli(self, env):
        out = Path(tempfile.mkdtemp()) / "out"
        e = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(out), **env}
        r = subprocess.run(["python3", "-I", str(SCRIPT), "deploy-central.yml", "apply", CENTRAL],
                           capture_output=True, text=True, env=e, cwd=tempfile.mkdtemp())
        return r, out.read_text() if out.exists() else ""

    def test_manual_run_deploys(self):
        r, out = self.run_cli({"EVENT": "workflow_dispatch"})
        self.assertEqual((r.returncode, out), (0, "deploy=true\n"))

    def test_api_or_git_failure_deploys(self):
        r, out = self.run_cli({"EVENT": "workflow_run", "HEAD_SHA": A, "GITHUB_REPOSITORY": "o/r"})
        self.assertEqual((r.returncode, out), (0, "deploy=true\n"))
        self.assertIn("fail-safe", r.stdout)

    def test_bad_head_sha_deploys(self):
        r, out = self.run_cli({"EVENT": "workflow_run", "HEAD_SHA": ""})
        self.assertEqual(out, "deploy=true\n")


if __name__ == "__main__":
    unittest.main()
