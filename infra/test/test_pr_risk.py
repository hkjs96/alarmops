"""PR risk classifier (.github/scripts/pr_risk.py), the hub's check script (pr_risk_check.sh) and the pinned shape of the
`risk` job in ci.yml. Expected answers come from the rules of D-62 and the security review, not from the script's output.
Scope is deliberately small: low = documents (plain files, not test inputs / gate evidence / agent-read documents)
and NEW test files. Everything else, including every dependency file and every change to an existing test, is human.
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

_UNSET = object()


def run(files, raw=_UNSET):
    """files: paths (status M) or (status, path). raw defaults to plain 100644 files (000000 -> 100644 for A)."""
    fl = [("M", f) if isinstance(f, str) else f for f in files]
    if raw is _UNSET:
        raw = {p: ("000000" if s == "A" else "100644", "100644") for s, p in fl}
    return pr_risk.classify(fl, raw)


def rule_of(res, path=None):
    return [r["rule"] for r in res[1] if path is None or r["path"] == path][0]


class Low(unittest.TestCase):
    def test_docs_added_and_modified(self):
        self.assertEqual(run([("A", "docs/new.md"), "docs/process/x.md", "docs/research/y.md"])[0], "low")

    def test_new_test_files_by_name(self):
        for p in ("services/x/test/test_a.py", "services/x/tests/b_test.py", "apps/console/src/a.test.tsx", "a/b.test.ts",
                  "scripts/c.test.mjs", "packages/z/d.spec.ts", "apps/console/e2e/login.spec.ts", "infra/test/test_x.py"):
            self.assertEqual(run([("A", p)])[0], "low", p)

    def test_docs_plus_new_test(self):
        self.assertEqual(run(["docs/process/a.md", ("A", "a/b.test.ts")])[0], "low")


class Human(unittest.TestCase):
    def test_empty_list(self):
        self.assertEqual(run([])[0], "human")

    def test_decisions_md(self):
        res = run(["docs/decisions/DECISIONS.md"])
        self.assertEqual(res[0], "human")
        self.assertEqual(rule_of(res), "docs-human")

    def test_docs_plus_decisions(self):
        self.assertEqual(run(["docs/process/a.md", "docs/decisions/DECISIONS.md"])[0], "human")

    def test_deleted_test(self):
        res = run([("D", "services/x/tests/test_a.py")])
        self.assertEqual(res[0], "human")
        self.assertEqual(rule_of(res), "test-existing")

    def test_workflow(self):
        res = run([".github/workflows/ci.yml"])
        self.assertEqual(res[0], "human")
        self.assertIn(".github/**", res[1][0]["detail"])

    def test_always_human_paths(self):
        for p in (".github/scripts/x.test.mjs", ".claude/settings.json", "CLAUDE.md", "infra/aws/central.yaml",
                  "infra/customer-stack/template.yaml", "db/prisma/schema.prisma", "db/test/x.test.ts",
                  "infra/aws/test/test_a.py", "infra/scripts/rehearsal/run.sh", "infra/scripts/rehearsal/README.md",
                  "infra/scripts/rehearsal/x.test.mjs"):
            res = run([("A", p)])
            self.assertEqual(res[0], "human", p)
            self.assertEqual(rule_of(res), "always-human", p)

    def test_mixed(self):
        res = run(["docs/process/a.md", "services/x/handler.py", ("A", "a.test.ts")])
        self.assertEqual(res[0], "human")
        self.assertEqual([r["path"] for r in res[1] if r["verdict"] == "human"], ["services/x/handler.py"])

    def test_not_listed_default(self):
        self.assertEqual(run(["apps/console/src/page.tsx"])[0], "human")
        self.assertEqual(run(["README.md"])[0], "human")


class ReviewFindings(unittest.TestCase):
    """Bypass cases of the security reviews."""

    # existing tests: any modification is human
    def test_modified_existing_test_is_human_even_with_only_added_lines(self):
        res = run(["a/b.test.ts"])
        self.assertEqual(res[0], "human")
        self.assertEqual(rule_of(res), "test-existing")

    def test_added_skip_line_to_an_existing_test(self):
        # the diff is a pure addition (`it.skip(...)`, `@unittest.skip`): still human, whatever numstat would say
        for p in ("apps/console/src/a.test.tsx", "services/x/tests/test_a.py", "packages/z/d.spec.ts"):
            self.assertEqual(run([("M", p)])[0], "human", p)

    def test_test_status_other_than_added(self):
        for st in ("M", "D", "T", "R", "C"):
            self.assertEqual(run([(st, "a/b.test.ts")])[0], "human", st)

    # new test files: regular files only
    def test_new_test_symlink_or_exec_bit(self):
        self.assertEqual(run([("A", "a/b.test.ts")], raw={"a/b.test.ts": ("000000", "120000")})[0], "human")
        self.assertEqual(run([("A", "a/b.test.ts")], raw={"a/b.test.ts": ("000000", "100755")})[0], "human")
        self.assertEqual(run([("A", "a/b.test.ts")], raw={"a/b.test.ts": ("000000", "100644")})[0], "low")

    def test_new_test_without_mode_info(self):
        self.assertEqual(run([("A", "a/b.test.ts")], raw=None)[0], "human")

    # test/ directory does not make a test
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
        self.assertEqual(run([("A", "apps/console/e2e/a.test.mjs")])[0], "human")
        self.assertEqual(run([("A", "apps/console/e2e/a.ts")])[0], "human")

    # no Dependabot exception: every dependency file is human
    def test_dependency_files_are_always_human(self):
        for p in ("package.json", "package-lock.json", "apps/console/package.json", "services/x/package-lock.json",
                  "services/alarm-engine/requirements-dev.txt", "infra/requirements-ci.txt", "requirements.txt",
                  "pyproject.toml", "services/x/pyproject.toml", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile",
                  ".npmrc", ".nvmrc", "setup.py", "uv.lock"):
            for st in ("M", "A"):
                res = run([(st, p)])
                self.assertEqual(res[0], "human", p)
                self.assertEqual(rule_of(res), "dependency-file", p)

    def test_dependency_file_next_to_docs_makes_the_pr_human(self):
        self.assertEqual(run(["docs/process/a.md", "package-lock.json"])[0], "human")

    def test_classifier_has_no_dependabot_logic(self):
        text = SCRIPT.read_text(encoding="utf-8").lower()
        for gone in ("emails", "numstat", "package_json_only_versions", "title_re", "pr_author", "pr_title"):
            self.assertNotIn(gone, text, gone)
        self.assertNotIn("dependabot_bump", text)

    def test_dependabot_pr_is_human(self):
        # Dependabot PRs change dependency files (and maybe workflows); whoever the author is, the answer is human
        for files in (["package.json", "package-lock.json"], ["apps/console/package.json"], [".github/workflows/ci.yml"],
                      ["infra/requirements-ci.txt"]):
            self.assertEqual(run(files)[0], "human", files)

    # documents
    def test_docs_human_list(self):
        for p in ("docs/decisions/DECISIONS.md", "docs/specs/alarm-rules.md", "docs/specs/other.md", "docs/GO-LIVE.md",
                  "docs/SETUP-PROD-DB.md", "docs/SETUP-SUPABASE.md", "docs/API-CONTRACT.md", "docs/DATA-MODEL.md",
                  "docs/PERSONAS.md", "docs/qa/results.md", "docs/qa/new.md", "docs/ui/menu.md", "docs/ui/README.md"):
            for st in ("M", "A"):
                res = run([(st, p)])
                self.assertEqual(res[0], "human", p)
                self.assertEqual(rule_of(res), "docs-human", p)

    def test_docs_executables_and_scripts(self):
        for p in ("docs/x.sh", "docs/y.py", "docs/z.mjs", "docs/w.js", "docs/process/run.sh", "docs/Z.SH"):
            self.assertEqual(run([("A", p)])[0], "human", p)

    def test_docs_symlink_and_exec_mode(self):
        self.assertEqual(run([("A", "docs/link.md")], raw={"docs/link.md": ("000000", "120000")})[0], "human")
        self.assertEqual(run(["docs/link.md"], raw={"docs/link.md": ("120000", "100644")})[0], "human")
        self.assertEqual(run([("A", "docs/x.md")], raw={"docs/x.md": ("000000", "100755")})[0], "human")
        self.assertEqual(run([("A", "docs/x.md")], raw={"docs/x.md": ("000000", "100644")})[0], "low")

    def test_docs_without_mode_info(self):
        self.assertEqual(run(["docs/process/a.md"], raw=None)[0], "human")

    def test_docs_deletion(self):
        self.assertEqual(run([("D", "docs/process/a.md")])[0], "human")
        self.assertEqual(run(["docs/process/b.md", ("D", "docs/research/c.md")])[0], "human")

    def test_parse_raw(self):
        raw = pr_risk.parse_raw(":100644 120000 abc def M\tdocs/a.md\n:000000 100755 0 d A\tdocs/b.md\n")
        self.assertEqual(raw["docs/a.md"], ("100644", "120000"))
        self.assertEqual(raw["docs/b.md"], ("000000", "100755"))

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
    def _run(self, stdin, args=()):
        env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT")}
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], input=stdin, capture_output=True, text=True, env=env)

    def test_stdout_is_one_json_line_exit_zero_and_has_head(self):
        res = self._run("M\tdocs/a.md\nD\tx/test/b.py\n", args=("--head", "c" * 40))
        self.assertEqual(res.returncode, 0)
        self.assertEqual(len(res.stdout.strip().splitlines()), 1)
        data = json.loads(res.stdout)
        self.assertEqual((data["risk"], data["head"]), ("human", "c" * 40))
        self.assertIn("| file |", res.stderr)

    def test_docs_need_raw_input(self):
        self.assertEqual(json.loads(self._run("docs/process/a.md\n").stdout)["risk"], "human")
        with tempfile.TemporaryDirectory() as d:
            raw = Path(d) / "raw.txt"
            raw.write_text(":100644 100644 a b M\tdocs/process/a.md\n")
            self.assertEqual(json.loads(self._run("docs/process/a.md\n", args=("--raw", str(raw))).stdout)["risk"], "low")

    def test_empty_stdin_is_human_exit_zero(self):
        res = self._run("")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(res.stdout)["risk"], "human")


@unittest.skipUnless(shutil.which("git") and shutil.which("bash"), "git and bash are needed")
class HubCheckScript(unittest.TestCase):
    """pr_risk_check.sh in a throwaway repository with a local `origin`: the classifier comes from origin/main, not the PR."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.origin, self.repo = root / "origin.git", root / "work"
        self.env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_COMMITTER_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                    "GIT_COMMITTER_EMAIL": "t@example.com", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        self.env.pop("GITHUB_ACTIONS", None)
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], env=self.env, check=True)
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("remote", "add", "origin", str(self.origin))
        (self.repo / ".github" / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPT, self.repo / ".github" / "scripts" / "pr_risk.py")
        shutil.copy(CHECK, self.repo / ".github" / "scripts" / "pr_risk_check.sh")
        (self.repo / "docs" / "process").mkdir(parents=True)
        (self.repo / "docs" / "process" / "a.md").write_text("a\n")
        (self.repo / "t.test.ts").write_text("one\ntwo\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "base")
        self.git("push", "-q", "origin", "main")
        self.git("checkout", "-q", "-b", "pr")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *a):
        return subprocess.run(["git", *a], cwd=self.repo, env=self.env, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "pr")
        return self.git("rev-parse", "HEAD")

    def check(self, sha, extra_env=None):
        env = {**self.env, **(extra_env or {})}
        return subprocess.run(["bash", str(self.repo / ".github" / "scripts" / "pr_risk_check.sh"), sha],
                              cwd=self.repo, env=env, capture_output=True, text=True)

    def test_docs_only_pr_is_low_and_prints_the_sha(self):
        (self.repo / "docs" / "process" / "b.md").write_text("b\n")
        sha = self.commit()
        res = self.check(sha)
        self.assertEqual(res.returncode, 0, res.stderr)
        data = json.loads(res.stdout)
        self.assertEqual((data["risk"], data["head"]), ("low", sha))

    def test_pr_cannot_rewrite_its_own_judge(self):
        (self.repo / ".github" / "scripts" / "pr_risk.py").write_text(
            "import json\nprint(json.dumps({'risk': 'low', 'head': 'x', 'reasons': []}))\n")
        (self.repo / "app.py").write_text("print(1)\n")
        res = self.check(self.commit())
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["risk"], "human")

    def test_new_test_is_low_and_edit_of_existing_test_is_human(self):
        (self.repo / "new.test.ts").write_text("x\n")
        self.assertEqual(json.loads(self.check(self.commit()).stdout)["risk"], "low")
        (self.repo / "t.test.ts").write_text("one\ntwo\nit.skip('x')\n")  # pure addition
        self.assertEqual(json.loads(self.check(self.commit()).stdout)["risk"], "human")

    def test_docs_symlink_is_human(self):
        os.symlink("/etc/passwd", self.repo / "docs" / "process" / "link.md")
        self.assertEqual(json.loads(self.check(self.commit()).stdout)["risk"], "human")

    def test_dependency_bump_is_human(self):
        (self.repo / "package.json").write_text(json.dumps({"dependencies": {"left-pad": "^1.3.0"}}))
        self.assertEqual(json.loads(self.check(self.commit(), {"PR_AUTHOR": "dependabot[bot]"}).stdout)["risk"], "human")

    def test_base_cannot_be_changed_by_environment(self):
        # BASE_REF is ignored: an attacker-chosen base (here the PR itself, which would give an empty diff) has no effect
        (self.repo / "app.py").write_text("print(1)\n")
        sha = self.commit()
        res = self.check(sha, {"BASE_REF": sha, "BASE": sha, "BASE_SHA": sha})
        self.assertEqual(json.loads(res.stdout)["risk"], "human")
        self.assertIn("app.py", res.stdout)

    def test_script_forces_a_fetch_of_origin_main(self):
        # main moves on origin after the clone's last fetch; the script must see it (it touches app.py there)
        other = Path(self.tmp.name) / "other"
        subprocess.run(["git", "clone", "-q", str(self.origin), str(other)], env=self.env, check=True)
        (other / "docs" / "process" / "zz.md").write_text("z\n")
        for a in (["add", "-A"], ["commit", "-q", "-m", "m2"], ["push", "-q", "origin", "main"]):
            subprocess.run(["git", *a], cwd=other, env=self.env, check=True, capture_output=True)
        (self.repo / "docs" / "process" / "b.md").write_text("b\n")
        sha = self.commit()
        before = self.git("rev-parse", "origin/main")
        res = self.check(sha)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertNotEqual(self.git("rev-parse", "origin/main"), before)

    def test_fetch_failure_stops_the_script(self):
        (self.repo / "docs" / "process" / "b.md").write_text("b\n")
        sha = self.commit()
        self.git("remote", "set-url", "origin", str(Path(self.tmp.name) / "missing.git"))
        res = self.check(sha)
        self.assertNotEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")

    def test_bad_arguments_are_rejected(self):
        for bad in ("not-a-sha", "--help", "-x", "", "A" * 40, "a" * 39):
            res = self.check(bad)
            self.assertNotEqual(res.returncode, 0, bad)
            self.assertEqual(res.stdout.strip(), "", bad)

    def test_script_text_has_no_overridable_base(self):
        text = CHECK.read_text(encoding="utf-8")
        self.assertNotIn("BASE_REF:-", text)
        self.assertIn('base_ref="origin/main"', text)
        self.assertIn("git fetch --quiet origin main", text)


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

    def test_uses_the_check_script_with_fixed_base(self):
        self.assertIn("pr_risk_check.sh", self.step["run"])
        self.assertNotIn("BASE_REF", self.step["run"])
        self.assertNotIn("pull_request.title", yaml.safe_dump(self.step))  # no free text of the PR reaches the job

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
        cls.d62 = text[text.index("### D-62"):].split("\n## ", 1)[0]

    def test_low_definition_matches_the_rules(self):
        self.assertIn("새 테스트 파일 추가", self.d62)
        self.assertIn("기존 테스트 파일의 수정은 줄만 추가해도 human", self.d62)
        self.assertIn("의존성 파일", self.d62)
        self.assertRegex(self.d62, r"Dependabot PR이어도 human")
        self.assertIn("`docs/qa/**`", self.d62)
        self.assertIn("`docs/ui/**`", self.d62)
        self.assertNotIn("0.x", self.d62)
        self.assertNotIn("줄만 추가(", self.d62)

    def test_official_verdict_procedure_is_written(self):
        self.assertIn("pr_risk_check.sh", self.d62)
        self.assertIn("origin/main", self.d62)
        self.assertIn("git fetch origin main", self.d62)

    def test_review_again_note(self):
        self.assertIn("새 테스트 파일은 CI와 개발 PC에서 임의 코드로 실행된다", self.d62)

    def test_claude_md_gate_5_is_updated(self):
        line = [l for l in CLAUDE_MD.read_text(encoding="utf-8").splitlines() if l.startswith("5. ")][0]
        self.assertIn("새 테스트 파일 추가", line)
        self.assertIn("Dependabot은 human", line)
        self.assertNotIn("patch/minor", line)
        self.assertNotIn("리허설", line)


if __name__ == "__main__":
    unittest.main()
