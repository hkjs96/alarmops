"""Issue #123: checks on the contract doc, the diff, and the infra templates (static; no AWS).

Diff-based checks compare against origin/main and are skipped when that ref is not available (shallow checkouts).
They live under services/ because this role may not edit infra/; move the infra part to infra/test when convenient.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
CENTRAL = ROOT / "infra" / "aws" / "central.yaml"
BOOTSTRAP = ROOT / "infra" / "aws" / "central-bootstrap.yaml"
CONTRACT = ROOT / "docs" / "API-CONTRACT.md"


def git(*args: str) -> str | None:
    try:
        r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


BASE = "origin/main"
HAVE_BASE = git("rev-parse", "--verify", BASE) is not None
needs_base = pytest.mark.skipif(not HAVE_BASE, reason="origin/main not available (shallow checkout)")


def changed_files() -> set[str]:
    return set((git("diff", "--name-only", f"{BASE}...HEAD") or "").split())


def added_lines(paths: list[str]) -> list[tuple[str, str]]:
    out = git("diff", "-U0", f"{BASE}...HEAD", "--", *paths) or ""
    cur, rows = "", []
    for ln in out.splitlines():
        if ln.startswith("+++ b/"):
            cur = ln[6:]
        elif ln.startswith("+") and not ln.startswith("+++"):
            rows.append((cur, ln[1:]))
    return rows


def load_cfn(path: Path) -> dict:
    class L(yaml.SafeLoader):
        pass

    def tag(loader, suffix, node):
        if isinstance(node, yaml.ScalarNode):
            val = loader.construct_scalar(node)
        elif isinstance(node, yaml.SequenceNode):
            val = loader.construct_sequence(node, deep=True)
        else:
            val = loader.construct_mapping(node, deep=True)
        return {("Ref" if suffix == "Ref" else f"Fn::{suffix}"): val}

    L.add_multi_constructor("!", tag)
    return yaml.load(path.read_text(encoding="utf-8"), Loader=L)


def as_list(v):
    return v if isinstance(v, list) else [v]


def arn(logical: str) -> dict:
    return {"Fn::GetAtt": f"{logical}.Arn"}


def key(v) -> str:
    return repr(v)


# ── [계약] API-CONTRACT §6 ────────────────────────────────────────────────────────────────────────────────────────

def section6() -> str:
    text = CONTRACT.read_text(encoding="utf-8")
    start = text.index("## 6. ")
    return text[start:text.index("\n## 7. ", start)]


def test_contract_section6_documents_the_new_command_and_the_delay_formula():
    s = section6()
    for token in ("SYNC_ALL_ACCOUNTS", "deferrals", "SKIPPED_BUSY", "DEFERRED"):
        assert token in s, token
    assert re.search(r'customerId["`\s:=]*"?system', s) or '"system"' in s
    assert "60분" in s
    assert "15분" in s or "900초" in s
    assert re.search(r"5\s*[×x*]\s*300|1500초|25분", s)


@needs_base
def test_first_contract_commit_touches_only_section6_and_comes_before_the_code():
    commits = (git("rev-list", "--reverse", f"{BASE}..HEAD") or "").split()
    doc_commit = next((c for c in commits if "docs/API-CONTRACT.md" in (git("show", "--name-only", "--format=", c) or "")),
                      None)
    if doc_commit is None:
        pytest.fail("no commit on this branch changes docs/API-CONTRACT.md")
    files = (git("show", "--name-only", "--format=", doc_commit) or "").split()
    assert files == ["docs/API-CONTRACT.md"]
    s6_start = next(i for i, ln in enumerate((git("show", f"{doc_commit}^:docs/API-CONTRACT.md") or "").splitlines(), 1)
                    if ln.startswith("## 6. "))
    old = (git("show", f"{doc_commit}^:docs/API-CONTRACT.md") or "").splitlines()
    s6_end = next(i for i, ln in enumerate(old, 1) if i > s6_start and ln.startswith("## 7. "))
    diff = git("diff", "-U0", f"{doc_commit}^", doc_commit, "--", "docs/API-CONTRACT.md") or ""
    for m in re.finditer(r"^@@ -(\d+)(?:,(\d+))? ", diff, re.M):
        a, n = int(m.group(1)), int(m.group(2) or 1)
        assert s6_start <= a and a + max(n, 1) - 1 <= s6_end, f"hunk at old line {a} is outside section 6"
    first_code = next((c for c in commits
                       if any(f.startswith(("services/alarm-engine/src", "infra/")) for f in
                              (git("show", "--name-only", "--format=", c) or "").split())), None)
    assert first_code is None or commits.index(doc_commit) < commits.index(first_code)


# ── [하드코딩 금지] / [마이그레이션 없음] ──────────────────────────────────────────────────────────────────────────

@needs_base
def test_no_account_ids_queue_urls_arn_or_region_literals_in_added_source_lines():
    rows = added_lines(["services/alarm-engine/src", "infra/aws/central.yaml", "infra/aws/central-bootstrap.yaml"])
    bad = []
    for path, ln in rows:
        code = ln.strip()
        if code.startswith("#"):
            continue
        if (re.search(r"(?<!\d)\d{12}(?!\d)", code) or re.search(r"https://sqs\.|sqs\.[a-z0-9-]+\.amazonaws", code)
                or re.search(r"arn:aws[a-z-]*:", code) or re.search(r"\b[a-z]{2}-[a-z]+-\d\b", code)):
            bad.append(f"{path}: {code}")
    assert bad == []


@needs_base
def test_no_new_migration_and_no_check_script_change():
    files = changed_files()
    assert not [f for f in files if f.startswith("db/prisma/migrations/")]
    assert "db/scripts/check.mjs" not in files


# ── [infra 규칙] ──────────────────────────────────────────────────────────────────────────────────────────────────

C = load_cfn(CENTRAL)
RES = C["Resources"]


def sync_rules() -> dict[str, dict]:
    out = {}
    for lid, r in RES.items():
        if r["Type"] != "AWS::Events::Rule":
            continue
        name = r["Properties"].get("Name")
        if isinstance(name, dict) and str(name.get("Fn::Sub", "")).startswith("${ResourcePrefix}-sync-"):
            out[lid] = r
    return out


def test_two_schedule_rules_on_the_default_bus_with_their_own_dlq():
    rules = sync_rules()
    assert len(rules) == 2
    names = sorted(r["Properties"]["Name"]["Fn::Sub"] for r in rules.values())
    assert names == ["${ResourcePrefix}-sync-daily", "${ResourcePrefix}-sync-hourly"]
    for lid, r in rules.items():
        p = r["Properties"]
        assert "EventBusName" not in p, lid                                 # schedule rules only exist on the default bus
        assert p["State"] == {"Ref": "SyncSchedulesState"}
        assert "ScheduleExpression" in p and "EventPattern" not in p
        targets = p["Targets"]
        assert len(targets) == 1
        assert targets[0]["Arn"] == arn("CommandsQueue")
        assert targets[0]["DeadLetterConfig"]["Arn"] == arn("SyncScheduleRuleDlq")
        assert "InputTransformer" in targets[0]
    sched = {r["Properties"]["Name"]["Fn::Sub"]: r["Properties"]["ScheduleExpression"] for r in rules.values()}
    assert sched["${ResourcePrefix}-sync-hourly"] == "rate(1 hour)"
    assert sched["${ResourcePrefix}-sync-daily"] == {"Ref": "SyncDailySchedule"}
    assert C["Parameters"]["SyncSchedulesState"]["AllowedValues"] == ["ENABLED", "DISABLED"]
    assert C["Parameters"]["SyncDailySchedule"]["Default"] == "cron(0 18 * * ? *)"      # 03:00 KST


@pytest.mark.skipif(shutil.which("cfn-lint") is None, reason="cfn-lint not installed")
def test_cfn_lint_passes_on_the_central_template():
    r = subprocess.run(["cfn-lint", str(CENTRAL)], capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stdout + r.stderr


# ── [infra 큐 정책] ───────────────────────────────────────────────────────────────────────────────────────────────

def statements(policy_id: str) -> list[dict]:
    return RES[policy_id]["Properties"]["PolicyDocument"]["Statement"]


def rule_arns() -> set[str]:
    return {key(arn(lid)) for lid in sync_rules()} | {key(arn("TagEventRule"))}


def test_commands_queue_policy_admits_only_the_three_rules_and_two_roles():
    stmts = statements("CommandsQueuePolicy")
    allowed_rules: set[str] = set()
    for s in stmts:
        if s["Effect"] == "Allow":
            assert s["Principal"] != "*" and s["Principal"] != {"AWS": "*"}
            if s["Principal"] == {"Service": "events.amazonaws.com"}:
                allowed_rules |= {key(v) for v in as_list(s["Condition"]["ArnEquals"]["aws:SourceArn"])}
    assert allowed_rules == rule_arns()
    deny = next(s for s in stmts if s["Sid"] == "DenySendFromOthers")
    cond = deny["Condition"]["ArnNotEquals"]
    assert {key(v) for v in as_list(cond["aws:SourceArn"])} == rule_arns()
    assert {key(v) for v in as_list(cond["aws:PrincipalArn"])} == {key(arn("VercelConsoleRole")),
                                                                    key(arn("CentralRole"))}


def test_schedule_dlq_policy_is_scoped_to_the_two_rules_and_tls_only():
    stmts = statements("SyncScheduleRuleDlqPolicy")
    assert RES["SyncScheduleRuleDlqPolicy"]["Properties"]["Queues"] == [{"Ref": "SyncScheduleRuleDlq"}]
    allows = [s for s in stmts if s["Effect"] == "Allow"]
    assert len(allows) == 1
    a = allows[0]
    assert a["Principal"] == {"Service": "events.amazonaws.com"} and a["Action"] == "sqs:SendMessage"
    assert a["Resource"] == arn("SyncScheduleRuleDlq")
    assert {key(v) for v in as_list(a["Condition"]["ArnEquals"]["aws:SourceArn"])} == {key(arn(lid)) for lid in sync_rules()}
    assert any(s["Effect"] == "Deny" and s["Condition"] == {"Bool": {"aws:SecureTransport": "false"}} for s in stmts)


def test_tag_events_dlq_policy_is_unchanged():
    p = RES["TagEventsRuleDlqPolicy"]["Properties"]
    assert p["Queues"] == [{"Ref": "TagEventsRuleDlq"}]
    allow = next(s for s in p["PolicyDocument"]["Statement"] if s["Effect"] == "Allow")
    assert allow["Condition"] == {"ArnEquals": {"aws:SourceArn": arn("TagEventRule")}}
    if HAVE_BASE:
        old = git("show", f"{BASE}:infra/aws/central.yaml")
        assert old is not None
        start = old.index("  TagEventsRuleDlqPolicy:")
        end = old.index("\n  AlertEventsQueuePolicy:", start)
        now_text = CENTRAL.read_text(encoding="utf-8")
        s2 = now_text.index("  TagEventsRuleDlqPolicy:")
        e2 = now_text.index("\n  AlertEventsQueuePolicy:", s2)
        assert now_text[s2:e2] == old[start:end]


# ── [infra 경보] ──────────────────────────────────────────────────────────────────────────────────────────────────

def test_schedule_dlq_alarm_mirrors_the_tag_events_alarm():
    a = RES["SyncScheduleRuleDlqNotEmptyAlarm"]
    assert a["Type"] == "AWS::CloudWatch::Alarm"
    p = a["Properties"]
    assert p["MetricName"] == "ApproximateNumberOfMessagesVisible" and p["Namespace"] == "AWS/SQS"
    assert p["Dimensions"] == [{"Name": "QueueName", "Value": {"Fn::GetAtt": "SyncScheduleRuleDlq.QueueName"}}]
    assert p["Threshold"] == 0 and p["ComparisonOperator"] == "GreaterThanThreshold" and p["Period"] == 300
    assert p["AlarmActions"] == RES["TagEventsRuleDlqNotEmptyAlarm"]["Properties"]["AlarmActions"]
    assert p["AlarmActions"]["Fn::If"][0] == "HasAlarmTopic"


def test_queue_policy_comment_explains_three_rules_and_the_central_role_sender():
    lines = CENTRAL.read_text(encoding="utf-8").splitlines()
    i = lines.index("  CommandsQueuePolicy:")
    block = []
    for ln in reversed(lines[:i]):
        if not ln.strip().startswith("#"):
            break
        block.insert(0, ln)
    text = " ".join(block)
    assert "CentralRole" in text
    assert re.search(r"\b3\b|three|세 |셋", text)
    assert "ONE rule" not in text and "that one" not in text


# ── [권한 범위] ───────────────────────────────────────────────────────────────────────────────────────────────────

def engine_statements(template: dict) -> list[dict]:
    pol = template["Resources"]["CentralRole"]["Properties"]["Policies"]
    doc = next(p for p in pol if p["PolicyName"] == "engine")["PolicyDocument"]
    return [s for s in doc["Statement"] if isinstance(s, dict) and "Sid" in s]


def test_central_role_gains_exactly_one_permission_sqs_send_on_the_commands_queue():
    stmts = engine_statements(C)
    sends = [s for s in stmts if "sqs:SendMessage" in as_list(s.get("Action", []))]
    assert len(sends) == 1
    s = sends[0]
    assert s["Effect"] == "Allow" and as_list(s["Action"]) == ["sqs:SendMessage"] and s["Resource"] == arn("CommandsQueue")
    if HAVE_BASE:
        old_text = git("show", f"{BASE}:infra/aws/central.yaml")
        assert old_text is not None
        tmp = Path(__file__).parent / ".base_central.yaml"
        try:
            tmp.write_text(old_text, encoding="utf-8")
            old = engine_statements(load_cfn(tmp))
        finally:
            tmp.unlink(missing_ok=True)
        added = [x for x in stmts if x not in old]
        assert added == [s]
        assert all(x in stmts for x in old)


def test_bootstrap_adds_only_the_default_bus_sync_rule_resource():
    B = load_cfn(BOOTSTRAP)
    text = BOOTSTRAP.read_text(encoding="utf-8")
    assert "scheduler:" not in text
    resources: list[str] = []

    def walk(n):
        if isinstance(n, dict):
            if "events:PutRule" in as_list(n.get("Action", [])):
                for r in as_list(n["Resource"]):
                    resources.append(r["Fn::Sub"] if isinstance(r, dict) else r)
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)

    walk(B)
    pre = "arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:rule/"
    assert sorted(resources) == sorted([pre + "${BusName}/${ResourcePrefix}-*", pre + "${ResourcePrefix}-sync-*"])
    if HAVE_BASE:
        old = git("show", f"{BASE}:infra/aws/central-bootstrap.yaml") or ""
        assert text.count("iam:PassRole") == old.count("iam:PassRole")
