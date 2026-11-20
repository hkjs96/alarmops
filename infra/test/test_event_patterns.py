"""TagChangeRule / AlarmStateRule event patterns (#89): a small EventBridge matcher plus sample CloudTrail events.

The matcher implements only what the template uses: exact string, `prefix`, `exists`, `$or`, nested objects, and the
EventBridge rule that an array in the event matches if any element matches. Run:  python -m unittest discover -s infra/test -v
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from test_templates import RES


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
ALARM = RES["AlarmStateRule"]["Properties"]["EventPattern"]


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


class AlarmStatePattern(unittest.TestCase):
    def test_all_alarm_state_changes_still_forwarded(self):
        """Not narrowed on purpose (README: central ingests customer-owned alarms too)."""
        ev = {"source": "aws.cloudwatch", "detail-type": "CloudWatch Alarm State Change", "detail": {"alarmName": "customer-own-alarm"}}
        self.assertTrue(match_obj(ALARM, ev))
        ev["detail"]["alarmName"] = "[EC2] web CPU (TagName: i-1)"
        self.assertTrue(match_obj(ALARM, ev))


if __name__ == "__main__":
    unittest.main()
