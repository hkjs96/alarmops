"""Production wiring (Lambda). Not exercised by tests: real boto3/STS and DATABASE_URL."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from alarm_engine.aws import DEFAULT_ALARM_LIMIT, SessionFactory
from alarm_engine.engine import Engine
from alarm_engine.repository import Repository

logger = logging.getLogger(__name__)
MAX_ALARM_LIMIT = 100_000


def alarm_limit_from_env(env: Mapping[str, str] | None = None) -> int:
    """Per account+region metric-alarm quota the engine refuses to exceed (`ALARMOPS_ALARM_LIMIT`, default 5000)."""
    raw = (os.environ if env is None else env).get("ALARMOPS_ALARM_LIMIT", "")
    if not raw.strip():
        return DEFAULT_ALARM_LIMIT
    try:
        v = int(raw.strip())
    except ValueError:
        v = 0
    if 1 <= v <= MAX_ALARM_LIMIT and raw.strip().isascii():
        return v
    logger.warning("ALARMOPS_ALARM_LIMIT=%r invalid (need integer 1..%d); using default %d", raw[:40], MAX_ALARM_LIMIT,
                   DEFAULT_ALARM_LIMIT)
    return DEFAULT_ALARM_LIMIT


def make_engine(repo: Repository, sessions: SessionFactory) -> Engine:
    """Engine with the real collectors (Reader role). Tests pass fake sessions (Stubber clients)."""
    from alarm_engine.collectors import AwsDiscovery
    from datetime import timedelta

    from alarm_engine.engine import DEAD_RUN_MARGIN
    return Engine(repo, sessions, AwsDiscovery(sessions), alarm_limit=alarm_limit_from_env(),
                  dead_run_after=timedelta(seconds=engine_time_limit_s()) + DEAD_RUN_MARGIN)


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

    # Periodic-sync settings and COMMANDS_QUEUE_URL are NOT checked here: a bad value must reject only the periodic
    # sync path (handler: InvalidCommand with the reason), never every command of the engine (#123).
    url = resolve_database_url()
    sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    sessions = StsSessionFactory(sts, boto3.client)
    return make_engine(PgRepository(url), sessions)


# ── periodic sync (#123) ─────────────────────────────────────────────────────────────────────────────────────────

def engine_time_limit_s(env: Mapping[str, str] | None = None) -> int:
    """Lambda timeout of the engine: `ENGINE_TIMEOUT_SECONDS` (central.yaml sets it from EngineTimeoutSeconds, so the
    value cannot drift from the template). Missing or out of range (1..900) = the template default 120."""
    from alarm_engine.engine import DEFAULT_ENGINE_TIME_LIMIT_S
    return _bounded_int(os.environ if env is None else env, "ENGINE_TIMEOUT_SECONDS", DEFAULT_ENGINE_TIME_LIMIT_S, 1, 900)


@dataclass(frozen=True)
class SyncSettings:
    fanout_spread_seconds: int = 10
    max_deferrals: int = 5
    defer_seconds: int = 300


def _bounded_int(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name, "")
    if not raw.strip():
        return default
    try:
        v = int(raw.strip())
    except ValueError:
        v = lo - 1
    if lo <= v <= hi and raw.strip().isascii():
        return v
    logger.warning("%s=%r invalid (need integer %d..%d); using default %d", name, raw[:40], lo, hi, default)
    return default


def sync_settings_from_env(env: Mapping[str, str] | None = None) -> SyncSettings:
    """Periodic-sync settings. Out-of-range values fall back to the default with a warning. The deferral budget
    (`max_deferrals x defer_seconds`) must exceed STALE_RUN_AFTER + the engine time limit, otherwise a run whose
    process died could outlive every deferral: that is refused (ValueError); the handler turns it into a rejected
    periodic-sync command (the engine itself keeps serving every other command)."""
    from alarm_engine.engine import STALE_RUN_AFTER
    env = os.environ if env is None else env
    s = SyncSettings(
        fanout_spread_seconds=_bounded_int(env, "SYNC_FANOUT_SPREAD_SECONDS", 10, 0, 900),
        max_deferrals=_bounded_int(env, "SYNC_BUSY_MAX_DEFERRALS", 5, 0, 20),
        defer_seconds=_bounded_int(env, "SYNC_BUSY_DEFER_SECONDS", 300, 1, 900),
    )
    need = int(STALE_RUN_AFTER.total_seconds()) + engine_time_limit_s(env)
    if s.max_deferrals * s.defer_seconds <= need:
        raise ValueError(f"SYNC_BUSY_MAX_DEFERRALS x SYNC_BUSY_DEFER_SECONDS = {s.max_deferrals * s.defer_seconds}s "
                         f"must exceed {need}s (stale run window + engine time limit)")
    return s


class SqsCommandSender:
    """CommandSender port: `SendMessageBatch` to the alarm-commands queue; returns the Ids that failed."""

    def __init__(self, client: Any, queue_url: str) -> None:
        self._client, self._url = client, queue_url

    def send_batch(self, entries: list[dict]) -> list[str]:
        resp = self._client.send_message_batch(QueueUrl=self._url, Entries=entries)
        return [str(f["Id"]) for f in resp.get("Failed", [])]


def build_command_sender(env: Mapping[str, str] | None = None,
                         client_factory: Callable[..., Any] | None = None) -> SqsCommandSender:
    env = os.environ if env is None else env
    url = env.get("COMMANDS_QUEUE_URL", "").strip()
    if not url:
        raise RuntimeError("COMMANDS_QUEUE_URL is not set")
    if client_factory is None:
        import boto3
        client_factory = boto3.client
    return SqsCommandSender(client_factory("sqs", region_name=env.get("AWS_REGION")), url)   # Lambda sets AWS_REGION


_SENDER: SqsCommandSender | None = None


def get_command_sender() -> SqsCommandSender:
    global _SENDER
    if _SENDER is None:
        _SENDER = build_command_sender()
    return _SENDER
