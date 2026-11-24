"""infra/aws/central-alerts.yaml (CloudTrail alert rules, issue #115) against deploy-role-policy.md 4-2, GO-LIVE.md and the
isolation rule: the deploy roles of central-bootstrap.yaml must not be able to change the alert rules, the topic or the stack.

Expected values come from the acceptance criteria and the document, never from the template's own output. Offline; needs PyYAML.
Run from the repo root:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import yaml

INFRA = Path(__file__).resolve().parents[1]
REPO = INFRA.parent
ALERTS = INFRA / "aws" / "central-alerts.yaml"
BOOTSTRAP = INFRA / "aws" / "central-bootstrap.yaml"
DOC = INFRA / "aws" / "deploy-role-policy.md"
GOLIVE = REPO / "docs" / "GO-LIVE.md"
CI = REPO / ".github" / "workflows" / "ci.yml"
THIS_FILE = Path(__file__).resolve()

STACK_NAME = "alarmops-central-alerts"
GUARD_PREFIX = "AlarmOpsGuard"
TOPIC_NAME = f"{GUARD_PREFIX}-alerts"
ACCOUNT, PARTITION = "123456789012", "aws"
GOLIVE_CHECKBOX_COUNT = 40  # checklist items of docs/GO-LIVE.md before #115: the existing item is edited, none is added
GOLIVE_D57_LINE_NO = 594
GOLIVE_D57_LINE = (
    "   - **신뢰 정책 변경의 우회 위험은 수용했다(D-57).** 보완책(CloudTrail 알림, plan 승인 전 본문 확인, `TrustChange` 정책 1시간 "
    "자동 만료)은 `deploy-role-policy.md` 3-2·4·4-1·4-2절에 있다. **CloudTrail 알림 규칙은 실고객 연결 전 필수다**(구현은 파일럿 전 이슈)."
)


# ---------------------------------------------------------------- template loading and rendering

def _load(path: Path) -> dict:
    class L(yaml.SafeLoader):
        pass

    def tag(loader, suffix, node):
        if isinstance(node, yaml.ScalarNode):
            val = loader.construct_scalar(node)
        elif isinstance(node, yaml.SequenceNode):
            val = loader.construct_sequence(node, deep=True)
        else:
            val = loader.construct_mapping(node, deep=True)
        return {("Ref" if suffix == "Ref" else "Condition" if suffix == "Condition" else f"Fn::{suffix}"): val}

    L.add_multi_constructor("!", tag)
    return yaml.load(path.read_text(encoding="utf-8"), Loader=L)


def _intrinsic(n):
    return isinstance(n, dict) and len(n) == 1 and (next(iter(n)) in ("Ref", "Condition") or next(iter(n)).startswith("Fn::"))


class Render:
    """Resolves Ref, Fn::Sub, Fn::If, Fn::Equals/Not/And/Or, Condition with parameter defaults (or overrides) for one region.
    References to resources and GetAtt become '<name>' placeholders."""

    def __init__(self, tpl: dict, region: str, params: dict | None = None):
        self.t = tpl
        self.p = {k: str(v.get("Default", "")) for k, v in tpl.get("Parameters", {}).items()}
        self.p.update(params or {})
        self.pseudo = {"AWS::Partition": PARTITION, "AWS::AccountId": ACCOUNT, "AWS::Region": region, "AWS::StackName": STACK_NAME}
        self._cond: dict = {}

    def cond(self, name: str) -> bool:
        if name not in self._cond:
            self._cond[name] = bool(self.x(self.t["Conditions"][name]))
        return self._cond[name]

    def ref(self, name: str) -> str:
        if name in self.pseudo:
            return self.pseudo[name]
        if name in self.p:
            return self.p[name]
        return f"<{name}>"

    def x(self, n):
        if _intrinsic(n):
            (k, v), = n.items()
            if k == "Ref":
                return self.ref(v)
            if k == "Condition":
                return self.cond(v)
            if k == "Fn::Equals":
                return self.x(v[0]) == self.x(v[1])
            if k == "Fn::Not":
                return not self.x(v[0])
            if k == "Fn::And":
                return all(self.x(i) for i in v)
            if k == "Fn::Or":
                return any(self.x(i) for i in v)
            if k == "Fn::If":
                return self.x(v[1] if self.cond(v[0]) else v[2])
            if k == "Fn::GetAtt":
                return "<" + (v if isinstance(v, str) else ".".join(v)) + ">"
            if k == "Fn::Join":
                return v[0].join(str(self.x(i)) for i in self.x(v[1]))
            if k == "Fn::Sub":
                tmpl, local = (v, {}) if isinstance(v, str) else (v[0], {a: self.x(b) for a, b in v[1].items()})
                return re.sub(r"\$\{([^}]+)\}", lambda m: str(local[m.group(1)]) if m.group(1) in local else self.ref(m.group(1)), tmpl)
            raise ValueError(f"unsupported intrinsic {k}")
        if isinstance(n, dict):
            return {k: self.x(v) for k, v in n.items()}
        if isinstance(n, list):
            return [self.x(v) for v in n]
        return n

    def resources(self, rtype: str | None = None) -> dict:
        """Logical id -> resource whose Condition holds in this region (optionally one type)."""
        return {
            i: r for i, r in self.t["Resources"].items()
            if (rtype is None or r["Type"] == rtype) and ("Condition" not in r or self.cond(r["Condition"]))
        }


def doc_blocks() -> dict[str, list]:
    """json blocks of deploy-role-policy.md keyed by the heading they sit under."""
    out: dict[str, list] = {}
    head, cur = "", None
    for line in DOC.read_text(encoding="utf-8").splitlines():
        if cur is None:
            if line.startswith("#"):
                head = line
            elif line.strip() == "```json":
                cur = []
        elif line.strip() == "```":
            out.setdefault(head, []).append(json.loads("\n".join(cur)))
            cur = None
        else:
            cur.append(line)
    return out


def doc_section(prefix: str) -> str:
    lines = DOC.read_text(encoding="utf-8").splitlines()
    start = next(i for i, l in enumerate(lines) if l.startswith(prefix))
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    return "\n".join(lines[start:end])


def doc_pattern_4_2(index: int) -> dict:
    blocks = [v for k, v in doc_blocks().items() if k.startswith("## 4-2.")]
    assert blocks, "no json block under heading '## 4-2.'"
    return blocks[0][index]


# ---------------------------------------------------------------- isolation checker

# Changing actions per service that must not be allowed on the alert rules, the topic or the stack.
MUTATING = {
    "events": ["PutRule", "DeleteRule", "PutTargets", "RemoveTargets", "EnableRule", "DisableRule", "TagResource", "UntagResource"],
    "sns": ["DeleteTopic", "SetTopicAttributes", "AddPermission", "RemovePermission", "Subscribe", "Unsubscribe",
            "SetSubscriptionAttributes", "TagResource", "UntagResource"],
    "cloudformation": ["UpdateStack", "DeleteStack", "SetStackPolicy", "CreateChangeSet", "ExecuteChangeSet", "DeleteChangeSet",
                       "UpdateTerminationProtection", "ContinueUpdateRollback", "RollbackStack", "SignalResource"],
}


def protected_samples() -> dict[str, list[str]]:
    """Concrete resource ARNs per service that stand for rule/AlarmOpsGuard-*, topic AlarmOpsGuard-alerts, stack/<STACK_NAME>/*."""
    out: dict[str, list[str]] = {"events": [], "sns": [], "cloudformation": []}
    for region in ("ap-northeast-2", "us-east-1"):
        for rule in ("iam-change", "service-change"):
            out["events"].append(f"arn:{PARTITION}:events:{region}:{ACCOUNT}:rule/{GUARD_PREFIX}-{rule}")
        out["sns"].append(f"arn:{PARTITION}:sns:{region}:{ACCOUNT}:{TOPIC_NAME}")
        out["cloudformation"].append(f"arn:{PARTITION}:cloudformation:{region}:{ACCOUNT}:stack/{STACK_NAME}/11111111-2222-3333-4444-555555555555")
    return out


def _glob(pattern: str, text: str, ignore_case: bool) -> bool:
    rx = "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in pattern)
    return re.fullmatch(rx, text, re.IGNORECASE if ignore_case else 0) is not None


def _as_list(v) -> list:
    return [] if v is None else v if isinstance(v, list) else [v]


def _statements(doc: dict) -> list[dict]:
    return _as_list(doc.get("Statement"))


def isolation_check(policies: dict[str, dict]) -> dict:
    """policies: id -> rendered policy document. Returns the ids that were checked, the number of expanded Allow statements
    per policy and the matches (policy id, sid, action, resource). Action matches case-insensitively, Resource case-sensitively."""
    samples = protected_samples()
    allow_counts: dict[str, int] = {}
    hits: list[tuple] = []
    for pid, doc in policies.items():
        allow_counts[pid] = 0
        for st in _statements(doc):
            if st.get("Effect") != "Allow":
                continue
            allow_counts[pid] += 1
            actions, not_actions = _as_list(st.get("Action")), _as_list(st.get("NotAction"))
            resources, not_resources = _as_list(st.get("Resource")), _as_list(st.get("NotResource"))
            for svc, names in MUTATING.items():
                for name in names:
                    full = f"{svc}:{name}"
                    if actions:
                        act_ok = any(_glob(a, full, True) for a in actions)
                    else:
                        act_ok = not any(_glob(a, full, True) for a in not_actions)
                    if not act_ok:
                        continue
                    for arn in samples[svc]:
                        if resources:
                            res_ok = any(_glob(r, arn, False) for r in resources)
                        else:
                            res_ok = not any(_glob(r, arn, False) for r in not_resources)
                        if res_ok:
                            hits.append((pid, st.get("Sid"), full, arn))
    return {"checked": set(policies), "allow_counts": allow_counts, "hits": hits}


def bootstrap_policies(tpl: dict) -> dict[str, dict]:
    """Rendered documents of every managed policy and every Role inline policy of central-bootstrap.yaml."""
    r = Render(tpl, "ap-northeast-2")
    out: dict[str, dict] = {}
    for rid, res in r.resources().items():
        if res["Type"] == "AWS::IAM::ManagedPolicy":
            out[rid] = r.x(res["Properties"]["PolicyDocument"])
        elif res["Type"] == "AWS::IAM::Role":
            for pol in res["Properties"].get("Policies", []) or []:
                out[f"{rid}/{r.x(pol['PolicyName'])}"] = r.x(pol["PolicyDocument"])
    return out


def bootstrap_policy_ids_by_scan(tpl: dict) -> set[str]:
    """Expected id set, built by a plain scan of the raw template (no policy rendering)."""
    ids: set[str] = set()
    for rid, res in tpl["Resources"].items():
        if res["Type"] == "AWS::IAM::ManagedPolicy":
            ids.add(rid)
        elif res["Type"] == "AWS::IAM::Role":
            for pol in res.get("Properties", {}).get("Policies", []) or []:
                name = pol["PolicyName"]
                if isinstance(name, dict):
                    name = Render(tpl, "ap-northeast-2").x(name)
                ids.add(f"{rid}/{name}")
    return ids


def _allow(action, resource, **extra) -> dict:
    return {"Version": "2012-10-17", "Statement": [{"Sid": "T", "Effect": "Allow", "Action": action, "Resource": resource, **extra}]}


RULE_ARN = f"arn:{PARTITION}:events:ap-northeast-2:{ACCOUNT}:rule/{GUARD_PREFIX}-*"


# ---------------------------------------------------------------- tests of the checker itself (synthetic policies)

class IsolationCheckerSelfTest(unittest.TestCase):
    def hits(self, doc) -> int:
        return len(isolation_check({"synthetic": doc})["hits"])

    def test_delete_rule_on_guard_rules_is_detected(self):
        self.assertGreaterEqual(self.hits(_allow("events:DeleteRule", RULE_ARN)), 1)

    def test_action_is_case_insensitive(self):
        self.assertGreaterEqual(self.hits(_allow("EVENTS:deleterule", RULE_ARN)), 1)

    def test_resource_is_case_sensitive(self):
        low = f"arn:{PARTITION}:events:ap-northeast-2:{ACCOUNT}:rule/alarmopsguard-*"
        self.assertEqual(self.hits(_allow("events:DeleteRule", low)), 0)

    def test_wildcards_are_expanded(self):
        self.assertGreaterEqual(self.hits(_allow("events:*", "*")), 1)
        self.assertGreaterEqual(self.hits(_allow("*", "*")), 1)
        self.assertGreaterEqual(self.hits(_allow("sns:Set*", f"arn:{PARTITION}:sns:*:{ACCOUNT}:{TOPIC_NAME}")), 1)
        self.assertGreaterEqual(
            self.hits(_allow("cloudformation:UpdateStack", f"arn:{PARTITION}:cloudformation:*:{ACCOUNT}:stack/{STACK_NAME}/*")), 1)

    def test_other_resources_and_read_actions_do_not_match(self):
        self.assertEqual(self.hits(_allow("events:DeleteRule", f"arn:{PARTITION}:events:*:{ACCOUNT}:rule/alarmops-*")), 0)
        self.assertEqual(self.hits(_allow("events:DescribeRule", "*")), 0)
        self.assertEqual(
            self.hits(_allow("cloudformation:UpdateStack", f"arn:{PARTITION}:cloudformation:*:{ACCOUNT}:stack/alarmops-central/*")), 0)

    def test_deny_is_not_an_allow_match(self):
        doc = {"Statement": [{"Effect": "Deny", "Action": "events:DeleteRule", "Resource": RULE_ARN}]}
        self.assertEqual(self.hits(doc), 0)

    def test_not_resource_and_not_action_are_expanded(self):
        self.assertGreaterEqual(self.hits({"Statement": [{"Effect": "Allow", "Action": "events:DeleteRule", "NotResource": "arn:x"}]}), 1)
        self.assertGreaterEqual(self.hits({"Statement": [{"Effect": "Allow", "NotAction": "iam:*", "Resource": "*"}]}), 1)

    def test_statement_may_be_a_single_object(self):
        doc = {"Statement": {"Effect": "Allow", "Action": "events:PutRule", "Resource": RULE_ARN}}
        self.assertGreaterEqual(self.hits(doc), 1)
        self.assertEqual(isolation_check({"s": doc})["allow_counts"]["s"], 1)


# ---------------------------------------------------------------- isolation against the real bootstrap policies

class BootstrapIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tpl = _load(BOOTSTRAP)
        cls.policies = bootstrap_policies(cls.tpl)
        cls.report = isolation_check(cls.policies)

    def test_checked_ids_are_all_bootstrap_policies(self):
        expected = bootstrap_policy_ids_by_scan(self.tpl)
        self.assertTrue(expected, "bootstrap template has no policies?")
        self.assertEqual(self.report["checked"], expected)

    def test_every_policy_expands_to_allow_statements(self):
        for pid, n in self.report["allow_counts"].items():
            self.assertGreater(n, 0, pid)

    def test_no_change_or_delete_allow_on_alert_resources(self):
        self.assertEqual(self.report["hits"], [])

    def test_stack_name_differs_from_bootstrap_stack_names(self):
        self.assertEqual(STACK_NAME, "alarmops-central-alerts")
        d = {k: v.get("Default") for k, v in self.tpl["Parameters"].items()}
        self.assertNotEqual(STACK_NAME, d["CentralStackName"])
        self.assertNotEqual(STACK_NAME, d["BusStackName"])
        self.assertNotEqual(STACK_NAME, "alarmops-central-bootstrap")


# ---------------------------------------------------------------- the template

class CentralAlerts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = ALERTS.read_text(encoding="utf-8")
        cls.tpl = _load(ALERTS)

    def render(self, region: str, params: dict | None = None) -> Render:
        return Render(self.tpl, region, params)

    def rules(self, region: str) -> dict:
        return self.render(region).resources("AWS::Events::Rule")

    def topics(self, region: str) -> dict:
        return self.render(region).resources("AWS::SNS::Topic")

    # -- event patterns

    def test_us_east_1_pattern_equals_doc_first_block(self):
        r = self.render("us-east-1")
        rules = self.rules("us-east-1")
        self.assertEqual(len(rules), 1)
        pattern = r.x(next(iter(rules.values()))["Properties"]["EventPattern"])
        self.assertEqual(pattern, doc_pattern_4_2(0))
        names = pattern["detail"]["userIdentity"]["sessionContext"]["sessionIssuer"]["userName"]
        self.assertEqual(names, ["AlarmOpsDeployCentral"])

    def test_seoul_pattern_equals_doc_second_block(self):
        r = self.render("ap-northeast-2")
        rules = self.rules("ap-northeast-2")
        self.assertEqual(len(rules), 1)
        pattern = r.x(next(iter(rules.values()))["Properties"]["EventPattern"])
        self.assertEqual(pattern, doc_pattern_4_2(1))
        names = pattern["detail"]["userIdentity"]["sessionContext"]["sessionIssuer"]["userName"]
        self.assertIn("AlarmOpsDeployCentral", names)
        self.assertIn("AlarmOpsDeployBus", names)

    # -- which resources exist in which region

    def test_region_selects_the_rule(self):
        for region, key, other in (("us-east-1", "iam-change", "service-change"), ("ap-northeast-2", "service-change", "iam-change")):
            r = self.render(region)
            names = [r.x(x["Properties"]["Name"]) for x in self.rules(region).values()]
            self.assertEqual(len(names), 1, region)
            self.assertIn(key, names[0])
            self.assertNotIn(other, names[0])
            self.assertTrue(names[0].startswith(f"{GUARD_PREFIX}-"), names[0])

    def test_rule_targets_the_topic_of_the_same_stack(self):
        for region in ("us-east-1", "ap-northeast-2"):
            topics = self.topics(region)
            self.assertEqual(len(topics), 1, region)
            tid = next(iter(topics))
            for rule in self.rules(region).values():
                targets = rule["Properties"]["Targets"]
                self.assertGreaterEqual(len(targets), 1)
                for t in targets:
                    arn = t["Arn"]
                    ok = arn == {"Ref": tid} or arn == {"Fn::GetAtt": [tid, "TopicArn"]} or arn == {"Fn::GetAtt": f"{tid}.TopicArn"}
                    self.assertTrue(ok, f"{region}: target {arn!r} is not the topic {tid}")

    def test_topic_name_uses_the_prefix(self):
        for region in ("us-east-1", "ap-northeast-2"):
            r = self.render(region)
            for t in self.topics(region).values():
                self.assertEqual(r.x(t["Properties"]["TopicName"]), TOPIC_NAME)

    def test_subscription_exists_in_each_region_and_is_email(self):
        for region in ("us-east-1", "ap-northeast-2"):
            r = self.render(region)
            subs = [r.x(x["Properties"]) for x in r.resources("AWS::SNS::Subscription").values()]
            for t in self.topics(region).values():
                subs += [r.x(s) for s in t["Properties"].get("Subscription", []) or []]
            self.assertGreaterEqual(len(subs), 1, region)
            for s in subs:
                self.assertEqual(s["Protocol"], "email")

    # -- topic policy

    def test_topic_policy(self):
        for region in ("us-east-1", "ap-northeast-2"):
            pols = self.render(region).resources("AWS::SNS::TopicPolicy")
            self.assertEqual(len(pols), 1, region)
            doc = next(iter(pols.values()))["Properties"]["PolicyDocument"]
            sts = _statements(doc)
            self.assertEqual(len(sts), 1)
            st = sts[0]
            self.assertEqual(st["Effect"], "Allow")
            self.assertEqual(st["Principal"], {"Service": "events.amazonaws.com"})
            self.assertEqual(st["Action"], "sns:Publish")
            self.assertEqual(
                st["Condition"],
                {"ArnLike": {"aws:SourceArn": {"Fn::Sub": "arn:${AWS::Partition}:events:${AWS::Region}:${AWS::AccountId}:rule/${ResourcePrefix}-*"}}},
            )

    def test_topic_policy_source_arn_covers_the_rules_only(self):
        for region in ("us-east-1", "ap-northeast-2"):
            r = self.render(region)
            pol = next(iter(r.resources("AWS::SNS::TopicPolicy").values()))
            src = r.x(pol["Properties"]["PolicyDocument"]["Statement"][0]["Condition"]["ArnLike"]["aws:SourceArn"])
            self.assertEqual(src, f"arn:{PARTITION}:events:{region}:{ACCOUNT}:rule/{GUARD_PREFIX}-*")
            for rule in r.resources("AWS::Events::Rule").values():
                arn = f"arn:{PARTITION}:events:{region}:{ACCOUNT}:rule/{r.x(rule['Properties']['Name'])}"
                self.assertTrue(_glob(src, arn, False), arn)

    # -- ResourcePrefix guard

    def test_resource_prefix_only_accepts_guard(self):
        p = self.tpl["Parameters"]["ResourcePrefix"]
        self.assertEqual(p["Default"], GUARD_PREFIX)
        rx = p["AllowedPattern"]
        self.assertIsNotNone(re.fullmatch(rx, GUARD_PREFIX))
        for bad in ("AlarmOpsDeployCentral", "AlarmOpsDeployBus", "alarmops", "alarmopsguard", f"{GUARD_PREFIX}-x", f"{GUARD_PREFIX}X", ""):
            self.assertIsNone(re.fullmatch(rx, bad), bad)

    # -- literals

    def test_no_hardcoded_account_partition_or_seoul(self):
        self.assertEqual(re.findall(r"(?<!\d)\d{12}(?!\d)", self.text), [])
        self.assertEqual(self.text.count("arn:aws:"), 0)
        self.assertEqual(self.text.count("ap-northeast-2"), 0)

    def test_only_us_east_1_literal_is_the_condition(self):
        self.assertEqual(self.text.count("us-east-1"), 1)
        cond = self.tpl["Conditions"]["IsUsEast1"]
        self.assertEqual(cond, {"Fn::Equals": [{"Ref": "AWS::Region"}, "us-east-1"]})

    # -- deletion

    def test_nothing_is_retained_on_delete(self):
        self.assertIsNone(re.search(r"DeletionPolicy\s*:\s*['\"]?Retain", self.text))
        for rid, res in self.tpl["Resources"].items():
            self.assertNotEqual(res.get("DeletionPolicy"), "Retain", rid)

    # -- lint

    def test_no_ignore_checks(self):
        self.assertEqual(self.text.count("ignore_checks"), 0)

    def test_cfn_lint_passes(self):
        exe = shutil.which("cfn-lint")
        if exe is None:
            self.skipTest("cfn-lint is not installed")
        res = subprocess.run([exe, str(ALERTS)], capture_output=True, text=True, cwd=REPO)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)


# ---------------------------------------------------------------- workflow and documents

class CiAndDocs(unittest.TestCase):
    def test_ci_lints_the_alerts_template_in_a_step_named_alerts(self):
        ci = yaml.safe_load(CI.read_text(encoding="utf-8"))
        found = [
            s for job in ci["jobs"].values() for s in job.get("steps", [])
            if "cfn-lint" in str(s.get("run", "")) and "infra/aws/central-alerts.yaml" in str(s.get("run", ""))
        ]
        self.assertEqual(len(found), 1)
        self.assertIn("alerts", found[0].get("name", ""))

    def test_doc_removed_stale_sentences_and_points_to_template(self):
        text = DOC.read_text(encoding="utf-8")
        self.assertEqual(text.count("서울 버스로 전달"), 0)
        self.assertEqual(text.count("초안만 둔다"), 0)
        self.assertGreaterEqual(text.count("central-alerts.yaml로 구현(#115)"), 1)

    def test_section_4_2_has_the_procedure(self):
        sec = doc_section("## 4-2.")
        for needle in (STACK_NAME, "us-east-1", "ap-northeast-2", "구독", "Confirmed", "삭제", "되돌", "실고객 연결 중 삭제 금지"):
            self.assertIn(needle, sec, needle)

    def test_go_live_has_one_extended_checklist_item(self):
        lines = GOLIVE.read_text(encoding="utf-8").splitlines()
        boxes = [i for i, l in enumerate(lines) if re.match(r"\s*- \[[ xX]\]", l)]
        self.assertEqual(len(boxes), GOLIVE_CHECKBOX_COUNT)
        items = [i for i in boxes if "CloudTrail 알림 규칙" in lines[i]]
        self.assertEqual(len(items), 1)
        i = items[0]
        item = [lines[i]]
        for l in lines[i + 1:]:
            if not l.strip() or re.match(r"\s*- \[[ xX]\]", l) or l.startswith("#"):
                break
            item.append(l)
        body = "\n".join(item)
        for needle in ("CREATE_COMPLETE", "CentralStackName", "BusStackName", "Confirmed", "시험 알림", "CloudTrail 관리 이벤트"):
            self.assertIn(needle, body, needle)

    def test_go_live_d57_line_is_unchanged(self):
        lines = GOLIVE.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[GOLIVE_D57_LINE_NO - 1], GOLIVE_D57_LINE)

    def test_no_foreign_email_domains(self):
        rx = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})")
        for path in (ALERTS, DOC, GOLIVE, THIS_FILE):
            for m in rx.finditer(path.read_text(encoding="utf-8")):
                self.assertIn(m.group(1).lower(), ("example.com", "example.org"), f"{path.name}: {m.group(0)}")


if __name__ == "__main__":
    unittest.main()
