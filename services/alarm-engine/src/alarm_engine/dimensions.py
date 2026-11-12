"""CloudWatch dimensions — ported from aws-alert-manager `backend/common/dimension_builder.py` @4eafce9.

Changes: no default boto3 client anywhere — every `list_metrics` goes to the client the caller passes (the customer
account's Reader session; known-bugs 4-2). The WAF `Region` dimension falls back to the resource region, not the Lambda
`AWS_REGION` (known-bugs 4-3).
"""

from __future__ import annotations

import logging
from typing import Any

from botocore.exceptions import ClientError

from alarm_engine.registry import _DIMENSION_KEY_MAP, _NAMESPACE_MAP

logger = logging.getLogger(__name__)


def extract_elb_dimension(elb_arn: str) -> str:
    parts = elb_arn.split("loadbalancer/", 1)
    if len(parts) == 2:
        return parts[1]
    parts = elb_arn.split(":targetgroup/", 1)
    if len(parts) == 2:
        return "targetgroup/" + parts[1]
    return elb_arn


def build_dimensions(alarm_def: dict, resource_id: str, resource_type: str, resource_tags: dict,
                     region: str = "ap-northeast-2") -> list[dict]:
    dim_key = alarm_def["dimension_key"]
    if resource_type == "TG":
        dims = [{"Name": "TargetGroup", "Value": extract_elb_dimension(resource_id)},
                {"Name": "LoadBalancer", "Value": extract_elb_dimension(resource_tags["_lb_arn"])}]
    elif resource_type in ("ALB", "NLB"):
        dims = [{"Name": dim_key, "Value": extract_elb_dimension(resource_id)}]
    elif resource_type == "ECS":
        dims = [{"Name": "ServiceName", "Value": resource_id}]
        if resource_tags.get("_cluster_name"):
            dims.append({"Name": "ClusterName", "Value": resource_tags["_cluster_name"]})
    elif resource_type == "WAF":
        dims = [{"Name": "WebACL", "Value": resource_id},
                {"Name": "Rule", "Value": resource_tags.get("_waf_rule", "ALL")},
                {"Name": "Region", "Value": resource_tags.get("_waf_region", region)}]
    elif resource_type == "S3":
        dims = [{"Name": "BucketName", "Value": resource_id}]
        if alarm_def.get("needs_storage_type"):
            dims.append({"Name": "StorageType", "Value": resource_tags.get("_storage_type", "StandardStorage")})
        else:
            dims.append({"Name": "FilterId", "Value": resource_tags.get("_filter_id", "EntireBucket")})
    elif resource_type == "SageMaker":
        dims = [{"Name": "EndpointName", "Value": resource_id}]
        if resource_tags.get("_variant_name"):
            dims.append({"Name": "VariantName", "Value": resource_tags["_variant_name"]})
    elif resource_type == "APIGW":
        name = "ApiId" if resource_tags.get("_api_type") in ("HTTP", "WEBSOCKET") else "ApiName"
        dims = [{"Name": name, "Value": resource_id}]
    elif resource_type == "CloudFront":
        dims = [{"Name": dim_key, "Value": resource_id}, {"Name": "Region", "Value": "Global"}]
    else:
        dims = [{"Name": dim_key, "Value": resource_id}]
    if resource_type == "OpenSearch" and resource_tags.get("_client_id"):
        dims.append({"Name": "ClientId", "Value": resource_tags["_client_id"]})
    dims.extend(alarm_def.get("extra_dimensions", []))
    return dims


def resolve_namespace(alarm_def: dict, resource_type: str, resource_tags: dict) -> str:
    if resource_type == "TG" and resource_tags.get("_lb_type") == "network":
        return "AWS/NetworkELB"
    return str(alarm_def["namespace"])


def select_best_dimensions(metrics: list[dict], primary_dim_key: str) -> list[dict]:
    if not metrics:
        return []
    for m in metrics:
        dims = m["Dimensions"]
        if len(dims) == 1 and dims[0]["Name"] == primary_dim_key:
            return list(dims)
    no_az: list[list[dict]] = [m["Dimensions"] for m in metrics if not any(d["Name"] == "AvailabilityZone" for d in m["Dimensions"])]
    if no_az:
        best: list[dict] = min(no_az, key=len)
        return list(best)
    all_dims: list[list[dict]] = [m["Dimensions"] for m in metrics]
    smallest: list[dict] = min(all_dims, key=len)
    return list(smallest)


def _list_metrics_all(cw: Any, **kw: Any) -> list[dict]:
    """Paginated (known-bugs 4-7)."""
    out: list[dict] = []
    token = None
    while True:
        resp = cw.list_metrics(**kw, **({"NextToken": token} if token else {}))
        out.extend(resp.get("Metrics", []))
        token = resp.get("NextToken")
        if not token:
            return out


def resolve_metric_dimensions(cw: Any, resource_id: str, metric_name: str, resource_type: str,
                              resource_tags: dict | None = None) -> tuple[str, list[dict]] | None:
    tags = resource_tags or {}
    dim_key = _DIMENSION_KEY_MAP.get(resource_type, "")
    if resource_type == "APIGW" and tags.get("_api_type") in ("HTTP", "WEBSOCKET"):
        dim_key = "ApiId"
    dim_value = extract_elb_dimension(resource_id) if resource_type in ("ALB", "NLB", "TG") else resource_id
    for ns in _NAMESPACE_MAP.get(resource_type, []):
        try:
            metrics = _list_metrics_all(cw, Namespace=ns, MetricName=metric_name,
                                        Dimensions=[{"Name": dim_key, "Value": dim_value}])
        except ClientError as e:
            logger.error("list_metrics %s/%s (%s): %s", ns, metric_name, resource_id, e)
            continue
        if metrics:
            return ns, select_best_dimensions(metrics, dim_key)
    return None


EXCLUDED_DEFAULT_DISK_PATHS = {"/boot", "/boot/efi"}
PSEUDO_FSTYPES = frozenset({
    "tmpfs", "devtmpfs", "ramfs", "overlay", "squashfs", "proc", "sysfs", "cgroup", "cgroup2", "efivarfs",
    "autofs", "nsfs", "tracefs", "debugfs", "securityfs", "fuse.lxcfs",
})
PSEUDO_PATH_ROOTS = ("/run", "/dev", "/sys", "/proc")
DISK_DIM_KEYS = {"InstanceId", "device", "fstype", "path"}


class DiskLookupError(Exception):
    """list_metrics failed — callers must treat this as 'unknown', not 'no disks' (no delete/recreate on it)."""


def is_default_disk_path(path: str, explicit_paths: set[str], fstype: str = "") -> bool:
    if path in explicit_paths or path == "/":
        return True
    if path in EXCLUDED_DEFAULT_DISK_PATHS or path.startswith("/boot/"):
        return False
    if fstype in PSEUDO_FSTYPES:
        return False
    if any(path == r or path.startswith(r + "/") for r in PSEUDO_PATH_ROOTS):
        return False
    return not explicit_paths


def get_disk_dimensions(cw: Any, instance_id: str, extra_paths: set[str] | None = None) -> list[list[dict]]:
    """CWAgent disk_used_percent dimension sets for the instance (customer client). [] = agent not reporting."""
    target = set(extra_paths or [])
    try:
        metrics = _list_metrics_all(cw, Namespace="CWAgent", MetricName="disk_used_percent",
                                    Dimensions=[{"Name": "InstanceId", "Value": instance_id}])
    except ClientError as e:
        raise DiskLookupError(str(e)) from e
    seen: set[str] = set()
    out: list[list[dict]] = []
    for m in metrics:
        path = next((d["Value"] for d in m["Dimensions"] if d["Name"] == "path"), None)
        fstype = next((d["Value"] for d in m["Dimensions"] if d["Name"] == "fstype"), "")
        if path and path not in seen and is_default_disk_path(path, target, fstype):
            seen.add(path)
            out.append([d for d in m["Dimensions"] if d["Name"] in DISK_DIM_KEYS])
    return out
