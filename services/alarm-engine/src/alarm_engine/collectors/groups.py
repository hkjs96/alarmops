"""The 29 resource types as collector groups (types that share a listing call share a group, like AAM's collectors).

Discovery is tag-first: `tag:GetResources` (Monitoring key) gives ARN + tags; service Describe/List calls add what
`desired.py`/`dimensions.py` need (engine, cluster, load balancer, variant, state, ...). EC2-family types use the
server-side tag filter (`tag-key=Monitoring`). Lambda has no Describe at all (Reader has no lambda:List*, secrets).

`exists` answers "is this resource really gone?" for the engine's D-16 logic: True / False / None (unknown → the engine
changes nothing). Types whose describe is not in the Reader role return None.

Row `region`: the resource region; CloudFront/Route53 (global) use us-east-1 where their metrics live.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from botocore.exceptions import ClientError

from alarm_engine.collectors.core import (
    Ctx,
    call,
    chunks,
    error_code,
    found,
    marker_pages,
    pages,
    tag_dict,
)
from alarm_engine.engine import DiscoveredResource
from alarm_engine.resource_types import base as rt

Collect = Callable[[Ctx], list[DiscoveredResource]]
Exists = Callable[[Ctx, list[str]], dict[str, bool | None]]
MON = {"Name": "tag-key", "Values": ["Monitoring"]}


@dataclass(frozen=True)
class Group:
    name: str
    types: tuple[str, ...]
    collect: Collect
    exists: Exists | None = None
    global_region: str = ""


def _tail(sep: str) -> Callable[[str], str]:
    return rt.arn_tail(sep)


def _probe(keys: list[str], fn: Callable[[str], bool | None], missing: tuple[str, ...]) -> dict[str, bool | None]:
    out: dict[str, bool | None] = {}
    for k in keys:
        try:
            out[k] = fn(k)
        except ClientError as e:
            out[k] = False if error_code(e) in missing else None
        except Exception:  # noqa: BLE001 — unknown, never "gone"
            out[k] = None
    return out


def _in_set(keys: list[str], names: Callable[[], set[str]]) -> dict[str, bool | None]:
    try:
        have = names()
    except Exception:  # noqa: BLE001
        return {k: None for k in keys}
    return {k: k in have for k in keys}


# ── generic tag-first group (identity from the type spec) ─────────────────────────────────────────────────────────

def _simple(rtype: str, ident: Callable[[str], str] | None = None) -> Collect:
    spec = rt.get(rtype)
    fn = ident or spec.identity
    assert fn is not None, rtype

    def collect(ctx: Ctx) -> list[DiscoveredResource]:
        return [found(rtype, fn(arn), arn, ctx.region, tags) for arn, tags in ctx.rgt(spec.rgt_filters)]
    return collect


# ── EC2 family: server-side tag filter ───────────────────────────────────────────────────────────────────────────

def _ec2(ctx: Ctx) -> list[DiscoveredResource]:
    out = []
    for res in pages(ctx.client("ec2").describe_instances, "Reservations", Filters=[MON]):
        for i in res.get("Instances", []):
            if i.get("State", {}).get("Name") in ("terminated", "shutting-down"):
                continue
            iid = i["InstanceId"]
            out.append(found("EC2", iid, f"arn:{ctx.partition}:ec2:{ctx.region}:{ctx.account.aws_account_id}:instance/{iid}",
                             ctx.region, tag_dict(i.get("Tags"))))
    return out


def _ec2_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        r = call(ctx.client("ec2").describe_instances, InstanceIds=[k])
        states = [i.get("State", {}).get("Name") for x in r.get("Reservations", []) for i in x.get("Instances", [])]
        return bool(states) and not all(s in ("terminated",) for s in states)
    return _probe(keys, one, ("InvalidInstanceID.NotFound",))


def _nat(ctx: Ctx) -> list[DiscoveredResource]:
    out = []
    for n in pages(ctx.client("ec2").describe_nat_gateways, "NatGateways", Filter=[MON]):
        if n.get("State") not in ("pending", "available"):
            continue
        nid = n["NatGatewayId"]
        out.append(found("NAT", nid, f"arn:{ctx.partition}:ec2:{ctx.region}:{ctx.account.aws_account_id}:natgateway/{nid}",
                         ctx.region, tag_dict(n.get("Tags"))))
    return out


def _nat_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        r = call(ctx.client("ec2").describe_nat_gateways, NatGatewayIds=[k])
        return any(n.get("State") not in ("deleted", "deleting", "failed") for n in r.get("NatGateways", []))
    return _probe(keys, one, ("NatGatewayNotFound",))


def _vpn(ctx: Ctx) -> list[DiscoveredResource]:
    out = []
    r = call(ctx.client("ec2").describe_vpn_connections, Filters=[MON])     # not paginated by the API
    for v in r.get("VpnConnections", []):
        if v.get("State") not in ("pending", "available"):
            continue
        vid = v["VpnConnectionId"]
        out.append(found("VPN", vid, f"arn:{ctx.partition}:ec2:{ctx.region}:{ctx.account.aws_account_id}:vpn-connection/{vid}",
                         ctx.region, tag_dict(v.get("Tags"))))
    return out


def _vpn_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        r = call(ctx.client("ec2").describe_vpn_connections, VpnConnectionIds=[k])
        return any(v.get("State") not in ("deleted", "deleting") for v in r.get("VpnConnections", []))
    return _probe(keys, one, ("InvalidVpnConnectionID.NotFound",))


# ── RDS / Aurora / DocDB ─────────────────────────────────────────────────────────────────────────────────────────

def _rds(ctx: Ctx) -> list[DiscoveredResource]:
    tagged = dict(ctx.rgt(("rds:db",)))
    if not tagged:
        return []
    rds = ctx.client("rds")
    by_arn = {i["DBInstanceArn"]: i for i in pages(rds.describe_db_instances, "DBInstances", "Marker")}
    members: dict[str, dict[str, bool]] | None = None
    out = []
    for arn, tags in tagged.items():
        i = by_arn.get(arn)
        if i is None or i.get("DBInstanceStatus") in ("deleting",):
            continue
        key, engine = i["DBInstanceIdentifier"], str(i.get("Engine", ""))
        if engine == "docdb":
            out.append(found("DocDB", key, arn, ctx.region, tags))
        elif engine.startswith("aurora"):
            if members is None:
                members = {c["DBClusterIdentifier"]: {m["DBInstanceIdentifier"]: bool(m.get("IsClusterWriter"))
                                                      for m in c.get("DBClusterMembers", [])}
                           for c in pages(rds.describe_db_clusters, "DBClusters", "Marker")}
            cluster = members.get(i.get("DBClusterIdentifier", ""), {})
            is_writer = cluster.get(key, False)
            out.append(found("AuroraRDS", key, arn, ctx.region, tags,
                             _is_serverless_v2=str(i.get("DBInstanceClass") == "db.serverless").lower(),
                             _is_cluster_writer=str(is_writer).lower(),
                             _has_readers=str(any(not w for w in cluster.values())).lower()))
        elif engine != "neptune":
            out.append(found("RDS", key, arn, ctx.region, tags))
    return out


def _rds_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        r = call(ctx.client("rds").describe_db_instances, DBInstanceIdentifier=k)
        return any(i.get("DBInstanceStatus") != "deleting" for i in r.get("DBInstances", []))
    return _probe(keys, one, ("DBInstanceNotFound",))


# ── Load balancers ───────────────────────────────────────────────────────────────────────────────────────────────

LB = ("elasticloadbalancing:loadbalancer",)
TGF = ("elasticloadbalancing:targetgroup",)


def _lb_kind(arn: str) -> str:
    tail = arn.split("loadbalancer/", 1)[-1]
    return {"app": "ALB", "net": "NLB", "gwy": "GWLB"}.get(tail.split("/", 1)[0], "CLB") if "/" in tail else "CLB"


def _elb(ctx: Ctx) -> list[DiscoveredResource]:
    out = [found(k, arn, arn, ctx.region, tags) for arn, tags in ctx.rgt(LB) if (k := _lb_kind(arn)) in ("ALB", "NLB")]
    tgs = dict(ctx.rgt(TGF))
    if tgs:
        elb = ctx.client("elbv2")
        for batch in chunks(list(tgs), 20):
            for g in pages(elb.describe_target_groups, "TargetGroups", "Marker", "NextMarker", TargetGroupArns=batch):
                lbs = g.get("LoadBalancerArns") or []
                if not lbs:
                    continue    # not attached to any LB: no LoadBalancer dimension, no alarm (legacy)
                out.append(found("TG", g["TargetGroupArn"], g["TargetGroupArn"], ctx.region, tgs[g["TargetGroupArn"]],
                                 _lb_arn=lbs[0], _lb_type="network" if "/net/" in lbs[0] else "application",
                                 _target_type=str(g.get("TargetType", "instance"))))
    return out


def _elb_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    elb = ctx.client("elbv2")

    def one(k: str) -> bool:
        if ":targetgroup/" in k:
            return bool(call(elb.describe_target_groups, TargetGroupArns=[k]).get("TargetGroups"))
        return bool(call(elb.describe_load_balancers, LoadBalancerArns=[k]).get("LoadBalancers"))
    return _probe(keys, one, ("LoadBalancerNotFound", "TargetGroupNotFound"))


def _clb(ctx: Ctx) -> list[DiscoveredResource]:
    return [found("CLB", arn.split("loadbalancer/", 1)[-1], arn, ctx.region, tags)
            for arn, tags in ctx.rgt(LB) if _lb_kind(arn) == "CLB"]


def _clb_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        return bool(call(ctx.client("elb").describe_load_balancers, LoadBalancerNames=[k]).get("LoadBalancerDescriptions"))
    return _probe(keys, one, ("LoadBalancerNotFound",))


# ── ElastiCache / ECS / DynamoDB / ... ───────────────────────────────────────────────────────────────────────────

def _elasticache(ctx: Ctx) -> list[DiscoveredResource]:
    tagged = dict(ctx.rgt(("elasticache:cluster",)))
    if not tagged:
        return []
    out = []
    for c in pages(ctx.client("elasticache").describe_cache_clusters, "CacheClusters", "Marker"):
        arn = c.get("ARN", "")
        if arn not in tagged or c.get("Engine") not in ("redis", "valkey") \
                or c.get("CacheClusterStatus") in ("deleting", "deleted"):
            continue
        out.append(found("ElastiCache", c["CacheClusterId"], arn, ctx.region, tagged[arn]))
    return out


def _elasticache_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        r = call(ctx.client("elasticache").describe_cache_clusters, CacheClusterId=k)
        return any(c.get("CacheClusterStatus") not in ("deleting", "deleted") for c in r.get("CacheClusters", []))
    return _probe(keys, one, ("CacheClusterNotFound",))


def _ecs_services(ctx: Ctx) -> list[tuple[str, dict]]:
    ecs = ctx.client("ecs")
    out: list[tuple[str, dict]] = []
    for cl in pages(ecs.list_clusters, "clusterArns", "nextToken"):
        arns = pages(ecs.list_services, "serviceArns", "nextToken", cluster=cl)
        for batch in chunks(arns, 10):
            r = call(ecs.describe_services, cluster=cl, services=batch, include=["TAGS"])
            out += [(cl, s) for s in r.get("services", [])]
    return out


def _ecs(ctx: Ctx) -> list[DiscoveredResource]:
    out: dict[str, DiscoveredResource] = {}
    for cl, s in _ecs_services(ctx):
        tags = tag_dict(s.get("tags"))
        if "Monitoring" not in tags or s.get("status") != "ACTIVE":
            continue
        name = s["serviceName"]
        # ServiceName is the dimension value; the same name in two clusters would collide on one row (legacy limit).
        out.setdefault(name, found("ECS", name, s["serviceArn"], ctx.region, tags, _cluster_name=cl.rsplit("/", 1)[-1]))
    return list(out.values())


def _ecs_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    return _in_set(keys, lambda: {s["serviceName"] for _, s in _ecs_services(ctx) if s.get("status") == "ACTIVE"})


def _dynamodb_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        return call(ctx.client("dynamodb").describe_table, TableName=k).get("Table", {}).get("TableStatus") != "DELETING"
    return _probe(keys, one, ("ResourceNotFoundException",))


def _sqs_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    """ListQueues is only a hint: a queue missing from the list is "gone" only if GetQueueUrl also says it does not
    exist (D-16 fail-safe: one list result must never delete alarms). Any other answer is unknown (None)."""
    listed = _in_set(keys, lambda: {u.rsplit("/", 1)[-1] for u in pages(ctx.client("sqs").list_queues, "QueueUrls")})
    missing = [k for k, v in listed.items() if v is False]
    if not missing:
        return listed
    confirmed = _probe(missing, lambda k: bool(call(ctx.client("sqs").get_queue_url, QueueName=k).get("QueueUrl")),
                       ("QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue"))
    return {k: (confirmed[k] if k in confirmed else v) for k, v in listed.items()}


def _sns_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    return _in_set(keys, lambda: {t["TopicArn"].rsplit(":", 1)[-1] for t in pages(ctx.client("sns").list_topics, "Topics")})


def _msk_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    return _in_set(keys, lambda: {c["ClusterName"] for c in pages(ctx.client("kafka").list_clusters_v2, "ClusterInfoList")
                                  if c.get("State") != "DELETING"})


def _s3_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    return _in_set(keys, lambda: {b["Name"] for b in pages(ctx.client("s3").list_buckets, "Buckets", "ContinuationToken")})


def _cloudfront_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def names() -> set[str]:
        items = marker_pages(ctx.client("cloudfront").list_distributions,
                             lambda r: (r.get("DistributionList", {}).get("Items", []),
                                        r.get("DistributionList", {}).get("NextMarker")), "Marker")
        return {d["Id"] for d in items}
    return _in_set(keys, names)


def _route53_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def names() -> set[str]:
        items = marker_pages(ctx.client("route53").list_health_checks,
                             lambda r: (r.get("HealthChecks", []), r.get("NextMarker") if r.get("IsTruncated") else None),
                             "Marker")
        return {h["Id"] for h in items}
    return _in_set(keys, names)


def _opensearch(ctx: Ctx) -> list[DiscoveredResource]:
    return [found("OpenSearch", arn.rsplit("/", 1)[-1], arn, ctx.region, tags, _client_id=arn.split(":")[4])
            for arn, tags in ctx.rgt(("es:domain",))]


def _opensearch_exists(ctx: Ctx, keys: list[str]) -> dict[str, bool | None]:
    def one(k: str) -> bool:
        st = call(ctx.client("es").describe_domain, DomainName=k).get("DomainStatus", {})
        return not st.get("Deleted", False)
    return _probe(keys, one, ("ResourceNotFoundException",))


# ── Needs describe calls the Reader role does not have yet (see README "Reader permissions") ────────────────────────

def _apigw(ctx: Ctx) -> list[DiscoveredResource]:
    tagged = dict(ctx.rgt(("apigateway:restapis", "apigateway:apis")))
    rest_ids = {a.rsplit("/", 1)[-1]: a for a in tagged if "/restapis/" in a}
    http_ids = {a.rsplit("/", 1)[-1]: a for a in tagged if "/apis/" in a}
    out = []
    if rest_ids:      # REST dimension = ApiName
        for api in pages(ctx.client("apigateway").get_rest_apis, "items", "position", limit=500):
            if api["id"] in rest_ids:
                arn = rest_ids[api["id"]]
                out.append(found("APIGW", api["name"], arn, ctx.region, tagged[arn], _api_type="REST"))
    if http_ids:      # HTTP/WebSocket dimension = ApiId
        for api in pages(ctx.client("apigatewayv2").get_apis, "Items", "NextToken"):
            if api["ApiId"] in http_ids:
                arn = http_ids[api["ApiId"]]
                out.append(found("APIGW", api["ApiId"], arn, ctx.region, tagged[arn],
                                 _api_type=str(api.get("ProtocolType", "HTTP"))))
    return out


def _mq(ctx: Ctx) -> list[DiscoveredResource]:
    tagged = {a.split(":")[7] if a.count(":") >= 7 else "": (a, t) for a, t in ctx.rgt(("mq:broker",))}
    if not tagged:
        return []
    out = []
    # ListBrokers summaries carry BrokerState and DeploymentMode; DescribeBroker (user lists) is never called.
    for b in pages(ctx.client("mq").list_brokers, "BrokerSummaries", "NextToken"):
        hit = tagged.get(b.get("BrokerId", ""))
        if hit is None or b.get("BrokerState") == "DELETION_IN_PROGRESS":
            continue
        arn, tg = hit
        name = arn.split(":")[6]
        n = 1 if b.get("DeploymentMode") == "SINGLE_INSTANCE" else 2
        out += [found("MQ", f"{name}-{i}", arn, ctx.region, tg) for i in range(1, n + 1)]
    return out


def _sagemaker(ctx: Ctx) -> list[DiscoveredResource]:
    out = []
    for arn, tags in ctx.rgt(("sagemaker:endpoint",)):
        name = arn.rsplit("/", 1)[-1]
        d = call(ctx.client("sagemaker").describe_endpoint, EndpointName=name)
        if d.get("EndpointStatus") != "InService":
            continue
        variants = d.get("ProductionVariants") or []
        extra = {"_variant_name": variants[0]["VariantName"]} if variants else {}
        out.append(found("SageMaker", name, arn, ctx.region, tags, **extra))
    return out


def _dx(ctx: Ctx) -> list[DiscoveredResource]:
    tagged = dict(ctx.rgt(("directconnect:dxcon",)))
    if not tagged:
        return []
    states = {c["connectionId"]: c.get("connectionState")
              for c in call(ctx.client("directconnect").describe_connections).get("connections", [])}
    return [found("DX", arn.rsplit("/", 1)[-1], arn, ctx.region, tags)
            for arn, tags in tagged.items() if states.get(arn.rsplit("/", 1)[-1]) == "available"]


def _waf(ctx: Ctx) -> list[DiscoveredResource]:
    out = []
    for arn, tags in ctx.rgt(("wafv2:webacl",)):
        res = arn.split(":", 5)[-1].split("/")              # regional/webacl/NAME/ID
        if res[0] != "regional" or len(res) < 3:
            continue                                         # CLOUDFRONT scope not collected (legacy)
        out.append(found("WAF", res[2], arn, ctx.region, tags, _waf_rule="ALL", _waf_region=ctx.region))
    return out


def _s3(ctx: Ctx) -> list[DiscoveredResource]:
    return [found("S3", _tail(":")(arn), arn, ctx.region, tags) for arn, tags in ctx.rgt(("s3",))]


GLOBAL = "us-east-1"
GROUPS: tuple[Group, ...] = (
    Group("ec2", ("EC2",), _ec2, _ec2_exists),
    Group("natgw", ("NAT",), _nat, _nat_exists),
    Group("vpn", ("VPN",), _vpn, _vpn_exists),
    Group("rds", ("RDS", "AuroraRDS", "DocDB"), _rds, _rds_exists),
    Group("elb", ("ALB", "NLB", "TG"), _elb, _elb_exists),
    Group("clb", ("CLB",), _clb, _clb_exists),
    Group("elasticache", ("ElastiCache",), _elasticache, _elasticache_exists),
    Group("lambda", ("Lambda",), _simple("Lambda")),
    Group("apigw", ("APIGW",), _apigw),
    Group("acm", ("ACM",), _simple("ACM", lambda arn: arn)),   # dimension CertificateArn
    Group("backup", ("Backup",), _simple("Backup")),
    Group("mq", ("MQ",), _mq),
    Group("opensearch", ("OpenSearch",), _opensearch, _opensearch_exists),
    Group("sqs", ("SQS",), _simple("SQS"), _sqs_exists),
    Group("ecs", ("ECS",), _ecs, _ecs_exists),
    Group("msk", ("MSK",), _simple("MSK"), _msk_exists),
    Group("dynamodb", ("DynamoDB",), _simple("DynamoDB"), _dynamodb_exists),
    Group("cloudfront", ("CloudFront",), _simple("CloudFront", _tail("/")), _cloudfront_exists, GLOBAL),
    Group("waf", ("WAF",), _waf),
    Group("route53", ("Route53",), _simple("Route53", _tail("/")), _route53_exists, GLOBAL),
    Group("dx", ("DX",), _dx),
    Group("efs", ("EFS",), _simple("EFS")),
    Group("s3", ("S3",), _s3, _s3_exists),
    Group("sagemaker", ("SageMaker",), _sagemaker),
    Group("sns", ("SNS",), _simple("SNS"), _sns_exists),
)

GROUP_OF: dict[str, Group] = {t: g for g in GROUPS for t in g.types}


def _check() -> None:
    types = {t for g in GROUPS for t in g.types}
    missing = set(rt.types()) - types
    if missing:
        raise RuntimeError(f"no collector for {sorted(missing)}")


_check()
