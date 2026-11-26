"""PR risk class: `low` (the hub may merge without a human approval once CI and review pass) or `human` (default).
Standard library only; run as `python3 -I pr_risk.py [options]` (D-62).

The official verdict is made by the hub with the classifier from `main` (.github/scripts/pr_risk_check.sh <pr-head-sha>);
the `risk` job of ci.yml runs the PR's own copy and is information only (a PR could change the classifier).

Input
  stdin        `git diff --name-status --no-renames base...head` (`A<TAB>path`); bare paths count as M
  --raw FILE   `git diff --raw --no-renames base...head` (file modes; without it nothing can be low)
  --head SHA   the PR head, echoed in the output
Output: stdout is ONE JSON line {"risk", "head", "reasons": [{"path","rule","detail","verdict"}...]}; a markdown table goes to
$GITHUB_STEP_SUMMARY (else stderr); `risk=` and `sha=` go to $GITHUB_OUTPUT when set. Always exits 0.
Anything that cannot be established from the input makes the answer human.

low  = every file is one of:
  - a document under docs/, added or modified, regular file (mode 100644), not a script (.sh .py .mjs .js ...), and not one
    of the documents that tests read, that are gate evidence (docs/qa/**) or that agents read as instructions
    (docs/ui/**, specs, DATA-MODEL, API-CONTRACT, PERSONAS, DECISIONS, ...). See DOCS_HUMAN.
  - a NEW test file (status A, mode 100644), recognised by file name only: *.test.ts(x), *.test.mjs, *.spec.ts, test_*.py,
    *_test.py; apps/console/e2e only *.spec.ts. Any change to an existing test file is human (a test can be weakened
    by editing it), and so is a deleted one.
human = everything else, in particular .github/**, .claude/**, CLAUDE.md, infra/aws/**, infra/customer-stack/**,
  infra/scripts/rehearsal/**, db/**, every dependency file (package.json, lock files, requirements*, pyproject.toml, ...,
  also for Dependabot: there is no Dependabot exception). No files: human.
"""
import json
import os
import re
import sys

ALWAYS_HUMAN = [
    (".github/**", "workflow / CI / script change"),
    (".claude/**", "agent configuration change"),
    ("CLAUDE.md", "project instructions change"),
    ("infra/aws/**", "central AWS stack change"),
    ("infra/customer-stack/**", "customer-facing IAM stack change"),
    ("infra/scripts/rehearsal/**", "rehearsal scripts run against a real account"),
    ("db/**", "database change"),
]
# Documents that are not low: DECISIONS (decisions are for a person); documents that tests or scripts read (alarm-rules golden
# test, GO-LIVE / SETUP-PROD-DB checks in infra/test, API-CONTRACT in the engine tests, SETUP-SUPABASE in mask-db-urls);
# gate evidence (docs/qa); documents that agents read as instructions (ui, DATA-MODEL, PERSONAS), a prompt-injection path.
DOCS_HUMAN = [
    "docs/decisions/DECISIONS.md",
    "docs/specs/**",
    "docs/GO-LIVE.md",
    "docs/SETUP-PROD-DB.md",
    "docs/SETUP-SUPABASE.md",
    "docs/API-CONTRACT.md",
    "docs/DATA-MODEL.md",
    "docs/PERSONAS.md",
    "docs/qa/**",
    "docs/ui/**",
]
# Dependency files, by base name, anywhere in the tree.
DEP_FILE_RE = re.compile(
    r"(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.nvmrc"
    r"|requirements[^/]*\.(?:txt|in)|constraints[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?"
    r"|setup\.py|setup\.cfg|uv\.lock|Gemfile(?:\.lock)?|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Dockerfile[^/]*)",
    re.I,
)
SCRIPT_EXT = (".sh", ".bash", ".py", ".mjs", ".cjs", ".js", ".ts", ".ps1", ".cmd", ".bat", ".command")
TEST_NAME_RE = re.compile(r"(?:.+\.(?:test\.tsx?|test\.mjs|spec\.ts)|test_[^/]+\.py|[^/]+_test\.py)")


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


def is_test_file(path):
    """By file name only; a `test/` directory does not make a file a test."""
    parts = path.split("/")
    base = parts[-1]
    if _match(path, "apps/console/e2e/**") and not _match(path, "apps/console/e2e/*.spec.ts"):
        return False
    if not TEST_NAME_RE.fullmatch(base):
        return False
    if base.endswith(".py") and "src" in parts[:-1]:
        return False  # a test_*.py inside a product package is product code until shown otherwise
    return True


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


def parse_raw(text):
    """path -> (old_mode, new_mode)."""
    out = {}
    for line in (text or "").splitlines():
        if not line.startswith(":") or "\t" not in line:
            continue
        meta, path = line.rstrip("\r").split("\t", 1)
        f = meta[1:].split()
        if len(f) >= 2:
            out[path] = (f[0], f[1])
    return out


def classify(files, raw=None):
    """files: [(status, path)]; raw: {path: (old_mode, new_mode)} or None (unknown). Returns (risk, reasons)."""
    if not files:
        return "human", [{"path": "-", "rule": "empty", "detail": "no changed files (fail-safe)", "verdict": "human"}]
    reasons = []
    for status, path in files:
        H = lambda rule, detail: (rule, detail, "human")
        L = lambda rule, detail: (rule, detail, "low")
        r = None
        for pat, why in ALWAYS_HUMAN:
            if _match(path, pat):
                r = H("always-human", f"{pat}: {why}")
                break
        if r is None and DEP_FILE_RE.fullmatch(path.split("/")[-1]):
            r = H("dependency-file", "dependency / build file (always a person, also for Dependabot)")
        if r is None:
            for pat in DOCS_HUMAN:
                if _match(path, pat):
                    r = H("docs-human", f"{pat}: decision, test input, gate evidence or agent-read document")
                    break
        modes = (raw or {}).get(path)
        regular = modes is not None and modes[1] == "100644" and modes[0] in ("000000", "100644")
        if r is None and _match(path, "docs/**"):
            if status == "D":
                r = H("docs-deleted", "a deleted document")
            elif status not in ("A", "M"):
                r = H("docs-status", f"status {status}")
            elif path.lower().endswith(SCRIPT_EXT):
                r = H("docs-script", "an executable-type file under docs/")
            elif modes is None:
                r = H("docs-mode-unknown", "file mode unknown (no --raw input)")
            elif not regular:
                r = H("docs-mode", f"mode {modes[0]} -> {modes[1]} (symlink, executable or type change)")
            else:
                r = L("docs", "docs/**")
        if r is None and is_test_file(path):
            if status != "A":
                r = H("test-existing", f"existing test file with status {status} (only a new test file is low)")
            elif modes is None:
                r = H("test-mode-unknown", "file mode unknown (no --raw input)")
            elif not regular:
                r = H("test-mode", f"mode {modes[0]} -> {modes[1]} (symlink or executable bit)")
            else:
                r = L("test-added", "new test file")
        if r is None:
            r = H("not-listed", "outside the low list (default human)")
        reasons.append({"path": path, "rule": r[0], "detail": r[1], "verdict": r[2]})
    risk = "low" if all(x["verdict"] == "low" for x in reasons) else "human"
    return risk, reasons


def cell(s):
    s = str(s).replace("\r", " ").replace("\n", " ").replace("`", "'").replace("|", "\\|")
    return s.replace("<", "&lt;").replace(">", "&gt;")


def render_table(risk, reasons, head=""):
    lines = [
        f"### PR risk class: `{risk}`",
        "",
        f"Head commit: `{cell(head) or 'unknown'}`. The official verdict is made by the hub with the classifier from `main` "
        "(`.github/scripts/pr_risk_check.sh <head-sha>`); this one is information only.",
        "",
        "| file | rule | verdict | detail |",
        "|---|---|---|---|",
    ]
    for x in reasons:
        lines.append(f"| {cell(x['path'])} | {cell(x['rule'])} | {cell(x['verdict'])} | {cell(x['detail'])} |")
    return "\n".join(lines) + "\n"


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None


def _args(argv):
    opts = {}
    i = 0
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return opts


def main(argv=None):
    opts = _args(sys.argv[1:] if argv is None else argv)
    head = opts.get("head", "")
    try:
        files = parse_files(sys.stdin.read())
        raw_text = _read(opts["raw"]) if "raw" in opts else None
        risk, reasons = classify(files, parse_raw(raw_text) if raw_text is not None else None)
    except Exception as e:  # information only; the safe answer is human
        risk, reasons = "human", [{"path": "-", "rule": "error", "detail": f"classifier error: {e}", "verdict": "human"}]
    print(json.dumps({"risk": risk, "head": head, "reasons": reasons}, ensure_ascii=False, separators=(",", ":")))
    table = render_table(risk, reasons, head)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(table)
    else:
        sys.stderr.write(table)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"risk={risk}\nsha={head}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
