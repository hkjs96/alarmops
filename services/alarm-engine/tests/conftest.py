"""Test doubles. Nothing here talks to AWS: a fake CloudWatch, a fake session factory, a fake discovery."""

from __future__ import annotations

import copy
import os
from dataclasses import dataclass, field
from typing import Any

import pytest

# Belt and braces: any accidental real boto3 client gets fake credentials and no network endpoint.
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_DEFAULT_REGION", "ap-northeast-2")
os.environ.pop("AWS_PROFILE", None)

from alarm_engine.aws import CloudAccount  # noqa: E402
from alarm_engine.engine import DiscoveredResource, Engine  # noqa: E402
from alarm_engine.repository import InMemoryRepository, ResourceRow  # noqa: E402

ACCOUNT_ID = "111122223333"


class ClientError(Exception):
    pass


class FakeCloudWatch:
    """Enough of CloudWatch for the engine. Alarms are keyed by name, per (account, region)."""

    def __init__(self, account_id: str, region: str, page_size: int = 2):
        self.account_id, self.region, self.page_size = account_id, region, page_size
        self.alarms: dict[str, dict] = {}
        self.tags: dict[str, dict[str, str]] = {}
        self.metrics: list[dict] = []
        self.calls: list[tuple[str, dict]] = []
        self.fail_tagging = False
        self.fail_list_metrics = False

    def arn(self, name: str) -> str:
        return f"arn:aws:cloudwatch:{self.region}:{self.account_id}:alarm:{name}"

    def _page(self, items: list, token: str | None, key: str) -> dict:
        start = int(token or 0)
        page = items[start:start + self.page_size]
        out: dict[str, Any] = {key: copy.deepcopy(page)}
        if start + self.page_size < len(items):
            out["NextToken"] = str(start + self.page_size)
        return out

    def put_metric_alarm(self, **kw: Any) -> dict:
        self.calls.append(("put_metric_alarm", kw))
        # AlarmWriter IAM policy (D-43): create needs request tag ManagedBy=AlarmOps; update needs resource tag.
        name = kw["AlarmName"]
        req = {t["Key"]: t["Value"] for t in kw.get("Tags", [])}
        if name in self.alarms:
            if self.tags.get(self.arn(name), {}).get("ManagedBy") != "AlarmOps":
                raise ClientError("AccessDenied: update of alarm without ManagedBy=AlarmOps")
        elif req.get("ManagedBy") != "AlarmOps":
            raise ClientError("AccessDenied: create without request tag ManagedBy=AlarmOps")
        row = {k: v for k, v in kw.items() if k != "Tags"}
        if name not in self.alarms:
            self.tags[self.arn(name)] = req
        row["AlarmArn"] = self.arn(kw["AlarmName"])
        row.setdefault("StateValue", self.alarms.get(kw["AlarmName"], {}).get("StateValue", "INSUFFICIENT_DATA"))
        self.alarms[kw["AlarmName"]] = row
        return {}

    def describe_alarms(self, AlarmNames: list[str] | None = None, NextToken: str | None = None, **kw: Any) -> dict:
        self.calls.append(("describe_alarms", {"AlarmNames": AlarmNames, **kw}))
        rows = [a for n, a in self.alarms.items() if AlarmNames is None or n in AlarmNames]
        return self._page(rows, NextToken, "MetricAlarms")

    def list_tags_for_resource(self, ResourceARN: str) -> dict:
        return {"Tags": [{"Key": k, "Value": v} for k, v in self.tags.get(ResourceARN, {}).items()]}

    def tag_resource(self, ResourceARN: str, Tags: list[dict]) -> dict:
        self.calls.append(("tag_resource", {"ResourceARN": ResourceARN, "Tags": Tags}))
        if self.fail_tagging:
            raise ClientError("AccessDenied")
        if any(t["Key"] == "ManagedBy" for t in Tags):
            raise ClientError("AccessDenied: explicit deny on ManagedBy")
        if self.tags.get(ResourceARN, {}).get("ManagedBy") != "AlarmOps":
            raise ClientError("AccessDenied: resource not tagged ManagedBy=AlarmOps")
        self.tags.setdefault(ResourceARN, {}).update({t["Key"]: t["Value"] for t in Tags})
        return {}

    def untag_resource(self, ResourceARN: str, TagKeys: list[str]) -> dict:
        self.calls.append(("untag_resource", {"ResourceARN": ResourceARN, "TagKeys": TagKeys}))
        if "ManagedBy" in TagKeys:
            raise ClientError("AccessDenied: explicit deny on ManagedBy")
        for k in TagKeys:
            self.tags.get(ResourceARN, {}).pop(k, None)
        return {}

    def delete_alarms(self, AlarmNames: list[str]) -> dict:
        self.calls.append(("delete_alarms", {"AlarmNames": AlarmNames}))
        for n in AlarmNames:
            self.alarms.pop(n, None)
            self.tags.pop(self.arn(n), None)
        return {}

    def list_metrics(self, Namespace: str, MetricName: str, Dimensions: list[dict], NextToken: str | None = None) -> dict:
        self.calls.append(("list_metrics", {"Namespace": Namespace, "MetricName": MetricName}))
        if self.fail_list_metrics:
            from botocore.exceptions import ClientError as BotoClientError
            raise BotoClientError({"Error": {"Code": "Throttling", "Message": "slow down"}}, "ListMetrics")
        want = {(d["Name"], d["Value"]) for d in Dimensions}
        rows = [m for m in self.metrics if m["Namespace"] == Namespace and m["MetricName"] == MetricName
                and want <= {(d["Name"], d["Value"]) for d in m["Dimensions"]}]
        return self._page(rows, NextToken, "Metrics")

    # helpers
    def add_foreign_alarm(self, name: str, description: str = "", tags: dict | None = None, **kw: Any) -> None:
        self.alarms[name] = {"AlarmName": name, "AlarmArn": self.arn(name), "AlarmDescription": description,
                             "Threshold": 1.0, "EvaluationPeriods": 1, **kw}
        if tags:
            self.tags[self.arn(name)] = dict(tags)

    def writes(self) -> list[str]:
        return [c for c, _ in self.calls if c in ("put_metric_alarm", "delete_alarms", "tag_resource", "untag_resource")]


class RecordingClient:
    """Any other service: records every call (remediation tests)."""

    def __init__(self, service: str):
        self.service = service
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, name: str) -> Any:
        def call(**kw: Any) -> dict:
            self.calls.append((name, kw))
            return {}
        return call


@dataclass
class FakeSessions:
    cws: dict[tuple[str, str], FakeCloudWatch] = field(default_factory=dict)
    others: dict[tuple[str, str, str], RecordingClient] = field(default_factory=dict)
    assumed: list[tuple[str, str, str]] = field(default_factory=list)   # (role arn, external id, region)

    def cw(self, region: str, account_id: str = ACCOUNT_ID) -> FakeCloudWatch:
        return self.cws.setdefault((account_id, region), FakeCloudWatch(account_id, region))

    def client(self, account: CloudAccount, role: str, service: str, region: str) -> Any:
        arn = account.role_arn(role)  # type: ignore[arg-type]  # raises CapabilityDisabled
        self.assumed.append((arn, account.external_id, region))
        if service == "cloudwatch":
            return self.cw(region, account.aws_account_id)
        return self.others.setdefault((role, service, region), RecordingClient(service))

    def all_calls(self) -> list[str]:
        out = [c for cw in self.cws.values() for c, _ in cw.calls]
        out += [c for rc in self.others.values() for c, _ in rc.calls]
        return out


@dataclass
class FakeDiscovery:
    resources: list[DiscoveredResource] = field(default_factory=list)
    alive_map: dict[str, bool | None] = field(default_factory=dict)
    tags_map: dict[str, dict | None] = field(default_factory=dict)
    fail: bool = False

    def list_monitored(self, account: CloudAccount, region: str) -> list[DiscoveredResource]:
        if self.fail:
            raise RuntimeError("AssumeRole throttled")
        return [r for r in self.resources if r.region == region and r.tags and r.tags.get("Monitoring", "").lower() == "on"]

    def read_tags(self, account: CloudAccount, row: ResourceRow) -> dict | None:
        return self.tags_map.get(row.resource_key)

    def alive(self, account: CloudAccount, region: str, resource_type: str, keys: list[str]) -> dict[str, bool | None]:
        return {k: self.alive_map.get(k) for k in keys}


def make_account(**kw: Any) -> CloudAccount:
    base = dict(id="acc_1", customer_id="cus_1", aws_account_id=ACCOUNT_ID, external_id="ext-123",
                reader_role_arn=f"arn:aws:iam::{ACCOUNT_ID}:role/AlarmOpsReader",
                alarm_writer_role_arn=f"arn:aws:iam::{ACCOUNT_ID}:role/AlarmOpsAlarmWriter", alarm_writer_enabled=True)
    base.update(kw)
    return CloudAccount(**base)  # type: ignore[arg-type]


@pytest.fixture
def world():
    repo = InMemoryRepository()
    acc = make_account()
    repo.accounts[acc.id] = acc
    sessions = FakeSessions()
    disc = FakeDiscovery()
    return repo, sessions, disc, Engine(repo, sessions, disc), acc


def ec2(iid: str = "i-0abc", tags: dict | None = None, region: str = "ap-northeast-2") -> DiscoveredResource:
    t = {"Monitoring": "on", "Name": "web-1"} if tags is None else tags
    return DiscoveredResource("EC2", iid, f"arn:aws:ec2:{region}:{ACCOUNT_ID}:instance/{iid}", region, t)
