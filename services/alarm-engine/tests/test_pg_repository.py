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


def test_find_active_account_by_aws_id_skips_non_active_customers(pg):
    """CloudTrail events carry only the AWS account id; a SUSPENDED/TERMINATED customer is never synced (D-43)."""
    pg._exec('''UPDATE "Customer" SET status = 'ACTIVE' WHERE id = 'cus_1' ''')
    acc = pg.find_active_account_by_aws_id("111122223333")
    assert acc is not None and acc.id == "acc_1" and acc.customer_id == "cus_1"
    assert pg.find_active_account_by_aws_id("999999999999") is None
    pg._exec('''UPDATE "Customer" SET status = 'SUSPENDED' WHERE id = 'cus_1' ''')
    assert pg.find_active_account_by_aws_id("111122223333") is None


def test_find_active_account_requires_enabled_and_not_purged(pg):
    pg._exec('''UPDATE "Customer" SET status = 'ACTIVE' WHERE id = 'cus_1' ''')
    assert pg.find_active_account_by_aws_id("111122223333") is not None
    pg._exec('''UPDATE "CloudAccount" SET disabled = true WHERE id = 'acc_1' ''')
    assert pg.find_active_account_by_aws_id("111122223333") is None
    pg._exec('''UPDATE "CloudAccount" SET disabled = false, "connectionPurgedAt" = now() WHERE id = 'acc_1' ''')
    assert pg.find_active_account_by_aws_id("111122223333") is None
    pg._exec('''UPDATE "CloudAccount" SET "connectionPurgedAt" = NULL WHERE id = 'acc_1' ''')
    assert pg.find_active_account_by_aws_id("111122223333") is not None


def test_sync_run_started_since_is_account_scoped_and_windowed(pg):
    from datetime import timedelta
    assert not pg.sync_run_started_since("acc_other", timedelta(minutes=10))
    pg.start_sync_run("cus_1", "acc_1", "TAG_RECONCILE")
    assert pg.sync_run_started_since("acc_1", timedelta(minutes=10))
    assert not pg.sync_run_started_since("acc_1", timedelta(seconds=-1))


# ── #123 periodic sync: claim_sync_run (advisory lock) and the fan-out target list ────────────────────────────────

def _acct(pg, aid: str, cus: str, aws: str, **cols) -> None:
    pg._exec('''INSERT INTO "CloudAccount" (id, "customerId", "awsAccountId", "externalId", "readerRoleArn",
                "eventForwarderRoleArn", "alarmWriterRoleArn", "alarmWriterEnabled", "updatedAt")
                VALUES (%s,%s,%s,'ext','arn:r','arn:fw','arn:w',true,now())''', aid, cus, aws)
    for col, val in cols.items():
        pg._exec(f'UPDATE "CloudAccount" SET "{col}" = %s WHERE id = %s', val, aid)


def _running(pg, acct: str) -> int:
    return pg._one('SELECT count(*) AS n FROM "AlarmSyncRun" WHERE "cloudAccountId" = %s AND status = \'RUNNING\'',
                   acct)["n"]


def test_list_active_accounts_matches_the_fan_out_rule(pg):
    for cid, status in (("cus_p_act", "ACTIVE"), ("cus_p_sus", "SUSPENDED")):
        pg._exec('''INSERT INTO "Customer" (id, name, slug, status, "updatedAt") VALUES (%s,%s,%s,%s::"CustomerStatus",now())''',
                 cid, cid, cid, status)
    _acct(pg, "acc_p_ok1", "cus_p_act", "300000000001")
    _acct(pg, "acc_p_ok2", "cus_p_act", "300000000002")
    _acct(pg, "acc_p_sus", "cus_p_sus", "300000000003")
    _acct(pg, "acc_p_dis", "cus_p_act", "300000000004", disabled=True)
    pg._exec('''INSERT INTO "CloudAccount" (id, "customerId", "awsAccountId", "externalId", "readerRoleArn",
                "eventForwarderRoleArn", "alarmWriterRoleArn", "connectionPurgedAt", "updatedAt")
                VALUES ('acc_p_pur','cus_p_act','300000000005','e','arn:r','arn:fw','arn:w',now(),now())''')
    got = {(a.id, a.customer_id) for a in pg.list_active_accounts() if a.id.startswith("acc_p_")}
    assert got == {("acc_p_ok1", "cus_p_act"), ("acc_p_ok2", "cus_p_act")}


def test_claim_sync_run_lets_exactly_one_of_two_concurrent_callers_win(pg):
    import threading

    from alarm_engine.pg_repository import PgRepository
    pg._exec('''INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ('cus_p_c','C','pc',now())
                ON CONFLICT DO NOTHING''')
    url = URL.rsplit("/", 1)[0] + "/" + pg.conn.info.dbname      # info.dsn omits the password
    for rnd in range(15):
        acct = f"acc_p_claim{rnd}"
        _acct(pg, acct, "cus_p_c", f"4000000000{rnd:02d}")
        repos = [PgRepository(url), PgRepository(url)]
        barrier = threading.Barrier(2)
        results: list = [None, None]
        errors: list = []

        def go(i, repos=repos, barrier=barrier, results=results, errors=errors, acct=acct):
            try:
                barrier.wait()
                results[i] = repos[i].claim_sync_run("cus_p_c", acct, "DAILY", timedelta(minutes=20))
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        ts = [threading.Thread(target=go, args=(i,)) for i in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for r in repos:
            r.conn.close()
        assert errors == []
        assert sorted(x is None for x in results) == [False, True]
        assert _running(pg, acct) == 1


def test_claim_sync_run_respects_staleness_and_tenant_account_scope(pg):
    pg._exec('''INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ('cus_p_c','C','pc',now())
                ON CONFLICT DO NOTHING''')
    _acct(pg, "acc_p_st", "cus_p_c", "500000000001")
    _acct(pg, "acc_p_st2", "cus_p_c", "500000000002")
    stale = timedelta(minutes=20)
    first = pg.claim_sync_run("cus_p_c", "acc_p_st", "TAG_RECONCILE", stale)
    assert first is not None
    assert pg.claim_sync_run("cus_p_c", "acc_p_st", "DAILY", stale) is None
    assert pg.claim_sync_run("cus_p_c", "acc_p_st2", "DAILY", stale) is not None      # other account is independent
    pg._exec('''UPDATE "AlarmSyncRun" SET "heartbeatAt" = now() - interval '21 minutes' WHERE id = %s''', first)
    assert pg.claim_sync_run("cus_p_c", "acc_p_st", "DAILY", stale) is not None       # stale row no longer blocks
    pg.finish_sync_run("cus_p_c", first, "FAILED", {})


def test_existing_duplicate_running_rows_mean_busy_then_stale_cleanup_replaces_them(pg):
    from alarm_engine.engine import Engine
    from conftest import FakeDiscovery, FakeSessions
    pg._exec('''INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ('cus_p_c','C','pc',now())
                ON CONFLICT DO NOTHING''')
    _acct(pg, "acc_p_dup", "cus_p_c", "600000000001")
    for rid in ("run_dup1", "run_dup2"):
        pg._exec('''INSERT INTO "AlarmSyncRun" (id, "customerId", "cloudAccountId", mode, "startedAt", "heartbeatAt")
                    VALUES (%s,'cus_p_c','acc_p_dup','DAILY'::"SyncMode",now(),now())''', rid)
    eng = Engine(pg, FakeSessions(), FakeDiscovery())
    assert eng.sync_account("acc_p_dup", "DAILY") == {"skipped": "BUSY"}
    assert pg._one('SELECT count(*) AS n FROM "AlarmSyncRun" WHERE "cloudAccountId" = %s', "acc_p_dup")["n"] == 2
    pg._exec('''UPDATE "AlarmSyncRun" SET "heartbeatAt" = now() - interval '21 minutes' WHERE "cloudAccountId" = 'acc_p_dup' ''')
    assert pg.fail_stale_sync_runs(timedelta(minutes=20)) >= 2
    states = {r["id"]: r["status"] for r in pg._all('SELECT id, status FROM "AlarmSyncRun" WHERE "cloudAccountId" = %s',
                                                    "acc_p_dup")}
    assert states["run_dup1"] == "FAILED" and states["run_dup2"] == "FAILED"
    assert pg.claim_sync_run("cus_p_c", "acc_p_dup", "DAILY", timedelta(minutes=20)) is not None
    assert _running(pg, "acc_p_dup") == 1
