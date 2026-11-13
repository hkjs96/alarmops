"""PgRepository against a real Postgres with the Prisma migrations applied.

Runs only when ALARM_ENGINE_TEST_PG_URL points at a throwaway server (it creates and drops its own database).
Otherwise every test here is skipped with that reason. Local recipe (Postgres binaries at /opt/pglocal, run as nobody):
  runuser -u nobody -- /opt/pglocal/native/bin/initdb -D <dir> -U postgres --auth=trust
  runuser -u nobody -- /opt/pglocal/native/bin/pg_ctl -D <dir> -o "-p 54331 -c listen_addresses=127.0.0.1" start
  ALARM_ENGINE_TEST_PG_URL=postgresql://postgres@127.0.0.1:54331/postgres pytest
"""

from __future__ import annotations

import os
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb

URL = os.environ.get("ALARM_ENGINE_TEST_PG_URL")
pytestmark = [pytest.mark.pg, pytest.mark.skipif(not URL, reason="ALARM_ENGINE_TEST_PG_URL not set (no local Postgres)")]

MIGRATIONS = Path(__file__).resolve().parents[3] / "db" / "prisma" / "migrations"


@pytest.fixture(scope="module")
def pg():
    import psycopg

    from alarm_engine.pg_repository import PgRepository
    name = f"alarm_engine_{uuid.uuid4().hex[:8]}"
    admin = psycopg.connect(URL, autocommit=True)
    admin.execute(f"CREATE DATABASE \"{name}\" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0")
    url = URL.rsplit("/", 1)[0] + f"/{name}"
    with psycopg.connect(url, autocommit=True) as c:
        for mig in sorted(p for p in MIGRATIONS.iterdir() if p.is_dir()):
            c.execute((mig / "migration.sql").read_text(encoding="utf-8"))
        c.execute('''INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ('cus_1','A','a',now()),
                     ('cus_2','B','b',now())''')
        c.execute('''INSERT INTO "CloudAccount" (id, "customerId", "awsAccountId", "externalId", "readerRoleArn",
                     "eventForwarderRoleArn", "alarmWriterRoleArn", "alarmWriterEnabled", "updatedAt")
                     VALUES ('acc_1','cus_1','111122223333','ext-123','arn:aws:iam::111122223333:role/AlarmOpsReader',
                     'arn:fw','arn:aws:iam::111122223333:role/AlarmOpsAlarmWriter',true,now())''')
    repo = PgRepository(url)
    yield repo
    repo.conn.close()
    admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
    admin.close()


def test_full_sync_against_postgres(pg):
    from alarm_engine.engine import Engine
    from conftest import FakeDiscovery, FakeSessions, ec2
    sessions, disc = FakeSessions(), FakeDiscovery(resources=[ec2()])
    eng = Engine(pg, sessions, disc)
    counts = eng.sync_account("acc_1", "DAILY")
    assert counts["created"] == 3
    rows = pg.list_resources("acc_1")
    assert len(rows) == 1 and rows[0].monitoring_state == "MONITORED"
    alarms = pg.list_managed_alarms("cus_1", rows[0].id)
    assert alarms["CPUUtilization"].severity == "SEV-3" and alarms["CPUUtilization"].threshold == 80.0
    assert pg.list_managed_alarms("cus_2", rows[0].id) == {}          # tenant scoping
    assert pg.get_resource("cus_2", rows[0].id) is None
    # idempotent second run, then D-16
    sessions.cw("ap-northeast-2").calls.clear()
    eng.sync_account("acc_1", "TAG_RECONCILE")
    assert sessions.cw("ap-northeast-2").writes() == []
    disc.resources, disc.alive_map, disc.tags_map = [], {"i-0abc": True}, {"i-0abc": {}}
    eng.sync_account("acc_1", "TAG_RECONCILE")
    assert pg.list_resources("acc_1")[0].monitoring_state == "NEEDS_REVIEW"
    run = pg._all('SELECT status, counts FROM "AlarmSyncRun" ORDER BY "startedAt"')
    assert [r["status"] for r in run] == ["SUCCEEDED"] * 3
    assert pg.fail_stale_sync_runs(timedelta(minutes=20)) == 0


def test_threshold_change_claim_is_conditional(pg):
    pg._exec('''INSERT INTO "ThresholdChange" (id, "customerId", target, "resourceType", "metricKey", field,
                "newValue", "actorType", "resourceId") VALUES ('tc1','cus_1','ALARM','EC2','CPUUtilization','THRESHOLD',
                '70','USER','r1')''')
    assert pg.claim_threshold_change("cus_2", "tc1", "c") is None
    assert pg.claim_threshold_change("cus_1", "tc1", "c") is not None
    pg.finish_threshold_change("cus_1", "tc1", "APPLIED")
    assert pg.claim_threshold_change("cus_1", "tc1", "c") is None
    assert pg.console_values("cus_1", "r1", "CPUUtilization").threshold == 70.0


def test_threshold_defaults_and_remediation_transitions(pg):
    pg._exec('''INSERT INTO "ThresholdDefault" (id, level, "customerId", "resourceType", "metricKey", threshold,
                "periodSec", "updatedAt") VALUES ('d1','MSP',NULL,'EC2','CPUUtilization',85,60,now()),
                ('d2','CUSTOMER','cus_1','EC2','CPUUtilization',75,NULL,now())''')
    cus, msp = pg.threshold_defaults("cus_1", "EC2", "CPUUtilization")
    assert (cus.threshold, msp.threshold, msp.period) == (75.0, 85.0, 60)
    assert pg.threshold_defaults("cus_2", "EC2", "CPUUtilization")[0] is None
    assert pg.get_remediation_policy("cus_1").enabled is False
    from alarm_engine.repository import RemediationRequestRow
    rid = pg.list_resources("acc_1")[0].id
    r = pg.create_remediation_request(RemediationRequestRow("rq1", "cus_1", "acc_1", rid, "EC2_STOP",
                                                            "PENDING_APPROVAL", {"e": 1}))
    assert r is not None
    assert pg.create_remediation_request(RemediationRequestRow("rq2", "cus_1", "acc_1", rid, "EC2_STOP",
                                                               "PENDING_APPROVAL", {})) is None
    assert pg.transition_remediation("cus_1", "rq1", "APPROVED", "EXECUTING") is False   # not APPROVED yet
    assert pg.transition_remediation("cus_2", "rq1", "PENDING_APPROVAL", "APPROVED") is False   # other customer: no row


def test_offboarding_result_is_merged_under_a_row_lock_and_scoped_by_customer(pg):
    """D-43: the engine writes only steps.ALARMS_DELETED (and completedAt when every step is DONE)."""
    pg._exec('''UPDATE "Customer" SET status = 'TERMINATED' WHERE id = 'cus_1' ''')
    pg._exec('''INSERT INTO "CustomerOffboarding" (id, "customerId", "startedByUserId", reason, steps) VALUES
                ('ob_1','cus_1','usr_1','contract ended', %s)''', Jsonb({
        "PAGING_STOPPED": {"state": "DONE"}, "ALARMS_DELETED": {"state": "PENDING"},
        "CUSTOMER_STACK_REMOVED": {"state": "DONE"}, "ACCOUNTS_DISABLED": {"state": "DONE"},
        "BUS_ALLOWLIST_REMOVED": {"state": "DONE"}}))
    assert pg.get_offboarding("cus_2", "ob_1") is None                    # another customer's id: not found
    ob = pg.get_offboarding("cus_1", "ob_1")
    assert ob is not None and ob.customer_status == "TERMINATED"
    assert pg.customer_account_ids("cus_1") == ["acc_1"]
    with pytest.raises(LookupError):
        pg.record_offboard_result("cus_2", "ob_1", "acc_1", {"status": "OK", "deleted": 1, "failed": 0})
    assert pg.record_offboard_result("cus_1", "ob_1", "acc_1", {"status": "OK", "deleted": 3, "failed": 0}) == "DONE"
    after = pg.get_offboarding("cus_1", "ob_1")
    assert after is not None and after.steps["ALARMS_DELETED"]["accounts"]["acc_1"]["deleted"] == 3
    assert after.completed_at is not None
