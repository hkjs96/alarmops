"""Production wiring (Lambda). Not exercised by tests: real boto3/STS and DATABASE_URL."""

from __future__ import annotations

import os

from alarm_engine.aws import SessionFactory
from alarm_engine.engine import Engine
from alarm_engine.repository import Repository


def make_engine(repo: Repository, sessions: SessionFactory) -> Engine:
    """Engine with the real collectors (Reader role). Tests pass fake sessions (Stubber clients)."""
    from alarm_engine.collectors import AwsDiscovery
    return Engine(repo, sessions, AwsDiscovery(sessions))


def build_engine() -> Engine:  # pragma: no cover
    import boto3

    from alarm_engine.aws import StsSessionFactory
    from alarm_engine.pg_repository import PgRepository

    url = os.environ["DATABASE_URL"]
    sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    sessions = StsSessionFactory(sts, boto3.client)
    return make_engine(PgRepository(url), sessions)
