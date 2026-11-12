"""Thin psycopg implementation of `Repository` against the Prisma-migrated schema (`db/prisma/migrations`).

Enabled only when DATABASE_URL is set (`wiring.build_engine`). Schema changes stay in `prisma migrate` (D-09 rule 6);
this module only reads/writes the tables of API-CONTRACT §7. Every statement carries a customer or account condition.
Severity enum mapping: engine "SEV-3" ↔ DB `SEV_3`.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from alarm_engine.aws import CloudAccount
from alarm_engine.repository import (
    ManagedAlarmRow,
    RemediationPolicyRow,
    RemediationRequestRow,
    ResourceRow,
    ThresholdChangeRow,
)
from alarm_engine.thresholds import LayerValues


def _sev_db(s: str) -> str:
    return s.replace("-", "_")


def _sev_engine(s: str) -> str:
    return s.replace("_", "-")


def _f(v: Any) -> float | None:
    return None if v is None else float(v)


class PgRepository:
    def __init__(self, conninfo: str):
        self.conn = psycopg.connect(conninfo, autocommit=True, row_factory=dict_row)  # type: ignore[arg-type]

    def _one(self, sql: str, *args: Any) -> dict | None:
        with self.conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchone()  # type: ignore[return-value]

    def _all(self, sql: str, *args: Any) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute(sql, args)
            return list(cur.fetchall())  # type: ignore[arg-type]

    def _exec(self, sql: str, *args: Any) -> int:
        with self.conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.rowcount

    # accounts
    def get_account(self, cloud_account_id: str) -> CloudAccount:
        r = self._one('SELECT * FROM "CloudAccount" WHERE id = %s', cloud_account_id)
        if r is None:
            raise LookupError(cloud_account_id)
        return CloudAccount(
            id=r["id"], customer_id=r["customerId"], aws_account_id=r["awsAccountId"], external_id=r["externalId"],
            reader_role_arn=r["readerRoleArn"], regions=tuple(r["regions"] or ["ap-northeast-2"]),
            alarm_writer_role_arn=r["alarmWriterRoleArn"], alarm_writer_enabled=r["alarmWriterEnabled"],
            tag_writer_role_arn=r["tagWriterRoleArn"], tag_writer_enabled=r["tagWriterEnabled"],
            remediator_role_arn=r["remediatorRoleArn"], remediator_enabled=r["remediatorEnabled"],
        )

    def update_account_status(self, cloud_account_id: str, statuses: dict[str, str]) -> None:
        cols = {"reader": "readerStatus", "alarmWriter": "alarmWriterStatus", "tagWriter": "tagWriterStatus",
                "remediator": "remediatorStatus"}
        sets = ", ".join(f'"{cols[k]}" = %s::"RoleStatus"' for k in statuses)
        self._exec(f'UPDATE "CloudAccount" SET {sets}, "lastCheckedAt" = now(), "updatedAt" = now() WHERE id = %s',
                   *statuses.values(), cloud_account_id)

    # resources
    @staticmethod
    def _res(r: dict) -> ResourceRow:
        return ResourceRow(
            id=r["id"], customer_id=r["customerId"], cloud_account_id=r["cloudAccountId"], region=r["region"],
            resource_type=r["resourceType"], resource_arn=r["resourceArn"], resource_key=r["resourceKey"],
            name=r["name"], tags=dict(r["tags"] or {}), monitoring_tag=r["monitoringTag"],
            monitoring_state=r["monitoringState"], needs_review_since=r["needsReviewSince"],
            needs_review_reason=r["needsReviewReason"], monitoring_tag_set_by=r["monitoringTagSetBy"],
            last_seen_at=r["lastSeenAt"], discovery_run_id=r["discoveryRunId"],
        )

    def list_resources(self, cloud_account_id: str) -> list[ResourceRow]:
        return [self._res(r) for r in self._all('SELECT * FROM "Resource" WHERE "cloudAccountId" = %s', cloud_account_id)]

    def list_customer_resources(self, customer_id: str) -> list[ResourceRow]:
        return [self._res(r) for r in self._all('SELECT * FROM "Resource" WHERE "customerId" = %s', customer_id)]

    def get_resource(self, customer_id: str, resource_id: str) -> ResourceRow | None:
        r = self._one('SELECT * FROM "Resource" WHERE id = %s AND "customerId" = %s', resource_id, customer_id)
        return self._res(r) if r else None

    def upsert_resource(self, row: ResourceRow) -> ResourceRow:
        r = self._one(
            '''INSERT INTO "Resource" (id, "customerId", "cloudAccountId", region, "resourceType", "resourceArn",
                 "resourceKey", name, tags, "monitoringTag", "monitoringState", "needsReviewSince", "needsReviewReason",
                 "monitoringTagSetBy", "lastSeenAt", "discoveryRunId", "updatedAt")
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::"MonitoringTag",%s::"MonitoringState",%s,%s,%s::"TagSetBy",%s,%s,now())
               ON CONFLICT ("cloudAccountId", region, "resourceType", "resourceKey") DO UPDATE SET
                 "resourceArn" = EXCLUDED."resourceArn", name = EXCLUDED.name, tags = EXCLUDED.tags,
                 "monitoringTag" = EXCLUDED."monitoringTag", "monitoringState" = EXCLUDED."monitoringState",
                 "needsReviewSince" = EXCLUDED."needsReviewSince", "needsReviewReason" = EXCLUDED."needsReviewReason",
                 "monitoringTagSetBy" = COALESCE(EXCLUDED."monitoringTagSetBy", "Resource"."monitoringTagSetBy"),
                 "lastSeenAt" = EXCLUDED."lastSeenAt", "discoveryRunId" = EXCLUDED."discoveryRunId", "updatedAt" = now()
               WHERE "Resource"."customerId" = EXCLUDED."customerId"
               RETURNING *''',
            row.id, row.customer_id, row.cloud_account_id, row.region, row.resource_type, row.resource_arn,
            row.resource_key, row.name, Jsonb(row.tags), row.monitoring_tag, row.monitoring_state,
            row.needs_review_since, row.needs_review_reason, row.monitoring_tag_set_by, row.last_seen_at,
            row.discovery_run_id)
        if r is None:
            raise PermissionError("resource belongs to another customer")
        return self._res(r)

    # thresholds
    @staticmethod
    def _lv(r: dict | None) -> LayerValues | None:
        if r is None:
            return None
        return LayerValues(threshold=_f(r["threshold"]), off=r["off"], eval_m=r["evalM"], eval_n=r["evalN"],
                           period=r["periodSec"], statistic=r["statistic"])

    def threshold_defaults(self, customer_id: str, resource_type: str, metric_key: str
                           ) -> tuple[LayerValues | None, LayerValues | None]:
        cus = self._one('''SELECT * FROM "ThresholdDefault" WHERE level = 'CUSTOMER' AND "customerId" = %s
                           AND "resourceType" = %s AND "metricKey" = %s''', customer_id, resource_type, metric_key)
        msp = self._one('''SELECT * FROM "ThresholdDefault" WHERE level = 'MSP' AND "customerId" IS NULL
                           AND "resourceType" = %s AND "metricKey" = %s''', resource_type, metric_key)
        return self._lv(cus), self._lv(msp)

    def console_values(self, customer_id: str, resource_id: str, metric_key: str) -> LayerValues | None:
        rows = self._all('''SELECT DISTINCT ON (field) field, "newValue" FROM "ThresholdChange"
                            WHERE "customerId" = %s AND "resourceId" = %s AND "metricKey" = %s
                              AND target = 'ALARM' AND "applyStatus" = 'APPLIED'
                            ORDER BY field, at DESC''', customer_id, resource_id, metric_key)
        if not rows:
            return None
        by = {r["field"]: r["newValue"] for r in rows}
        ev = by.get("EVAL") or {}
        return LayerValues(threshold=_f(by.get("THRESHOLD")), off=bool(by.get("OFF")),
                           eval_m=ev.get("m") if isinstance(ev, dict) else None,
                           eval_n=ev.get("n") if isinstance(ev, dict) else None)

    # managed alarms
    @staticmethod
    def _ma(r: dict) -> ManagedAlarmRow:
        return ManagedAlarmRow(
            id=r["id"], customer_id=r["customerId"], resource_id=r["resourceId"], cloud_account_id=r["cloudAccountId"],
            region=r["region"], metric_key=r["metricKey"], alarm_name=r["alarmName"], alarm_arn=r["alarmArn"],
            severity=_sev_engine(r["severity"]), severity_manual=r["severityManual"], threshold=float(r["threshold"]),
            threshold_source=r["thresholdSource"], console_threshold=_f(r["consoleThreshold"]), eval_m=r["evalM"],
            eval_n=r["evalN"], eval_source=r["evalSource"], comparison=r["comparison"], statistic=r["statistic"],
            period=r["period"], treat_missing_data=r["treatMissingData"], drift_status=r["driftStatus"],
            drift_detail=r["driftDetail"], last_synced_at=r["lastSyncedAt"], version=r["version"],
        )

    def list_managed_alarms(self, customer_id: str, resource_id: str) -> dict[str, ManagedAlarmRow]:
        return {r["metricKey"]: self._ma(r) for r in self._all(
            'SELECT * FROM "ManagedAlarm" WHERE "customerId" = %s AND "resourceId" = %s', customer_id, resource_id)}

    def get_managed_alarm(self, customer_id: str, managed_alarm_id: str) -> ManagedAlarmRow | None:
        r = self._one('SELECT * FROM "ManagedAlarm" WHERE id = %s AND "customerId" = %s', managed_alarm_id, customer_id)
        return self._ma(r) if r else None

    def upsert_managed_alarm(self, row: ManagedAlarmRow) -> ManagedAlarmRow:
        r = self._one(
            '''INSERT INTO "ManagedAlarm" (id, "customerId", "resourceId", "cloudAccountId", region, "metricKey",
                 "alarmName", "alarmArn", severity, "severityManual", threshold, "thresholdSource", "consoleThreshold",
                 "evalM", "evalN", "evalSource", comparison, statistic, period, "treatMissingData", "driftStatus",
                 "driftDetail", "lastSyncedAt")
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::"Severity",%s,%s,%s::"ValueSource",%s,%s,%s,%s::"ValueSource",
                       %s,%s,%s,%s,%s::"DriftStatus",%s,%s)
               ON CONFLICT ("resourceId", "metricKey") DO UPDATE SET
                 "alarmName" = EXCLUDED."alarmName", "alarmArn" = EXCLUDED."alarmArn", region = EXCLUDED.region,
                 severity = EXCLUDED.severity, "severityManual" = EXCLUDED."severityManual",
                 threshold = EXCLUDED.threshold, "thresholdSource" = EXCLUDED."thresholdSource",
                 "consoleThreshold" = EXCLUDED."consoleThreshold", "evalM" = EXCLUDED."evalM",
                 "evalN" = EXCLUDED."evalN", "evalSource" = EXCLUDED."evalSource", comparison = EXCLUDED.comparison,
                 statistic = EXCLUDED.statistic, period = EXCLUDED.period,
                 "treatMissingData" = EXCLUDED."treatMissingData", "driftStatus" = EXCLUDED."driftStatus",
                 "driftDetail" = EXCLUDED."driftDetail", "lastSyncedAt" = EXCLUDED."lastSyncedAt",
                 version = "ManagedAlarm".version + 1
               WHERE "ManagedAlarm"."customerId" = EXCLUDED."customerId"
               RETURNING *''',
            row.id, row.customer_id, row.resource_id, row.cloud_account_id, row.region, row.metric_key, row.alarm_name,
            row.alarm_arn, _sev_db(row.severity), row.severity_manual, row.threshold, row.threshold_source,
            row.console_threshold, row.eval_m, row.eval_n, row.eval_source, row.comparison, row.statistic, row.period,
            row.treat_missing_data, row.drift_status, Jsonb(row.drift_detail) if row.drift_detail is not None else None,
            row.last_synced_at)
        if r is None:
            raise PermissionError("managed alarm belongs to another customer")
        return self._ma(r)

    def delete_managed_alarm(self, customer_id: str, resource_id: str, metric_key: str) -> None:
        self._exec('DELETE FROM "ManagedAlarm" WHERE "customerId" = %s AND "resourceId" = %s AND "metricKey" = %s',
                   customer_id, resource_id, metric_key)

    # threshold changes (applyStatus / error only)
    def claim_threshold_change(self, customer_id: str, change_id: str, command_id: str) -> ThresholdChangeRow | None:
        r = self._one('''SELECT * FROM "ThresholdChange" WHERE id = %s AND "customerId" = %s
                         AND "applyStatus" = 'PENDING' ''', change_id, customer_id)
        if r is None:
            return None
        return ThresholdChangeRow(id=r["id"], customer_id=r["customerId"], target=r["target"], field=r["field"],
                                  resource_type=r["resourceType"], metric_key=r["metricKey"], new_value=r["newValue"],
                                  managed_alarm_id=r["managedAlarmId"], resource_id=r["resourceId"],
                                  apply_status=r["applyStatus"], command_id=r["commandId"], error=r["error"], at=r["at"])

    def finish_threshold_change(self, customer_id: str, change_id: str, status: str, error: str | None = None) -> None:
        self._exec('''UPDATE "ThresholdChange" SET "applyStatus" = %s::"ApplyStatus", error = %s
                      WHERE id = %s AND "customerId" = %s AND "applyStatus" = 'PENDING' ''',
                   status, error, change_id, customer_id)

    # sync runs
    def start_sync_run(self, customer_id: str, cloud_account_id: str, mode: str) -> str:
        rid = f"run_{uuid.uuid4().hex}"
        self._exec('''INSERT INTO "AlarmSyncRun" (id, "customerId", "cloudAccountId", mode, "startedAt", "heartbeatAt")
                      VALUES (%s,%s,%s,%s::"SyncMode",now(),now())''', rid, customer_id, cloud_account_id, mode)
        return rid

    def heartbeat_sync_run(self, customer_id: str, run_id: str) -> None:
        self._exec('UPDATE "AlarmSyncRun" SET "heartbeatAt" = now() WHERE id = %s AND "customerId" = %s',
                   run_id, customer_id)

    def finish_sync_run(self, customer_id: str, run_id: str, status: str, counts: dict,
                        error: str | None = None) -> None:
        self._exec('''UPDATE "AlarmSyncRun" SET status = %s::"SyncStatus", counts = %s, error = %s, "finishedAt" = now()
                      WHERE id = %s AND "customerId" = %s''', status, Jsonb(counts), error, run_id, customer_id)

    def fail_stale_sync_runs(self, older_than: timedelta) -> int:
        return self._exec('''UPDATE "AlarmSyncRun" SET status = 'FAILED', error = 'stale: no heartbeat (timeout)',
                               "finishedAt" = now()
                             WHERE status = 'RUNNING' AND COALESCE("heartbeatAt", "startedAt") < now() - %s''',
                          older_than)

    # remediation
    def get_remediation_policy(self, customer_id: str) -> RemediationPolicyRow:
        r = self._one('SELECT * FROM "RemediationPolicy" WHERE "customerId" = %s', customer_id)
        if r is None:
            return RemediationPolicyRow(customer_id)
        return RemediationPolicyRow(customer_id, r["enabled"], r["mode"], tuple(r["actions"] or ()))

    @staticmethod
    def _rr(r: dict) -> RemediationRequestRow:
        return RemediationRequestRow(
            id=r["id"], customer_id=r["customerId"], cloud_account_id=r["cloudAccountId"], resource_id=r["resourceId"],
            action=r["action"], status=r["status"], trigger=r["trigger"], requested_at=r["requestedAt"],
            expires_at=r["expiresAt"], decided_by=r["decidedBy"], decided_at=r["decidedAt"],
            decision_via=r["decisionVia"], executed_at=r["executedAt"], result=r["result"], version=r["version"])

    def create_remediation_request(self, row: RemediationRequestRow) -> RemediationRequestRow | None:
        r = self._one('''INSERT INTO "RemediationRequest" (id, "customerId", "cloudAccountId", "resourceId", trigger,
                           action, status, "requestedAt", "expiresAt")
                         VALUES (%s,%s,%s,%s,%s,%s::"RemediationAction",%s::"RemediationStatus",%s,%s)
                         ON CONFLICT DO NOTHING RETURNING *''',
                      row.id, row.customer_id, row.cloud_account_id, row.resource_id, Jsonb(row.trigger), row.action,
                      row.status, row.requested_at, row.expires_at)
        return self._rr(r) if r else None

    def get_remediation_request(self, customer_id: str | None, request_id: str) -> RemediationRequestRow | None:
        if customer_id is None:
            r = self._one('SELECT * FROM "RemediationRequest" WHERE id = %s', request_id)
        else:
            r = self._one('SELECT * FROM "RemediationRequest" WHERE id = %s AND "customerId" = %s',
                          request_id, customer_id)
        return self._rr(r) if r else None

    def transition_remediation(self, customer_id: str, request_id: str, from_status: str, to_status: str,
                               result: dict | None = None) -> bool:
        return self._exec('''UPDATE "RemediationRequest" SET status = %s::"RemediationStatus",
                               result = COALESCE(%s, result), version = version + 1,
                               "executedAt" = CASE WHEN %s IN ('SUCCEEDED','FAILED') THEN now() ELSE "executedAt" END
                             WHERE id = %s AND "customerId" = %s AND status = %s::"RemediationStatus"''',
                          to_status, Jsonb(result) if result is not None else None, to_status, request_id,
                          customer_id, from_status) == 1
