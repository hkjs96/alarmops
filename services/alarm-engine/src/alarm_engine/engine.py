"""Orchestration: discovery → Monitoring-state reconcile (D-16) → orphan handling → per-resource sync → DB writes.

Ported from daily_monitor `lambda_handler` (daily / tag_reconcile modes) and alarm_manager `sync_alarms_for_resource`.

D-16 replaces the legacy "tag removed → delete alarms" (10e6444): a resource that was MONITORED and lost its
`Monitoring=on` tag becomes NEEDS_REVIEW and keeps its alarms untouched (no create, no update, no delete) until a person
chooses STOP_MONITORING (alarms deleted) or the tag comes back. A resource that is really gone → DELETED + alarms
deleted (kept from legacy). Tags that cannot be read → nothing changes (alarm-sync §6-3). A discovery failure is not
"zero resources": the run fails and no row changes (4-9).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Protocol

from alarm_engine import naming
from alarm_engine import tags as T
from alarm_engine.aws import (
    AlarmWriter,
    CapabilityDisabled,
    CloudAccount,
    SessionFactory,
    assert_arn_in_account,
    console_tags,
    list_owned_alarms,
    read_console_tags,
)
from alarm_engine.desired import DesiredAlarm, ResourceRef, alarm_region, build_desired, type_defs
from alarm_engine.repository import ManagedAlarmRow, Repository, ResourceRow, new_id, now
from alarm_engine.resource_types.base import global_service_regions
from alarm_engine.sync import ActualAlarm, Command, SyncPlan, plan
from alarm_engine.thresholds import LayerValues

logger = logging.getLogger(__name__)
STALE_RUN_AFTER = timedelta(minutes=20)


class DiscoveryError(Exception):
    pass


@dataclass(frozen=True)
class DiscoveredResource:
    resource_type: str
    resource_key: str
    resource_arn: str
    region: str
    tags: dict[str, str] | None     # None = tags could not be read


class Discovery(Protocol):
    """Reader-role resource discovery (collectors). Interface only in this PR; tests use a fake."""
    def list_monitored(self, account: CloudAccount, region: str) -> list[DiscoveredResource]: ...
    def read_tags(self, account: CloudAccount, row: ResourceRow) -> dict[str, str] | None: ...
    def alive(self, account: CloudAccount, region: str, resource_type: str, keys: list[str]) -> dict[str, bool | None]: ...


def _console_from_tags(tags: dict[str, str]) -> LayerValues | None:
    c = read_console_tags(tags)
    if not c:
        return None
    ev = T.parse_eval(c.get("Eval")) if c.get("Eval") else None
    try:
        thr = float(c["Threshold"]) if "Threshold" in c else None
        period = int(c["Period"]) if "Period" in c else None
    except ValueError:
        thr, period = None, None
    return LayerValues(threshold=thr, eval_m=ev[1] if ev else None, eval_n=ev[0] if ev else None,
                       period=period, statistic=c.get("Statistic"))


def merge_layers(base: LayerValues | None, top: LayerValues | None) -> LayerValues | None:
    if base is None:
        return top
    if top is None:
        return base
    return LayerValues(
        threshold=top.threshold if top.threshold is not None else base.threshold,
        off=top.off or (base.off and top.threshold is None),
        eval_m=top.eval_m if top.eval_m is not None else base.eval_m,
        eval_n=top.eval_n if top.eval_n is not None else base.eval_n,
        period=top.period if top.period is not None else base.period,
        statistic=top.statistic if top.statistic is not None else base.statistic,
    )


def console_tag_values(lv: LayerValues | None) -> dict[str, str | None]:
    if lv is None:
        return {}
    return {
        "Threshold": None if lv.threshold is None else f"{lv.threshold:g}",
        "Eval": f"{lv.eval_m}/{lv.eval_n}" if lv.eval_m and lv.eval_n else None,
        "Period": None if lv.period is None else str(lv.period),
        "Statistic": lv.statistic,
    }


@dataclass
class ResourceResult:
    plan: SyncPlan
    errors: list[str] = field(default_factory=list)
    read_only: bool = False


class Engine:
    def __init__(self, repo: Repository, sessions: SessionFactory, discovery: Discovery,
                 alarm_actions: dict[str, list[str]] | None = None):
        self.repo = repo
        self.sessions = sessions
        self.discovery = discovery
        self.alarm_actions = alarm_actions or {}   # region → same-region SNS topic ARNs (alarm-sync §2-5)

    # ── clients
    def _reader_cw(self, account: CloudAccount, region: str) -> Any:
        return self.sessions.client(account, "reader", "cloudwatch", region)

    def _writer(self, account: CloudAccount, region: str) -> AlarmWriter | None:
        try:
            cw = self.sessions.client(account, "alarmWriter", "cloudwatch", region)
        except CapabilityDisabled:
            return None
        return AlarmWriter(cw, account.aws_account_id, self.alarm_actions.get(region))

    # ── single resource
    def sync_resource(self, account: CloudAccount, row: ResourceRow, *, index: dict[str, list[ActualAlarm]] | None = None,
                      restore_external: bool = False, console_override: dict[str, LayerValues] | None = None,
                      ) -> ResourceResult:
        ref = ResourceRef(row.resource_type, row.resource_key, row.region, account.aws_account_id, row.tags, row.id)
        reader = self._reader_cw(account, row.region)
        actual = index.get(row.resource_key, []) if index is not None else self._owned_for(account, ref)
        actual_by_key = {a.metadata.metric_key: a for a in actual if a.metadata}
        override = console_override or {}

        def layers(key: str) -> tuple[LayerValues | None, LayerValues | None, LayerValues | None]:
            console = self.repo.console_values(row.customer_id, row.id, key)
            a = actual_by_key.get(key)
            if a is not None:
                console = merge_layers(console, _console_from_tags(a.tags))
            console = merge_layers(console, override.get(key))
            customer, msp = self.repo.threshold_defaults(row.customer_id, row.resource_type, key)
            return console, customer, msp

        desired = build_desired(ref, reader, layers)
        managed = self.repo.list_managed_alarms(row.customer_id, row.id)
        p = plan(desired, actual, last_applied={k: {"expected": m.expected()} for k, m in managed.items()},
                 restore_external=restore_external)
        res = ResourceResult(plan=p)
        writers: dict[str, AlarmWriter | None] = {}

        def writer_for(region: str) -> AlarmWriter | None:
            if region not in writers:
                writers[region] = self._writer(account, region)
            return writers[region]

        for cmd in p.commands:
            region = cmd.desired.region if cmd.desired else alarm_region(ref)
            w = writer_for(region)
            if w is None:
                res.read_only = True
                self._record_drift(row, cmd)
                continue
            try:
                existing_console = read_console_tags(cmd.actual.tags) if cmd.actual else {}
                console, _, _ = layers(cmd.metric_key) if cmd.op != "DELETE" else (None, None, None)
                new_console = {k: v for k, v in console_tag_values(console).items() if v is not None}
                arn = w.apply(cmd, console_tags(new_console))
                stale = [k for k in existing_console if k not in new_console]
                if stale and arn:
                    w.cw.untag_resource(ResourceARN=arn, TagKeys=[f"AlarmOps:Console:{k}" for k in stale])
                if cmd.op == "DELETE":
                    self.repo.delete_managed_alarm(row.customer_id, row.id, cmd.metric_key)
                else:
                    assert cmd.desired is not None and arn is not None
                    self._save_alarm(row, account, cmd.desired, cmd.name, arn, cmd.severity or cmd.desired.severity,
                                     cmd.severity_manual, console, "IN_SYNC", None)
            except Exception as e:  # noqa: BLE001 — one alarm's failure must not stop the resource
                logger.exception("apply %s %s failed", cmd.op, cmd.name)
                res.errors.append(f"{cmd.op} {cmd.name}: {e}")
        for d, a, sev, manual in p.in_sync:
            console, _, _ = layers(d.metric_key)
            self._save_alarm(row, account, d, a.name, a.arn, sev, manual, console, "IN_SYNC", None)
        for d, a, detail in p.external_changes:
            sev = a.tags.get("Severity") or d.severity
            console, _, _ = layers(d.metric_key)
            prev = managed.get(d.metric_key)
            self._save_alarm(row, account, d, a.name, a.arn, sev, prev.severity_manual if prev else False, console,
                             "EXTERNAL_CHANGE", {"fields": detail, "by": None}, keep_expected=prev)
        return res

    def _owned_for(self, account: CloudAccount, ref: ResourceRef) -> list[ActualAlarm]:
        regions = {ref.region, alarm_region(ref)}
        out: list[ActualAlarm] = []
        for region in regions:
            out += list_owned_alarms(self._reader_cw(account, region)).get(ref.resource_id, [])
        return out

    def _record_drift(self, row: ResourceRow, cmd: Command) -> None:
        """Read-only mode (no AlarmWriter): only record what would change."""
        if cmd.op == "CREATE" or cmd.op == "DELETE":
            return
        cur = self.repo.list_managed_alarms(row.customer_id, row.id).get(cmd.metric_key)
        if cur and cmd.op == "UPDATE":
            cur.drift_status = "DRIFTED"
            cur.drift_detail = {"fields": list(cmd.changed), "readOnly": True}
            self.repo.upsert_managed_alarm(cur)

    def _save_alarm(self, row: ResourceRow, account: CloudAccount, d: DesiredAlarm, name: str, arn: str, sev: str,
                    manual: bool, console: LayerValues | None, drift: str, detail: dict | None,
                    keep_expected: ManagedAlarmRow | None = None) -> None:
        r = d.resolved
        src = keep_expected
        self.repo.upsert_managed_alarm(ManagedAlarmRow(
            id=new_id("ma"), customer_id=row.customer_id, resource_id=row.id, cloud_account_id=account.id,
            region=d.region, metric_key=d.metric_key, alarm_name=name, alarm_arn=arn, severity=sev,
            severity_manual=manual,
            threshold=src.threshold if src else d.threshold,
            threshold_source=r.threshold_source if r else "TAG",
            console_threshold=console.threshold if console else None,
            eval_m=src.eval_m if src else (d.datapoints_to_alarm or d.evaluation_periods),
            eval_n=src.eval_n if src else d.evaluation_periods,
            eval_source=r.eval_source if r else "CODE",
            comparison=d.comparison, statistic=src.statistic if src else d.statistic,
            period=src.period if src else d.period, treat_missing_data=d.treat_missing_data,
            drift_status=drift, drift_detail=detail, last_synced_at=now(),
        ))

    # ── account
    def sync_account(self, account_id: str, mode: str) -> dict:
        account = self.repo.get_account(account_id)
        self.repo.fail_stale_sync_runs(STALE_RUN_AFTER)
        run = self.repo.start_sync_run(account.customer_id, account.id, mode)
        counts: dict[str, Any] = {"created": 0, "updated": 0, "refreshed": 0, "deleted": 0, "needsReview": 0, "externalChange": 0,
                  "errors": 0, "readOnly": False}
        try:
            discovered: list[DiscoveredResource] = []
            for region in account.regions:
                discovered += self.discovery.list_monitored(account, region)
        except Exception as e:  # noqa: BLE001 — failure ≠ zero resources (4-9)
            self.repo.finish_sync_run(account.customer_id, run, "FAILED", counts, f"discovery failed: {e}")
            return counts

        known = {(r.region, r.resource_type, r.resource_key): r for r in self.repo.list_resources(account.id)}
        seen: set[tuple[str, str, str]] = set()
        to_sync: list[ResourceRow] = []
        for d in discovered:
            k = (d.region, d.resource_type, d.resource_key)
            seen.add(k)
            row = known.get(k) or ResourceRow(new_id("res"), account.customer_id, account.id, d.region,
                                              d.resource_type, d.resource_arn, d.resource_key)
            row = self._apply_tags(row, d.tags, run)
            row = self.repo.upsert_resource(row)
            known[k] = row
            if row.monitoring_state == "MONITORED":
                to_sync.append(row)

        # Known rows not listed as Monitoring=on: gone? tag removed? unreadable?
        by_group: dict[tuple[str, str], list[ResourceRow]] = {}
        for k, row in known.items():
            if k not in seen and row.monitoring_state in ("MONITORED", "NEEDS_REVIEW"):
                by_group.setdefault((row.region, row.resource_type), []).append(row)
        for (region, rtype), rows in by_group.items():
            alive = self.discovery.alive(account, region, rtype, [r.resource_key for r in rows])
            for row in rows:
                state = alive.get(row.resource_key)
                if state is False:
                    self._delete_all(account, row, counts)
                    row.monitoring_state = "DELETED"
                    self.repo.upsert_resource(row)
                elif state is True:
                    tags = self.discovery.read_tags(account, row)
                    row = self.repo.upsert_resource(self._apply_tags(row, tags, run))
                    if row.monitoring_state == "MONITORED":
                        to_sync.append(row)
                # None → unknown, change nothing

        # Owned alarms whose resource we have no row for (orphans): delete only if the resource is gone.
        index: dict[str, list[ActualAlarm]] = {}
        alarm_regions = set(account.regions) | set(global_service_regions().values())
        for region in sorted(alarm_regions):
            for rid, alarms in list_owned_alarms(self._reader_cw(account, region)).items():
                index.setdefault(rid, []).extend(alarms)
        known_keys = {r.resource_key for r in known.values()}
        for rid, alarms in index.items():
            if rid in known_keys:
                continue
            md = alarms[0].metadata
            if md is None:
                continue
            region = alarms[0].raw.get("AlarmArn", "::::").split(":")[3] or account.regions[0]
            state = self.discovery.alive(account, region, md.resource_type, [rid]).get(rid)
            if state is False:
                w = self._writer(account, region)
                for a in alarms:
                    if w is not None:
                        w.apply(Command("DELETE", a.name, a.metadata.metric_key if a.metadata else "", actual=a))
                        counts["deleted"] += 1
                    else:
                        counts["readOnly"] = True

        for row in to_sync:
            try:
                r = self.sync_resource(account, row, index=index)
            except Exception:  # noqa: BLE001
                logger.exception("sync %s failed", row.resource_key)
                counts["errors"] += 1
                continue
            for ck, cv in r.plan.counts().items():
                counts[ck] = counts.get(ck, 0) + cv
            counts["errors"] += len(r.errors)
            counts["readOnly"] = counts["readOnly"] or r.read_only
            self.repo.heartbeat_sync_run(account.customer_id, run)
        counts["needsReview"] = sum(1 for rr in self.repo.list_resources(account.id)
                                    if rr.monitoring_state == "NEEDS_REVIEW")
        self.repo.finish_sync_run(account.customer_id, run, "PARTIAL" if counts["errors"] else "SUCCEEDED", counts)
        return counts

    def _apply_tags(self, row: ResourceRow, tags: dict[str, str] | None, run_id: str | None) -> ResourceRow:
        if tags is None:          # unreadable: state unchanged
            row.last_seen_at = now()
            return row
        row.tags = dict(tags)
        row.name = tags.get("Name")
        row.monitoring_tag = T.monitoring_tag_value(tags)
        row.last_seen_at = now()
        row.discovery_run_id = run_id
        if row.monitoring_tag == "ON":
            row.monitoring_state = "MONITORED"
            row.needs_review_since = row.needs_review_reason = None
        elif row.monitoring_state in ("MONITORED", "NEEDS_REVIEW"):
            if row.monitoring_state != "NEEDS_REVIEW":
                row.needs_review_since = now()
            row.monitoring_state = "NEEDS_REVIEW"
            row.needs_review_reason = "tag_removed"
        else:
            row.monitoring_state = "NOT_MONITORED"
        return row

    def _delete_all(self, account: CloudAccount, row: ResourceRow, counts: dict | None = None) -> int:
        ref = ResourceRef(row.resource_type, row.resource_key, row.region, account.aws_account_id, row.tags, row.id)
        n = 0
        for a in self._owned_for(account, ref):
            region = a.arn.split(":")[3] if a.arn.count(":") >= 5 else row.region
            w = self._writer(account, region)
            if w is None:
                raise CapabilityDisabled("alarmWriter")
            w.apply(Command("DELETE", a.name, a.metadata.metric_key if a.metadata else "", actual=a))
            self.repo.delete_managed_alarm(row.customer_id, row.id, a.metadata.metric_key if a.metadata else "")
            n += 1
        if counts is not None:
            counts["deleted"] = counts.get("deleted", 0) + n
        return n

    # ── commands
    def stop_monitoring(self, customer_id: str, resource_id: str) -> int:
        """A person resolves NEEDS_REVIEW by stopping monitoring: only now are alarms deleted (D-16)."""
        row = self._row(customer_id, resource_id)
        account = self.repo.get_account(row.cloud_account_id)
        n = self._delete_all(account, row)
        row.monitoring_state, row.needs_review_since, row.needs_review_reason = "NOT_MONITORED", None, None
        self.repo.upsert_resource(row)
        return n

    def _row(self, customer_id: str, resource_id: str) -> ResourceRow:
        row = self.repo.get_resource(customer_id, resource_id)
        if row is None:
            raise LookupError(f"resource {resource_id} not found for customer {customer_id}")
        return row

    def sync_one(self, customer_id: str, resource_id: str, *, restore_external: bool = False) -> ResourceResult | None:
        row = self._row(customer_id, resource_id)
        if row.monitoring_state != "MONITORED":
            return None     # NEEDS_REVIEW / NOT_MONITORED: no writes
        return self.sync_resource(self.repo.get_account(row.cloud_account_id), row, restore_external=restore_external)

    def apply_threshold(self, customer_id: str, payload: dict, command_id: str) -> str:
        """APPLY_THRESHOLD (D-08): console value stored on our alarm, same alarm updated in place. Returns applyStatus."""
        change_id = payload["thresholdChangeId"]
        change = self.repo.claim_threshold_change(customer_id, change_id, command_id)
        if change is None:
            return "IGNORED"                       # not PENDING (duplicate / already applied)
        ma = self.repo.get_managed_alarm(customer_id, payload["managedAlarmId"])
        if ma is None:
            self.repo.finish_threshold_change(customer_id, change_id, "FAILED", "managed alarm not found")
            return "FAILED"
        row = self._row(customer_id, ma.resource_id)
        key = ma.metric_key
        wants_thr = "threshold" in payload or payload.get("off") is not None
        wants_eval = payload.get("evalM") is not None or payload.get("evalN") is not None
        tag_thr = T.raw_threshold_tag(row.tags, key) is not None
        tag_eval = T.get_eval_override(row.tags, key) is not None
        if (wants_thr and tag_thr) or (wants_eval and tag_eval and not wants_thr):
            self.repo.finish_threshold_change(customer_id, change_id, "SKIPPED_TAG_WINS")
            return "SKIPPED_TAG_WINS"
        bad = threshold_payload_error(payload)
        if bad:
            self.repo.finish_threshold_change(customer_id, change_id, "FAILED", bad)
            return "FAILED"
        account = self.repo.get_account(row.cloud_account_id)
        try:
            account.role_arn("alarmWriter")
        except CapabilityDisabled:
            self.repo.finish_threshold_change(customer_id, change_id, "FAILED", "CAPABILITY_DISABLED")
            return "FAILED"
        override = LayerValues(
            threshold=payload.get("threshold"), off=bool(payload.get("off")),
            eval_m=payload.get("evalM"), eval_n=payload.get("evalN"),
            period=payload.get("periodSec"), statistic=payload.get("statistic"),
        )
        try:
            res = self.sync_resource(account, row, console_override={key: override}, restore_external=True)
        except Exception as e:  # noqa: BLE001
            self.repo.finish_threshold_change(customer_id, change_id, "FAILED", str(e)[:500])
            return "FAILED"
        if res.errors or res.read_only:
            self.repo.finish_threshold_change(customer_id, change_id, "FAILED", "; ".join(res.errors)[:500] or
                                              "CAPABILITY_DISABLED")
            return "FAILED"
        self.repo.finish_threshold_change(customer_id, change_id, "APPLIED")
        return "APPLIED"

    def apply_customer_default(self, customer_id: str, resource_type: str, metric_key: str) -> int:
        n = 0
        accounts = {r.cloud_account_id for r in self._customer_rows(customer_id)}
        for acc in accounts:
            for row in self.repo.list_resources(acc):
                if row.customer_id != customer_id or row.resource_type != resource_type \
                        or row.monitoring_state != "MONITORED":
                    continue
                keys = {d.get("metric_key") or d["metric"] for d in type_defs(resource_type, row.tags)}
                if metric_key in keys:
                    self.sync_resource(self.repo.get_account(acc), row)
                    n += 1
        return n

    def _customer_rows(self, customer_id: str) -> list[ResourceRow]:
        repo: Any = self.repo
        if hasattr(repo, "resources"):
            return [r for r in repo.resources.values() if r.customer_id == customer_id]
        return list(repo.list_customer_resources(customer_id))

    def set_severity(self, customer_id: str, managed_alarm_id: str, severity: str) -> None:
        from alarm_engine.registry import get_severity, is_valid_severity
        if not is_valid_severity(severity):
            raise ValueError(f"invalid severity {severity!r}")
        ma = self.repo.get_managed_alarm(customer_id, managed_alarm_id)
        if ma is None:
            raise LookupError(managed_alarm_id)
        row = self._row(customer_id, ma.resource_id)
        account = self.repo.get_account(row.cloud_account_id)
        w = self._writer(account, ma.region)
        if w is None:
            raise CapabilityDisabled("alarmWriter")
        actual = next((a for a in list_owned_alarms(w.cw).get(row.resource_key, []) if a.name == ma.alarm_name), None)
        if actual is None:
            raise LookupError(f"alarm {ma.alarm_name} not found")
        w.set_severity(actual, severity)
        ma.severity, ma.severity_manual = severity, severity != get_severity(ma.metric_key)
        self.repo.upsert_managed_alarm(ma)

    def set_monitoring_tag(self, customer_id: str, resource_id: str) -> None:
        """TagWriter: only `Monitoring=on`, never S3 / Route53 (D-07)."""
        row = self._row(customer_id, resource_id)
        if row.resource_type in ("S3", "Route53"):
            raise CapabilityDisabled("tagWriter")
        account = self.repo.get_account(row.cloud_account_id)
        if account.customer_id != customer_id:
            raise PermissionError("tenant mismatch")
        account.role_arn("tagWriter")             # CapabilityDisabled first, before inspecting the ARN
        assert_arn_in_account(row.resource_arn, account, row.region)
        tagging = self.sessions.client(account, "tagWriter", "resourcegroupstaggingapi", row.region)
        resp = tagging.tag_resources(ResourceARNList=[row.resource_arn], Tags={"Monitoring": "on"})
        if resp.get("FailedResourcesMap"):
            raise RuntimeError(f"tag_resources failed: {resp['FailedResourcesMap']}")
        row.monitoring_tag_set_by = "CONSOLE"
        self.repo.upsert_resource(row)

    def check_connection(self, account_id: str) -> dict[str, str]:
        account = self.repo.get_account(account_id)
        out: dict[str, str] = {}
        for role in ("reader", "alarmWriter", "tagWriter", "remediator"):
            try:
                self.sessions.client(account, role, "sts", account.regions[0])  # type: ignore[arg-type]
                out[role] = "OK"
            except CapabilityDisabled:
                out[role] = "MISSING"
            except Exception:  # noqa: BLE001
                out[role] = "DENIED"
        self.repo.update_account_status(account_id, out)
        return out


ALLOWED_STATISTICS = frozenset({"SampleCount", "Average", "Sum", "Minimum", "Maximum"})


def _allowed_period(p: int) -> bool:
    """CloudWatch PutMetricAlarm periods: 10, 30, or a multiple of 60 up to one day."""
    return p in (10, 30) or (60 <= p <= 86400 and p % 60 == 0)


def threshold_payload_error(p: dict) -> str | None:
    def num(v: Any) -> bool:
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

    def pos_int(v: Any) -> bool:
        return isinstance(v, int) and not isinstance(v, bool) and v >= 1

    if "threshold" in p and p["threshold"] is not None and not num(p["threshold"]):
        return "threshold must be a finite number"
    m, n = p.get("evalM"), p.get("evalN")
    if (m is not None and not pos_int(m)) or (n is not None and not pos_int(n)):
        return "evalM/evalN must be positive integers"
    if m is not None and n is not None and m > n:
        return "evalM must be <= evalN"
    per = p.get("periodSec")
    if per is not None and not (pos_int(per) and _allowed_period(per)):
        return "periodSec not allowed"
    st = p.get("statistic")
    if st is not None and st not in ALLOWED_STATISTICS:
        return "statistic not allowed"
    return None


def classify_liveness(cw: Any, alarm_names: list[str]) -> dict[str, str]:
    """CHECK_ALARM_LIVENESS: deleted / not_firing / firing / unknown per alarm name."""
    try:
        rows = {a["AlarmName"]: a for a in cw.describe_alarms(AlarmNames=alarm_names).get("MetricAlarms", [])}
    except Exception:  # noqa: BLE001
        return {n: "unknown" for n in alarm_names}
    out = {}
    for n in alarm_names:
        a = rows.get(n)
        out[n] = "deleted" if a is None else ("firing" if a.get("StateValue") == "ALARM" else "not_firing")
    return out


__all__ = ["Engine", "Discovery", "DiscoveredResource", "DiscoveryError", "classify_liveness", "naming"]
