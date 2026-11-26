"""D-16 end to end on moto + a real Postgres (PgRepository)."""

from __future__ import annotations

import os
import uuid
from datetime import timedelta
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from alarm_engine import events
from alarm_engine.collectors import AwsDiscovery
from alarm_engine.collectors.groups import GROUP_OF
from alarm_engine.engine import Engine
from test_d16_moto_e2e import MOTO_ACCOUNT, R, MotoSessions, _event, _managed

URL = os.environ.get("ALARM_ENGINE_TEST_PG_URL")
pytestmark = [pytest.mark.pg, pytest.mark.skipif(not URL, reason="ALARM_ENGINE_TEST_PG_URL not set")]
MIGRATIONS = Path(__file__).resolve().parents[3] / "db" / "prisma" / "migrations"


@pytest.fixture
def pgworld(monkeypatch):
    import psycopg

    from alarm_engine.pg_repository import PgRepository
    name = f"alarm_engine_{uuid.uuid4().hex[:8]}"
    admin = psycopg.connect(URL, autocommit=True)
    admin.execute(f"CREATE DATABASE \"{name}\" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0")
    url = URL.rsplit("/", 1)[0] + f"/{name}"
    with psycopg.connect(url, autocommit=True) as c:
        for mig in sorted(p for p in MIGRATIONS.iterdir() if p.is_dir()):
            c.execute((mig / "migration.sql").read_text(encoding="utf-8"))
        c.execute('''INSERT INTO "Customer" (id, name, slug, "updatedAt") VALUES ('cus_1','A','a',now())''')
        c.execute(f'''INSERT INTO "CloudAccount" (id, "customerId", "awsAccountId", "externalId", "readerRoleArn",
                     "eventForwarderRoleArn", "alarmWriterRoleArn", "alarmWriterEnabled", regions, "updatedAt")
                     VALUES ('acc_1','cus_1','{MOTO_ACCOUNT}','ext-123','arn:aws:iam::{MOTO_ACCOUNT}:role/AlarmOpsReader',
                     'arn:fw','arn:aws:iam::{MOTO_ACCOUNT}:role/AlarmOpsAlarmWriter',true, ARRAY['{R}'], now())''')
    repo = PgRepository(url)
    monkeypatch.setattr(events, "RESOURCE_DEDUPE", timedelta(0))
    monkeypatch.setattr(events, "RECONCILE_DEBOUNCE", timedelta(0))
    try:
        with mock_aws():
            sess = MotoSessions()
            eng = Engine(repo, sess, AwsDiscovery(sess))
            sqs = boto3.client("sqs", region_name=R)
            qurl = sqs.create_queue(QueueName="alarmops-rehearsal-b7",
                                    tags={"Monitoring": "on", "AlarmOpsRehearsal": "true"})["QueueUrl"]
            yield repo, eng, sqs, qurl, boto3.client("cloudwatch", region_name=R)
    finally:
        repo.conn.close()
        admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        admin.close()


def test_pg_untag_event_and_syncs_keep_alarms(pgworld):
    repo, eng, sqs, qurl, cw = pgworld
    eng.sync_account("acc_1", "TAG_RECONCILE")
    before = _managed(cw)
    assert len(before) == 3
    sqs.untag_queue(QueueUrl=qurl, TagKeys=["Monitoring"])
    out = events.handle_tag_event(eng, _event("UntagQueue", qurl, ["Monitoring"]))
    assert out["status"] == "OK", out
    assert _managed(cw) == before and repo.list_resources("acc_1")[0].monitoring_state == "NEEDS_REVIEW"
    for mode in ("DAILY", "TAG_RECONCILE"):
        c = eng.sync_account("acc_1", mode)
        assert c["deleted"] == 0 and _managed(cw) == before, c
