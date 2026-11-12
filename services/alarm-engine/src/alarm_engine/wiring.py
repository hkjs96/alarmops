"""Production wiring (Lambda). Not exercised by tests: real boto3/STS and DATABASE_URL."""

from __future__ import annotations

import os

from alarm_engine.engine import Engine


class _DiscoveryNotWired:
    """Collectors (29 types) are not ported in this PR — SYNC_ACCOUNT fails clearly instead of seeing 0 resources."""

    def list_monitored(self, account, region):  # type: ignore[no-untyped-def]
        raise NotImplementedError("resource discovery collectors are not wired yet")

    def read_tags(self, account, row):  # type: ignore[no-untyped-def]
        return None

    def alive(self, account, region, resource_type, keys):  # type: ignore[no-untyped-def]
        return {k: None for k in keys}


def build_engine() -> Engine:  # pragma: no cover
    import boto3

    from alarm_engine.aws import StsSessionFactory
    from alarm_engine.pg_repository import PgRepository

    url = os.environ["DATABASE_URL"]
    sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    return Engine(PgRepository(url), StsSessionFactory(sts, boto3.client), _DiscoveryNotWired())
