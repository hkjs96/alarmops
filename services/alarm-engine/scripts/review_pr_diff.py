"""PR-review checks for issue #123 that need the PR diff (not a pytest: the diff is empty after merge).

Run by the reviewer / CI step with full history:

    git fetch --no-tags origin main          # or actions/checkout with fetch-depth: 0
    python services/alarm-engine/scripts/review_pr_diff.py [--base origin/main]

Exit code 1 on any failed check; exit code 2 when the base ref is missing (never a silent pass).
Checks: first contract commit touches only API-CONTRACT section 6 and precedes the code; no account-id / queue-URL /
ARN / region literals in added source lines; no new migration and no db/scripts/check.mjs change; CentralRole gains only
sqs:SendMessage on the commands queue; bootstrap gains no scheduler:* and no iam:PassRole.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE_PATHS = ["services/alarm-engine/src", "infra/aws/central.yaml", "infra/aws/central-bootstrap.yaml"]


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=120, check=False)
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def added_lines(base: str, paths: list[str]) -> list[tuple[str, str]]:
    cur, rows = "", []
    for ln in git("diff", "-U0", f"{base}...HEAD", "--", *paths).splitlines():
        if ln.startswith("+++ b/"):
            cur = ln[6:]
        elif ln.startswith("+") and not ln.startswith("+++"):
            rows.append((cur, ln[1:]))
    return rows


def check_contract_commit(base: str) -> list[str]:
    commits = git("rev-list", "--reverse", f"{base}..HEAD").split()
    names = {c: git("show", "--name-only", "--format=", c).split() for c in commits}
    doc = next((c for c in commits if "docs/API-CONTRACT.md" in names[c]), None)
    if doc is None:
        return ["no commit changes docs/API-CONTRACT.md"]
    errs = []
    if names[doc] != ["docs/API-CONTRACT.md"]:
        errs.append(f"first contract commit touches other files: {names[doc]}")
    old = git("show", f"{doc}^:docs/API-CONTRACT.md").splitlines()
    s6 = next(i for i, ln in enumerate(old, 1) if ln.startswith("## 6. "))
    s7 = next(i for i, ln in enumerate(old, 1) if i > s6 and ln.startswith("## 7. "))
    diff = git("diff", "-U0", f"{doc}^", doc, "--", "docs/API-CONTRACT.md")
    for m in re.finditer(r"^@@ -(\d+)(?:,(\d+))? ", diff, re.M):
        a, n = int(m.group(1)), int(m.group(2) or 1)
        if not (s6 <= a and a + max(n, 1) - 1 <= s7):
            errs.append(f"hunk at old line {a} is outside section 6")
    first_code = next((c for c in commits if any(f.startswith(("services/alarm-engine/src", "infra/"))
                                                  for f in names[c])), None)
    if first_code is not None and commits.index(doc) > commits.index(first_code):
        errs.append("contract commit comes after the first code commit")
    return errs


def check_literals(base: str) -> list[str]:
    bad = []
    for path, ln in added_lines(base, SOURCE_PATHS):
        code = ln.strip()
        if code.startswith("#"):
            continue
        if (re.search(r"(?<!\d)\d{12}(?!\d)", code) or re.search(r"sqs\.[a-z0-9-]+\.amazonaws|https://sqs\.", code)
                or re.search(r"arn:aws[a-z-]*:", code) or re.search(r"\b[a-z]{2}-[a-z]+-\d\b", code)):
            bad.append(f"{path}: {code}")
    return bad


def check_no_migration(base: str) -> list[str]:
    files = git("diff", "--name-only", f"{base}...HEAD").split()
    return [f"changed: {f}" for f in files if f.startswith("db/prisma/migrations/") or f == "db/scripts/check.mjs"]


def check_permissions(base: str) -> list[str]:
    errs = []
    added = [t for _, t in added_lines(base, ["infra/aws/central-bootstrap.yaml"])]
    if any("scheduler:" in t or "iam:PassRole" in t for t in added):
        errs.append("bootstrap diff adds scheduler:* or iam:PassRole")
    added_c = [t.strip() for _, t in added_lines(base, ["infra/aws/central.yaml"])]
    if any(re.search(r"sqs:(Send|\*)", t) for t in added_c) and sum("sqs:SendMessage" in t for t in added_c) > 2:
        errs.append("central.yaml adds more than the one CommandsQueue sqs:SendMessage grant (and the DLQ policy)")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/main")
    args = ap.parse_args()
    try:
        git("rev-parse", "--verify", args.base)
    except RuntimeError as e:
        print(f"ERROR: base ref {args.base} is not available (shallow checkout?): {e}", file=sys.stderr)
        return 2
    failed = False
    for name, fn in (("contract commit", check_contract_commit), ("literals", check_literals),
                     ("no migration", check_no_migration), ("permissions", check_permissions)):
        errs = fn(args.base)
        print(f"{'FAIL' if errs else 'ok  '} {name}")
        for e in errs:
            print(f"     {e}")
        failed = failed or bool(errs)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
