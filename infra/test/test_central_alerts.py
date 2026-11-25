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


DOC_IAM_DIRECT, DOC_SVC_DIRECT, DOC_IAM_DENIED, DOC_SVC_DENIED, DOC_DEPLOY, DOC_IAM_TRUST = range(6)

CFN_IP, EXTERNAL_IP = "cloudformation.amazonaws.com", "203.0.113.7"


def matches(pattern, event) -> bool:
    """Minimal EventBridge matcher: list = any element matches; dict leaf rules {prefix}, {exists}; nested dicts recurse;
    an array-valued event field matches if any of its values matches."""
    def leaf(rule, val):
        if isinstance(rule, dict):
            if "prefix" in rule:
                return isinstance(val, str) and val.startswith(rule["prefix"])
            if "exists" in rule:
                return (val is not _MISSING) == bool(rule["exists"])
            if "anything-but" in rule:
                excluded = rule["anything-but"]
                excluded = excluded if isinstance(excluded, list) else [excluded]
                return val is not _MISSING and val not in excluded
            raise ValueError(f"unsupported rule {rule}")
        return val is not _MISSING and val == rule

    def node(pat, ev):
        for key, sub in pat.items():
            val = ev.get(key, _MISSING) if isinstance(ev, dict) else _MISSING
            if isinstance(sub, dict):
                if not isinstance(val, dict) and not (isinstance(val, list)):
                    return False
                if not node(sub, val if isinstance(val, dict) else {}):
                    return False
            else:
                vals = val if isinstance(val, list) else [val]
                if not any(leaf(r, v) for r in sub for v in vals):
                    return False
        return True
    return node(pattern, event)


_MISSING = object()


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
        for rule in ("iam-change", "iam-denied", "iam-trust", "service-change", "service-denied", "deploy"):
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

    def rule(self, region: str, rid: str) -> dict:
        return self.rules(region)[rid]

    def pat(self, region: str, rid: str) -> dict:
        return self.render(region).x(self.rule(region, rid)["Properties"]["EventPattern"])

    def test_patterns_equal_doc_blocks(self):
        for region, rid, idx in (
            ("us-east-1", "IamChangeRule", DOC_IAM_DIRECT),
            ("us-east-1", "IamDeniedRule", DOC_IAM_DENIED),
            ("ap-northeast-2", "ServiceChangeRule", DOC_SVC_DIRECT),
            ("ap-northeast-2", "ServiceDeniedRule", DOC_SVC_DENIED),
            ("ap-northeast-2", "DeployRule", DOC_DEPLOY),
            ("us-east-1", "IamTrustRule", DOC_IAM_TRUST),
        ):
            with self.subTest(rule=rid):
                self.assertEqual(self.pat(region, rid), doc_pattern_4_2(idx))

    def test_user_names(self):
        def names(region, rid):
            return self.pat(region, rid)["detail"]["userIdentity"]["sessionContext"]["sessionIssuer"]["userName"]
        self.assertEqual(names("us-east-1", "IamChangeRule"), ["AlarmOpsDeployCentral"])
        self.assertEqual(names("us-east-1", "IamDeniedRule"), ["AlarmOpsDeployCentral"])
        self.assertEqual(names("us-east-1", "IamTrustRule"), ["AlarmOpsDeployCentral"])
        for rid in ("ServiceChangeRule", "ServiceDeniedRule", "DeployRule"):
            self.assertEqual(names("ap-northeast-2", rid), ["AlarmOpsDeployCentral", "AlarmOpsDeployBus"])

    def test_direct_rules_exclude_cloudformation_source_ip(self):
        for region, rid in (("us-east-1", "IamChangeRule"), ("ap-northeast-2", "ServiceChangeRule")):
            self.assertEqual(self.pat(region, rid)["detail"]["sourceIPAddress"], [{"anything-but": CFN_IP}])

    def test_denied_rules_have_error_code_and_no_source_ip_condition(self):
        for region, rid in (("us-east-1", "IamDeniedRule"), ("ap-northeast-2", "ServiceDeniedRule")):
            d = self.pat(region, rid)["detail"]
            self.assertEqual(d["errorCode"], [{"exists": True}])
            self.assertNotIn("sourceIPAddress", d)

    CFN_EVENTS = ["ExecuteChangeSet", "CreateStack", "UpdateStack", "DeleteStack"]

    def test_denied_rules_cover_direct_rules_plus_cloudformation(self):
        for region, direct, denied in (("us-east-1", "IamChangeRule", "IamDeniedRule"), ("ap-northeast-2", "ServiceChangeRule", "ServiceDeniedRule")):
            a, b = self.pat(region, direct), self.pat(region, denied)
            self.assertEqual(b["source"], a["source"] + ["aws.cloudformation"])
            self.assertEqual(b["detail"]["eventName"], a["detail"]["eventName"] + self.CFN_EVENTS)
            self.assertEqual(a["detail"]["userIdentity"], b["detail"]["userIdentity"])

    def test_iam_trust_rule_has_no_source_ip_and_no_error_condition(self):
        d = self.pat("us-east-1", "IamTrustRule")["detail"]
        self.assertEqual(d["eventName"], ["CreateRole", "UpdateAssumeRolePolicy"])
        self.assertNotIn("sourceIPAddress", d)
        self.assertNotIn("errorCode", d)

    def test_iam_trust_mail_summary_fields(self):
        it = self.rule("us-east-1", "IamTrustRule")["Properties"]["Targets"][0]["InputTransformer"]
        self.assertEqual(it["InputPathsMap"]["roleName"], "$.detail.requestParameters.roleName")
        for var in ("<roleName>", "<eventTime>", "<sourceIp>", "<eventId>"):
            self.assertIn(var, it["InputTemplate"])

    def test_iam_trust_matches_cfn_and_direct_create_role_but_not_other_roles(self):
        p = self.pat("us-east-1", "IamTrustRule")
        for ip in (CFN_IP, EXTERNAL_IP, None):
            for name in ("CreateRole", "UpdateAssumeRolePolicy"):
                with self.subTest(ip=ip, name=name):
                    self.assertTrue(matches(p, self.ev("aws.iam", name, "AlarmOpsDeployCentral", ip=ip)))
        self.assertFalse(matches(p, self.ev("aws.iam", "CreateRole", "AlarmOpsDeployBus", ip=CFN_IP)))
        self.assertFalse(matches(p, self.ev("aws.iam", "CreateRole", "SomeAdmin", ip=CFN_IP)))
        self.assertFalse(matches(p, self.ev("aws.iam", "PutRolePolicy", "AlarmOpsDeployCentral", ip=CFN_IP)))

    def test_cfn_denied_change_set_matches_denied_rules(self):
        for region, rid in (("ap-northeast-2", "ServiceDeniedRule"), ("us-east-1", "IamDeniedRule")):
            for name in self.CFN_EVENTS:
                with self.subTest(region=region, name=name):
                    e = self.ev("aws.cloudformation", name, "AlarmOpsDeployCentral", "AccessDenied", CFN_IP)
                    self.assertTrue(matches(self.pat(region, rid), e))
                    self.assertFalse(matches(self.pat(region, rid), self.ev("aws.cloudformation", name, "AlarmOpsDeployCentral", ip=CFN_IP)))
        # a succeeded CloudFormation event is never mailed by direct rules
        for region, rid in (("ap-northeast-2", "ServiceChangeRule"), ("us-east-1", "IamChangeRule")):
            e = self.ev("aws.cloudformation", "ExecuteChangeSet", "AlarmOpsDeployCentral", "AccessDenied", EXTERNAL_IP)
            self.assertFalse(matches(self.pat(region, rid), e))

    def test_apigateway_route_direct_call_matches_cfn_does_not(self):
        p = self.pat("ap-northeast-2", "ServiceChangeRule")
        for name in ("CreateRoute", "UpdateRoute", "DeleteRoute", "CreateIntegration", "UpdateIntegration", "UpdateStage"):
            with self.subTest(name=name):
                self.assertTrue(matches(p, self.ev("aws.apigateway", name, "AlarmOpsDeployCentral", ip=EXTERNAL_IP)))
                self.assertFalse(matches(p, self.ev("aws.apigateway", name, "AlarmOpsDeployCentral", ip=CFN_IP)))
                self.assertFalse(matches(p, self.ev("aws.apigateway", name, "SomeAdmin", ip=EXTERNAL_IP)))

    def test_new_seoul_events_are_backed_by_deploy_role_permissions(self):
        pols = bootstrap_policies(_load(BOOTSTRAP))
        allowed = {a.lower() for doc in pols.values() for st in _statements(doc) if st.get("Effect") == "Allow" for a in _as_list(st.get("Action"))}
        for a in ("lambda:DeleteFunction", "events:RemovePermission", "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret"):
            self.assertIn(a.lower(), allowed, a)
        for a in ("apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"):  # v2 CreateRoute/Update*/Delete*
            self.assertIn(a.lower(), allowed, a)

    def test_denied_mail_starts_with_urgent_severity(self):
        for region, rid in (("us-east-1", "IamDeniedRule"), ("ap-northeast-2", "ServiceDeniedRule")):
            tmpl = self.rule(region, rid)["Properties"]["Targets"][0]["InputTransformer"]["InputTemplate"]
            first = tmpl.strip().splitlines()[1].strip()
            self.assertEqual(first, '"severity": "URGENT - denied call by the deploy role",')
        for region, rid in (("us-east-1", "IamChangeRule"), ("us-east-1", "IamTrustRule"), ("ap-northeast-2", "ServiceChangeRule"), ("ap-northeast-2", "DeployRule")):
            tmpl = self.rule(region, rid)["Properties"]["Targets"][0]["InputTransformer"]["InputTemplate"]
            self.assertNotIn("severity", tmpl)

    def test_deploy_rule_mail_summary_fields(self):
        it = self.rule("ap-northeast-2", "DeployRule")["Properties"]["Targets"][0]["InputTransformer"]
        self.assertEqual(it["InputPathsMap"]["stackName"], "$.detail.requestParameters.stackName")
        self.assertEqual(it["InputPathsMap"]["changeSetName"], "$.detail.requestParameters.changeSetName")
        for var in ("<stackName>", "<changeSetName>", "<eventTime>", "<sourceIp>", "<eventId>"):
            self.assertIn(var, it["InputTemplate"])

    # -- event sample matching (small EventBridge pattern matcher)

    @staticmethod
    def ev(source, name, role, error=None, ip=None):
        d = {"eventName": name, "userIdentity": {"sessionContext": {"sessionIssuer": {"userName": role}}}}
        if error:
            d["errorCode"] = error
        if ip:
            d["sourceIPAddress"] = ip
        return {"source": source, "detail-type": "AWS API Call via CloudTrail", "detail": d}

    SEOUL_SAMPLES = (
        ("aws.lambda", "CreateFunction20150331", "AlarmOpsDeployCentral"),
        ("aws.lambda", "UpdateFunctionCode20150331v2", "AlarmOpsDeployCentral"),
        ("aws.lambda", "UpdateFunctionConfiguration20150331v2", "AlarmOpsDeployCentral"),
        ("aws.lambda", "UpdateEventSourceMapping20150331", "AlarmOpsDeployCentral"),
        ("aws.lambda", "CreateEventSourceMapping20150331", "AlarmOpsDeployCentral"),
        ("aws.sqs", "SetQueueAttributes", "AlarmOpsDeployCentral"),
        ("aws.events", "PutRule", "AlarmOpsDeployBus"),
        ("aws.events", "PutTargets", "AlarmOpsDeployCentral"),
        ("aws.lambda", "DeleteFunction20150331", "AlarmOpsDeployCentral"),
        ("aws.events", "RemovePermission", "AlarmOpsDeployBus"),
        ("aws.apigateway", "CreateRoute", "AlarmOpsDeployCentral"),
        ("aws.apigateway", "UpdateStage", "AlarmOpsDeployCentral"),
        ("aws.secretsmanager", "CreateSecret", "AlarmOpsDeployCentral"),
        ("aws.secretsmanager", "DeleteSecret", "AlarmOpsDeployCentral"),
    )
    IAM_SAMPLES = (
        ("aws.iam", "PutRolePolicy", "AlarmOpsDeployCentral"),
        ("aws.iam", "CreateRole", "AlarmOpsDeployCentral"),
        ("aws.iam", "AttachRolePolicy", "AlarmOpsDeployCentral"),
    )

    def test_cfn_success_events_match_neither_direct_nor_denied_rules(self):
        for region, direct, denied, samples in (
            ("ap-northeast-2", "ServiceChangeRule", "ServiceDeniedRule", self.SEOUL_SAMPLES),
            ("us-east-1", "IamChangeRule", "IamDeniedRule", self.IAM_SAMPLES),
        ):
            for src, name, role in samples:
                e = self.ev(src, name, role, ip=CFN_IP)
                with self.subTest(name=name, role=role):
                    self.assertFalse(matches(self.pat(region, direct), e))
                    self.assertFalse(matches(self.pat(region, denied), e))

    def test_same_events_from_external_ip_match_direct_rules(self):
        for region, direct, denied, samples in (
            ("ap-northeast-2", "ServiceChangeRule", "ServiceDeniedRule", self.SEOUL_SAMPLES),
            ("us-east-1", "IamChangeRule", "IamDeniedRule", self.IAM_SAMPLES),
        ):
            for src, name, role in samples:
                e = self.ev(src, name, role, ip=EXTERNAL_IP)
                with self.subTest(name=name, role=role):
                    self.assertTrue(matches(self.pat(region, direct), e))
                    self.assertFalse(matches(self.pat(region, denied), e))  # succeeded: not a denied attempt

    def test_denied_rules_match_cfn_and_direct_denials(self):
        for region, denied, samples in (
            ("ap-northeast-2", "ServiceDeniedRule", self.SEOUL_SAMPLES),
            ("us-east-1", "IamDeniedRule", self.IAM_SAMPLES),
        ):
            for src, name, role in samples:
                for ip in (CFN_IP, EXTERNAL_IP):
                    with self.subTest(name=name, ip=ip):
                        self.assertTrue(matches(self.pat(region, denied), self.ev(src, name, role, "AccessDenied", ip)))
        # CFN-routed denial is not mailed by the direct rule, only by the denied rule
        e = self.ev("aws.iam", "PutRolePolicy", "AlarmOpsDeployCentral", "AccessDenied", CFN_IP)
        self.assertFalse(matches(self.pat("us-east-1", "IamChangeRule"), e))

    def test_denied_rules_reject_other_roles_and_sources(self):
        p = self.pat("ap-northeast-2", "ServiceDeniedRule")
        self.assertFalse(matches(p, self.ev("aws.lambda", "CreateFunction20150331", "SomeAdmin", "AccessDenied", EXTERNAL_IP)))
        self.assertFalse(matches(p, self.ev("aws.s3", "PutRule", "AlarmOpsDeployCentral", "AccessDenied", EXTERNAL_IP)))
        self.assertFalse(matches(self.pat("us-east-1", "IamDeniedRule"), self.ev("aws.iam", "CreateRole", "AlarmOpsDeployBus", "AccessDenied")))

    def test_deploy_rule_matches_deploy_roles_only(self):
        p = self.pat("ap-northeast-2", "DeployRule")
        for name in ("ExecuteChangeSet", "CreateStack", "UpdateStack", "DeleteStack"):
            for role in ("AlarmOpsDeployCentral", "AlarmOpsDeployBus"):
                with self.subTest(name=name, role=role):
                    self.assertTrue(matches(p, self.ev("aws.cloudformation", name, role, ip=EXTERNAL_IP)))
            self.assertFalse(matches(p, self.ev("aws.cloudformation", name, "SomeAdmin")))
        self.assertFalse(matches(p, self.ev("aws.cloudformation", "CreateChangeSet", "AlarmOpsDeployCentral")))
        self.assertFalse(matches(p, self.ev("aws.lambda", "ExecuteChangeSet", "AlarmOpsDeployCentral")))

    def test_seoul_direct_rule_does_not_match_other_roles_or_sources(self):
        p = self.pat("ap-northeast-2", "ServiceChangeRule")
        for src, name, role in (
            ("aws.lambda", "CreateFunction20150331", "SomeAdmin"),
            ("aws.events", "PutRule", "SomeAdmin"),
            ("aws.events", "PutTargets", "SomeAdmin"),
            ("aws.s3", "PutRule", "AlarmOpsDeployCentral"),
            ("aws.s3", "CreateFunction20150331", "AlarmOpsDeployBus"),
        ):
            with self.subTest(src=src, name=name, role=role):
                self.assertFalse(matches(p, self.ev(src, name, role, ip=EXTERNAL_IP)))

    def test_us_east_1_direct_rule_matches_and_rejects_samples(self):
        p = self.pat("us-east-1", "IamChangeRule")
        self.assertTrue(matches(p, self.ev("aws.iam", "CreatePolicyVersion", "AlarmOpsDeployCentral", "AccessDenied", EXTERNAL_IP)))
        self.assertFalse(matches(p, self.ev("aws.iam", "DeleteRolePolicy", "AlarmOpsDeployCentral", ip=EXTERNAL_IP)))
        self.assertFalse(matches(p, self.ev("aws.iam", "CreateRole", "AlarmOpsDeployBus", ip=EXTERNAL_IP)))

    def test_matcher_negative_control(self):
        wrong = {"source": ["aws.iam"], "detail": {"eventName": ["CreateRole"], "userIdentity": {"sessionContext": {"sessionIssuer": {"userName": ["Other"]}}}}}
        self.assertFalse(matches(wrong, self.ev("aws.iam", "CreateRole", "AlarmOpsDeployCentral")))
        self.assertTrue(matches({"detail": {"errorCode": [{"exists": True}]}}, self.ev("aws.iam", "X", "r", "AccessDenied")))
        self.assertFalse(matches({"detail": {"errorCode": [{"exists": True}]}}, self.ev("aws.iam", "X", "r")))
        anything = {"detail": {"sourceIPAddress": [{"anything-but": CFN_IP}]}}
        self.assertFalse(matches(anything, self.ev("aws.iam", "X", "r", ip=CFN_IP)))
        self.assertTrue(matches(anything, self.ev("aws.iam", "X", "r", ip=EXTERNAL_IP)))
        self.assertTrue(matches({"detail": {"eventName": [{"prefix": "Create"}]}}, self.ev("aws.iam", "CreateRole", "r")))
        self.assertFalse(matches({"detail": {"eventName": [{"prefix": "Create"}]}}, self.ev("aws.iam", "XCreate", "r")))

    def test_dropped_events_are_not_in_any_pattern(self):
        for region in ("us-east-1", "ap-northeast-2"):
            for rid in self.rules(region):
                if rid == "DeployRule":
                    continue
                names = self.pat(region, rid)["detail"]["eventName"]
                for bad in ("DeleteRolePolicy", "DetachRolePolicy", "DeleteEventSourceMapping"):
                    self.assertNotIn(bad, names)
                    self.assertNotIn({"prefix": bad}, names)

    def test_targets_have_input_transformer_with_summary_fields(self):
        for region in ("us-east-1", "ap-northeast-2"):
            for rule in self.rules(region).values():
                for t in rule["Properties"]["Targets"]:
                    it = t["InputTransformer"]
                    paths = it["InputPathsMap"]
                    self.assertEqual(paths["eventId"], "$.detail.eventID")
                    self.assertEqual(paths["eventName"], "$.detail.eventName")
                    self.assertEqual(paths["errorCode"], "$.detail.errorCode")
                    tmpl = it["InputTemplate"]
                    for var in ("<eventId>", "<eventName>", "<errorCode>", "<aws.events.rule-name>", "<eventTime>", "<sourceIp>", "<userAgent>", "<region>"):
                        self.assertIn(var, tmpl)
                    used = set(re.findall(r"<([A-Za-z]+)>", tmpl))
                    self.assertLessEqual(used, set(paths), f"{region}: template uses undefined path variables")
                    self.assertNotIn("<aws.events.event>", tmpl)  # no raw event dump

    def test_doc_4_2_records_skipped_events_and_completion(self):
        sec = doc_section("## 4-2.")
        for needle in ("DeleteRolePolicy", "DetachRolePolicy", "소음", "관리 이벤트를 기록하는 추적", "CT 조직 추적", "실제 배포 1회"):
            self.assertIn(needle, sec, needle)

    # -- which resources exist in which region

    def test_region_selects_the_rules(self):
        for region, expected in (
            ("us-east-1", {"IamChangeRule": "iam-change", "IamDeniedRule": "iam-denied", "IamTrustRule": "iam-trust"}),
            ("ap-northeast-2", {"ServiceChangeRule": "service-change", "ServiceDeniedRule": "service-denied", "DeployRule": "deploy"}),
            ("eu-west-1", {"ServiceChangeRule": "service-change", "ServiceDeniedRule": "service-denied", "DeployRule": "deploy"}),
        ):
            r = self.render(region)
            rules = self.rules(region)
            self.assertEqual(set(rules), set(expected), region)
            for rid, key in expected.items():
                name = r.x(rules[rid]["Properties"]["Name"])
                self.assertEqual(name, f"{GUARD_PREFIX}-{key}")

    def test_every_rule_arn_is_protected_by_the_isolation_samples(self):
        samples = set(protected_samples()["events"])
        for region in ("us-east-1", "ap-northeast-2", "eu-west-1"):
            r = self.render(region)
            for rule in self.rules(region).values():
                arn = f"arn:{PARTITION}:events:{region}:{ACCOUNT}:rule/{r.x(rule['Properties']['Name'])}"
                if region != "eu-west-1":
                    self.assertIn(arn, samples)
                self.assertTrue(_glob(f"arn:{PARTITION}:events:*:{ACCOUNT}:rule/{GUARD_PREFIX}-*", arn, False))

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
        for needle in ("CREATE_COMPLETE", "CentralStackName", "BusStackName", "Confirmed", "시험 알림", "CloudTrail 관리 이벤트", "실측", "메일 수신"):
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
