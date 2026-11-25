"""Issue #123: static checks on the contract doc and the infra templates (no AWS, no git history).

Everything here reads the files in the working tree, so it gives the same answer on a PR branch, after a squash merge
and on main. Checks that need the PR diff (first contract commit, literals in added lines, no new migration, CentralRole
and bootstrap additions) live in services/alarm-engine/scripts/review_pr_diff.py, run during PR review / by CI with
fetch-depth 0. They are not permanent tests because the diff is empty once the PR is merged.
Nothing is skipped: a missing tool fails the test.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from alarm_engine import handler

ROOT = Path(__file__).resolve().parents[3]
CENTRAL = ROOT / "infra" / "aws" / "central.yaml"
BOOTSTRAP = ROOT / "infra" / "aws" / "central-bootstrap.yaml"
CONTRACT = ROOT / "docs" / "API-CONTRACT.md"


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


def test_cfn_lint_passes_on_the_central_template():
    """cfn-lint is pinned in requirements-dev.txt; if it is missing this fails (never skips)."""
    exe = shutil.which("cfn-lint")
    assert exe is not None, "cfn-lint is not installed (requirements-dev.txt)"
    r = subprocess.run([exe, str(CENTRAL)], capture_output=True, text=True, timeout=300)
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


# ── [EngineBatchSize] 템플릿이 시뮬레이션의 전제(BatchSize 1)를 실제로 배포한다 ───────────────────────────────────────

def test_engine_batch_size_is_a_parameter_defaulting_to_one_and_the_event_source_uses_it():
    p = C["Parameters"]["EngineBatchSize"]
    assert p["Type"] == "Number" and p["Default"] == 1 and p["MinValue"] == 1 and p["MaxValue"] == 10
    sources = [ev["Properties"] for f in RES.values() if f["Type"] == "AWS::Serverless::Function"
               for ev in (f["Properties"].get("Events") or {}).values()
               if ev["Type"] == "SQS" and ev["Properties"]["Queue"] == {"Fn::GetAtt": "CommandsQueue.Arn"}]
    assert len(sources) == 1
    assert sources[0]["BatchSize"] == {"Ref": "EngineBatchSize"}
    assert sources[0]["FunctionResponseTypes"] == ["ReportBatchItemFailures"]


# ── [스케줄 규칙 → 명령] 규칙이 보내는 JSON이 handler.parse 를 통과한다 ───────────────────────────────────────────────

SAMPLE_TIME = "2026-11-25T09:00:00Z"


def render_input(target: dict, event: dict) -> str:
    """What EventBridge sends: each <name> in InputTemplate is replaced by the value at its JSONPath in the event."""
    tr = target["InputTransformer"]
    out = tr["InputTemplate"]
    assert isinstance(out, str), "InputTemplate must be a plain string"
    for name, path in tr["InputPathsMap"].items():
        assert path.startswith("$.") and path.count(".") == 1, path
        out = out.replace(f"<{name}>", str(event[path[2:]]))
    assert "<" not in out, f"unresolved placeholder: {out}"
    return out


@pytest.mark.parametrize("rule_name,mode", [("${ResourcePrefix}-sync-hourly", "TAG_RECONCILE"),
                                            ("${ResourcePrefix}-sync-daily", "DAILY")])
def test_each_schedule_rule_sends_its_own_mode_as_a_valid_sync_all_accounts_command(rule_name, mode):
    rule = next(r for r in sync_rules().values() if r["Properties"]["Name"]["Fn::Sub"] == rule_name)
    target = rule["Properties"]["Targets"][0]
    assert "$.time" in target["InputTransformer"]["InputPathsMap"].values()
    body = render_input(target, {"time": SAMPLE_TIME, "id": "evt-1"})
    cmd = json.loads(body)
    assert cmd["type"] == "SYNC_ALL_ACCOUNTS"
    assert cmd["customerId"] == "system"
    assert cmd["schemaVersion"] == 1
    assert cmd["payload"] == {"mode": mode}
    assert cmd["commandId"] == f"sched-{mode}-{SAMPLE_TIME}"
    assert len(body.encode()) < 1024
    parsed = handler.parse(body)
    assert parsed["type"] == "SYNC_ALL_ACCOUNTS" and parsed["customerId"] == "system"
    other = "DAILY" if mode == "TAG_RECONCILE" else "TAG_RECONCILE"
    assert other not in body


# ── [차단 4] 미룸 총량 부등식을 템플릿 Rules 가 배포 전에 강제한다 ─────────────────────────────────────────────────────

def _eval_rule(expr, params: dict):
    """Tiny evaluator for the Rules functions used by SyncBusyBudget (Fn::Or/And/Equals/Contains, Ref)."""
    if not isinstance(expr, dict):
        return expr
    ((fn, args),) = expr.items()
    if fn == "Ref":
        return params[args]
    vals = [_eval_rule(a, params) for a in args]
    if fn == "Fn::Or":
        return any(vals)
    if fn == "Fn::And":
        return all(vals)
    if fn == "Fn::Equals":
        return vals[0] == vals[1]
    if fn == "Fn::Contains":
        return vals[1] in vals[0]
    raise AssertionError(fn)


def test_rule_sync_busy_budget_admits_exactly_the_pairs_above_the_stale_window_plus_engine_timeout():
    t = load_cfn(CENTRAL)
    (assertion,) = t["Rules"]["SyncBusyBudget"]["Assertions"]
    deferrals = [str(v) for v in t["Parameters"]["SyncBusyMaxDeferrals"]["AllowedValues"]]
    delays = [str(v) for v in t["Parameters"]["SyncBusyDeferSeconds"]["AllowedValues"]]
    limit = 1200 + t["Parameters"]["EngineTimeoutSeconds"]["MaxValue"]          # 1320
    assert str(t["Parameters"]["SyncBusyMaxDeferrals"]["Default"]) in deferrals
    assert str(t["Parameters"]["SyncBusyDeferSeconds"]["Default"]) in delays
    assert max(int(d) for d in delays) <= 900
    for n in deferrals:
        for d in delays:
            ok = _eval_rule(assertion["Assert"], {"SyncBusyMaxDeferrals": n, "SyncBusyDeferSeconds": d})
            assert ok == (int(n) * int(d) > limit), (n, d)
    assert t["Parameters"]["SyncBusyMaxDeferrals"]["Default"] * t["Parameters"]["SyncBusyDeferSeconds"]["Default"] > limit


def test_engine_gets_its_timeout_from_the_same_parameter_as_the_function_timeout():
    t = load_cfn(CENTRAL)
    fn = t["Resources"]["AlarmEngineFunction"]["Properties"]
    assert fn["Timeout"] == {"Ref": "EngineTimeoutSeconds"}
    assert fn["Environment"]["Variables"]["ENGINE_TIMEOUT_SECONDS"] == {"Ref": "EngineTimeoutSeconds"}
