"""Gate of deploy-central / deploy-console: deploy only when something changed SINCE THE LAST SUCCESSFUL DEPLOY.
Standard library only; run as `python3 -I .github/scripts/deploy_gate.py <deploy-workflow-file> <deploy-job> <path-regex>`.

Why not "the files of the merged commit": two merges one minute apart can cancel the first `ci` run (concurrency), so that
commit is never deployed; judging only the second commit then skips the first one's changes for good.

Base commit = the head_sha of the newest run of the SAME workflow on main whose real deploy job (<deploy-job>: `apply` /
`deploy`) ended in success. A run where only `gate` ran and the rest was skipped is not a base. The deploy workflows set
`run-name` to the commit they deploy (a workflow_run run's own head_sha is the latest main commit, not ci's head_sha), so
the commit is read from the run's display_title. Decision (decide()):
  no base                      -> deploy   (fail-safe)
  base is not an ancestor      -> deploy   (fail-safe; also when git cannot tell)
  diff <base>..<head> fails    -> deploy   (fail-safe)
  a changed file matches regex -> deploy
  otherwise                    -> skip (also when base == head: nothing new)
Environment: EVENT (github.event_name), HEAD_SHA (commit to deploy), GITHUB_REPOSITORY, GITHUB_RUN_ID (excluded),
GH_TOKEN (GITHUB_TOKEN with `actions: read`), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Writes `deploy=true|false`. Never exits non-zero
on a judgement problem: the answer is then deploy=true.
"""
import json
import os
import re
import subprocess
import sys

SHA_RE = re.compile(r"[0-9a-f]{40}")
MAX_RUNS_CHECKED = 30


def sha_from_title(title):
    """The commit a run deployed, from its run-name (`<workflow> <40-hex sha>`); None when the title has none."""
    m = SHA_RE.fullmatch((title or "").strip().rsplit(" ", 1)[-1])
    return m.group(0) if m else None


def find_base(runs, jobs_of, deploy_job, current_run_id=None):
    """runs: newest first (API order). jobs_of(run_id) -> list of job dicts. Returns a sha or None."""
    checked = 0
    for run in runs:
        if str(run.get("id")) == str(current_run_id) or run.get("conclusion") != "success":
            continue
        sha = sha_from_title(run.get("display_title"))
        if not sha:
            continue
        checked += 1
        if checked > MAX_RUNS_CHECKED:
            return None
        if any(j.get("name") == deploy_job and j.get("conclusion") == "success" for j in jobs_of(run["id"])):
            return sha
    return None


def decide(base, head, is_ancestor, changed_files, path_re):
    """-> (deploy: bool, reason). changed_files(base, head) -> list or None on error."""
    if not base:
        return True, "no earlier successful deploy found; deploying (fail-safe)."
    if not is_ancestor(base, head):
        return True, f"last deployed commit {base[:12]} is not an ancestor of {head[:12]}; deploying (fail-safe)."
    files = changed_files(base, head)
    if files is None:
        return True, "Cannot judge the diff; deploying (fail-safe)."
    rx = re.compile(path_re)
    hit = [f for f in files if rx.search(f)]
    if hit:
        return True, f"changed since the last deploy {base[:12]}: {hit[0]}" + (f" (+{len(hit) - 1} more)" if len(hit) > 1 else "")
    return False, f"no deploy path changed in {base[:12]}..{head[:12]}; skipping the deploy."


def _git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True)


def git_is_ancestor(base, head):
    return _git("merge-base", "--is-ancestor", base, head).returncode == 0


def git_changed_files(base, head):
    r = _git("diff", "--name-only", "--no-renames", f"{base}..{head}")
    return r.stdout.splitlines() if r.returncode == 0 else None


def gh_json(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout)


def main(argv, env):
    workflow, deploy_job, path_re = argv
    out = env.get("GITHUB_OUTPUT")

    def emit(deploy, reason):
        print(reason)
        for f, line in ((out, f"deploy={'true' if deploy else 'false'}"), (env.get("GITHUB_STEP_SUMMARY"), reason)):
            if f:
                with open(f, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")

    if env.get("EVENT") != "workflow_run":
        return emit(True, "Manual run; deploying.")
    head = env.get("HEAD_SHA", "")
    repo = env.get("GITHUB_REPOSITORY", "")
    try:
        if not SHA_RE.fullmatch(head):
            raise ValueError("HEAD_SHA is not a commit sha")
        runs = gh_json(f"repos/{repo}/actions/workflows/{workflow}/runs?branch=main&status=success&per_page=50")["workflow_runs"]
        base = find_base(runs, lambda i: gh_json(f"repos/{repo}/actions/runs/{i}/jobs?per_page=100")["jobs"],
                         deploy_job, env.get("GITHUB_RUN_ID"))
        deploy, reason = decide(base, head, git_is_ancestor, git_changed_files, path_re)
    except Exception as e:  # any failure to judge deploys
        deploy, reason = True, f"Cannot judge ({type(e).__name__}: {e}); deploying (fail-safe)."
    emit(deploy, reason)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__.split("\n")[1], file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1:], os.environ)
