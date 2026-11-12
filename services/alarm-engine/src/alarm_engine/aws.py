"""AWS ports: cross-account sessions (D-07) and the CloudWatch read/write adapter.

Rules:
- Every customer-account call goes through a session from `SessionFactory.client(...)` — there is **no** default
  `boto3.client` in this package (known-bugs 4-2). Tests use botocore Stubber / moto; nothing calls real AWS.
- AssumeRole always passes the account's ExternalId (D-07). A role that is missing or disabled raises
  `CapabilityDisabled` before any call.
- Alarm clients are created per *alarm* region (global types → us-east-1, others → resource region; 4-3, 4-4).
- After PutMetricAlarm the ARN is read back with the same client and must contain the customer account id; tagging
  failures raise (4-5, 1a1080b).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from alarm_engine import naming
from alarm_engine.desired import DesiredAlarm
from alarm_engine.sync import ActualAlarm, Command

logger = logging.getLogger(__name__)

Role = Literal["reader", "alarmWriter", "tagWriter", "remediator"]
CONSOLE_TAG_PREFIX = "AlarmOps:Console:"


class CapabilityDisabled(Exception):
    def __init__(self, role: str):
        super().__init__(f"CAPABILITY_DISABLED: {role}")
        self.role = role


class TaggingFailed(Exception):
    pass


@dataclass(frozen=True)
class CloudAccount:
    id: str
    customer_id: str
    aws_account_id: str
    external_id: str
    reader_role_arn: str
    regions: tuple[str, ...] = ("ap-northeast-2",)
    alarm_writer_role_arn: str | None = None
    alarm_writer_enabled: bool = False
    tag_writer_role_arn: str | None = None
    tag_writer_enabled: bool = False
    remediator_role_arn: str | None = None
    remediator_enabled: bool = False

    def role_arn(self, role: Role) -> str:
        arn, enabled = {
            "reader": (self.reader_role_arn, True),
            "alarmWriter": (self.alarm_writer_role_arn, self.alarm_writer_enabled),
            "tagWriter": (self.tag_writer_role_arn, self.tag_writer_enabled),
            "remediator": (self.remediator_role_arn, self.remediator_enabled),
        }[role]
        if not arn or not enabled:
            raise CapabilityDisabled(role)
        return arn


def assert_arn_in_account(arn: str | None, account: CloudAccount, region: str | None) -> None:
    """Before any write on a resource ARN: ARN account must be the customer account and region must match
    (empty ARN region is accepted only for global resources handled in us-east-1)."""
    parts = (arn or "").split(":")
    if len(parts) < 6 or parts[0] != "arn":
        raise PermissionError(f"malformed ARN {arn!r}")
    if parts[4] != account.aws_account_id:
        raise PermissionError(f"ARN {arn!r} is not in customer account {account.aws_account_id}")
    if region is not None and parts[3] != region and not (parts[3] == "" and region == "us-east-1"):
        raise PermissionError(f"ARN {arn!r} region does not match {region}")


class SessionFactory(Protocol):
    def client(self, account: CloudAccount, role: Role, service: str, region: str) -> Any: ...


class StsSessionFactory:
    """Central role → customer role via STS AssumeRole with ExternalId. `sts_client` is injected (Stubber in tests)."""

    def __init__(self, sts_client: Any, client_ctor: Callable[..., Any] | None = None, session_name: str = "alarmops-engine"):
        self._sts = sts_client
        self._ctor = client_ctor
        self._name = session_name

    def credentials(self, account: CloudAccount, role: Role) -> dict[str, str]:
        arn = account.role_arn(role)
        if not account.external_id:          # D-07: never AssumeRole without ExternalId
            raise CapabilityDisabled(role)
        resp = self._sts.assume_role(RoleArn=arn, RoleSessionName=self._name,
                                     ExternalId=account.external_id, DurationSeconds=900)
        c = resp["Credentials"]
        return {"aws_access_key_id": c["AccessKeyId"], "aws_secret_access_key": c["SecretAccessKey"],
                "aws_session_token": c["SessionToken"]}

    def client(self, account: CloudAccount, role: Role, service: str, region: str) -> Any:
        creds = self.credentials(account, role)
        if self._ctor is None:  # pragma: no cover - production wiring only
            import boto3
            return boto3.client(service, region_name=region, **creds)  # type: ignore[call-overload]
        return self._ctor(service, region_name=region, **creds)


def _paginate(cw: Any, method: str, key: str, **kw: Any) -> list[dict]:
    out: list[dict] = []
    token = None
    while True:
        resp = getattr(cw, method)(**kw, **({"NextToken": token} if token else {}))
        out.extend(resp.get(key, []))
        token = resp.get("NextToken")
        if not token:
            return out


def list_owned_alarms(cw: Any) -> dict[str, list[ActualAlarm]]:
    """All metric alarms in this client's account/region that we own, grouped by metadata resourceId.

    Only alarms whose description parses are tag-checked (one ListTagsForResource each); the ManagedBy tag decides.
    """
    out: dict[str, list[ActualAlarm]] = {}
    for raw in _paginate(cw, "describe_alarms", "MetricAlarms", AlarmTypes=["MetricAlarm"]):
        md = naming.parse_metadata(raw.get("AlarmDescription"))
        if md is None:
            continue
        tags = {t["Key"]: t["Value"] for t in cw.list_tags_for_resource(ResourceARN=raw["AlarmArn"]).get("Tags", [])}
        if tags.get("ManagedBy") != naming.MANAGED_BY:
            continue
        out.setdefault(md.resource_id, []).append(ActualAlarm(raw=raw, tags=tags))
    return out


def console_tags(values: Mapping[str, str | None]) -> list[dict[str, str]]:
    """Console per-resource values stored on our alarm (D-08). Format decision is Q-DM-12; tags chosen here."""
    return [{"Key": CONSOLE_TAG_PREFIX + k, "Value": str(v)} for k, v in values.items() if v is not None]


def read_console_tags(tags: dict[str, str]) -> dict[str, str]:
    return {k[len(CONSOLE_TAG_PREFIX):]: v for k, v in tags.items() if k.startswith(CONSOLE_TAG_PREFIX)}


class AlarmWriter:
    """Applies sync commands with an AlarmWriter-role client for one account+region."""

    def __init__(self, cw: Any, account_id: str, actions: list[str] | None = None):
        self.cw = cw
        self.account_id = account_id
        self.actions = actions or []

    def _arn(self, name: str) -> str:
        rows = self.cw.describe_alarms(AlarmNames=[name]).get("MetricAlarms", [])
        arn = rows[0]["AlarmArn"] if rows else ""
        if f":{self.account_id}:alarm:" not in arn:
            raise TaggingFailed(f"alarm ARN {arn!r} is not in customer account {self.account_id}")
        return str(arn)

    def put(self, d: DesiredAlarm, *, name: str, severity: str, extra_tags: list[dict[str, str]] | None = None) -> str:
        params = d.put_params(self.actions)
        params["AlarmName"] = name
        md = naming.parse_metadata(d.description)
        assert md is not None
        params["AlarmDescription"] = naming.build_description(md.resource_type, md.resource_id, md.metric_key,
                                                              severity, md.resource_name or "")
        self.cw.put_metric_alarm(**params)
        arn = self._arn(name)
        tags = [{"Key": "ManagedBy", "Value": naming.MANAGED_BY}, {"Key": "Severity", "Value": severity}]
        try:
            self.cw.tag_resource(ResourceARN=arn, Tags=tags + list(extra_tags or []))
        except Exception as e:  # noqa: BLE001 — surfaced, never swallowed (4-5)
            raise TaggingFailed(f"TagResource failed for {arn}: {e}") from e
        return arn

    def apply(self, cmd: Command, extra_tags: list[dict[str, str]] | None = None) -> str | None:
        if cmd.op == "DELETE":
            assert cmd.actual is not None
            if not naming.is_ours(cmd.actual.raw, cmd.actual.tags):   # last guard (4-6)
                raise PermissionError(f"refusing to delete non-owned alarm {cmd.name}")
            self.cw.delete_alarms(AlarmNames=[cmd.name])
            return None
        assert cmd.desired is not None and cmd.severity is not None
        return self.put(cmd.desired, name=cmd.name, severity=cmd.severity, extra_tags=extra_tags)

    def set_severity(self, actual: ActualAlarm, severity: str) -> None:
        """SET_SEVERITY: tag and description together (alarm-sync §3-2), in place."""
        raw = dict(actual.raw)
        md = naming.parse_metadata(raw.get("AlarmDescription"))
        if md is None or not naming.is_ours(raw, actual.tags):
            raise PermissionError("not our alarm")
        keep: dict[str, Any] = {k: raw[k] for k in ("AlarmName", "Namespace", "MetricName", "Dimensions", "Statistic", "Period",
                                     "EvaluationPeriods", "Threshold", "ComparisonOperator", "TreatMissingData",
                                     "DatapointsToAlarm", "AlarmActions", "OKActions", "ActionsEnabled") if k in raw}
        keep["AlarmDescription"] = naming.build_description(md.resource_type, md.resource_id, md.metric_key, severity,
                                                            md.resource_name or "")
        self.cw.put_metric_alarm(**keep)
        try:
            self.cw.tag_resource(ResourceARN=actual.arn, Tags=[{"Key": "Severity", "Value": severity}])
        except Exception as e:  # noqa: BLE001
            raise TaggingFailed(str(e)) from e
