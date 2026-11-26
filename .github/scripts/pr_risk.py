"""PR risk class: `low` (the hub may merge without a human approval once CI and review pass) or `human` (default).
Standard library only; run as `python3 -I .github/scripts/pr_risk.py` (D-62, planned).

Input (environment, so that a PR title is never put on a command line):
  PR_AUTHOR   login of the PR author
  PR_TITLE    PR title
  stdin       changed files of base..head, one per line: either `git diff --name-status --no-renames` lines
              (`M<TAB>path`, `D<TAB>path`) or bare paths from `git diff --name-only` (treated as modified).
Output: stdout is ONE JSON line {"risk": "low"|"human", "reasons": [{"path", "rule", "detail", "verdict"}...]};
a markdown table goes to $GITHUB_STEP_SUMMARY when set, else to stderr; `risk=<value>` goes to $GITHUB_OUTPUT when set.
Always exits 0 (information only).

low  = every file is in the low list: docs/** (not docs/decisions/DECISIONS.md), test files (a deleted test file is human),
       infra/scripts/rehearsal/**, docs/qa/**, and, for a Dependabot patch/minor PR, package.json / package-lock.json.
human = anything else. Always human, with the reason named: .github/**, .claude/**, CLAUDE.md, infra/aws/**,
       infra/customer-stack/**, db/**, package.json / package-lock.json (except the Dependabot patch/minor case),
       docs/decisions/DECISIONS.md. No files at all is human.
"""
import json
import os
import re
import sys

DEPENDABOT = "dependabot[bot]"
ALWAYS_HUMAN = [
    (".github/**", "workflow / CI / script change"),
    (".claude/**", "agent configuration change"),
    ("CLAUDE.md", "project instructions change"),
    ("infra/aws/**", "central AWS stack change"),
    ("infra/customer-stack/**", "customer-facing IAM stack change"),
    ("db/**", "database change"),
    ("docs/decisions/DECISIONS.md", "decision change (decisions are for a person)"),
]
DEP_FILES = ("package.json", "package-lock.json")
TITLE_RE = re.compile(r"\bfrom\s+v?(\d+)(?:\.[^\s]*)?\s+to\s+v?(\d+)(?:\.[^\s]*)?", re.I)


def _match(path, pattern):
    """Glob where `**` crosses directories and `*` does not."""
    rx = ""
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            rx += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            rx += ".*"
            i += 2
        elif pattern[i] == "*":
            rx += "[^/]*"
            i += 1
        else:
            rx += re.escape(pattern[i])
            i += 1
    return re.fullmatch(rx, path) is not None


def _is_test(path):
    parts = path.split("/")
    if "test" in parts[:-1] or "tests" in parts[:-1]:
        return True
    if _match(path, "apps/console/e2e/**"):
        return True
    return bool(re.fullmatch(r".+\.(test\.tsx?|test\.mjs|spec\.ts)", parts[-1]))


def dependabot_bump(author, title):
    """'minor' (patch or minor), 'major', or None when this is not a Dependabot bump whose versions can be read."""
    if author != DEPENDABOT:
        return None
    m = TITLE_RE.search(title or "")
    if not m:
        return None
    return "minor" if m.group(1) == m.group(2) else "major"


def parse_files(text):
    out = []
    for line in text.splitlines():
        line = line.rstrip("\r")
        if not line.strip():
            continue
        if "\t" in line:
            status, path = line.split("\t", 1)
            out.append((status.strip()[:1] or "M", path.strip()))
        else:
            out.append(("M", line.strip()))
    return out


def classify(files, author, title):
    """files: list of (status, path). Returns (risk, reasons)."""
    if not files:
        return "human", [{"path": "-", "rule": "empty", "detail": "no changed files (fail-safe)", "verdict": "human"}]
    bump = dependabot_bump(author, title)
    reasons = []
    for status, path in files:
        r = None
        for pat, why in ALWAYS_HUMAN:
            if _match(path, pat):
                r = ("always-human", f"{pat}: {why}", "human")
                break
        if r is None and path.split("/")[-1] in DEP_FILES:
            if bump == "minor":
                r = ("dependabot-minor", "Dependabot patch/minor update", "low")
            elif bump == "major":
                r = ("dependabot-major", "Dependabot major update", "human")
            else:
                r = ("always-human", "package.json / package-lock.json change (not a Dependabot patch/minor update)", "human")
        if r is None:
            if _match(path, "docs/qa/**"):
                r = ("docs-qa", "docs/qa/**", "low")
            elif _match(path, "docs/**"):
                r = ("docs", "docs/**", "low")
            elif _is_test(path):
                if status == "D":
                    r = ("test-deleted", "a deleted test file", "human")
                else:
                    r = ("test", "test file", "low")
            elif _match(path, "infra/scripts/rehearsal/**"):
                r = ("rehearsal", "infra/scripts/rehearsal/**", "low")
            else:
                r = ("not-listed", "outside the low list (default human)", "human")
        reasons.append({"path": path, "rule": r[0], "detail": r[1], "verdict": r[2]})
    risk = "low" if all(x["verdict"] == "low" for x in reasons) else "human"
    return risk, reasons


def render_table(risk, reasons):
    def cell(s):
        return str(s).replace("|", "\\|")

    lines = [f"### PR risk class: `{risk}`", "", "| file | rule | verdict | detail |", "|---|---|---|---|"]
    for x in reasons:
        lines.append(f"| `{cell(x['path'])}` | {x['rule']} | {x['verdict']} | {cell(x['detail'])} |")
    return "\n".join(lines) + "\n"


def main():
    try:
        files = parse_files(sys.stdin.read())
        risk, reasons = classify(files, os.environ.get("PR_AUTHOR", ""), os.environ.get("PR_TITLE", ""))
    except Exception as e:  # information only; the safe answer is human
        risk, reasons = "human", [{"path": "-", "rule": "error", "detail": f"classifier error: {e}", "verdict": "human"}]
    print(json.dumps({"risk": risk, "reasons": reasons}, ensure_ascii=False, separators=(",", ":")))
    table = render_table(risk, reasons)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(table)
    else:
        sys.stderr.write(table)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"risk={risk}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
