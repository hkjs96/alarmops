"""Lambda entry point: Secrets Manager DB URL, container reuse, remaining-time cutoff. No AWS calls (stub clients)."""

from __future__ import annotations

import json
import logging

import pytest

from alarm_engine import handler, pg_repository, wiring

URL = "postgresql://engine:s3cr3t-pw@db.example.test:5432/postgres"
ARN = "arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:alarmops-engine-db-AbCdEf"


class FakeSecrets:
    def __init__(self, value: str | None) -> None:
        self.value, self.calls = value, []

    def get_secret_value(self, **kw):
        self.calls.append(kw)
        return {"SecretString": self.value} if self.value is not None else {}


def factory(client):
    seen = {}

    def make(service, **kw):
        seen["service"], seen["kw"] = service, kw
        return client

    make.seen = seen
    return make


def test_url_from_secret_when_arn_set():
    c = FakeSecrets(URL + "\n")
    f = factory(c)
    assert wiring.resolve_database_url({"DATABASE_URL_SECRET_ARN": ARN, "DATABASE_URL": "ignored"}, f) == URL
    assert c.calls == [{"SecretId": ARN}]
    assert f.seen["service"] == "secretsmanager"


def test_json_secret_and_empty_secret():
    assert wiring.resolve_database_url({"DATABASE_URL_SECRET_ARN": ARN}, factory(FakeSecrets(json.dumps({"url": URL})))) == URL
    with pytest.raises(RuntimeError) as e:
        wiring.resolve_database_url({"DATABASE_URL_SECRET_ARN": ARN}, factory(FakeSecrets(None)))
    assert "s3cr3t" not in str(e.value)
    with pytest.raises(RuntimeError):
        wiring.resolve_database_url({"DATABASE_URL_SECRET_ARN": ARN}, factory(FakeSecrets('{"password": "s3cr3t-pw"')))


def test_env_fallback_and_unset():
    assert wiring.resolve_database_url({"DATABASE_URL": URL}, factory(FakeSecrets("x"))) == URL
    with pytest.raises(RuntimeError):
        wiring.resolve_database_url({})


def rec(i: int, cmd_type: str = "SYNC_RESOURCE") -> dict:
    body = {"schemaVersion": 1, "commandId": f"c{i}", "type": cmd_type, "customerId": "cus_1",
            "payload": {"resourceId": f"r{i}"}}
    return {"messageId": f"m{i}", "body": json.dumps(body)}


class Ctx:
    def __init__(self, *remaining: int) -> None:
        self.values = list(remaining)

    def get_remaining_time_in_millis(self) -> int:
        return self.values.pop(0) if len(self.values) > 1 else self.values[0]


def test_remaining_time_cutoff_returns_unstarted_records(monkeypatch):
    done = []
    monkeypatch.setattr(handler, "dispatch", lambda eng, cmd, *a, **k: done.append(cmd["commandId"]) or {"status": "OK"})
    ctx = Ctx(100_000, 90_000, 20_000)  # third record sees 20 s < 30 s margin
    out = handler.handle_batch(object(), {"Records": [rec(1), rec(2), rec(3), rec(4)]}, ctx.get_remaining_time_in_millis)
    assert done == ["c1", "c2"]
    assert out == {"batchItemFailures": [{"itemIdentifier": "m3"}, {"itemIdentifier": "m4"}]}


def test_no_cutoff_without_context_and_failure_mapping(monkeypatch):
    def dispatch(eng, cmd, *a, **k):
        if cmd["commandId"] == "c2":
            raise RuntimeError("aws down")
        if cmd["commandId"] == "c3":
            raise handler.InvalidCommand("poison")
        return {"status": "OK"}

    monkeypatch.setattr(handler, "dispatch", dispatch)
    out = handler.handle_batch(object(), {"Records": [rec(1), rec(2), rec(3), {"messageId": "m4", "body": "nope"}]})
    assert out == {"batchItemFailures": [{"itemIdentifier": "m2"}]}


def test_lambda_handler_builds_engine_once_and_uses_context(monkeypatch):
    monkeypatch.setattr(handler, "_ENGINE", None)
    built = []
    monkeypatch.setattr(wiring, "build_engine", lambda: built.append(1) or object())
    monkeypatch.setattr(handler, "dispatch", lambda eng, cmd, *a, **k: {"status": "OK"})
    monkeypatch.setenv("ALARMOPS_TIME_MARGIN_MS", "5000")
    ev = {"Records": [rec(1), rec(2)]}
    assert handler.lambda_handler(ev, Ctx(4_000))["batchItemFailures"] == [{"itemIdentifier": "m1"}, {"itemIdentifier": "m2"}]
    assert handler.lambda_handler(ev, Ctx(60_000)) == {"batchItemFailures": []}
    assert built == [1]


def test_engine_init_failure_fails_whole_batch_without_leaking(monkeypatch, caplog):
    monkeypatch.setattr(handler, "_ENGINE", None)

    def boom():
        raise RuntimeError(f"could not connect {URL}")

    monkeypatch.setattr(wiring, "build_engine", boom)
    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({"Records": [rec(1), rec(2)]}, Ctx(60_000))
    assert [f["itemIdentifier"] for f in out["batchItemFailures"]] == ["m1", "m2"]
    assert "s3cr3t" not in caplog.text
    assert handler._ENGINE is None  # retried on the next invocation


def test_lambda_refuses_plain_database_url():
    with pytest.raises(RuntimeError) as e:
        wiring.resolve_database_url({"AWS_LAMBDA_FUNCTION_NAME": "alarmops-alarm-engine", "DATABASE_URL": URL})
    assert "s3cr3t" not in str(e.value)


def test_tls_required_in_lambda_only():
    lam = {"AWS_LAMBDA_FUNCTION_NAME": "alarmops-alarm-engine"}
    for mode in ("require", "verify-ca", "verify-full"):
        pg_repository.require_tls_in_lambda(f"{URL}?sslmode={mode}", lam)
    for q in ("", "?sslmode=disable", "?sslmode=allow", "?sslmode=prefer"):
        with pytest.raises(RuntimeError) as e:
            pg_repository.require_tls_in_lambda(URL + q, lam)
        assert "s3cr3t" not in str(e.value)
    pg_repository.require_tls_in_lambda(URL, {})  # local runs are not enforced


class DbError(Exception):
    sqlstate = "08006"


def test_logs_carry_type_and_code_only(monkeypatch, caplog):
    def dispatch(eng, cmd, *a, **k):
        raise DbError(f"connection to {URL} failed")

    monkeypatch.setattr(handler, "dispatch", dispatch)
    with caplog.at_level(logging.ERROR):
        out = handler.handle_batch(object(), {"Records": [rec(1)]})
    assert out["batchItemFailures"] == [{"itemIdentifier": "m1"}]
    assert "DbError code=08006" in caplog.text
    assert "s3cr3t" not in caplog.text and "db.example.test" not in caplog.text
    assert "Traceback" not in caplog.text
