"""TagChangeRule / AlarmStateRule event patterns (#89): a small EventBridge matcher plus sample CloudTrail events.

The matcher implements only what the template uses: exact string, `prefix`, `exists`, `$or`, nested objects, and the
EventBridge rule that an array in the event matches if any element matches. Run:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from test_templates import RES, T


def _leaf(rule, value) -> bool:
    if isinstance(rule, dict):
        if "prefix" in rule:
            return isinstance(value, str) and value.startswith(rule["prefix"])
        if rule.get("exists") is True:
            return True      # reached only when the key is present (see match_obj)
        raise NotImplementedError(rule)
    return value == rule


def match_obj(pattern: dict, event) -> bool:
    if isinstance(event, list):                      # arrays: any element matches
        return any(match_obj(pattern, e) for e in event)
    if not isinstance(event, dict):
        return False
    for key, sub in pattern.items():
        if key == "$or":
            if not any(match_obj(b, event) for b in sub):
                return False
            continue
        if key not in event:
            return False
        if isinstance(sub, dict):
            if not match_obj(sub, event[key]):
                return False
        else:                                        # list of leaf matchers
            vals = event[key] if isinstance(event[key], list) else [event[key]]
            if not any(_leaf(r, v) for r in sub for v in vals):
                return False
    return True


TAG = RES["TagChangeRule"]["Properties"]["EventPattern"]
_IF = RES["AlarmStateRule"]["Properties"]["EventPattern"]["Fn::If"]
assert _IF[0] == "AlarmScopeManagedPrefix"
ALARM_PREFIX, ALARM = _IF[1], _IF[2]       # AlarmScope=managed-prefix, AlarmScope=all (default)


def ct(name: str, params, source: str = "aws.ec2") -> dict:
    return {"source": source, "detail-type": "AWS API Call via CloudTrail",
            "detail": {"eventName": name, "requestParameters": params}}


def kv(*keys: str, k: str = "key") -> list[dict]:
    return [{k: x, "value": "v"} for x in keys]


MATCH = {
    "ec2 CreateTags Monitoring": ct("CreateTags", {"resourcesSet": {"items": [{"resourceId": "i-1"}]}, "tagSet": {"items": kv("Name", "Monitoring")}}),
    "ec2 DeleteTags Monitoring": ct("DeleteTags", {"resourcesSet": {"items": [{"resourceId": "i-1"}]}, "tagSet": {"items": [{"key": "Monitoring"}]}}),
    "ec2 CreateTags Threshold_": ct("CreateTags", {"tagSet": {"items": kv("Threshold_CPU")}}),
    "rds AddTagsToResource": ct("AddTagsToResource", {"resourceName": "arn:aws:rds:x", "tags": kv("Monitoring")}, "aws.rds"),
    "rds RemoveTagsFromResource": ct("RemoveTagsFromResource", {"resourceName": "arn", "tagKeys": ["Env", "Monitoring"]}, "aws.rds"),
    "elbv2 AddTags": ct("AddTags", {"resourceArns": ["arn"], "tags": kv("Monitoring")}, "aws.elasticloadbalancing"),
    "clb RemoveTags (tags[].key)": ct("RemoveTags", {"loadBalancerNames": ["x"], "tags": [{"key": "Monitoring"}]}, "aws.elasticloadbalancing"),
    "elbv2 RemoveTags tagKeys": ct("RemoveTags", {"resourceArns": ["arn"], "tagKeys": ["Threshold_Latency"]}, "aws.elasticloadbalancing"),
    "es AddTags tagList": ct("AddTags", {"aRN": "arn", "tagList": kv("Monitoring")}, "aws.es"),
    "capitalised TagList[].Key": ct("AddTags", {"TagList": [{"Key": "Threshold_X", "Value": "1"}]}, "aws.x"),
    "lambda TagResource map": ct("TagResource", {"resource": "arn", "tags": {"Monitoring": "on", "Env": "p"}}, "aws.lambda"),
    "sqs TagQueue map": ct("TagQueue", {"queueUrl": "u", "tags": {"Monitoring": "on"}}, "aws.sqs"),
    "lambda UntagResource": ct("UntagResource", {"resource": "arn", "tagKeys": ["Monitoring"]}, "aws.lambda"),
    "sqs UntagQueue": ct("UntagQueue", {"queueUrl": "u", "tagKeys": ["Monitoring"]}, "aws.sqs"),
    "TagResources map Monitoring": ct("TagResources", {"resourceARNList": ["arn"], "tags": {"Monitoring": "on"}}, "aws.tagging"),
    "UntagResources": ct("UntagResources", {"resourceARNList": ["arn"], "tagKeys": ["Monitoring"]}, "aws.tagging"),
    "sns TagResource list": ct("TagResource", {"resourceArn": "arn", "tags": kv("Monitoring")}, "aws.sns"),
}

NO_MATCH = {
    # `Tags` (capital T) is not a name alarm_engine.events.extract reads, so the engine would drop it anyway.
    "capitalised Tags[].Key (engine cannot read it)": ct("TagResource", {"resourceArn": "arn", "Tags": [{"Key": "Monitoring", "Value": "on"}]}, "aws.sagemaker"),
    "ec2 CreateTags other keys (Terraform default_tags)": ct("CreateTags", {"tagSet": {"items": kv("Name", "Env", "Owner", "ManagedBy")}}),
    "rds AddTags other keys": ct("AddTagsToResource", {"resourceName": "arn", "tags": kv("Team")}, "aws.rds"),
    "rds RemoveTags other keys": ct("RemoveTagsFromResource", {"resourceName": "arn", "tagKeys": ["Team"]}, "aws.rds"),
    "lambda TagResource map other keys": ct("TagResource", {"resource": "arn", "tags": {"Env": "p", "Monitoring2": "x"}}, "aws.lambda"),
    "key lookalike not prefix": ct("CreateTags", {"tagSet": {"items": kv("MyThreshold_CPU", "monitoring")}}),
    "UntagResource other keys": ct("UntagResource", {"resource": "arn", "tagKeys": ["Env"]}, "aws.lambda"),
    "non tag event with Monitoring": ct("RunInstances", {"tagSet": {"items": kv("Monitoring")}}),
    "no requestParameters": ct("CreateTags", None),
    "not CloudTrail": {"detail-type": "EC2 Instance State-change Notification", "detail": {"eventName": "CreateTags", "requestParameters": {"tagSet": {"items": kv("Monitoring")}}}},
}


class TagChangePattern(unittest.TestCase):
    def test_matches(self):
        for name, ev in MATCH.items():
            with self.subTest(name):
                self.assertTrue(match_obj(TAG, ev))

    def test_no_match(self):
        for name, ev in NO_MATCH.items():
            with self.subTest(name):
                self.assertFalse(match_obj(TAG, ev))

    def test_pattern_size_under_eventbridge_limit(self):
        self.assertLess(len(json.dumps(TAG)), 4096)

    def test_event_names_equal_engine_tag_events(self):
        """Every eventName the engine accepts (events.TAG_EVENTS) is in the rule, and nothing else."""
        src = (Path(__file__).resolve().parents[2] / "services/alarm-engine/src/alarm_engine/events.py").read_text(encoding="utf-8")
        engine = set(re.findall(r'"(\w+)"', src.split("TAG_EVENTS = frozenset({")[1].split("})")[0]))
        self.assertEqual(engine, set(TAG["detail"]["eventName"]))


def alarm_ev(name: str, detail_type: str = "CloudWatch Alarm State Change", source: str = "aws.cloudwatch") -> dict:
    return {"source": source, "detail-type": detail_type, "detail": {"alarmName": name}}


class AlarmStatePattern(unittest.TestCase):
    OWN = ["[EC2] web CPU (TagName: i-1)", "[AuroraRDS] db ACUUtilization (TagName: x)", "[WAF] acl BlockedRequests (TagName: y)"]
    CUSTOMER = ["customer-own-alarm", "AlarmOps-legacy", "[Unknown] x", "[EC2]no-space", "ec2 [EC2] x", "[ec2] lower"]

    def test_all_forwards_everything(self):
        for n in self.OWN + self.CUSTOMER:
            with self.subTest(n):
                self.assertTrue(match_obj(ALARM, alarm_ev(n)))

    def test_managed_prefix_forwards_only_alarmops_names(self):
        for n in self.OWN:
            with self.subTest(n):
                self.assertTrue(match_obj(ALARM_PREFIX, alarm_ev(n)))
        for n in self.CUSTOMER:
            with self.subTest(n):
                self.assertFalse(match_obj(ALARM_PREFIX, alarm_ev(n)))

    def test_other_events_never_match(self):
        for pat in (ALARM, ALARM_PREFIX):
            self.assertFalse(match_obj(pat, alarm_ev("[EC2] x", "CloudWatch Alarm Configuration Change")))
            self.assertFalse(match_obj(pat, alarm_ev("[EC2] x", source="aws.ec2")))

    def test_prefixes_cover_the_29_engine_types(self):
        root = Path(__file__).resolve().parents[2] / "services/alarm-engine/src/alarm_engine/resource_types"
        types = set()
        for f in root.glob("*.py"):
            types |= set(re.findall(r'^\s+type="([^"]+)"', f.read_text(encoding="utf-8"), re.M))
        got = {r["prefix"] for r in ALARM_PREFIX["detail"]["alarmName"]}
        self.assertEqual(len(types), 29)
        self.assertEqual(got, {f"[{t}] " for t in types})

    def test_size_limit(self):
        for pat in (ALARM, ALARM_PREFIX):
            self.assertLess(len(json.dumps(pat)), 4096)

    def test_parameter(self):
        p = T["Parameters"]["AlarmScope"]
        self.assertEqual(p["Default"], "all")
        self.assertEqual(p["AllowedValues"], ["all", "managed-prefix"])


if __name__ == "__main__":
    unittest.main()
