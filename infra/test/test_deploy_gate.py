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
    STEM = "deploy-central"

    def run_(self, sha, conclusion="success", title=None):
        return {"id": int(sha[0]) * 1000, "conclusion": conclusion, "display_title": title or f"deploy-central {sha}"}

    def find(self, runs, jobs, deploy_job="apply", **kw):
        return dg.find_base(runs, lambda i: jobs[i], deploy_job, self.STEM, **kw)

    def test_newest_run_whose_deploy_job_succeeded(self):
        r1, r2, r3 = self.run_("1" * 40), self.run_("2" * 40), self.run_("3" * 40)
        jobs = {r1["id"]: [{"name": "apply", "conclusion": "success"}],
                r2["id"]: [{"name": "gate", "conclusion": "success"}, {"name": "apply", "conclusion": "skipped"}],
                r3["id"]: [{"name": "gate", "conclusion": "success"}, {"name": "build", "conclusion": "skipped"}]}
        # r3 (gate only) and r2 (apply skipped) are not bases
        self.assertEqual(self.find([r3, r2, r1], jobs), "1" * 40)

    def test_empty_change_set_run_is_a_base_when_noop_job_given(self):
        # plan success + apply skipped = empty change set = the stack equals that commit
        r = self.run_("2" * 40)
        jobs = {r["id"]: [{"name": "gate", "conclusion": "success"}, {"name": "plan", "conclusion": "success"},
                          {"name": "apply", "conclusion": "skipped"}]}
        self.assertEqual(self.find([r], jobs, noop_job="plan"), "2" * 40)
        self.assertIsNone(self.find([r], jobs))  # console: no such case

    def test_failed_or_skipped_plan_is_never_a_base(self):
        for plan in ("failure", "cancelled", "skipped"):
            r = self.run_("2" * 40)
            jobs = {r["id"]: [{"name": "plan", "conclusion": plan}, {"name": "apply", "conclusion": "skipped"}]}
            self.assertIsNone(self.find([r], jobs, noop_job="plan"), plan)

    def test_failed_apply_after_good_plan_is_not_a_base(self):
        r = self.run_("2" * 40)
        for apply in ("failure", "cancelled"):
            jobs = {r["id"]: [{"name": "plan", "conclusion": "success"}, {"name": "apply", "conclusion": apply}]}
            self.assertIsNone(self.find([r], jobs, noop_job="plan"), apply)

    def test_deploy_job_name_must_match(self):
        r = self.run_("1" * 40)
        self.assertIsNone(self.find([r], {r["id"]: [{"name": "deploy", "conclusion": "success"}]}))

    def test_current_run_and_untitled_runs_are_ignored(self):
        cur, old = self.run_("1" * 40), {"id": 7, "conclusion": "success", "display_title": "Merge pull request #1"}
        ok = {cur["id"]: [{"name": "apply", "conclusion": "success"}], 7: [{"name": "apply", "conclusion": "success"}]}
        self.assertIsNone(self.find([cur, old], ok, current_run_id=cur["id"]))

    def test_title_ending_in_hex_is_not_a_base(self):
        # an old commit message (display_title before run-name existed) that happens to end in 40 hex characters
        ok = lambda r: {r["id"]: [{"name": "apply", "conclusion": "success"}]}
        for title in (f"Revert {A}", f"deploy-central {A} extra", f" deploy-central {A}", f"deploy-console {A}",
                      f"x deploy-central {A}", f"deploy-central {A.upper()}"):
            r = self.run_("1" * 40, title=title)
            self.assertIsNone(self.find([r], ok(r)), title)

    def test_no_runs_no_base(self):
        self.assertIsNone(self.find([], {}))

    def test_sha_from_title(self):
        self.assertEqual(dg.sha_from_title(f"deploy-console {A}", "deploy-console"), A)
        self.assertIsNone(dg.sha_from_title(f"deploy-console {A}", "deploy-central"))
        self.assertIsNone(dg.sha_from_title("deploy-console abc", "deploy-console"))
        self.assertIsNone(dg.sha_from_title(None, "deploy-console"))


class MainWithMockedApi(unittest.TestCase):
    """main() end to end with gh_json and the git helpers replaced: the API queries and the decision wiring."""

    def run_main(self, argv, runs, jobs, ancestor=True, files=("README.md",), event="workflow_run"):
        self.calls = []

        def fake_gh(path):
            self.calls.append(path)
            if "/jobs" in path:
                return {"jobs": jobs[int(path.split("/runs/")[1].split("/")[0])]}
            return {"workflow_runs": runs}

        saved = (dg.gh_json, dg.git_is_ancestor, dg.git_changed_files)
        dg.gh_json = fake_gh
        dg.git_is_ancestor = lambda b, h: ancestor
        dg.git_changed_files = lambda b, h: list(files)
        d = Path(tempfile.mkdtemp())
        try:
            dg.main(argv, {"EVENT": event, "HEAD_SHA": B, "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "99",
                           "GITHUB_OUTPUT": str(d / "out")})
        finally:
            dg.gh_json, dg.git_is_ancestor, dg.git_changed_files = saved
        return (d / "out").read_text()

    def test_query_filters_and_skip(self):
        run = {"id": 5, "conclusion": "success", "display_title": f"deploy-central {A}"}
        out = self.run_main(["deploy-central.yml", "apply", CENTRAL, "plan"], [run],
                            {5: [{"name": "apply", "conclusion": "success"}]})
        self.assertEqual(out, "deploy=false\n")
        q = self.calls[0]
        self.assertTrue(q.startswith("repos/o/r/actions/workflows/deploy-central.yml/runs?"), q)
        self.assertIn("branch=main", q)
        self.assertIn("status=success", q)
        self.assertEqual(self.calls[1], "repos/o/r/actions/runs/5/jobs?per_page=100")

    def test_changed_path_deploys(self):
        run = {"id": 5, "conclusion": "success", "display_title": f"deploy-central {A}"}
        out = self.run_main(["deploy-central.yml", "apply", CENTRAL], [run],
                            {5: [{"name": "apply", "conclusion": "success"}]}, files=["services/a.ts"])
        self.assertEqual(out, "deploy=true\n")

    def test_no_base_deploys_and_empty_changeset_run_counts_as_base(self):
        run = {"id": 5, "conclusion": "success", "display_title": f"deploy-central {A}"}
        noop = {5: [{"name": "plan", "conclusion": "success"}, {"name": "apply", "conclusion": "skipped"}]}
        self.assertEqual(self.run_main(["deploy-central.yml", "apply", CENTRAL], [run], noop), "deploy=true\n")
        self.assertEqual(self.run_main(["deploy-central.yml", "apply", CENTRAL, "plan"], [run], noop), "deploy=false\n")

    def test_own_run_is_excluded_and_base_not_ancestor_deploys(self):
        own = {"id": 99, "conclusion": "success", "display_title": f"deploy-central {A}"}
        jobs = {99: [{"name": "apply", "conclusion": "success"}]}
        self.assertEqual(self.run_main(["deploy-central.yml", "apply", CENTRAL], [own], jobs), "deploy=true\n")
        run = dict(own, id=5)
        self.assertEqual(self.run_main(["deploy-central.yml", "apply", CENTRAL], [run], {5: jobs[99]}, ancestor=False),
                         "deploy=true\n")


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
