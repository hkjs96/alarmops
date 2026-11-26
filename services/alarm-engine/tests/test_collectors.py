"""Collectors: per-type discovery (botocore Stubber, no AWS), pagination, throttling, per-type failure isolation,
and discovered resources → desired alarms == the 114-row golden table."""

from __future__ import annotations

import pytest

from alarm_engine.collectors import AwsDiscovery, core
from alarm_engine.collectors.groups import GROUP_OF, GROUPS
from alarm_engine.desired import ResourceRef, build_desired
from alarm_engine.engine import DiscoveryError
from alarm_engine.resource_types.base import get, hardcoded_defaults, types
from aws_stubs import ACCOUNT as A
from aws_stubs import EPOCH, GLOBAL, REGION, StubSessions, kv, rgt, tags
from conftest import FakeCloudWatch, make_account

R = REGION
LB_ALB = f"arn:aws:elasticloadbalancing:{R}:{A}:loadbalancer/app/my-alb/50dc6c495c0c9188"
LB_NLB = f"arn:aws:elasticloadbalancing:{R}:{A}:loadbalancer/net/my-nlb/2a3b4c5d6e7f8091"
LB_CLB = f"arn:aws:elasticloadbalancing:{R}:{A}:loadbalancer/legacy-lb"
TG = f"arn:aws:elasticloadbalancing:{R}:{A}:targetgroup/my-tg/73e2d6bc24d8a067"
LBF = ["elasticloadbalancing:loadbalancer"]
RDS_A = f"arn:aws:rds:{R}:{A}:db:db1"
RDS_B = f"arn:aws:rds:{R}:{A}:db:db2"
ECS_C = f"arn:aws:ecs:{R}:{A}:cluster/prod"
T = tags(name="web-1")


def _elb_steps() -> list[tuple]:
    return [
        rgt(R, LBF, [(LB_ALB, T), (LB_NLB, T)]),
        rgt(R, ["elasticloadbalancing:targetgroup"], [(TG, T)]),
        ("elbv2", R, "describe_target_groups",
         {"TargetGroups": [{"TargetGroupArn": TG, "LoadBalancerArns": [LB_NLB], "TargetType": "instance"}]},
         {"TargetGroupArns": [TG]}),
    ]


def _rds_steps(engine: str, cls: str = "db.m5.large", clusters: bool = False) -> list[tuple]:
    inst = {"DBInstanceIdentifier": "db1", "DBInstanceArn": RDS_A, "Engine": engine, "DBInstanceClass": cls,
            "DBInstanceStatus": "available", "DBClusterIdentifier": "c1"}
    steps = [rgt(R, ["rds:db"], [(RDS_A, T)]), ("rds", R, "describe_db_instances", {"DBInstances": [inst]}, None)]
    if clusters:
        steps.append(("rds", R, "describe_db_clusters", {"DBClusters": [{"DBClusterIdentifier": "c1", "DBClusterMembers": [
            {"DBInstanceIdentifier": "db1", "IsClusterWriter": True}, {"DBInstanceIdentifier": "db2", "IsClusterWriter": False}]}]},
            None))
    return steps


def _simple(rtype: str, arn: str, region: str = R) -> list[tuple]:
    return [rgt(region, list(get(rtype).rgt_filters), [(arn, T)])]


def _ec2_inst(iid: str, state: str) -> dict:
    return {"InstanceId": iid, "State": {"Name": state, "Code": 16}, "Tags": kv(T)}


# type → (stub steps, expected key, expected region, expected internal tags)
CASES: dict[str, tuple[list[tuple], str, str, dict[str, str]]] = {
    "EC2": ([("ec2", R, "describe_instances", {"Reservations": [{"Instances": [_ec2_inst("i-0abc", "running"),
                                                                              _ec2_inst("i-dead", "terminated")]}]},
              {"Filters": [{"Name": "tag-key", "Values": ["Monitoring"]}]})], "i-0abc", R, {}),
    "NAT": ([("ec2", R, "describe_nat_gateways", {"NatGateways": [
        {"NatGatewayId": "nat-1", "State": "available", "Tags": kv(T)},
        {"NatGatewayId": "nat-gone", "State": "deleted", "Tags": kv(T)}]},
        {"Filter": [{"Name": "tag-key", "Values": ["Monitoring"]}]})], "nat-1", R, {}),
    "VPN": ([("ec2", R, "describe_vpn_connections", {"VpnConnections": [
        {"VpnConnectionId": "vpn-1", "State": "available", "Tags": kv(T)}]},
        {"Filters": [{"Name": "tag-key", "Values": ["Monitoring"]}]})], "vpn-1", R, {}),
    "RDS": (_rds_steps("mysql"), "db1", R, {}),
    "AuroraRDS": (_rds_steps("aurora-mysql", "db.serverless", clusters=True), "db1", R,
                  {"_is_serverless_v2": "true", "_is_cluster_writer": "true", "_has_readers": "true"}),
    "DocDB": (_rds_steps("docdb"), "db1", R, {}),
    "ALB": (_elb_steps(), LB_ALB, R, {}),
    "NLB": (_elb_steps(), LB_NLB, R, {}),
    "TG": (_elb_steps(), TG, R, {"_lb_arn": LB_NLB, "_lb_type": "network", "_target_type": "instance"}),
    "CLB": ([rgt(R, LBF, [(LB_ALB, T), (LB_CLB, T)])], "legacy-lb", R, {}),
    "ElastiCache": ([rgt(R, ["elasticache:cluster"], [(f"arn:aws:elasticache:{R}:{A}:cluster:redis-1", T),
                                                        (f"arn:aws:elasticache:{R}:{A}:cluster:memc-1", T)]),
                     ("elasticache", R, "describe_cache_clusters", {"CacheClusters": [
                         {"CacheClusterId": "redis-1", "ARN": f"arn:aws:elasticache:{R}:{A}:cluster:redis-1",
                          "Engine": "redis", "CacheClusterStatus": "available"},
                         {"CacheClusterId": "memc-1", "ARN": f"arn:aws:elasticache:{R}:{A}:cluster:memc-1",
                          "Engine": "memcached", "CacheClusterStatus": "available"}]}, None)], "redis-1", R, {}),
    "Lambda": (_simple("Lambda", f"arn:aws:lambda:{R}:{A}:function:fn"), "fn", R, {}),
    "APIGW": ([rgt(R, ["apigateway:restapis", "apigateway:apis"], [(f"arn:aws:apigateway:{R}::/restapis/abc", T),
                                                                  (f"arn:aws:apigateway:{R}::/apis/xyz", T)]),
               ("apigateway", R, "get_rest_apis", {"items": [{"id": "abc", "name": "orders"}, {"id": "zzz", "name": "x"}]},
                {"limit": 500}),
               ("apigatewayv2", R, "get_apis", {"Items": [{"ApiId": "xyz", "ProtocolType": "WEBSOCKET", "Name": "ws", "RouteSelectionExpression": "$request.body.action"}]},
                None)], "orders", R, {"_api_type": "REST"}),
    "ACM": (_simple("ACM", f"arn:aws:acm:{R}:{A}:certificate/uuid-1"), f"arn:aws:acm:{R}:{A}:certificate/uuid-1", R, {}),
    "Backup": (_simple("Backup", f"arn:aws:backup:{R}:{A}:backup-vault:vault-1"), "vault-1", R, {}),
    "MQ": ([rgt(R, ["mq:broker"], [(f"arn:aws:mq:{R}:{A}:broker:orders:b-1234", T)]),
            ("mq", R, "list_brokers", {"BrokerSummaries": [
                {"BrokerId": "b-1234", "EngineType": "ACTIVEMQ", "BrokerState": "RUNNING", "DeploymentMode": "ACTIVE_STANDBY_MULTI_AZ"},
                {"BrokerId": "b-other", "EngineType": "ACTIVEMQ", "BrokerState": "RUNNING", "DeploymentMode": "SINGLE_INSTANCE"}]},
             None)], "orders-1", R, {}),
    "OpenSearch": (_simple("OpenSearch", f"arn:aws:es:{R}:{A}:domain/search-1"), "search-1", R, {"_client_id": A}),
    "SQS": (_simple("SQS", f"arn:aws:sqs:{R}:{A}:jobs"), "jobs", R, {}),
    "ECS": ([("ecs", R, "list_clusters", {"clusterArns": [ECS_C]}, None),
             ("ecs", R, "list_services", {"serviceArns": [f"arn:aws:ecs:{R}:{A}:service/prod/web",
                                                          f"arn:aws:ecs:{R}:{A}:service/prod/untagged"]}, {"cluster": ECS_C}),
             ("ecs", R, "describe_services", {"services": [
                 {"serviceName": "web", "serviceArn": f"arn:aws:ecs:{R}:{A}:service/prod/web", "status": "ACTIVE",
                  "tags": kv(T, lower=True)},
                 {"serviceName": "untagged", "serviceArn": f"arn:aws:ecs:{R}:{A}:service/prod/untagged",
                  "status": "ACTIVE", "tags": []}]},
              {"cluster": ECS_C, "services": [f"arn:aws:ecs:{R}:{A}:service/prod/web",
                                              f"arn:aws:ecs:{R}:{A}:service/prod/untagged"], "include": ["TAGS"]})],
            "web", R, {"_cluster_name": "prod"}),
    "MSK": (_simple("MSK", f"arn:aws:kafka:{R}:{A}:cluster/my-c/uuid-1"), "my-c", R, {}),
    "DynamoDB": (_simple("DynamoDB", f"arn:aws:dynamodb:{R}:{A}:table/orders"), "orders", R, {}),
    "CloudFront": (_simple("CloudFront", f"arn:aws:cloudfront::{A}:distribution/E123", GLOBAL), "E123", GLOBAL, {}),
    "WAF": ([rgt(R, ["wafv2:webacl"], [(f"arn:aws:wafv2:{R}:{A}:regional/webacl/web-acl/uuid-1", T),
                                       (f"arn:aws:wafv2:{GLOBAL}:{A}:global/webacl/cf-acl/uuid-2", T)])],
            "web-acl", R, {"_waf_rule": "ALL", "_waf_region": R}),
    "Route53": (_simple("Route53", "arn:aws:route53:::healthcheck/hc-1", GLOBAL), "hc-1", GLOBAL, {}),
    "DX": ([rgt(R, ["directconnect:dxcon"], [(f"arn:aws:directconnect:{R}:{A}:dxcon/dxcon-abc", T),
                                             (f"arn:aws:directconnect:{R}:{A}:dxcon/dxcon-pending", T)]),
            ("directconnect", R, "describe_connections", {"connections": [
                {"connectionId": "dxcon-abc", "connectionState": "available"},
                {"connectionId": "dxcon-pending", "connectionState": "pending"}]}, None)], "dxcon-abc", R, {}),
    "EFS": (_simple("EFS", f"arn:aws:elasticfilesystem:{R}:{A}:file-system/fs-1"), "fs-1", R, {}),
    "S3": (_simple("S3", "arn:aws:s3:::my-bucket"), "my-bucket", R, {}),
    "SageMaker": ([rgt(R, ["sagemaker:endpoint"], [(f"arn:aws:sagemaker:{R}:{A}:endpoint/ep-1", T)]),
                   ("sagemaker", R, "describe_endpoint", {
                       "EndpointName": "ep-1", "EndpointArn": f"arn:aws:sagemaker:{R}:{A}:endpoint/ep-1",
                       "EndpointConfigName": "cfg", "EndpointStatus": "InService", "CreationTime": EPOCH,
                       "LastModifiedTime": EPOCH, "ProductionVariants": [{"VariantName": "AllTraffic"}]},
                    {"EndpointName": "ep-1"})], "ep-1", R, {"_variant_name": "AllTraffic"}),
    "SNS": (_simple("SNS", f"arn:aws:sns:{R}:{A}:alerts"), "alerts", R, {}),
}


def discover(rtype: str, steps: list[tuple], region: str = R) -> tuple[list, AwsDiscovery, StubSessions]:
    sess = StubSessions()
    for s in steps:
        sess.add(s)
    disc = AwsDiscovery(sess, (GROUP_OF[rtype],))
    out = disc.list_monitored(make_account(), region)
    sess.assert_all_consumed()
    return out, disc, sess


def test_every_type_has_a_collector_and_a_case():
    assert set(CASES) == set(types()) == {t for g in GROUPS for t in g.types}
    assert len(types()) == 29


@pytest.mark.parametrize("rtype", sorted(CASES))
def test_discovery_per_type(rtype):
    steps, key, region, internal = CASES[rtype]
    out, disc, sess = discover(rtype, steps)
    mine = [r for r in out if r.resource_type == rtype]
    assert key in [r.resource_key for r in mine], [r.resource_key for r in out]
    r = next(x for x in mine if x.resource_key == key)
    assert r.region == region and r.tags["Monitoring"] == "on"
    assert {k: v for k, v in r.tags.items() if k.startswith("_")} == internal
    assert r.resource_arn.startswith("arn:aws:")
    assert not disc.take_errors()
    assert set(sess.roles) == {"reader"}          # collectors never touch another role


def test_apigw_and_mq_fan_out():
    out, _, _ = discover("APIGW", CASES["APIGW"][0])
    assert {(r.resource_key, r.tags["_api_type"]) for r in out} == {("orders", "REST"), ("xyz", "WEBSOCKET")}
    out, _, _ = discover("MQ", CASES["MQ"][0])
    assert [r.resource_key for r in out] == ["orders-1", "orders-2"]      # active/standby → two broker instances


# ── pagination ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_tag_getresources_is_paginated():
    f = ["sqs"]
    steps = [rgt(R, f, [(f"arn:aws:sqs:{R}:{A}:q1", T)], token="tok1"),
             rgt(R, f, [(f"arn:aws:sqs:{R}:{A}:q2", T)], token="tok2", params_token="tok1"),
             rgt(R, f, [(f"arn:aws:sqs:{R}:{A}:q3", T)], params_token="tok2")]
    out, _, _ = discover("SQS", steps)
    assert [r.resource_key for r in out] == ["q1", "q2", "q3"]


def test_service_describe_is_paginated_rds_and_ec2():
    arns = [f"arn:aws:rds:{R}:{A}:db:db{i}" for i in (1, 2, 3)]
    inst = lambda i: {"DBInstanceIdentifier": f"db{i}", "DBInstanceArn": arns[i - 1], "Engine": "mysql",  # noqa: E731
                      "DBInstanceStatus": "available"}
    steps = [rgt(R, ["rds:db"], [(a, T) for a in arns]),
             ("rds", R, "describe_db_instances", {"DBInstances": [inst(1)], "Marker": "m1"}, None),
             ("rds", R, "describe_db_instances", {"DBInstances": [inst(2), inst(3)]}, {"Marker": "m1"})]
    out, _, _ = discover("RDS", steps)
    assert [r.resource_key for r in out] == ["db1", "db2", "db3"]

    f = {"Filters": [{"Name": "tag-key", "Values": ["Monitoring"]}]}
    steps = [("ec2", R, "describe_instances", {"Reservations": [{"Instances": [_ec2_inst("i-1", "running")]}],
                                               "NextToken": "n1"}, f),
             ("ec2", R, "describe_instances", {"Reservations": [{"Instances": [_ec2_inst("i-2", "stopped")]}]},
              {**f, "NextToken": "n1"})]
    out, _, _ = discover("EC2", steps)
    assert [r.resource_key for r in out] == ["i-1", "i-2"]


def test_elb_target_groups_paginated_with_next_marker():
    steps = _elb_steps()[:2] + [
        ("elbv2", R, "describe_target_groups", {"TargetGroups": [], "NextMarker": "x"}, {"TargetGroupArns": [TG]}),
        ("elbv2", R, "describe_target_groups",
         {"TargetGroups": [{"TargetGroupArn": TG, "LoadBalancerArns": [LB_ALB], "TargetType": "ip"}]},
         {"TargetGroupArns": [TG], "Marker": "x"})]
    out, _, _ = discover("TG", steps)
    tg = [r for r in out if r.resource_type == "TG"][0]
    assert tg.tags["_lb_type"] == "application" and tg.tags["_target_type"] == "ip"


# ── throttling ───────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def no_sleep(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr(core, "_sleep", slept.append)
    return slept


def test_throttling_is_retried_then_succeeds(no_sleep):
    steps = [("resourcegroupstaggingapi", R, "get_resources", "ThrottlingException"),
             ("resourcegroupstaggingapi", R, "get_resources", "TooManyRequestsException"),
             rgt(R, ["sqs"], [(f"arn:aws:sqs:{R}:{A}:q1", T)])]
    out, disc, _ = discover("SQS", steps)
    assert [r.resource_key for r in out] == ["q1"] and len(no_sleep) == 2 and all(0 < s <= 8 for s in no_sleep)


def test_throttling_is_bounded_and_recorded(no_sleep):
    sess = StubSessions()
    for _ in range(core.MAX_ATTEMPTS):
        sess.add(("resourcegroupstaggingapi", R, "get_resources", "ThrottlingException"))
    sess.add(rgt(R, ["sqs"], [(f"arn:aws:sqs:{R}:{A}:q1", T)]))      # sns group's call below must not be reached
    disc = AwsDiscovery(sess, (GROUP_OF["SQS"], GROUP_OF["SNS"]))
    # SQS exhausts its 5 attempts; SNS then makes its own (different filter) call and gets the 6th stub: params differ
    # → the stubber raises, which is also a recorded per-type error, so both fail → run-level DiscoveryError.
    with pytest.raises(DiscoveryError):
        disc.list_monitored(make_account(), R)
    assert len(no_sleep) == core.MAX_ATTEMPTS - 1
    assert set(disc.take_errors()) == {(R, "SQS"), (R, "SNS")}


def test_non_throttle_error_is_not_retried(no_sleep):
    sess = StubSessions()
    sess.add(("resourcegroupstaggingapi", R, "get_resources", "AccessDeniedException"))
    sess.add(rgt(R, ["sns"], [(f"arn:aws:sns:{R}:{A}:alerts", T)]))
    disc = AwsDiscovery(sess, (GROUP_OF["SQS"], GROUP_OF["SNS"]))
    out = disc.list_monitored(make_account(), R)
    assert [r.resource_key for r in out] == ["alerts"] and no_sleep == []


# ── failure isolation ────────────────────────────────────────────────────────────────────────────────────────────

def test_a_failing_type_does_not_stop_the_others():
    sess = StubSessions()
    sess.add(("ec2", R, "describe_instances", "UnauthorizedOperation"))                          # EC2 fails
    sess.add(rgt(R, ["lambda:function"], [(f"arn:aws:lambda:{R}:{A}:function:fn", T)]))          # Lambda works
    sess.add(("apigateway", R, "get_rest_apis", "AccessDeniedException"))                       # APIGW: no apigateway:GET
    sess.add(rgt(R, ["apigateway:restapis", "apigateway:apis"], [(f"arn:aws:apigateway:{R}::/restapis/abc", T)]))
    disc = AwsDiscovery(sess, (GROUP_OF["EC2"], GROUP_OF["Lambda"], GROUP_OF["APIGW"]))
    out = disc.list_monitored(make_account(), R)
    assert [(r.resource_type, r.resource_key) for r in out] == [("Lambda", "fn")]
    errs = disc.take_errors()
    assert set(errs) == {(R, "EC2"), (R, "APIGW")} and errs[(R, "EC2")] == "UnauthorizedOperation"
    assert disc.take_errors() == {}       # taken once


def test_all_types_failing_is_a_failed_run_not_zero_resources():
    sess = StubSessions()
    sess.add(("ec2", R, "describe_instances", "AuthFailure"))
    sess.add(("ec2", R, "describe_nat_gateways", "AuthFailure"))
    disc = AwsDiscovery(sess, (GROUP_OF["EC2"], GROUP_OF["NAT"]))
    with pytest.raises(DiscoveryError):
        disc.list_monitored(make_account(), R)


def test_global_types_listed_once_per_account_against_us_east_1():
    acct = make_account(regions=(R, "us-west-2"))
    sess = StubSessions()
    sess.add(rgt(GLOBAL, ["cloudfront:distribution"], [(f"arn:aws:cloudfront::{A}:distribution/E1", T)]))
    sess.add(rgt("us-west-2", ["sqs"], []))
    disc = AwsDiscovery(sess, (GROUP_OF["CloudFront"], GROUP_OF["SQS"]))
    first = disc.list_monitored(acct, R)
    assert [(r.resource_type, r.region) for r in first] == [("CloudFront", GLOBAL)]
    # (SQS in R has no stub → recorded error, CloudFront kept)
    assert (R, "SQS") in disc.take_errors()
    disc.list_monitored(acct, "us-west-2")                    # second region: only SQS runs, CloudFront is not asked again
    sess.assert_all_consumed()


# ── read_tags / alive ────────────────────────────────────────────────────────────────────────────────────────────

def _row(rtype: str, key: str, arn: str, region: str = R, tg: dict | None = None):
    from alarm_engine.repository import ResourceRow
    return ResourceRow("res_1", "cus_1", "acc_1", region, rtype, arn, key, tags=tg or {})


def test_read_tags_keeps_internal_tags_and_reports_removal():
    arn = f"arn:aws:elasticloadbalancing:{R}:{A}:targetgroup/my-tg/1"
    sess = StubSessions()
    sess.add(("resourcegroupstaggingapi", R, "get_resources",
              {"ResourceTagMappingList": [{"ResourceARN": arn, "Tags": [{"Key": "Team", "Value": "a"}]}],
               "PaginationToken": ""}, {"ResourceARNList": [arn]}))
    t = AwsDiscovery(sess).read_tags(make_account(), _row("TG", arn, arn, tg={"Monitoring": "on", "_lb_arn": "x"}))
    assert t == {"Team": "a", "_lb_arn": "x"}               # Monitoring gone → the engine makes it NEEDS_REVIEW
    sess.add(("resourcegroupstaggingapi", R, "get_resources", "AccessDeniedException"))
    assert AwsDiscovery(sess).read_tags(make_account(), _row("TG", arn, arn)) is None


@pytest.mark.parametrize("rtype,steps,keys,want", [
    ("EC2", [("ec2", R, "describe_instances", "InvalidInstanceID.NotFound", {"InstanceIds": ["i-1"]})], ["i-1"], False),
    ("EC2", [("ec2", R, "describe_instances", {"Reservations": [{"Instances": [_ec2_inst("i-1", "running")]}]},
              {"InstanceIds": ["i-1"]})], ["i-1"], True),
    ("EC2", [("ec2", R, "describe_instances", "UnauthorizedOperation", {"InstanceIds": ["i-1"]})], ["i-1"], None),
    ("RDS", [("rds", R, "describe_db_instances", "DBInstanceNotFound", {"DBInstanceIdentifier": "db1"})], ["db1"], False),
    ("DynamoDB", [("dynamodb", R, "describe_table", "ResourceNotFoundException", {"TableName": "t"})], ["t"], False),
    ("SQS", [("sqs", R, "list_queues", {"QueueUrls": [f"https://sqs.{R}.amazonaws.com/{A}/q1"]}, None),
            ("sqs", R, "get_queue_url", "QueueDoesNotExist", {"QueueName": "q2"})], ["q1", "q2"], None),
    ("Lambda", [], ["fn"], None),                              # no Lambda list API in the Reader role → unknown
])
def test_alive_probes(rtype, steps, keys, want):
    sess = StubSessions()
    for s in steps:
        sess.add(s)
    res = AwsDiscovery(sess).alive(make_account(), R, rtype, keys)
    if rtype == "SQS":
        assert res == {"q1": True, "q2": False}
    else:
        assert res == {keys[0]: want}


# ── discovered resources → desired alarms == golden table ────────────────────────────────────────────────────────

def _cw_with_disk(iid: str) -> FakeCloudWatch:
    cw = FakeCloudWatch(A, R)
    cw.metrics = [{"Namespace": "CWAgent", "MetricName": "disk_used_percent",
                   "Dimensions": [{"Name": "InstanceId", "Value": iid}, {"Name": "path", "Value": "/"},
                                  {"Name": "device", "Value": "xvda1"}, {"Name": "fstype", "Value": "xfs"}]}]
    return cw


#: defined in the ported spec but never selected by `_get_aurora_alarm_defs` (its docstring: excluded for Serverless v2)
DEAD_DEFINITIONS = {("AuroraRDS", "ServerlessDatabaseCapacity")}


def test_discovered_resources_produce_exactly_the_golden_alarms():
    from test_golden_alarm_rules import table_rows
    expected = {(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[8], r[9], r[10], r[11]) for r in table_rows()}
    got: set[tuple] = set()
    for rtype, (steps, _key, _region, _internal) in CASES.items():
        out, _, _ = discover(rtype, [s for s in steps])
        d = next(r for r in out if r.resource_type == rtype)
        spec = get(rtype)
        for variant in spec.variants or ({},):
            varying = {k for v in (spec.variants or ({},)) for k in v}
            tg = {**{k: v for k, v in d.tags.items() if k not in varying}, **variant}
            ref = ResourceRef(rtype, d.resource_key, d.region, A, tg)
            ds = build_desired(ref, _cw_with_disk(d.resource_key))
            for a in ds.alarms:
                key = "disk_used_percent" if a.metric_key.startswith("Disk_") else a.metric_key
                thr = a.threshold / 1024 ** 3 if _transformed(rtype, key) else a.threshold
                sym = {"GreaterThanThreshold": ">", "GreaterThanOrEqualToThreshold": ">=",
                       "LessThanThreshold": "<", "LessThanOrEqualToThreshold": "<="}[a.comparison]
                ns = a.namespace.replace("NetworkELB", "ApplicationELB") if rtype == "TG" else a.namespace  # table lists ALB ns
                dp = a.datapoints_to_alarm or a.evaluation_periods
                if any(k.startswith("Threshold_") for k in variant):     # opt-in tag value is the threshold; table = default
                    thr = hardcoded_defaults()[key]
                got.add((rtype, key, f"{ns}/{a.metric_name}", a.statistic, a.period, sym, round(thr, 6),
                         _transformed(rtype, key), f"{dp}/{a.evaluation_periods}", a.severity, a.treat_missing_data))
    expected = {(*e[:6], round(e[6], 6), *e[7:]) for e in expected if e[:2] not in DEAD_DEFINITIONS}
    # the table's namespace for NLB target groups etc. is whatever the type's builder resolves; compare without it too
    missing, extra = expected - got, got - expected
    assert not missing and not extra, f"in table, not produced: {sorted(missing)}\nproduced, not in table: {sorted(extra)}"


def _transformed(rtype: str, key: str) -> bool:
    return any("transform_threshold" in d for v in (get(rtype).variants or ({},)) for d in get(rtype).alarms(v)
               if (d.get("metric_key") or d["metric"]) == key)


def test_keys_are_the_dimension_values_alarms_will_use():
    """Spot check the dimension each discovered key becomes (what a wrong key would silently break)."""
    from alarm_engine.dimensions import build_dimensions
    steps, key, _, _ = CASES["TG"]
    out, _, _ = discover("TG", steps)
    tg = next(r for r in out if r.resource_type == "TG")
    d = get("TG").alarms(tg.tags)[0]
    dims = build_dimensions(d, tg.resource_key, "TG", tg.tags, R)
    assert dims == [{"Name": "TargetGroup", "Value": "targetgroup/my-tg/73e2d6bc24d8a067"},
                    {"Name": "LoadBalancer", "Value": "net/my-nlb/2a3b4c5d6e7f8091"}]


# ── bounded pagination (never truncate) ──────────────────────────────────────────────────────────────────────────

def test_repeated_pagination_token_raises_instead_of_truncating():
    f = ["sqs"]
    steps = [rgt(R, f, [(f"arn:aws:sqs:{R}:{A}:q1", T)], token="same"),
             rgt(R, f, [(f"arn:aws:sqs:{R}:{A}:q2", T)], token="same", params_token="same")]
    sess = StubSessions()
    for s in steps:
        sess.add(s)
    disc = AwsDiscovery(sess, (GROUP_OF["SQS"],))
    with pytest.raises(DiscoveryError):                   # the only group failed -> failed run, no partial list
        disc.list_monitored(make_account(), R)
    assert disc.take_errors() == {(R, "SQS"): "PaginationError"}


def test_page_limit_raises(monkeypatch):
    monkeypatch.setattr(core, "MAX_PAGES", 3)
    calls = []

    def fn(**kw):
        calls.append(kw)
        return {"Items": [1], "NextToken": f"t{len(calls)}"}
    with pytest.raises(core.PaginationError):
        core.pages(fn, "Items")
    assert len(calls) == 3


def test_cloudfront_and_route53_marker_loops_are_bounded():
    for rtype, svc, op, resp in (
            ("CloudFront", "cloudfront", "list_distributions", {"DistributionList": {"Marker": "", "MaxItems": 1,
                                                                                    "IsTruncated": True, "Quantity": 0,
                                                                                    "NextMarker": "m"}}),
            ("Route53", "route53", "list_health_checks", {"HealthChecks": [], "Marker": "", "IsTruncated": True,
                                                         "NextMarker": "m", "MaxItems": "1"})):
        sess = StubSessions()
        sess.add((svc, GLOBAL, op, resp))
        sess.add((svc, GLOBAL, op, resp, {"Marker": "m"}))
        # repeated NextMarker "m": the probe must not loop; unknown (None), never a truncated "gone"
        assert AwsDiscovery(sess).alive(make_account(), GLOBAL, rtype, ["x"]) == {"x": None}


def test_stored_type_errors_contain_codes_only():
    sess = StubSessions()
    sess.add(("ec2", R, "describe_instances", "UnauthorizedOperation"))
    sess.add(rgt(R, ["sqs"], []))
    disc = AwsDiscovery(sess, (GROUP_OF["EC2"], GROUP_OF["SQS"]))
    disc.list_monitored(make_account(), R)
    assert disc.take_errors() == {(R, "EC2"): "UnauthorizedOperation"}
