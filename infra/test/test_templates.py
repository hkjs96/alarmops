"""Structural tests of the CloudFormation templates (offline; cfn-lint covers syntax, this covers D-07 rules).

Run from the repo root:  python -m unittest discover -s infra/test -v
Needs only PyYAML (installed with cfn-lint).
"""

from __future__ import annotations

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
        self.assertEqual(RES["AlarmStateRule"]["Properties"]["EventPattern"]["detail-type"],
                         ["CloudWatch Alarm State Change"])

    def test_reader_has_no_write_and_denies_secrets(self):
        allowed = [a for s in statements("ReaderRole") if s["Effect"] == "Allow" for a in as_list(s["Action"])]
        for a in allowed:
            verb = a.split(":")[1]
            self.assertTrue(verb.startswith(("Describe", "List", "Get")), a)
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


class CommandsQueue(unittest.TestCase):
    def test_queue_hardening(self):
        Q = _load(ROOT / "aws" / "alarm-commands-queue.yaml")
        r = Q["Resources"]
        self.assertTrue(r["CommandsQueue"]["Properties"]["SqsManagedSseEnabled"])
        self.assertFalse(r["CommandsQueue"]["Properties"].get("FifoQueue", False))
        self.assertIn("RedrivePolicy", r["CommandsQueue"]["Properties"])
        sts = r["CommandsQueuePolicy"]["Properties"]["PolicyDocument"]["Statement"]
        text = str(sts)
        self.assertIn("aws:SecureTransport", text)
        self.assertIn("ConsoleSenderRoleArn", text)
        self.assertIn("EngineRoleArn", text)
        self.assertIn("aws:PrincipalArn", text)
        self.assertEqual(r["DlqNotEmptyAlarm"]["Type"], "AWS::CloudWatch::Alarm")


if __name__ == "__main__":
    unittest.main()
