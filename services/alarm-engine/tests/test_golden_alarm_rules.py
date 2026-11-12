"""Golden: every row of docs/specs/alarm-rules.md §3 (114 rows) matches the ported definitions, and vice versa."""

from __future__ import annotations

import importlib
import re
from collections import Counter
from pathlib import Path

import pytest

from alarm_engine.registry import _apply_eval_policy, get_severity
from alarm_engine.resource_types.base import all_specs, hardcoded_defaults, metric_display

SPEC = Path(__file__).resolve().parents[3] / "docs" / "specs" / "alarm-rules.md"
MODULE_OF = {"EC2": "ec2", "RDS": "rds", "ALB": "alb", "NLB": "nlb", "TG": "tg", "AuroraRDS": "aurora_rds",
             "DocDB": "docdb", "ElastiCache": "elasticache", "NAT": "nat", "Lambda": "lambda_fn", "VPN": "vpn",
             "APIGW": "apigw", "ACM": "acm", "Backup": "backup", "MQ": "mq", "CLB": "clb", "OpenSearch": "opensearch",
             "SQS": "sqs", "ECS": "ecs", "MSK": "msk", "DynamoDB": "dynamodb", "CloudFront": "cloudfront", "WAF": "waf",
             "Route53": "route53", "DX": "dx", "EFS": "efs", "S3": "s3", "SageMaker": "sagemaker", "SNS": "sns"}
DIR = {"GreaterThanThreshold": ">", "GreaterThanOrEqualToThreshold": ">=", "LessThanThreshold": "<",
       "LessThanOrEqualToThreshold": "<="}


def table_rows() -> list[tuple]:
    rows = []
    in_table = False
    for line in SPEC.read_text(encoding="utf-8").splitlines():
        if line.startswith("| 타입 | 키 |"):
            in_table = True
            continue
        if in_table:
            if not line.startswith("|"):
                break
            if line.startswith("|---"):
                continue
            c = [x.strip() for x in line.strip("|").split("|")]
            rtype, key, nsm, stat, period, thr, unit, mn, sev, tmd = c[:10]
            key = key.strip("`")
            m = re.match(r"(>=|<=|>|<)\s*([\d.]+)", thr)
            assert m, line
            tmd_v = ("notBreaching" if "미지정" in tmd else tmd.split("·")[0].strip())
            rows.append((rtype, key, nsm, stat, int(period), m.group(1), float(m.group(2)),
                         unit.replace(" (GB→bytes)", "").strip(), "(GB→bytes)" in unit, mn, sev, tmd_v,
                         "옵트인" in tmd))
    return rows


def module_defs(rtype: str) -> list[dict]:
    """Every alarm-def dict defined at module level (lists or single dicts), like the spec table was built."""
    mod = importlib.import_module(f"alarm_engine.resource_types.{MODULE_OF[rtype]}")
    out: list[dict] = []
    seen: set[int] = set()
    for v in vars(mod).values():
        cands = v if isinstance(v, list) else [v] if isinstance(v, dict) else []
        for d in cands:
            if isinstance(d, dict) and "metric" in d and "namespace" in d and id(d) not in seen:
                seen.add(id(d))
                out.append(d)
    return out


def code_rows() -> list[tuple]:
    disp, dflt = metric_display(), hardcoded_defaults()
    rows = []
    for rtype in MODULE_OF:
        for d in module_defs(rtype):
            key = d.get("metric_key") or d["metric"]
            e = _apply_eval_policy([d])[0]
            mn = f"{e.get('datapoints_to_alarm', e['evaluation_periods'])}/{e['evaluation_periods']}"
            rows.append((rtype, key, f"{d['namespace']}/{d['metric_name']}", d["stat"], d["period"],
                         DIR[d["comparison"]], float(dflt[key]), disp[key][2], "transform_threshold" in d, mn,
                         get_severity(key), d.get("treat_missing_data", "notBreaching"), bool(d.get("opt_in"))))
    return rows


def test_table_has_114_rows():
    assert len(table_rows()) == 114


def test_29_types_registered():
    assert sorted(s.type for s in all_specs()) == sorted(MODULE_OF)


def test_table_equals_code():
    t, c = Counter(table_rows()), Counter(code_rows())
    assert t - c == Counter(), f"in table, not in code: {sorted(t - c)}"
    assert c - t == Counter(), f"in code, not in table: {sorted(c - t)}"


@pytest.mark.parametrize("rtype", sorted(MODULE_OF))
def test_every_type_has_rows(rtype):
    assert any(r[0] == rtype for r in table_rows())
