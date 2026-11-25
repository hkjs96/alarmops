"""Structural tests of the CloudFormation templates (offline; cfn-lint covers syntax, this covers D-07 rules).

Run from the repo root:  python -m unittest discover -s infra/test -v
Needs only PyYAML (installed with cfn-lint).
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


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
        return {("Ref" if suffix == "Ref" else f"Fn::{suffix}"): val}

    L.add_multi_constructor("!", tag)
    return yaml.load(path.read_text(encoding="utf-8"), Loader=L)


T = _load(ROOT / "customer-stack" / "template.yaml")
RES = T["Resources"]
ASSUMED_BY_CENTRAL = ["ReaderRole", "AlarmWriterRole", "TagWriterRole", "RemediatorRole"]
ROLES = ASSUMED_BY_CENTRAL + ["EventForwarderRole"]


def statements(role: str) -> list[dict]:
    out = []
    for p in RES[role]["Properties"]["Policies"]:
        out.extend(p["PolicyDocument"]["Statement"])
    return out


def as_list(x):
    return x if isinstance(x, list) else [x]


class CustomerStack(unittest.TestCase):
    def test_exactly_five_roles(self):
        self.assertEqual(sorted(k for k, v in RES.items() if v["Type"] == "AWS::IAM::Role"), sorted(ROLES))

    def test_optional_roles_are_conditional_and_default_off(self):
        for role, param in (("AlarmWriterRole", "EnableAlarmWriter"), ("TagWriterRole", "EnableTagWriter"),
                            ("RemediatorRole", "EnableRemediator")):
            self.assertIn("Condition", RES[role])
            self.assertEqual(T["Parameters"][param]["Default"], "false")
        for role in ("ReaderRole", "EventForwarderRole"):
            self.assertNotIn("Condition", RES[role])

    def test_trust_is_one_central_role_with_external_id(self):
        self.assertNotIn("Default", T["Parameters"]["ExternalId"])
        self.assertGreaterEqual(T["Parameters"]["ExternalId"]["MinLength"], 16)
        self.assertNotIn("Default", T["Parameters"]["CentralRoleArn"])
        self.assertIn(":role/", T["Parameters"]["CentralRoleArn"]["AllowedPattern"])   # not :root
        for role in ASSUMED_BY_CENTRAL:
            (st,) = RES[role]["Properties"]["AssumeRolePolicyDocument"]["Statement"]
            want = "RemediatorCallerRoleArn" if role == "RemediatorRole" else "CentralRoleArn"
            self.assertEqual(st["Principal"], {"AWS": {"Ref": want}}, role)
            self.assertEqual(st["Action"], "sts:AssumeRole")
            self.assertEqual(st["Condition"], {"StringEquals": {"sts:ExternalId": {"Ref": "ExternalId"}}}, role)

    def test_event_forwarder_trust_is_events_service_pinned_to_own_rules(self):
        (st,) = RES["EventForwarderRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(st["Principal"], {"Service": "events.amazonaws.com"})
        self.assertIn("aws:SourceAccount", st["Condition"]["StringEquals"])
        self.assertIn("aws:SourceArn", st["Condition"]["ArnLike"])
        (pol,) = statements("EventForwarderRole")
        self.assertEqual(pol["Action"], "events:PutEvents")
        self.assertEqual(pol["Resource"], {"Ref": "CentralEventBusArn"})

    def test_session_one_hour_or_less(self):
        for role in ROLES:
            self.assertLessEqual(RES[role]["Properties"]["MaxSessionDuration"], 3600, role)

    def test_rules_target_central_bus_with_forwarder_role(self):
        for rule in ("AlarmStateRule", "TagChangeRule"):
            (t,) = RES[rule]["Properties"]["Targets"]
            self.assertEqual(t["Arn"], {"Ref": "CentralEventBusArn"})
            self.assertEqual(t["RoleArn"], {"Fn::GetAtt": "EventForwarderRole.Arn"})
        self.assertEqual(RES["AlarmStateRule"]["Properties"]["EventPattern"]["Fn::If"][2]["detail-type"],
                         ["CloudWatch Alarm State Change"])

    def test_reader_has_no_write_and_denies_secrets(self):
        allowed = [a for s in statements("ReaderRole") if s["Effect"] == "Allow" for a in as_list(s["Action"])]
        for a in allowed:
            verb = a.split(":")[1]
            self.assertTrue(verb.startswith(("Describe", "List", "Get")) or a == "apigateway:GET", a)
        for a in ("s3:GetObject", "secretsmanager:GetSecretValue", "ssm:GetParameter", "kms:Decrypt"):
            self.assertNotIn(a, allowed)
        deny = [s for s in statements("ReaderRole") if s["Effect"] == "Deny"]
        denied = {a for s in deny for a in as_list(s["Action"])}
        for a in ("secretsmanager:*", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
                  "s3:GetObject", "kms:Decrypt"):
            self.assertIn(a, denied)

    def test_alarm_writer_manages_only_managed_by_alarmops(self):
        sts = statements("AlarmWriterRole")
        allows = [s for s in sts if s["Effect"] == "Allow"]
        for s in allows:
            for a in as_list(s["Action"]):
                self.assertTrue(a.startswith("cloudwatch:"), a)
        create = [s for s in allows if s.get("Sid") == "CreateAlarmWithManagedByTag"][0]
        self.assertEqual(as_list(create["Action"]), ["cloudwatch:PutMetricAlarm"])
        self.assertEqual(create["Condition"], {"StringEquals": {"aws:RequestTag/ManagedBy": "AlarmOps"}})
        own = [s for s in allows if s.get("Sid") == "ChangeOwnAlarms"][0]
        self.assertEqual(own["Condition"], {"StringEquals": {"aws:ResourceTag/ManagedBy": "AlarmOps"}})
        # every statement that can delete, tag or untag is bound to the ResourceTag condition; RequestTag only creates
        for s in allows:
            acts = as_list(s["Action"])
            if s is not own and s is not create:
                self.assertFalse({"cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource"} & set(acts))
        deny = [s for s in sts if s["Effect"] == "Deny"][0]
        self.assertEqual(sorted(as_list(deny["Action"])), ["cloudwatch:TagResource", "cloudwatch:UntagResource"])
        self.assertEqual(deny["Condition"], {"ForAnyValue:StringEquals": {"aws:TagKeys": ["ManagedBy"]}})

    def test_tag_writer_only_monitoring_key_no_s3_route53(self):
        for s in statements("TagWriterRole"):
            self.assertEqual(s["Effect"], "Allow")
            self.assertEqual(s["Condition"]["ForAllValues:StringEquals"], {"aws:TagKeys": ["Monitoring"]})
            self.assertEqual(s["Condition"]["Null"], {"aws:TagKeys": "false"})
            self.assertEqual(s["Condition"]["StringEquals"], {"aws:RequestTag/Monitoring": "on"})
            for a in as_list(s["Action"]):
                self.assertFalse(a.startswith(("s3:", "route53:")), a)
                self.assertRegex(a.split(":")[1], r"(?i)tag")

    def test_remediator_only_three_actions_with_monitoring_on(self):
        acts = []
        for s in statements("RemediatorRole"):
            self.assertEqual(s["Condition"], {"StringEquals": {"aws:ResourceTag/Monitoring": "on"}})
            acts += as_list(s["Action"])
        self.assertEqual(sorted(acts), sorted(["ec2:StopInstances", "rds:StopDBInstance", "rds:StopDBCluster",
                                               "elasticloadbalancing:DeleteLoadBalancer"]))

    def test_reader_has_no_lambda_listing(self):
        allowed = [a for s in statements("ReaderRole") if s["Effect"] == "Allow" for a in as_list(s["Action"])]
        self.assertFalse([a for a in allowed if a.startswith("lambda:")])

    def test_remediator_caller_required_when_enabled(self):
        self.assertIn("RemediatorNeedsCaller", T["Rules"])
        self.assertEqual(T["Parameters"]["RemediatorCallerRoleArn"]["Default"], "")

    def test_no_wildcard_actions_in_allow(self):
        for role in ROLES:
            for s in statements(role):
                if s["Effect"] == "Allow":
                    for a in as_list(s["Action"]):
                        self.assertNotIn("*", a, f"{role}: {a}")


class CentralBus(unittest.TestCase):
    def test_policy_principals_come_from_allow_list_and_default_is_empty(self):
        B = _load(ROOT / "aws" / "central-bus.yaml")
        self.assertEqual(B["Parameters"]["AllowedAccountIds"]["Default"], "")
        p = B["Resources"]["CustomerPutEventsPolicy"]
        self.assertEqual(p["Condition"], "HasAllowedAccounts")
        st = p["Properties"]["Statement"]
        self.assertEqual(st["Action"], "events:PutEvents")
        self.assertEqual(st["Principal"], {"AWS": {"Fn::Split": [",", {"Ref": "AllowedAccountIds"}]}})
        self.assertNotIn("*", str(st["Principal"]))
        cond = st["Condition"]
        self.assertEqual(cond["StringLike"], {"events:source": ["aws.*"]})
        self.assertEqual(sorted(cond["StringEquals"]["events:detail-type"]),
                         ["AWS API Call via CloudTrail", "CloudWatch Alarm State Change"])
        self.assertIn("BusName", B["Outputs"])


class ReaderCollectorAdditions(unittest.TestCase):
    """hkjs96/alarmops#47 / #48: exactly the narrowed Reader permissions requested in services/alarm-engine/README.md."""

    @staticmethod
    def _by_sid(sid):
        (s,) = [x for x in statements("ReaderRole") if x.get("Sid") == sid]
        return s

    def test_apigateway_get_only_on_the_two_list_paths(self):
        s = self._by_sid("ApiGatewayList")
        self.assertEqual(s["Effect"], "Allow")
        self.assertEqual(as_list(s["Action"]), ["apigateway:GET"])
        self.assertEqual([r["Fn::Sub"] for r in s["Resource"]],
                         ["arn:${AWS::Partition}:apigateway:*::/restapis", "arn:${AWS::Partition}:apigateway:*::/apis"])
        # apigateway:GET is nowhere else in an Allow
        for st in statements("ReaderRole"):
            if st["Effect"] == "Allow" and st is not s:
                self.assertNotIn("apigateway:GET", as_list(st["Action"]))

    def test_apigateway_keys_and_detail_are_explicitly_denied(self):
        s = self._by_sid("DenyApiGatewayKeysAndDetail")
        self.assertEqual(s["Effect"], "Deny")
        self.assertEqual(as_list(s["Action"]), ["apigateway:GET"])
        self.assertEqual(sorted(r["Fn::Sub"] for r in s["Resource"]), sorted([
            "arn:${AWS::Partition}:apigateway:*::/apikeys*",
            "arn:${AWS::Partition}:apigateway:*::/usageplans/*/keys*",
            "arn:${AWS::Partition}:apigateway:*::/restapis/*/*"]))

    def test_mq_sagemaker_directconnect(self):
        inv = [x for x in statements("ReaderRole") if x.get("Sid") == "ResourceInventoryAndTags"][0]
        acts = as_list(inv["Action"])
        self.assertIn("mq:ListBrokers", acts)
        self.assertIn("directconnect:DescribeConnections", acts)
        every = [a for st in statements("ReaderRole") if st["Effect"] == "Allow" for a in as_list(st["Action"])]
        self.assertNotIn("mq:DescribeBroker", every)      # user lists
        self.assertFalse([a for a in every if a.startswith(("acm:", "backup:", "wafv2:", "efs:"))])  # not used yet
        sm = self._by_sid("SageMakerEndpoints")
        self.assertEqual(as_list(sm["Action"]), ["sagemaker:DescribeEndpoint"])
        self.assertTrue(sm["Resource"]["Fn::Sub"].endswith(":endpoint/*"))

    def test_deny_secrets_and_data_unchanged(self):
        s = self._by_sid("DenySecretsAndData")
        self.assertEqual(s["Effect"], "Deny")
        self.assertEqual(s["Resource"], "*")
        for a in ("secretsmanager:*", "ssm:GetParameter", "s3:GetObject", "kms:Decrypt"):
            self.assertIn(a, as_list(s["Action"]))


C = _load(ROOT / "aws" / "central.yaml")
CR = C["Resources"]
BOOT = _load(ROOT / "aws" / "central-bootstrap.yaml")


def c_statements(role: str) -> list[dict]:
    out = []
    for p in CR[role]["Properties"]["Policies"]:
        out.extend(x for x in p["PolicyDocument"]["Statement"] if isinstance(x, dict) and "Effect" in x)
    return out


def c_all_statements(role: str) -> list[dict]:
    """Like c_statements but also returns the branches of Fn::If entries."""
    out = []
    for p in CR[role]["Properties"]["Policies"]:
        for x in p["PolicyDocument"]["Statement"]:
            if "Fn::If" in x:
                out.extend(b for b in x["Fn::If"][1:] if isinstance(b, dict) and "Effect" in b)
            else:
                out.append(x)
    return out


def queue_statements(policy: str) -> dict[str, dict]:
    return {s["Sid"]: s for s in CR[policy]["Properties"]["PolicyDocument"]["Statement"]}


class CentralTemplate(unittest.TestCase):
    def test_is_sam_seoul_stack(self):
        self.assertEqual(C["Transform"], "AWS::Serverless-2016-10-31")
        self.assertEqual(CR["AlarmEngineFunction"]["Properties"]["Runtime"], "python3.12")

    # ---- central role
    def test_central_role_assumes_only_alarmops_roles_and_never_the_customer_remediator(self):
        sts = c_statements("CentralRole")
        assume = [s for s in sts if s["Effect"] == "Allow" and "sts:AssumeRole" in as_list(s["Action"])]
        resources = [r for s in assume for r in as_list(s["Resource"])]
        self.assertIn({"Fn::Sub": "arn:${AWS::Partition}:iam::*:role/AlarmOps-*"}, resources)
        for r in resources:
            text = r["Fn::Sub"]
            self.assertNotIn(text, ("*", "arn:${AWS::Partition}:iam::*:role/*"))
            self.assertRegex(text, r":role/AlarmOps(-\*|Central-RemediatorCaller)$")
        (deny,) = [s for s in sts if s["Effect"] == "Deny"]
        self.assertEqual(deny["Resource"], {"Fn::Sub": "arn:${AWS::Partition}:iam::*:role/AlarmOps-Remediator"})
        # no other rights than sts, the queue, its secret and its logs
        for s in sts:
            if s["Effect"] == "Allow":
                for a in as_list(s["Action"]):
                    self.assertIn(a.split(":")[0], ("sts", "sqs", "secretsmanager", "logs"), a)
                    self.assertNotIn("*", a)

    def test_central_role_trust_is_lambda_service_and_session_one_hour(self):
        for role in ("CentralRole", "RemediatorCallerRole", "VercelConsoleRole"):
            self.assertLessEqual(CR[role]["Properties"]["MaxSessionDuration"], 3600)
        (st,) = CR["CentralRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(st["Principal"], {"Service": "lambda.amazonaws.com"})
        self.assertIn("aws:SourceAccount", st["Condition"]["StringEquals"])

    def test_engine_function_uses_central_role(self):
        f = CR["AlarmEngineFunction"]["Properties"]
        self.assertEqual(f["Role"], {"Fn::GetAtt": "CentralRole.Arn"})
        self.assertEqual(f["Events"]["Commands"]["Properties"]["FunctionResponseTypes"], ["ReportBatchItemFailures"])
        self.assertIn("MaximumConcurrency", f["Events"]["Commands"]["Properties"]["ScalingConfig"])
        self.assertIn("ReservedConcurrentExecutions", f)

    def test_engine_secret_and_queue_rights(self):
        sts = {s["Sid"]: s for s in c_statements("CentralRole")}
        self.assertEqual(sts["ReadEngineDbSecret"]["Action"], "secretsmanager:GetSecretValue")
        self.assertEqual(sts["ReadEngineDbSecret"]["Resource"], {"Ref": "EngineDbSecret"})
        self.assertEqual(sorted(sts["ConsumeAlarmCommands"]["Action"]),
                         ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"])
        # Every statement (Fn::If branches too) whose Action or NotAction pattern could match sqs:SendMessage.
        from fnmatch import fnmatchcase
        def could_send(x: dict) -> bool:
            pats = [a for a in as_list(x.get("Action")) + as_list(x.get("NotAction")) if isinstance(a, str)]
            return any(fnmatchcase("sqs:sendmessage", a.lower()) for a in pats) or "NotAction" in x
        senders = [x for x in c_all_statements("CentralRole") if could_send(x)]
        self.assertEqual(len(senders), 1, senders)
        self.assertEqual(senders[0]["Sid"], "SendSyncCommands")
        self.assertEqual(senders[0]["Effect"], "Allow")
        self.assertEqual(senders[0]["Action"], "sqs:SendMessage")
        self.assertEqual(senders[0]["Resource"], {"Fn::GetAtt": "CommandsQueue.Arn"})
        self.assertNotIn("Condition", senders[0])

    def test_remediator_caller_reachable_only_from_central_role(self):
        (st,) = CR["RemediatorCallerRole"]["Properties"]["AssumeRolePolicyDocument"]["Statement"]
        self.assertEqual(st["Principal"], {"AWS": {"Fn::GetAtt": "CentralRole.Arn"}})
        (p,) = c_statements("RemediatorCallerRole")
        self.assertEqual(as_list(p["Action"]), ["sts:AssumeRole"])
        self.assertEqual(p["Resource"], {"Fn::Sub": "arn:${AWS::Partition}:iam::*:role/AlarmOps-Remediator"})

    # ---- Vercel OIDC role (D-49): Global and Team issuer modes; condition-key prefix computed from the provider ARN
    @staticmethod
    def _render_vercel_trust(provider_arn, in_account=True, slug="acme-team", project="alarmops"):
        """Evaluate the Fn::If / Fn::Sub / Select / Split subset used by the trust document and parse the JSON."""
        env = {"VercelOidcProviderArn": provider_arn, "VercelTeamSlug": slug, "VercelProjectName": project}

        def ev(x, local):
            if isinstance(x, str):
                return x
            (k, v), = x.items()
            if k == "Ref":
                return env[v]
            if k == "Fn::If":
                assert v[0] == "VercelProviderInThisAccount"
                return ev(v[1] if in_account else v[2], local)
            if k == "Fn::Split":
                return ev(v[1], local).split(v[0])
            if k == "Fn::Select":
                return ev(v[1], local)[int(v[0])]
            if k == "Fn::Sub":
                tmpl, extra = (v, {}) if isinstance(v, str) else (v[0], {n: ev(e, local) for n, e in v[1].items()})
                scope = {**env, **extra}
                return re.sub(r"\$\{([A-Za-z0-9]+)\}", lambda m: scope[m.group(1)], tmpl)
            raise AssertionError(f"unsupported intrinsic {k}")

        doc = CR["VercelConsoleRole"]["Properties"]["AssumeRolePolicyDocument"]
        return json.loads(ev(doc, {}))

    def test_vercel_provider_arn_pattern_accepts_global_and_team_only(self):
        for pat in (C["Parameters"]["VercelOidcProviderArn"]["AllowedPattern"],
                    BOOT["Parameters"]["VercelOidcProviderArn"]["AllowedPattern"]):
            for ok in ("arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com",
                       "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/acme-team",
                       "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/a1"):
                self.assertRegex(ok, pat)
            for bad in ("arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/",
                        "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/Acme",
                        "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/-a",
                        "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/a/b",
                        "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/a*",
                        "arn:aws:iam::123456789012:oidc-provider/oidc.vercelxcom",
                        "arn:aws:iam::123456789012:oidc-provider/evil.example.com/acme",
                        "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
                        "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/a" + "b" * 63):
                self.assertNotRegex(bad, pat)
        self.assertRegex("", BOOT["Parameters"]["VercelOidcProviderArn"]["AllowedPattern"])
        self.assertNotRegex("", C["Parameters"]["VercelOidcProviderArn"]["AllowedPattern"])

    def test_vercel_trust_is_pinned_to_project_production_and_team_audience(self):
        P = C["Parameters"]
        for n in ("VercelTeamSlug", "VercelProjectName", "VercelOidcProviderArn"):
            self.assertNotIn("Default", P[n])
        for arn, prefix in (
                ("arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/acme-team", "oidc.vercel.com/acme-team"),
                ("arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com", "oidc.vercel.com")):
            with self.subTest(provider=arn):
                doc = self._render_vercel_trust(arn)
                (st,) = doc["Statement"]
                self.assertEqual(doc["Version"], "2012-10-17")
                self.assertEqual(st["Effect"], "Allow")
                self.assertEqual(st["Principal"], {"Federated": arn})
                self.assertEqual(st["Action"], "sts:AssumeRoleWithWebIdentity")
                self.assertEqual(st["Condition"], {"StringEquals": {
                    f"{prefix}:aud": "https://vercel.com/acme-team",
                    f"{prefix}:sub": "owner:acme-team:project:alarmops:environment:production"}})
                self.assertNotIn("*", json.dumps(st))
                self.assertNotIn("StringLike", json.dumps(st))

    def test_vercel_trust_has_no_principal_when_provider_is_in_another_account(self):
        doc = self._render_vercel_trust("arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/acme-team", in_account=False)
        (st,) = doc["Statement"]
        self.assertEqual(st["Principal"], {})
        self.assertEqual(st["Action"], "sts:AssumeRoleWithWebIdentity")

    def test_vercel_role_has_one_permission_plus_optional_scoped_ses(self):
        sts = c_all_statements("VercelConsoleRole")
        send = [s for s in sts if s.get("Sid") == "SendAlarmCommands"]
        self.assertEqual(len(send), 1)
        self.assertEqual(send[0]["Action"], "sqs:SendMessage")
        self.assertEqual(send[0]["Resource"], {"Fn::GetAtt": "CommandsQueue.Arn"})
        others = [s for s in sts if s is not send[0]]
        self.assertEqual(len(others), 1)            # SES, only under the HasSes condition
        ses = others[0]
        self.assertEqual(ses["Action"], "ses:SendEmail")
        self.assertEqual(ses["Resource"], {"Ref": "SesIdentityArn"})
        self.assertIn("ses:FromAddress", ses["Condition"]["StringEquals"])
        (stmt_if,) = [x for p in CR["VercelConsoleRole"]["Properties"]["Policies"]
                      for x in p["PolicyDocument"]["Statement"] if "Fn::If" in x]
        self.assertEqual(stmt_if["Fn::If"][0], "HasSes")
        self.assertEqual(stmt_if["Fn::If"][2], {"Ref": "AWS::NoValue"})
        self.assertEqual(C["Parameters"]["SesIdentityArn"]["Default"], "")
        self.assertIn("SesNeedsFromAddress", C["Rules"])

    # ---- queue policy (security review, hkjs96/alarmops#47)
    def test_commands_queue_policy_shape(self):
        sts = queue_statements("CommandsQueuePolicy")
        vercel = {"Fn::GetAtt": "VercelConsoleRole.Arn"}
        rules = [{"Fn::GetAtt": f"{n}.Arn"} for n in ("TagEventRule", "SyncHourlyRule", "SyncDailyRule")]
        by_repr = lambda xs: sorted(xs, key=repr)
        allow_events = sts["TagEventRuleSend"]
        self.assertEqual(allow_events["Effect"], "Allow")
        self.assertEqual(allow_events["Principal"], {"Service": "events.amazonaws.com"})
        self.assertEqual(allow_events["Action"], "sqs:SendMessage")
        self.assertEqual(list(allow_events["Condition"]), ["ArnEquals"])
        self.assertEqual(list(allow_events["Condition"]["ArnEquals"]), ["aws:SourceArn"])
        self.assertEqual(by_repr(allow_events["Condition"]["ArnEquals"]["aws:SourceArn"]), by_repr(rules))
        deny = sts["DenySendFromOthers"]
        self.assertEqual(deny["Effect"], "Deny")
        self.assertEqual(deny["Action"], "sqs:SendMessage")
        self.assertEqual(list(deny["Condition"]), ["ArnNotEquals"])
        neq = deny["Condition"]["ArnNotEquals"]
        self.assertEqual(sorted(neq), ["aws:PrincipalArn", "aws:SourceArn"])
        self.assertEqual(by_repr(neq["aws:PrincipalArn"]), by_repr([vercel, {"Fn::GetAtt": "CentralRole.Arn"}]))
        self.assertEqual(by_repr(neq["aws:SourceArn"]), by_repr(rules))
        self.assertEqual(by_repr(sts["ConsoleAndEngineSend"]["Principal"]["AWS"]), by_repr([vercel, {"Fn::GetAtt": "CentralRole.Arn"}]))
        self.assertEqual(sts["DenyInsecureTransport"]["Condition"], {"Bool": {"aws:SecureTransport": "false"}})
        # nothing may allow everyone, and no SourceAccount-only trust
        for s in sts.values():
            if s["Effect"] == "Allow":
                self.assertNotEqual(s["Principal"], "*")
                self.assertNotIn("*", str(s["Principal"]))
                self.assertNotIn("aws:SourceAccount", str(s.get("Condition", {})))
        self.assertEqual(sts["DenyReceiveFromOthers"]["Condition"],
                         {"ArnNotEquals": {"aws:PrincipalArn": {"Fn::GetAtt": "CentralRole.Arn"}}})
        self.assertEqual(sorted(as_list(sts["EngineReceiveDelete"]["Action"])),
                         ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"])

    def test_tag_event_rule_pattern_and_dlq(self):
        r = CR["TagEventRule"]["Properties"]
        self.assertEqual(r["EventPattern"]["source"], [{"prefix": "aws."}])
        self.assertEqual(r["EventPattern"]["detail-type"], ["AWS API Call via CloudTrail"])
        self.assertEqual(r["EventBusName"], {"Ref": "CentralBusName"})
        (t,) = r["Targets"]
        self.assertEqual(t["Arn"], {"Fn::GetAtt": "CommandsQueue.Arn"})
        self.assertEqual(t["DeadLetterConfig"], {"Arn": {"Fn::GetAtt": "TagEventsRuleDlq.Arn"}})
        (dp,) = [s for s in queue_statements("TagEventsRuleDlqPolicy").values() if s["Effect"] == "Allow"]
        self.assertEqual(dp["Condition"], {"ArnEquals": {"aws:SourceArn": {"Fn::GetAtt": "TagEventRule.Arn"}}})
        self.assertEqual(dp["Principal"], {"Service": "events.amazonaws.com"})

    def test_queues_standard_sse_with_dlq_and_visibility_6x_timeout(self):
        for q, dlq in (("CommandsQueue", "CommandsDlq"), ("AlertEventsQueue", "AlertEventsDlq")):
            p = CR[q]["Properties"]
            self.assertTrue(p["SqsManagedSseEnabled"])
            self.assertNotIn("FifoQueue", p)
            self.assertEqual(p["RedrivePolicy"]["maxReceiveCount"], 5)
            self.assertTrue(CR[dlq]["Properties"]["SqsManagedSseEnabled"])
        self.assertGreaterEqual(CR["CommandsQueue"]["Properties"]["VisibilityTimeout"],
                                6 * C["Parameters"]["EngineTimeoutSeconds"]["MaxValue"])
        self.assertGreaterEqual(CR["AlertEventsQueue"]["Properties"]["VisibilityTimeout"],
                                6 * CR["AlertConsumerFunction"]["Properties"]["Timeout"])

    # ---- secrets and ingest
    def test_db_secrets_hold_no_value_in_the_template(self):
        for n in ("EngineDbSecret", "IngestDbSecret"):
            props = CR[n]["Properties"]
            self.assertEqual(CR[n]["Type"], "AWS::SecretsManager::Secret")
            for k in ("SecretString", "GenerateSecretString", "SecretStringTemplate"):
                self.assertNotIn(k, props)
        text = (ROOT / "aws" / "central.yaml").read_text(encoding="utf-8")
        self.assertNotIn("{{resolve:", text)

    def test_ingest_functions_least_privilege_and_limits(self):
        for fn in ("IngestWebhookFunction", "IngestEventBridgeFunction", "AlertConsumerFunction"):
            p = CR[fn]["Properties"]
            self.assertIn("ReservedConcurrentExecutions", p, fn)
            (pol,) = p["Policies"]
            acts = {a for s in pol["Statement"] for a in as_list(s["Action"])}
            self.assertEqual(acts, {"sqs:SendMessage", "secretsmanager:GetSecretValue"}, fn)
            self.assertEqual(p["Environment"]["Variables"]["DATABASE_URL_SECRET_ARN"], {"Ref": "IngestDbSecret"})
        c = CR["AlertConsumerFunction"]["Properties"]["Events"]["AlertEvents"]["Properties"]
        self.assertEqual(c["FunctionResponseTypes"], ["ReportBatchItemFailures"])
        self.assertIn("MaximumConcurrency", c["ScalingConfig"])
        self.assertNotIn("Events", CR["IngestEventBridgeFunction"]["Properties"])   # explicit rule, own DLQ

    def test_ingest_rule_has_own_sse_dlq_with_one_rule_policy(self):
        r = CR["IngestAlarmEventsRule"]["Properties"]
        self.assertEqual(r["EventBusName"], {"Ref": "CentralBusName"})
        self.assertEqual(r["EventPattern"]["source"], ["aws.cloudwatch"])
        (t,) = r["Targets"]
        self.assertEqual(t["DeadLetterConfig"], {"Arn": {"Fn::GetAtt": "IngestEventsRuleDlq.Arn"}})
        self.assertTrue(CR["IngestEventsRuleDlq"]["Properties"]["SqsManagedSseEnabled"])
        sts = queue_statements("IngestEventsRuleDlqPolicy")
        self.assertEqual(sts["IngestRuleDeadLetters"]["Condition"],
                         {"ArnEquals": {"aws:SourceArn": {"Fn::GetAtt": "IngestAlarmEventsRule.Arn"}}})
        self.assertEqual(sts["DenyInsecureTransport"]["Effect"], "Deny")
        perm = CR["IngestAlarmEventsInvokePermission"]["Properties"]
        self.assertEqual(perm["SourceArn"], {"Fn::GetAtt": "IngestAlarmEventsRule.Arn"})
        self.assertEqual(perm["Principal"], "events.amazonaws.com")

    def test_external_id_required_on_every_assume_of_a_customer_role(self):
        want = {"Null": {"sts:ExternalId": "false"}}
        (a,) = [s for s in c_statements("CentralRole") if s.get("Sid") == "AssumeCustomerRoles"]
        self.assertEqual(a["Condition"], want)
        (r,) = c_statements("RemediatorCallerRole")
        self.assertEqual(r["Condition"], want)

    def test_remediation_switch_is_enforced_by_iam_and_env(self):
        self.assertEqual(C["Parameters"]["RemediationExecution"]["Default"], "false")
        self.assertEqual(C["Conditions"]["RemediationEnabled"], {"Fn::Equals": [{"Ref": "RemediationExecution"}, "true"]})
        conds = [x["Fn::If"] for p in CR["CentralRole"]["Properties"]["Policies"]
                 for x in p["PolicyDocument"]["Statement"] if "Fn::If" in x]
        (cond,) = conds
        self.assertEqual(cond[0], "RemediationEnabled")
        self.assertEqual(cond[1]["Sid"], "AssumeRemediatorCaller")
        self.assertEqual(cond[2], {"Ref": "AWS::NoValue"})
        env = CR["AlarmEngineFunction"]["Properties"]["Environment"]["Variables"]["REMEDIATOR_CALLER_ROLE_ARN"]
        self.assertEqual(env["Fn::If"][0], "RemediationEnabled")
        self.assertEqual(env["Fn::If"][2], {"Ref": "AWS::NoValue"})

    def test_tag_rule_matches_only_engine_tag_apis_and_successful_calls(self):
        d = CR["TagEventRule"]["Properties"]["EventPattern"]["detail"]
        self.assertEqual(d["errorCode"], [{"exists": False}])
        self.assertEqual(d["eventSource"], [{"suffix": ".amazonaws.com"}])
        self.assertEqual(sorted(d["eventName"]), sorted([
            "CreateTags", "DeleteTags", "AddTagsToResource", "RemoveTagsFromResource", "AddTags", "RemoveTags",
            "TagResource", "UntagResource", "TagResources", "UntagResources", "TagQueue", "UntagQueue"]))
        # same list as the customer stack's forwarding rule
        self.assertEqual(sorted(d["eventName"]), sorted(RES["TagChangeRule"]["Properties"]["EventPattern"]["detail"]["eventName"]))

    def test_dlq_policies(self):
        for pol in ("CommandsDlqPolicy", "AlertEventsDlqPolicy"):
            self.assertEqual(queue_statements(pol)["DenyInsecureTransport"]["Condition"],
                             {"Bool": {"aws:SecureTransport": "false"}})
        deny = queue_statements("CommandsDlqPolicy")["DenyReadFromOthers"]
        self.assertEqual(deny["Effect"], "Deny")
        self.assertEqual(sorted(deny["Action"]),
                         ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"])
        allowed = deny["Condition"]["ArnNotEquals"]["aws:PrincipalArn"]["Fn::If"]
        self.assertEqual(allowed[0], "HasDlqOpsRole")
        self.assertEqual(allowed[1], [{"Fn::GetAtt": "CentralRole.Arn"}, {"Ref": "DlqOpsRoleArn"}])
        self.assertEqual(allowed[2], [{"Fn::GetAtt": "CentralRole.Arn"}])
        self.assertEqual(C["Parameters"]["DlqOpsRoleArn"]["Default"], "")

    def test_alert_events_policy_producers_and_consumer_only(self):
        sts = queue_statements("AlertEventsQueuePolicy")
        roles = [{"Fn::GetAtt": f"{f}Role.Arn"} for f in
                 ("IngestWebhookFunction", "IngestEventBridgeFunction", "AlertConsumerFunction")]
        consumer = {"Fn::GetAtt": "AlertConsumerFunctionRole.Arn"}
        self.assertEqual(sts["ProducersSend"]["Principal"], {"AWS": roles})
        self.assertEqual(sts["ProducersSend"]["Action"], "sqs:SendMessage")
        self.assertEqual(sts["ConsumerReceiveDelete"]["Principal"], {"AWS": consumer})
        self.assertEqual(sts["DenySendFromOthers"]["Condition"], {"ArnNotEquals": {"aws:PrincipalArn": roles}})
        self.assertEqual(sts["DenyReceiveFromOthers"]["Condition"], {"ArnNotEquals": {"aws:PrincipalArn": consumer}})
        for st in sts.values():
            if st["Effect"] == "Allow":
                self.assertNotIn("*", str(st["Principal"]))

    def test_webhook_http_api_throttled_without_access_log(self):
        api = CR["IngestHttpApi"]["Properties"]
        self.assertIn("ThrottlingRateLimit", api["DefaultRouteSettings"])
        self.assertNotIn("AccessLogSettings", api)     # the token may be in the query string
        ev = CR["IngestWebhookFunction"]["Properties"]["Events"]["Webhook"]["Properties"]
        self.assertEqual((ev["Method"], ev["Path"]), ("POST", "/ingest/v1/{source}"))

    def test_outputs_needed_by_console_and_customers(self):
        for o in ("AlarmCommandsQueueUrl", "AlertEventsQueueUrl", "CentralRoleArn", "RemediatorCallerRoleArn",
                  "VercelConsoleRoleArn", "CentralBusArn", "CentralAccountId", "WebhookUrl"):
            self.assertIn(o, C["Outputs"])

    def test_central_side_role_names_stay_out_of_the_customer_prefix(self):
        # AlarmOps-* is what the central role may assume; central-side roles must not match it.
        for n, r in CR.items():
            if r["Type"] == "AWS::IAM::Role":
                self.assertTrue(r["Properties"]["RoleName"].startswith("AlarmOpsCentral-"), n)


WORKFLOWS = ROOT.parent / ".github" / "workflows"


class Workflows(unittest.TestCase):
    def test_every_workflow_parses_as_yaml_with_jobs(self):
        files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
        self.assertTrue(files)
        for f in files:
            wf = yaml.safe_load(f.read_text(encoding="utf-8"))
            self.assertIsInstance(wf, dict, f.name)
            self.assertTrue(wf.get("jobs"), f.name)


import re

SHA_USES = re.compile(r"^[\w.-]+/[\w.-]+(/[\w./-]+)?@[0-9a-f]{40}$")


def all_steps(wf):
    for name, job in wf["jobs"].items():
        for st in job["steps"]:
            yield name, st


class PinnedActions(unittest.TestCase):
    def test_deploy_workflows_pin_actions_to_full_shas(self):
        for fn in ("deploy-central.yml", "deploy-console.yml", "prod-db.yml"):
            wf = yaml.safe_load((WORKFLOWS / fn).read_text(encoding="utf-8"))
            for job, st in all_steps(wf):
                if "uses" in st:
                    self.assertRegex(st["uses"], SHA_USES, f"{fn}:{job}")


def assert_auto_conditions(tc, cond):
    """workflow_run may deploy only after ci succeeded for a push to main of this repository."""
    cond = " ".join(cond.split())
    for needle in (
        "github.event_name == 'workflow_dispatch'",
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_repository.full_name == github.repository",
    ):
        tc.assertIn(needle, cond)


def assert_head_sha_checkouts(tc, wf):
    n = 0
    for name, st in all_steps(wf):
        if str(st.get("uses", "")).startswith("actions/checkout"):
            n += 1
            tc.assertEqual(st["with"]["ref"], "${{ github.event.workflow_run.head_sha || github.sha }}", name)
    tc.assertGreater(n, 0)


def assert_gate_failsafe(tc, run):
    tc.assertIn('"$HEAD_SHA^" "$HEAD_SHA"', run)
    tc.assertIn("deploy=true", run)
    tc.assertIn("fail-safe", run)
    tc.assertIn('"$EVENT" != "workflow_run"', run)


class DeployWorkflow(unittest.TestCase):
    def setUp(self):
        self.text = (WORKFLOWS / "deploy-central.yml").read_text(encoding="utf-8")
        self.wf = yaml.safe_load(self.text)
        self.jobs = self.wf["jobs"]

    def runs(self, job):
        return " ".join(st.get("run", "") for st in self.jobs[job]["steps"])

    def test_triggers_and_workflow_permissions(self):
        wf = self.wf
        on = wf.get("on", wf.get(True))
        self.assertEqual(sorted(on), ["workflow_dispatch", "workflow_run"])
        self.assertEqual(on["workflow_run"], {"workflows": ["ci"], "types": ["completed"], "branches": ["main"]})
        self.assertEqual(wf["permissions"], {"contents": "read"})
        self.assertIn("vars.CENTRAL_DEPLOY_ROLE_ARN", self.text)
        self.assertNotIn("secrets.", self.text)
        self.assertNotIn("AWS_ACCESS_KEY_ID", self.text)
        for name, job in self.jobs.items():
            self.assertIn("github.ref == 'refs/heads/main'", job["if"], name)
        assert_auto_conditions(self, self.jobs["gate"]["if"])
        for name in ("build", "checks"):
            self.assertEqual(self.jobs[name]["needs"], "gate", name)
            self.assertIn("needs.gate.outputs.deploy == 'true'", self.jobs[name]["if"], name)

    def test_gate_paths_and_head_sha_checkout(self):
        assert_head_sha_checkouts(self, self.wf)
        r = " ".join(st.get("run", "") for st in self.jobs["gate"]["steps"])
        for path in ("infra/aws/", "services/", "packages/core/", "deploy-central", "bundle_manifest"):
            self.assertIn(path, r)
        assert_gate_failsafe(self, r)
        self.assertEqual(self.jobs["gate"]["permissions"], {"contents": "read"})
        self.assertNotIn("environment", self.jobs["gate"])
        self.assertEqual(self.wf["concurrency"], {"group": "deploy-central", "cancel-in-progress": False})
        self.assertIn("--no-fail-on-empty-changeset", self.text)
        self.assertIn("environment: central", self.text)

    def test_job_split_and_permissions_per_job(self):
        self.assertEqual(sorted(self.jobs), ["apply", "build", "checks", "gate", "plan"])
        for name in ("gate", "build", "checks"):
            self.assertEqual(self.jobs[name]["permissions"], {"contents": "read"}, name)
            self.assertNotIn("environment", self.jobs[name], name)
        for name in ("plan", "apply"):
            self.assertEqual(self.jobs[name]["permissions"], {"contents": "read", "id-token": "write"}, name)
            self.assertEqual(self.jobs[name]["environment"], "central", name)
        self.assertEqual(sorted(self.jobs["plan"]["needs"]), ["build", "checks"])
        self.assertEqual(sorted(self.jobs["apply"]["needs"]), ["build", "plan"])

    def test_only_build_and_checks_run_package_managers(self):
        for name in ("plan", "apply"):
            r = self.runs(name)
            for bad in ("npm ", "npx ", "pip ", "pip3", "setup-python", "setup-node"):
                self.assertNotIn(bad, r, name)
            for st in self.jobs[name]["steps"]:
                self.assertNotRegex(str(st.get("uses", "")), r"setup-(node|python)", name)
        self.assertIn("npm ci --ignore-scripts", self.runs("build"))
        self.assertIn("--require-hashes -r infra/requirements-ci.txt", self.runs("checks"))
        self.assertNotIn("pip install \"cfn-lint", self.text)

    def test_download_and_verify_before_aws_credentials(self):
        for name in ("plan", "apply"):
            steps = self.jobs[name]["steps"]
            uses = [str(st.get("uses", "")) for st in steps]
            dl = next(i for i, u in enumerate(uses) if u.startswith("actions/download-artifact"))
            cred = next(i for i, u in enumerate(uses) if u.startswith("aws-actions/configure-aws-credentials"))
            self.assertLess(dl, cred, name)
            # a checksum comparison step sits between the download and the credentials
            between = " ".join(st.get("run", "") for st in steps[dl + 1:cred])
            self.assertIn("MANIFEST.sha256", between, name)
            self.assertIn("needs.build.outputs.manifest_sha256", self.text)

    def test_build_fingerprints_right_after_bundling(self):
        steps = self.jobs["build"]["steps"]
        runs = [st.get("run", "") for st in steps]
        i_build = next(i for i, r in enumerate(runs) if "build:lambda" in r)
        i_stage = next(i for i, r in enumerate(runs) if "bundle_manifest.py manifest" in r)
        self.assertEqual(i_stage, i_build + 1)
        i_eng = next(i for i, r in enumerate(runs) if "build:engine-lambda" in r)
        self.assertIn("bundle_manifest.py manifest", runs[i_eng + 1])
        self.assertTrue(any(str(st.get("uses", "")).startswith("actions/upload-artifact") for st in steps))

    def test_two_phase_plan_then_approved_apply(self):
        plan_cmds, apply_cmds = self.runs("plan"), self.runs("apply")
        self.assertIn("--no-execute-changeset", plan_cmds)
        self.assertNotIn("execute-change-set", plan_cmds)
        self.assertIn("starts_with(ResourceChange.ResourceType, 'AWS::IAM')", plan_cmds)
        self.assertIn("execute-change-set", apply_cmds)
        self.assertNotIn("sam deploy", apply_cmds)
        self.assertIn("check-zip", apply_cmds)
        # change set picked by "did not exist before", not by "latest available"
        self.assertIn("comm -13", plan_cmds)
        self.assertNotIn("[-1]", plan_cmds)

    def test_checkout_does_not_persist_credentials(self):
        for name, st in all_steps(self.wf):
            if str(st.get("uses", "")).startswith("actions/checkout"):
                self.assertIs(st["with"]["persist-credentials"], False, name)

    def test_trust_principal_check_runs_right_after_execute_in_apply_only(self):
        steps = self.jobs["apply"]["steps"]
        runs = [st.get("run", "") for st in steps]
        i_exec = next(i for i, r in enumerate(runs) if "execute-change-set" in r)
        i_chk = next(i for i, st in enumerate(steps) if st.get("name") == "Check trust principals")
        i_out = next(i for i, st in enumerate(steps) if "outputs to the job summary" in st.get("name", ""))
        self.assertEqual(i_chk, i_exec + 1)
        self.assertLess(i_chk, i_out)
        run = runs[i_chk]
        self.assertIn("python3 -I .github/scripts/check_trust_principals.py", run)
        for role in ("AlarmOpsCentral-RemediatorCaller", "AlarmOpsCentral-VercelConsole", "AlarmOpsCentral-Engine"):
            self.assertIn(role, run)
        self.assertIn("iam get-role", run)
        self.assertNotIn("update-assume-role-policy", run)
        self.assertEqual(steps[i_chk]["env"], {"PROVIDER": "${{ vars.VERCEL_OIDC_PROVIDER_ARN }}"})
        self.assertNotIn("if", steps[i_chk])          # no `if: always()` / continue-on-error that could hide a failure
        self.assertNotIn("continue-on-error", steps[i_chk])
        self.assertIn("exit \"$rc\"", run)
        self.assertNotIn("check_trust_principals", self.runs("plan"))
        # permissions stay exactly the same: the read is covered by the deploy role's IamReadRoles statement
        self.assertEqual(self.jobs["apply"]["permissions"], {"contents": "read", "id-token": "write"})
        self.assertRegex(self.jobs["gate"]["steps"][-1]["run"], r"check_trust_principals")

    def test_trust_check_roles_are_inside_the_deploy_role_iam_read_scope(self):
        boot = (ROOT / "aws" / "central-bootstrap.yaml").read_text(encoding="utf-8")
        block = boot[boot.index('Sid: "IamReadRoles"'):]
        block = block[:block.index("Sid:", 20)]
        self.assertIn('"iam:GetRole"', block)
        self.assertIn("role/AlarmOpsCentral-*", block)
        central = (ROOT / "aws" / "central.yaml").read_text(encoding="utf-8")
        for role in ("AlarmOpsCentral-RemediatorCaller", "AlarmOpsCentral-VercelConsole", "AlarmOpsCentral-Engine"):
            self.assertIn(f"RoleName: {role}", central)


class DeployConsoleWorkflow(unittest.TestCase):
    def setUp(self):
        self.text = (WORKFLOWS / "deploy-console.yml").read_text(encoding="utf-8")
        self.wf = yaml.safe_load(self.text)

    def test_guards(self):
        wf = self.wf
        on = wf.get("on", wf.get(True))
        self.assertEqual(sorted(on), ["workflow_dispatch", "workflow_run"])
        self.assertEqual(on["workflow_run"], {"workflows": ["ci"], "types": ["completed"], "branches": ["main"]})
        self.assertEqual(wf["permissions"], {"contents": "read"})
        self.assertEqual(list(wf["jobs"]), ["gate", "deploy"])
        gate = wf["jobs"]["gate"]
        assert_auto_conditions(self, gate["if"])
        self.assertEqual(gate["permissions"], {"contents": "read"})
        self.assertNotIn("environment", gate)
        self.assertEqual(wf["jobs"]["deploy"]["needs"], "gate")
        self.assertIn("needs.gate.outputs.deploy == 'true'", wf["jobs"]["deploy"]["if"])
        assert_head_sha_checkouts(self, wf)
        r = " ".join(st.get("run", "") for st in gate["steps"])
        for path in ("apps/", "packages/", "tools/vercel-cli/", "package[^/]*", "deploy-console"):
            self.assertIn(path, r)
        assert_gate_failsafe(self, r)
        self.assertEqual(wf["concurrency"], {"group": "deploy-console", "cancel-in-progress": False})
        job = wf["jobs"]["deploy"]
        self.assertEqual(job["permissions"], {"contents": "read"})
        self.assertEqual(job["environment"], "production")
        self.assertIn("github.ref == 'refs/heads/main'", job["if"])
        for name in ("VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"):
            self.assertIn("secrets." + name, self.text)
        self.assertNotIn("--token", self.text.replace("# ", ""))  # token only as environment variable
        self.assertNotRegex(self.text, r"echo[^\n]*\$\{?VERCEL_TOKEN")

    def test_token_only_on_pull_and_deploy_steps(self):
        for st in self.wf["jobs"]["deploy"]["steps"]:
            has = "VERCEL_TOKEN" in (st.get("env") or {})
            run = st.get("run", "")
            if "pull" in run or "deploy --prebuilt" in run or "settings are present" in st.get("name", ""):
                continue
            self.assertFalse(has, st.get("name", st.get("uses")))

    def test_step_order_and_cleanup(self):
        steps = self.wf["jobs"]["deploy"]["steps"]
        runs = [st.get("run", "") for st in steps]

        def idx(s):
            return next(i for i, r in enumerate(runs) if s in r)

        self.assertLess(idx("npm ci --ignore-scripts"), idx("--prefix tools/vercel-cli"))
        self.assertLess(idx("--prefix tools/vercel-cli"), idx("pull --yes --environment=production"))
        self.assertLess(idx("pull --yes"), idx("check-console-deploy-env.mjs .vercel/.env.production.local"))
        self.assertLess(idx("check-console-deploy-env.mjs"), idx("strip-deploy-env.mjs"))
        self.assertLess(idx("strip-deploy-env.mjs"), idx("build --prod"))
        self.assertLess(idx("build --prod"), idx("deploy --prebuilt --prod"))
        self.assertLess(idx("deploy --prebuilt --prod"), idx("smoke-console.mjs"))
        last = steps[-1]
        self.assertEqual(last.get("if"), "always()")
        self.assertIn("rm -rf .vercel", last["run"])
        self.assertIn("vercel\\.app$", self.text)

    def test_vercel_cli_from_locked_install(self):
        self.assertNotIn("npx", self.text.replace("# ", "").replace("npx does", ""))
        pkg = json.loads((ROOT.parent / "tools" / "vercel-cli" / "package.json").read_text(encoding="utf-8"))
        self.assertRegex(pkg["dependencies"]["vercel"], r"^\d+\.\d+\.\d+$")
        self.assertTrue((ROOT.parent / "tools" / "vercel-cli" / "package-lock.json").is_file())


class ProdDbWorkflow(unittest.TestCase):
    """prod-db.yml: production migrations, by hand, from main, behind a reviewer (issue #65)."""

    def setUp(self):
        self.text = (WORKFLOWS / "prod-db.yml").read_text(encoding="utf-8")
        self.wf = yaml.safe_load(self.text)
        self.job = self.wf["jobs"]["migrate"]
        self.steps = self.job["steps"]

    def idx(self, needle):
        for i, st in enumerate(self.steps):
            if needle in st.get("run", "") or needle in st.get("name", ""):
                return i
        self.fail(f"no step contains {needle!r}")

    def test_manual_main_only_and_own_environment(self):
        on = self.wf.get("on", self.wf.get(True))
        self.assertEqual(list(on), ["workflow_dispatch"])
        self.assertEqual(self.wf["permissions"], {"contents": "read"})
        self.assertEqual(list(self.wf["jobs"]), ["migrate"])
        self.assertIn("github.ref == 'refs/heads/main'", self.job["if"])
        self.assertEqual(self.job["environment"], "production-db")
        self.assertNotEqual(self.job["environment"], "dev")
        self.assertEqual(self.job["permissions"], {"contents": "read"})
        self.assertNotIn("id-token", self.text)
        self.assertEqual(self.wf["env"], {"CHECKPOINT_DISABLE": "1"})

    def test_only_production_secrets_and_never_dev_ones(self):
        used = set(re.findall(r"secrets\.([A-Z_]+)", self.text))
        self.assertEqual(used, {"PROD_DATABASE_URL", "PROD_DIRECT_URL"})
        self.assertNotIn("DEV_", self.text.replace("DEV_DATABASE_URL", "").replace("dev-db", ""))

    def test_never_db_push_never_seed(self):
        runs = " ".join(st.get("run", "") for st in self.steps)
        for bad in ("db push", "db seed", "migrate dev", "migrate reset", "migrate resolve", "tsx", "seed", "--accept-data-loss", "--force-reset"):
            self.assertNotIn(bad, runs)

    def test_mask_first_then_install_without_scripts(self):
        names = [st.get("name", st.get("run", st.get("uses", ""))) for st in self.steps]
        mask = self.idx("mask-db-urls.mjs")
        # nothing before the mask step touches a secret or installs anything
        for st in self.steps[:mask]:
            self.assertNotIn("secrets.", str(st), st)
            self.assertNotIn("npm", st.get("run", ""), st)
            self.assertNotIn("npx", st.get("run", ""), st)
        env = self.steps[mask]["env"]
        self.assertEqual(env["DB_SECRET_PREFIX"], "PROD_")
        self.assertEqual(env["DB_ENVIRONMENT"], "production-db")
        self.assertEqual(env["DB_SETUP_DOC"], "docs/SETUP-PROD-DB.md")
        install = self.idx("npm ci")
        self.assertLess(mask, install)
        self.assertIn("npm ci --ignore-scripts", self.steps[install]["run"])
        self.assertNotIn("env", self.steps[install])
        self.assertNotIn("secrets.", str(self.steps[install]))
        self.assertTrue(names)

    def test_secrets_only_where_needed(self):
        for i, st in enumerate(self.steps):
            uses_secret = "secrets." in str(st)
            if uses_secret:
                self.assertTrue("mask-db-urls.mjs" in st.get("run", "") or "npx prisma" in st.get("run", ""), st)

    def test_order_status_deploy_drift_status(self):
        status_before = self.idx("Status before")
        deploy = self.idx("npx prisma migrate deploy")
        drift = self.idx("check-migration-drift.mjs")
        status_after = self.idx("Status after")
        self.assertLess(self.idx("npm ci"), status_before)
        self.assertLess(status_before, deploy)
        self.assertLess(deploy, drift)
        self.assertLess(drift, status_after)
        self.assertIn("prisma migrate status", self.steps[status_before]["run"])
        self.assertIn("prisma migrate diff", self.steps[drift]["run"])
        self.assertIn("--from-url", self.steps[drift]["run"])

    def test_confirmation_is_a_required_input(self):
        on = self.wf.get("on", self.wf.get(True))
        inp = on["workflow_dispatch"]["inputs"]["confirm"]
        self.assertTrue(inp["required"])
        self.assertIn("migrate-production", self.text)
        self.assertEqual(self.steps[0]["name"], "Check confirmation")


class DbRolesSql(unittest.TestCase):
    """db/sql/roles.sql: no secret in it, the two roles, no grant outside the documented lists."""

    def setUp(self):
        self.sql = (ROOT.parent / "db" / "sql" / "roles.sql").read_text(encoding="utf-8")
        self.code = re.sub(r"--[^\n]*", "", self.sql)

    def test_no_password_in_the_file(self):
        self.assertNotRegex(self.code, r"(?i)password")

    def test_roles_have_bypassrls_and_no_extra_power(self):
        self.assertIn("LOGIN NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT", self.code)
        self.assertIn("rolsuper OR rolreplication", self.code)
        self.assertRegex(self.code, r"RAISE EXCEPTION 'role % has SUPERUSER or REPLICATION")
        self.assertIn("alarmops_engine", self.code)
        self.assertIn("alarmops_ingest", self.code)

    def test_grants_are_small(self):
        grants = re.findall(r"(?is)\bGRANT\b(.*?);", self.code)
        for g in grants:
            self.assertNotRegex(g, r"(?i)ALL PRIVILEGES|\bALL\b(?! TABLES)|TRUNCATE|REFERENCES|(?<!\")TRIGGER(?!\")|\bSEQUENCE|FUNCTION|WITH GRANT OPTION")
        # no table-wide UPDATE anywhere: every UPDATE grant names its columns
        for g in grants:
            if re.search(r"(?i)\bUPDATE\b(?!\s*\()", g):
                self.fail(f"table-wide UPDATE grant: {g.strip()}")
        # RemediationRequest INSERT is column-limited and never names the approval columns
        rr = [g for g in grants if re.search(r'(?i)\bINSERT\b.*"RemediationRequest"', g, re.S)]
        self.assertEqual(len(rr), 1)
        self.assertRegex(rr[0], r"(?i)INSERT\s*\(")
        for col in ("decidedBy", "decidedAt", "decisionVia"):
            self.assertNotIn(col, rr[0])
        # DELETE only on ManagedAlarm, for the engine
        deletes = [g for g in grants if re.search(r"(?i)\bDELETE\b", g)]
        self.assertEqual(len(deletes), 1)
        self.assertRegex(deletes[0], r'"ManagedAlarm" TO alarmops_engine')


class CustomerStackBoundary(unittest.TestCase):
    """D-58: works in organizations that demand a permissions boundary (hkjs96/alarmops#86); role paths are unsupported."""

    def test_parameters_default_to_no_boundary_and_no_role_path_parameter(self):
        P = T["Parameters"]
        self.assertEqual(P["PermissionsBoundaryArn"]["Default"], "")
        self.assertNotIn("RolePath", P)

    def test_boundary_condition_is_false_when_empty(self):
        self.assertEqual(T["Conditions"]["HasPermissionsBoundary"],
                         {"Fn::Not": [{"Fn::Equals": [{"Ref": "PermissionsBoundaryArn"}, ""]}]})

    def test_all_five_roles_use_default_path_and_optional_boundary(self):
        for role in ROLES:
            props = RES[role]["Properties"]
            self.assertNotIn("Path", props, role)  # default "/"; role ARNs are assumed path-less by central and backend
            self.assertEqual(props["PermissionsBoundary"],
                             {"Fn::If": ["HasPermissionsBoundary", {"Ref": "PermissionsBoundaryArn"},
                                         {"Ref": "AWS::NoValue"}]}, role)
            self.assertTrue(props["RoleName"].startswith("AlarmOps-"), role)

    def test_boundary_pattern_accepts_empty_and_any_partition_only_policies(self):
        import re
        pat = re.compile(T["Parameters"]["PermissionsBoundaryArn"]["AllowedPattern"])
        for ok in ("", "arn:aws:iam::444455556666:policy/OrgBoundary", "arn:aws-cn:iam::444455556666:policy/p/Boundary",
                   "arn:aws-us-gov:iam::444455556666:policy/B"):
            self.assertTrue(pat.match(ok), ok)
        for bad in ("arn:aws:iam::444455556666:role/x", "arn:aws:iam::4444:policy/x", "policy/x", "arn:aws:s3:::b"):
            self.assertFalse(pat.match(bad), bad)

    def test_no_hardcoded_partition_anywhere(self):
        import re
        raw = (ROOT / "customer-stack" / "template.yaml").read_text(encoding="utf-8")
        for line in raw.splitlines():
            if "arn:aws:" in line:
                # only free-text examples are allowed to name the aws partition
                self.assertRegex(line.strip(), r"^(ConstraintDescription|Description):", line)
        for name, p in T["Parameters"].items():
            pat = p.get("AllowedPattern", "")
            self.assertNotIn("arn:aws:", pat, name)
            if "arn:" in pat:
                self.assertIn("arn:aws[a-z-]*:", pat, name)

    def test_no_organizations_or_stackset_dependency(self):
        raw = (ROOT / "customer-stack" / "template.yaml").read_text(encoding="utf-8")
        for needle in ("PrincipalOrgID", "PrincipalOrgPaths", "organizations:", "AWS::Organizations",
                       "StackSet", "AWS::ControlTower"):
            self.assertNotIn(needle, raw)


if __name__ == "__main__":
    unittest.main()
