"""Production wiring (Lambda). Not exercised by tests: real boto3/STS and DATABASE_URL."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from typing import Any

from alarm_engine.aws import DEFAULT_ALARM_LIMIT, SessionFactory
from alarm_engine.engine import Engine
from alarm_engine.repository import Repository


def alarm_limit_from_env(env: Mapping[str, str] | None = None) -> int:
    """Per account+region metric-alarm quota the engine refuses to exceed (`ALARMOPS_ALARM_LIMIT`, default 5000)."""
    raw = (os.environ if env is None else env).get("ALARMOPS_ALARM_LIMIT", "").strip()
    return int(raw) if raw.isdigit() and int(raw) > 0 else DEFAULT_ALARM_LIMIT


def make_engine(repo: Repository, sessions: SessionFactory) -> Engine:
    """Engine with the real collectors (Reader role). Tests pass fake sessions (Stubber clients)."""
    from alarm_engine.collectors import AwsDiscovery
    return Engine(repo, sessions, AwsDiscovery(sessions), alarm_limit=alarm_limit_from_env())


def resolve_database_url(env: Mapping[str, str] | None = None, client_factory: Callable[..., Any] | None = None) -> str:
    """Connection string for the engine DB user. In Lambda it is read from Secrets Manager (`DATABASE_URL_SECRET_ARN`,
    infra/aws/central.yaml) at cold start; `DATABASE_URL` is the local/test fallback. The value is never logged and
    never put in an exception message. The secret holds the bare string (a JSON object with `url` is accepted)."""
    env = os.environ if env is None else env
    arn = env.get("DATABASE_URL_SECRET_ARN")
    if arn:
        import json

        if client_factory is None:
            import boto3
            client_factory = boto3.client
        client = client_factory("secretsmanager", region_name=env.get("AWS_REGION", "ap-northeast-2"))
        raw = (client.get_secret_value(SecretId=arn).get("SecretString") or "").strip()
        if raw.startswith("{"):
            try:
                obj = json.loads(raw)
            except ValueError:
                obj = {}
            raw = str(obj.get("url") or obj.get("DATABASE_URL") or "").strip() if isinstance(obj, dict) else ""
        if not raw:
            raise RuntimeError("DATABASE_URL_SECRET_ARN: the secret has no usable connection string")
        return raw
    if env.get("AWS_LAMBDA_FUNCTION_NAME"):
        # In Lambda the connection string only comes from Secrets Manager, never from a plain environment variable.
        raise RuntimeError("DATABASE_URL_SECRET_ARN is required in Lambda (DATABASE_URL is not accepted)")
    url = env.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL_SECRET_ARN (or DATABASE_URL for local runs) is not set")
    return url


def build_engine() -> Engine:  # pragma: no cover
    import boto3

    from alarm_engine.aws import StsSessionFactory
    from alarm_engine.pg_repository import PgRepository

    url = resolve_database_url()
    sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    sessions = StsSessionFactory(sts, boto3.client)
    return make_engine(PgRepository(url), sessions)
