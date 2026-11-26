"""PR risk class: `low` (the hub may merge without a human approval once CI and review pass) or `human` (default).
Standard library only; run as `python3 -I pr_risk.py [options]` (D-62).

The official verdict is made by the hub with the classifier from `main` (.github/scripts/pr_risk_check.sh <pr-head-sha>);
the `risk` job of ci.yml runs the PR's own copy and is information only (a PR could change the classifier).

Input
  env PR_AUTHOR, PR_TITLE   PR author login and title (env, so a title is never on a command line)
  stdin                     `git diff --name-status --no-renames base...head` (`M<TAB>path`); bare paths count as M
  --numstat FILE            `git diff --numstat --no-renames base...head` (needed to call a modified test file low)
  --raw FILE                `git diff --raw --no-renames base...head` (modes; needed to call a docs file low)
  --emails FILE             `git log --format=%ae base..head`, one per line (every commit must be Dependabot's)
  --base SHA --head SHA     merge base and PR head; package.json files are read with `git show` to see which keys changed
Output: stdout is ONE JSON line {"risk", "head", "reasons": [{"path","rule","detail","verdict"}...]}; a markdown table goes to
$GITHUB_STEP_SUMMARY (else stderr); `risk=` and `sha=` go to $GITHUB_OUTPUT when set. Always exits 0.
Anything that cannot be established from the input (no numstat, no modes, no emails, ...) makes the answer human.

low  = every file is one of:
  - docs/** (docs/qa/** included) that is added or modified, not a script (.sh .py .mjs .js ...), not executable, not a
    symlink (mode 120000), and not on the list of documents that tests or scripts read (DOCS_READ_BY_TESTS)
  - a test file, by FILE NAME only (*.test.ts(x), *.test.mjs, *.spec.ts, test_*.py, *_test.py): added, or modified with
    no deleted line (numstat deletions == 0). apps/console/e2e: only *.spec.ts. Not conftest.py, fixtures, config, shell files.
  - package.json / package-lock.json of a Dependabot patch/minor PR (not 0.x; every commit by dependabot; package.json only
    changes versions of dependencies it already has)
human = everything else, in particular .github/**, .claude/**, CLAUDE.md, infra/aws/**, infra/customer-stack/**,
  infra/scripts/rehearsal/** (real-account scripts), db/**, DECISIONS.md, deleted files of docs or tests. No files: human.
"""
import json
import os
import re
import subprocess
import sys

DEPENDABOT = "dependabot[bot]"
DEPENDABOT_EMAIL = re.compile(r"^(?:\d+\+)?dependabot\[bot\]@users\.noreply\.github\.com$")

ALWAYS_HUMAN = [
    (".github/**", "workflow / CI / script change"),
    (".claude/**", "agent configuration change"),
    ("CLAUDE.md", "project instructions change"),
    ("infra/aws/**", "central AWS stack change"),
    ("infra/customer-stack/**", "customer-facing IAM stack change"),
    ("infra/scripts/rehearsal/**", "rehearsal scripts run against a real account"),
    ("db/**", "database change"),
    ("docs/decisions/DECISIONS.md", "decision change (decisions are for a person)"),
]
# Documents that tests or scripts read (grep of the tests: alarm-rules golden test, GO-LIVE / SETUP-PROD-DB checks in
# infra/test, API-CONTRACT in the engine tests, SETUP-SUPABASE in mask-db-urls). Editing them can change a test's result.
DOCS_READ_BY_TESTS = [
    "docs/specs/**",
    "docs/GO-LIVE.md",
    "docs/SETUP-PROD-DB.md",
    "docs/SETUP-SUPABASE.md",
    "docs/API-CONTRACT.md",
]
DEP_FILES = ("package.json", "package-lock.json")
DEP_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
SCRIPT_EXT = (".sh", ".bash", ".py", ".mjs", ".cjs", ".js", ".ts", ".ps1", ".cmd", ".bat", ".command")
TITLE_RE = re.compile(r"\bfrom\s+v?(\d+)(?:\.(\d+))?\S*\s+to\s+v?(\d+)(?:\.(\d+))?", re.I)
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


def dependabot_bump(author, title):
    """'minor' (patch/minor, not 0.x), 'major', '0x' (0.x or 0.0.x, treated as breaking) or None (not readable)."""
    if author != DEPENDABOT:
        return None
    m = TITLE_RE.search(title or "")
    if not m:
        return None
    a1, a2, b1, b2 = m.groups()
    if a1 != b1:
        return "major"
    if a1 == "0":
        return "0x"
    return "minor"


def package_json_only_versions(old_text, new_text):
    """True when the only change is the version string of dependencies that already existed."""
    try:
        old, new = json.loads(old_text), json.loads(new_text)
    except Exception:
        return False
    if not isinstance(old, dict) or not isinstance(new, dict) or set(old) != set(new):
        return False
    for key in old:
        if key in DEP_SECTIONS and isinstance(old[key], dict) and isinstance(new[key], dict):
            if set(old[key]) != set(new[key]):
                return False
        elif old[key] != new[key]:
            return False
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


def parse_numstat(text):
    """path -> (added, deleted); binary files (`-`) become None."""
    out = {}
    for line in (text or "").splitlines():
        parts = line.rstrip("\r").split("\t", 2)
        if len(parts) != 3:
            continue
        a, d, path = parts
        out[path] = (int(a), int(d)) if a.isdigit() and d.isdigit() else None
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


def classify(files, author, title, numstat=None, raw=None, emails=None, pkg_ok=None):
    """files: [(status, path)]; numstat/raw: dicts or None (unknown); emails: list or None; pkg_ok: f(path)->bool or None.
    Returns (risk, reasons)."""
    if not files:
        return "human", [{"path": "-", "rule": "empty", "detail": "no changed files (fail-safe)", "verdict": "human"}]
    bump = dependabot_bump(author, title)
    reasons = []
    for status, path in files:
        H = lambda rule, detail: (rule, detail, "human")
        L = lambda rule, detail: (rule, detail, "low")
        r = None
        for pat, why in ALWAYS_HUMAN:
            if _match(path, pat):
                r = H("always-human", f"{pat}: {why}")
                break
        if r is None and any(_match(path, p) for p in DOCS_READ_BY_TESTS):
            r = H("docs-read-by-tests", "document that tests or scripts read")
        if r is None and path.split("/")[-1] in DEP_FILES:
            if author == DEPENDABOT and bump == "major":
                r = H("dependabot-major", "Dependabot major update")
            elif author == DEPENDABOT and bump == "0x":
                r = H("dependabot-0x", "Dependabot update of a 0.x package (minor is breaking)")
            elif bump != "minor":
                r = H("always-human", "package.json / package-lock.json change (not a Dependabot patch/minor update)")
            elif not emails or not all(DEPENDABOT_EMAIL.match(e.strip()) for e in emails):
                r = H("dependabot-commits", "a commit of the PR is not by dependabot (or authors unknown)")
            elif status != "M":
                r = H("dependabot-status", f"status {status}, only a modification is allowed")
            elif path.endswith("package.json") and not (pkg_ok and pkg_ok(path)):
                r = H("dependabot-pkg-keys", "package.json changes more than versions of existing dependencies (or cannot be checked)")
            else:
                r = L("dependabot-minor", "Dependabot patch/minor update")
        if r is None and _match(path, "docs/**"):
            modes = (raw or {}).get(path)
            base = path.split("/")[-1]
            if status == "D":
                r = H("docs-deleted", "a deleted document")
            elif status not in ("A", "M"):
                r = H("docs-status", f"status {status}")
            elif path.lower().endswith(SCRIPT_EXT):
                r = H("docs-script", "an executable-type file under docs/")
            elif modes is None:
                r = H("docs-mode-unknown", "file mode unknown (no --raw input)")
            elif "120000" in modes:
                r = H("docs-symlink", "symbolic link (mode 120000)")
            elif modes[1] != "100644":
                r = H("docs-mode", f"mode {modes[1]} (not a regular non-executable file)")
            else:
                r = L("docs-qa" if _match(path, "docs/qa/**") else "docs", "docs/qa/**" if _match(path, "docs/qa/**") else "docs/**")
        if r is None and is_test_file(path):
            if status == "A":
                r = L("test-added", "added test file")
            elif status == "M":
                ns = (numstat or {}).get(path)
                if ns is None:
                    r = H("test-modified", "modified test file: deleted-line count unknown")
                elif ns[1] == 0:
                    r = L("test-lines-added", "existing test file, lines added only")
                else:
                    r = H("test-modified", f"existing test file with {ns[1]} deleted/changed line(s)")
            else:
                r = H("test-deleted", f"test file with status {status}")
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


def _git_show(rev, path):
    try:
        return subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True, check=True).stdout
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
        numstat = parse_numstat(_read(opts["numstat"])) if "numstat" in opts and _read(opts["numstat"]) is not None else None
        raw = parse_raw(_read(opts["raw"])) if "raw" in opts and _read(opts["raw"]) is not None else None
        et = _read(opts["emails"]) if "emails" in opts else None
        emails = [e for e in et.splitlines() if e.strip()] if et is not None else None
        pkg_ok = None
        if opts.get("base") and head:
            def pkg_ok(path, b=opts["base"], h=head):
                if not path.endswith("package.json"):
                    return True
                o, n = _git_show(b, path), _git_show(h, path)
                return o is not None and n is not None and package_json_only_versions(o, n)
        risk, reasons = classify(files, os.environ.get("PR_AUTHOR", ""), os.environ.get("PR_TITLE", ""),
                                 numstat, raw, emails, pkg_ok)
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
