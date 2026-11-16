"""botocore Stubber plumbing for collector tests. Real boto3 clients (fake credentials), no network: the Stubber answers
every call, validates request parameters (when given) and the response shapes against the service model."""

from __future__ import annotations

import datetime as dt
from typing import Any

import boto3
from botocore.stub import Stubber

from alarm_engine.aws import CloudAccount

REGION = "ap-northeast-2"
GLOBAL = "us-east-1"
ACCOUNT = "111122223333"
MON_ON = {"Monitoring": "on"}
EPOCH = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)


class StubSessions:
    """`SessionFactory` whose clients are Stubber-backed. Only the Reader role is ever used by collectors."""

    def __init__(self, fallback: Any = None) -> None:
        self.stubbers: dict[tuple[str, str], Stubber] = {}
        self.clients: dict[tuple[str, str], Any] = {}
        self.roles: list[str] = []
        self.fallback = fallback        # e.g. conftest.FakeSessions for CloudWatch

    def _get(self, service: str, region: str) -> tuple[Any, Stubber]:
        k = (service, region)
        if k not in self.clients:
            c = boto3.client(service, region_name=region, aws_access_key_id="testing", aws_secret_access_key="testing")
            s = Stubber(c)
            s.activate()
            self.clients[k], self.stubbers[k] = c, s
        return self.clients[k], self.stubbers[k]

    def client(self, account: CloudAccount, role: str, service: str, region: str) -> Any:
        self.roles.append(role)
        if self.fallback is not None and (service in ("cloudwatch", "sts") or role != "reader"):
            return self.fallback.client(account, role, service, region)
        return self._get(service, region)[0]

    def respond(self, service: str, region: str, op: str, response: dict, params: dict | None = None) -> None:
        self._get(service, region)[1].add_response(op, response, params)

    def error(self, service: str, region: str, op: str, code: str, params: dict | None = None) -> None:
        self._get(service, region)[1].add_client_error(op, code, f"{code} (stub)", 400, expected_params=params)

    def add(self, step: tuple) -> None:
        service, region, op, response, *rest = step
        if isinstance(response, str):
            self.error(service, region, op, response, rest[0] if rest else None)
        else:
            self.respond(service, region, op, response, rest[0] if rest else None)

    def assert_all_consumed(self) -> None:
        for s in self.stubbers.values():
            s.assert_no_pending_responses()


def rgt(region: str, filters: list[str], items: list[tuple[str, dict]], token: str = "", params_token: str | None = None
        ) -> tuple:
    """One tag:GetResources page. `items` = (ARN, tags)."""
    params: dict[str, Any] = {"TagFilters": [{"Key": "Monitoring"}], "ResourceTypeFilters": filters, "ResourcesPerPage": 100}
    if params_token:
        params["PaginationToken"] = params_token
    return ("resourcegroupstaggingapi", region, "get_resources",
            {"ResourceTagMappingList": [{"ResourceARN": a, "Tags": [{"Key": k, "Value": v} for k, v in t.items()]}
                                        for a, t in items], "PaginationToken": token}, params)


def tags(extra: dict | None = None, name: str | None = None) -> dict[str, str]:
    t = dict(MON_ON)
    if name:
        t["Name"] = name
    return {**t, **(extra or {})}


def kv(t: dict[str, str], lower: bool = False) -> list[dict[str, str]]:
    return [({"key": k, "value": v} if lower else {"Key": k, "Value": v}) for k, v in t.items()]
