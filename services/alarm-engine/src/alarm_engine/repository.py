"""Engine ↔ DB boundary (API-CONTRACT §7). The engine writes only the tables listed there.

`Repository` is the interface; `InMemoryRepository` backs the tests; `pg_repository.PgRepository` is the thin psycopg
implementation (enabled only when DATABASE_URL is set). Every query is scoped by customer / cloud account.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, replace
from dataclasses import field as dc_field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from alarm_engine.aws import CloudAccount
from alarm_engine.thresholds import LayerValues


def now() -> datetime:
    return datetime.now(UTC)


@dataclass
class ResourceRow:
    id: str
    customer_id: str
    cloud_account_id: str
    region: str
    resource_type: str
    resource_arn: str
    resource_key: str
    name: str | None = None
    tags: dict[str, str] = dc_field(default_factory=dict)
    monitoring_tag: str = "ABSENT"            # ON | OFF | ABSENT
    monitoring_state: str = "NOT_MONITORED"   # MONITORED | NEEDS_REVIEW | NOT_MONITORED | DELETED
    needs_review_since: datetime | None = None
    needs_review_reason: str | None = None
    monitoring_tag_set_by: str | None = None
    last_seen_at: datetime = dc_field(default_factory=now)
    discovery_run_id: str | None = None


@dataclass
class ManagedAlarmRow:
    id: str
    customer_id: str
    resource_id: str
    cloud_account_id: str
    region: str
    metric_key: str
    alarm_name: str
    alarm_arn: str
    severity: str                 # "SEV-3" (pg layer maps to enum SEV_3)
    severity_manual: bool
    threshold: float
    threshold_source: str
    console_threshold: float | None
    eval_m: int
    eval_n: int
    eval_source: str
    comparison: str
    statistic: str
    period: int
    treat_missing_data: str
    drift_status: str = "IN_SYNC"
    drift_detail: dict | None = None
    last_synced_at: datetime | None = None
    version: int = 0

    def expected(self) -> dict[str, Any]:
        return {"Threshold": self.threshold, "Statistic": self.statistic, "Period": self.period,
                "EvaluationPeriods": self.eval_n, "DatapointsToAlarm": self.eval_m,
                "ComparisonOperator": self.comparison, "TreatMissingData": self.treat_missing_data}


@dataclass
class ThresholdChangeRow:
    id: str
    customer_id: str
    target: str
    field: str                    # THRESHOLD | EVAL | OFF | SEVERITY | MONITORING
    resource_type: str
    metric_key: str
    new_value: Any
    managed_alarm_id: str | None = None
    resource_id: str | None = None
    apply_status: str = "PENDING"
    command_id: str | None = None
    error: str | None = None
    at: datetime = dc_field(default_factory=now)


@dataclass
class RemediationRequestRow:
    id: str
    customer_id: str
    cloud_account_id: str
    resource_id: str
    action: str                   # EC2_STOP | RDS_STOP | ELB_DELETE
    status: str
    trigger: dict
    requested_at: datetime = dc_field(default_factory=now)
    expires_at: datetime | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    decision_via: str | None = None
    executed_at: datetime | None = None
    result: dict | None = None
    version: int = 0


@dataclass
class RemediationPolicyRow:
    customer_id: str
    enabled: bool = False             # D-15 default off
    mode: str = "NOTIFY_ONLY"         # NOTIFY_ONLY | APPROVAL_REQUIRED (no automatic mode exists)
    actions: tuple[str, ...] = ()


@dataclass
class SyncRunRow:
    id: str
    customer_id: str
    cloud_account_id: str
    mode: str
    status: str = "RUNNING"
    started_at: datetime = dc_field(default_factory=now)
    finished_at: datetime | None = None
    heartbeat_at: datetime | None = None
    counts: dict = dc_field(default_factory=dict)
    error: str | None = None


class Repository(Protocol):
    def get_account(self, cloud_account_id: str) -> CloudAccount: ...
    def update_account_status(self, cloud_account_id: str, statuses: dict[str, str]) -> None: ...
    def list_resources(self, cloud_account_id: str) -> list[ResourceRow]: ...
    def get_resource(self, customer_id: str, resource_id: str) -> ResourceRow | None: ...
    def upsert_resource(self, row: ResourceRow) -> ResourceRow: ...
    def threshold_defaults(self, customer_id: str, resource_type: str, metric_key: str
                           ) -> tuple[LayerValues | None, LayerValues | None]: ...
    def console_values(self, customer_id: str, resource_id: str, metric_key: str) -> LayerValues | None: ...
    def list_managed_alarms(self, customer_id: str, resource_id: str) -> dict[str, ManagedAlarmRow]: ...
    def get_managed_alarm(self, customer_id: str, managed_alarm_id: str) -> ManagedAlarmRow | None: ...
    def upsert_managed_alarm(self, row: ManagedAlarmRow) -> ManagedAlarmRow: ...
    def delete_managed_alarm(self, customer_id: str, resource_id: str, metric_key: str) -> None: ...
    def claim_threshold_change(self, customer_id: str, change_id: str, command_id: str) -> ThresholdChangeRow | None: ...
    def finish_threshold_change(self, customer_id: str, change_id: str, status: str, error: str | None = None) -> None: ...
    def start_sync_run(self, customer_id: str, cloud_account_id: str, mode: str) -> str: ...
    def heartbeat_sync_run(self, customer_id: str, run_id: str) -> None: ...
    def finish_sync_run(self, customer_id: str, run_id: str, status: str, counts: dict,
                        error: str | None = None) -> None: ...
    def fail_stale_sync_runs(self, older_than: timedelta) -> int: ...
    def get_remediation_policy(self, customer_id: str) -> RemediationPolicyRow: ...
    def create_remediation_request(self, row: RemediationRequestRow) -> RemediationRequestRow | None: ...
    def get_remediation_request(self, customer_id: str | None, request_id: str) -> RemediationRequestRow | None: ...
    def transition_remediation(self, customer_id: str, request_id: str, from_status: str, to_status: str,
                               result: dict | None = None) -> bool: ...


_ids = itertools.count(1)


def new_id(prefix: str) -> str:
    return f"{prefix}_{next(_ids):06d}"


_ACTIVE_REMEDIATION = ("PENDING_APPROVAL", "APPROVED", "EXECUTING")


class InMemoryRepository:
    def __init__(self) -> None:
        self.accounts: dict[str, CloudAccount] = {}
        self.account_status: dict[str, dict[str, str]] = {}
        self.resources: dict[str, ResourceRow] = {}
        self.defaults: dict[tuple[str, str | None, str, str], LayerValues] = {}   # (level, customer, type, key)
        self.alarms: dict[str, ManagedAlarmRow] = {}
        self.changes: dict[str, ThresholdChangeRow] = {}
        self.runs: dict[str, SyncRunRow] = {}
        self.policies: dict[str, RemediationPolicyRow] = {}
        self.remediations: dict[str, RemediationRequestRow] = {}

    # accounts
    def get_account(self, cloud_account_id: str) -> CloudAccount:
        return self.accounts[cloud_account_id]

    def update_account_status(self, cloud_account_id: str, statuses: dict[str, str]) -> None:
        self.account_status.setdefault(cloud_account_id, {}).update(statuses)

    # resources
    def list_resources(self, cloud_account_id: str) -> list[ResourceRow]:
        return [replace(r) for r in self.resources.values() if r.cloud_account_id == cloud_account_id]

    def get_resource(self, customer_id: str, resource_id: str) -> ResourceRow | None:
        r = self.resources.get(resource_id)
        return replace(r) if r and r.customer_id == customer_id else None

    def upsert_resource(self, row: ResourceRow) -> ResourceRow:
        for r in self.resources.values():
            if (r.cloud_account_id, r.region, r.resource_type, r.resource_key) == (
                    row.cloud_account_id, row.region, row.resource_type, row.resource_key) and r.id != row.id:
                row = replace(row, id=r.id)
        self.resources[row.id] = replace(row)
        return replace(row)

    # thresholds
    def threshold_defaults(self, customer_id: str, resource_type: str, metric_key: str
                           ) -> tuple[LayerValues | None, LayerValues | None]:
        return (self.defaults.get(("CUSTOMER", customer_id, resource_type, metric_key)),
                self.defaults.get(("MSP", None, resource_type, metric_key)))

    def console_values(self, customer_id: str, resource_id: str, metric_key: str) -> LayerValues | None:
        """DB copy of console values: latest APPLIED ThresholdChange per field (recovery source, D-08)."""
        rows = sorted((c for c in self.changes.values()
                       if c.customer_id == customer_id and c.resource_id == resource_id
                       and c.metric_key == metric_key and c.apply_status == "APPLIED" and c.target == "ALARM"),
                      key=lambda c: c.at)
        if not rows:
            return None
        thr: float | None = None
        off = False
        m = n = None
        for c in rows:
            if c.field == "THRESHOLD":
                thr = None if c.new_value is None else float(c.new_value)
            elif c.field == "OFF":
                off = bool(c.new_value)
            elif c.field == "EVAL":
                m, n = (c.new_value or {}).get("m"), (c.new_value or {}).get("n")
        return LayerValues(threshold=thr, off=off, eval_m=m, eval_n=n)

    # managed alarms
    def list_managed_alarms(self, customer_id: str, resource_id: str) -> dict[str, ManagedAlarmRow]:
        return {a.metric_key: replace(a) for a in self.alarms.values()
                if a.customer_id == customer_id and a.resource_id == resource_id}

    def get_managed_alarm(self, customer_id: str, managed_alarm_id: str) -> ManagedAlarmRow | None:
        a = self.alarms.get(managed_alarm_id)
        return replace(a) if a and a.customer_id == customer_id else None

    def upsert_managed_alarm(self, row: ManagedAlarmRow) -> ManagedAlarmRow:
        for a in self.alarms.values():
            if (a.resource_id, a.metric_key) == (row.resource_id, row.metric_key) and a.id != row.id:
                row = replace(row, id=a.id, version=a.version)
        prev = self.alarms.get(row.id)
        row = replace(row, version=(prev.version + 1) if prev else 0)
        self.alarms[row.id] = row
        return replace(row)

    def delete_managed_alarm(self, customer_id: str, resource_id: str, metric_key: str) -> None:
        for k, a in list(self.alarms.items()):
            if (a.customer_id, a.resource_id, a.metric_key) == (customer_id, resource_id, metric_key):
                del self.alarms[k]

    # threshold changes — engine only updates applyStatus/error (contract §7)
    def claim_threshold_change(self, customer_id: str, change_id: str, command_id: str) -> ThresholdChangeRow | None:
        c = self.changes.get(change_id)
        if c is None or c.customer_id != customer_id or c.apply_status != "PENDING":
            return None
        return replace(c)

    def finish_threshold_change(self, customer_id: str, change_id: str, status: str, error: str | None = None) -> None:
        c = self.changes[change_id]
        if c.customer_id == customer_id and c.apply_status == "PENDING":
            c.apply_status, c.error = status, error

    # sync runs
    def start_sync_run(self, customer_id: str, cloud_account_id: str, mode: str) -> str:
        rid = new_id("run")
        self.runs[rid] = SyncRunRow(rid, customer_id, cloud_account_id, mode, heartbeat_at=now())
        return rid

    def heartbeat_sync_run(self, customer_id: str, run_id: str) -> None:
        r = self.runs.get(run_id)
        if r is not None and r.customer_id == customer_id:
            r.heartbeat_at = now()

    def finish_sync_run(self, customer_id: str, run_id: str, status: str, counts: dict,
                        error: str | None = None) -> None:
        r = self.runs.get(run_id)
        if r is None or r.customer_id != customer_id:
            return
        r.status, r.counts, r.error, r.finished_at = status, counts, error, now()

    def fail_stale_sync_runs(self, older_than: timedelta) -> int:
        n = 0
        for r in self.runs.values():
            if r.status == "RUNNING" and (r.heartbeat_at or r.started_at) < now() - older_than:
                r.status, r.error, r.finished_at = "FAILED", "stale: no heartbeat (timeout)", now()
                n += 1
        return n

    # remediation
    def get_remediation_policy(self, customer_id: str) -> RemediationPolicyRow:
        return self.policies.get(customer_id, RemediationPolicyRow(customer_id))

    def create_remediation_request(self, row: RemediationRequestRow) -> RemediationRequestRow | None:
        for r in self.remediations.values():
            if (r.customer_id, r.resource_id, r.action) == (row.customer_id, row.resource_id, row.action) \
                    and r.status in _ACTIVE_REMEDIATION:
                return None
        self.remediations[row.id] = replace(row)
        return replace(row)

    def get_remediation_request(self, customer_id: str | None, request_id: str) -> RemediationRequestRow | None:
        r = self.remediations.get(request_id)
        if r is None or (customer_id is not None and r.customer_id != customer_id):
            return None
        return replace(r)

    def transition_remediation(self, customer_id: str, request_id: str, from_status: str, to_status: str,
                               result: dict | None = None) -> bool:
        r = self.remediations.get(request_id)
        if r is None or r.customer_id != customer_id or r.status != from_status:
            return False
        r.status, r.version = to_status, r.version + 1
        if result is not None:
            r.result = result
        if to_status in ("SUCCEEDED", "FAILED"):
            r.executed_at = now()
        return True
