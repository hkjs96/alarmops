"""Issue #123 periodic sync producer: acceptance tests written from the criteria, before the implementation.

Interface these tests assume (taken from the plan; adjust only the names, never the expectations):
- command `SYNC_ALL_ACCOUNTS` {customerId: "system", payload: {mode: DAILY|TAG_RECONCILE}}; commandId `sched-<mode>-<time>`.
- child `SYNC_ACCOUNT` commandId = `<fan-out commandId>-<cloudAccountId>`, payload {mode, deferrals?}.
- `handler.dispatch(engine, cmd, sender=...)` / `handler.handle_batch(engine, event, ..., sender=...)`; the sender is a
  CommandSender port with `send_batch(entries) -> list[failed entry Id]`; entries are SQS batch entries
  {"Id", "MessageBody", "DelaySeconds"}.
- `repo.list_active_accounts()` and `repo.claim_sync_run(customer_id, account_id, mode, stale_after) -> str | None`.
- `engine.sync_account` returns `{"skipped": "BUSY"}` when another non-stale run holds the account.
- settings are read from the environment when a command is handled (SYNC_FANOUT_SPREAD_SECONDS,
  SYNC_BUSY_MAX_DEFERRALS, SYNC_BUSY_DEFER_SECONDS); `wiring.sync_settings_from_env(env)` validates them at start.
- `wiring.build_command_sender(env, client_factory)` reads the queue URL from COMMANDS_QUEUE_URL only.
Nothing here calls AWS.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
from datetime import timedelta
from pathlib import Path

import pytest

from alarm_engine import events, handler
from alarm_engine.engine import Engine
from alarm_engine.repository import InMemoryRepository, SyncRunRow, now
from conftest import ACCOUNT_ID, FakeDiscovery, FakeSessions, ec2, make_account

TIME = "2026-11-25T09:00:00Z"
FIXTURES = Path(__file__).parent / "fixtures"


# ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeSender:
    """CommandSender port double. `fail_first` Ids fail on the first call only; `always_fail` Ids never succeed."""

    def __init__(self, fail_first: int = 0, always_fail: set[str] | None = None):
        self.batches: list[list[dict]] = []
        self.fail_first = fail_first
        self.always_fail = always_fail or set()

    def send_batch(self, entries: list[dict]) -> list[str]:
        self.batches.append([dict(e) for e in entries])
        failed = [e["Id"] for e in entries if e["Id"] in self.always_fail]
        if len(self.batches) == 1 and self.fail_first:
            failed += [e["Id"] for e in entries[: self.fail_first] if e["Id"] not in failed]
        return failed

    @property
    def entries(self) -> list[dict]:
        return [e for b in self.batches for e in b]

    def commands(self) -> list[dict]:
        return [json.loads(e["MessageBody"]) for e in self.entries]


def fanout(mode: str = "TAG_RECONCILE", time: str = TIME) -> dict:
    return {"schemaVersion": 1, "commandId": f"sched-{mode}-{time}", "type": "SYNC_ALL_ACCOUNTS",
            "customerId": "system", "payload": {"mode": mode}}


def child(acc, mode: str = "TAG_RECONCILE", deferrals: int | None = None, time: str = TIME) -> dict:
    payload: dict = {"mode": mode}
    if deferrals is not None:
        payload["deferrals"] = deferrals
    return {"schemaVersion": 1, "commandId": f"sched-{mode}-{time}-{acc.id}", "type": "SYNC_ACCOUNT",
            "customerId": acc.customer_id, "cloudAccountId": acc.id, "payload": payload}


def record(cmd: dict, mid: str = "m1") -> dict:
    return {"messageId": mid, "body": json.dumps(cmd)}


def add_accounts(repo: InMemoryRepository, n: int, customers: int = 1, prefix: str = "acc") -> list:
    out = []
    for i in range(n):
        a = make_account(id=f"{prefix}_{i:04d}", customer_id=f"cus_{i % customers}",
                         aws_account_id=f"{100000000000 + i}")
        repo.accounts[a.id] = a
        out.append(a)
    return out


def engine_of(repo: InMemoryRepository) -> Engine:
    return Engine(repo, FakeSessions(), FakeDiscovery())


def add_run(repo, acc, mode="ON_DEMAND", status="RUNNING", started_ago=timedelta(0), heartbeat_ago=timedelta(0),
            rid=None) -> SyncRunRow:
    rid = rid or f"run_{len(repo.runs)}"
    r = SyncRunRow(rid, acc.customer_id, acc.id, mode, status, started_at=now() - started_ago,
                   heartbeat_at=now() - heartbeat_ago)
    if status != "RUNNING":
        r.finished_at = r.started_at + timedelta(minutes=1)
    repo.runs[rid] = r
    return r


@pytest.fixture(autouse=True)
def _default_env(monkeypatch):
    for k in ("SYNC_FANOUT_SPREAD_SECONDS", "SYNC_BUSY_MAX_DEFERRALS", "SYNC_BUSY_DEFER_SECONDS"):
        monkeypatch.delenv(k, raising=False)


# ── [팬아웃 대상] ─────────────────────────────────────────────────────────────────────────────────────────────────

def test_fanout_sends_only_active_customer_enabled_unpurged_accounts():
    repo = InMemoryRepository()
    a1, a2, susp, dis, purged = add_accounts(repo, 5, customers=5)
    repo.customer_status[susp.customer_id] = "SUSPENDED"
    repo.disabled_accounts.add(dis.id)
    repo.purged_accounts.add(purged.id)
    sender = FakeSender()
    out = handler.dispatch(engine_of(repo), fanout("TAG_RECONCILE"), sender=sender)
    assert out["status"] == "OK"
    cmds = sender.commands()
    assert len(cmds) == 2
    assert {(c["customerId"], c["cloudAccountId"]) for c in cmds} == {(a1.customer_id, a1.id), (a2.customer_id, a2.id)}
    for c in cmds:
        assert c["type"] == "SYNC_ACCOUNT" and c["payload"]["mode"] == "TAG_RECONCILE"
        assert c["commandId"] == f"sched-TAG_RECONCILE-{TIME}-{c['cloudAccountId']}"
        assert handler.parse(json.dumps(c))["cloudAccountId"] == c["cloudAccountId"]


def test_fanout_runs_no_sync_itself():
    repo = InMemoryRepository()
    add_accounts(repo, 3)
    handler.dispatch(engine_of(repo), fanout("DAILY"), sender=FakeSender())
    assert repo.runs == {}


# ── [격리] ────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("ctype,extra", [
    ("SYNC_ACCOUNT", {"cloudAccountId": "acc_0000"}),
    ("CHECK_CONNECTION", {"cloudAccountId": "acc_0000"}),
    ("SYNC_RESOURCE", {"payload": {"resourceId": "r1"}}),
    ("OFFBOARD_ACCOUNT", {"cloudAccountId": "acc_0000", "payload": {"offboardingId": "ob_1"}}),
])
def test_system_customer_is_refused_for_every_other_type(ctype, extra):
    repo = InMemoryRepository()
    add_accounts(repo, 1)
    cmd = {"schemaVersion": 1, "commandId": "x-1", "type": ctype, "customerId": "system", **extra}
    sender = FakeSender()
    with pytest.raises(handler.InvalidCommand):
        handler.dispatch(engine_of(repo), handler.parse(json.dumps(cmd)), sender=sender)
    out = handler.handle_batch(engine_of(repo), {"Records": [record(cmd)]}, sender=sender)
    assert out == {"batchItemFailures": []}
    assert repo.runs == {} and sender.entries == []


@pytest.mark.parametrize("payload", [{"mode": "ON_DEMAND"}, {}, {"mode": None}, {"mode": "WEEKLY"}])
def test_fanout_mode_must_be_daily_or_tag_reconcile(payload):
    repo = InMemoryRepository()
    add_accounts(repo, 2)
    cmd = {**fanout(), "payload": payload}
    sender = FakeSender()
    with pytest.raises(handler.InvalidCommand):
        handler.dispatch(engine_of(repo), handler.parse(json.dumps(cmd)), sender=sender)
    out = handler.handle_batch(engine_of(repo), {"Records": [record(cmd)]}, sender=sender)
    assert out == {"batchItemFailures": []} and sender.entries == []


def test_fanout_with_a_real_customer_id_is_refused():
    repo = InMemoryRepository()
    add_accounts(repo, 1)
    cmd = {**fanout(), "customerId": "cus_0"}
    with pytest.raises(handler.InvalidCommand):
        handler.dispatch(engine_of(repo), handler.parse(json.dumps(cmd)), sender=FakeSender())


# ── [팬아웃 분산] ──────────────────────────────────────────────────────────────────────────────────────────────────

def test_spread_for_200_accounts_is_inside_0_900_and_strictly_increasing():
    repo = InMemoryRepository()
    add_accounts(repo, 200)
    sender = FakeSender()
    handler.dispatch(engine_of(repo), fanout(), sender=sender)
    delays = [e["DelaySeconds"] for e in sender.entries]
    assert len(delays) == 200 and delays[0] == 0
    assert all(0 <= d <= 900 for d in delays)
    assert all(b > a for a, b in zip(delays, delays[1:], strict=False))
    assert delays[-1] == int(199 * 4.5)          # floor(i * min(10, 900/200))


def test_spread_default_is_10_seconds_per_child_for_small_fleets():
    repo = InMemoryRepository()
    add_accounts(repo, 20)
    sender = FakeSender()
    handler.dispatch(engine_of(repo), fanout(), sender=sender)
    assert [e["DelaySeconds"] for e in sender.entries] == [i * 10 for i in range(20)]


@pytest.mark.parametrize("bad", ["1000", "-1", "abc", "901"])
def test_out_of_range_spread_falls_back_to_default_with_a_warning(bad, monkeypatch, caplog):
    monkeypatch.setenv("SYNC_FANOUT_SPREAD_SECONDS", bad)
    repo = InMemoryRepository()
    add_accounts(repo, 20)
    sender = FakeSender()
    with caplog.at_level(logging.WARNING):
        handler.dispatch(engine_of(repo), fanout(), sender=sender)
    assert [e["DelaySeconds"] for e in sender.entries] == [i * 10 for i in range(20)]
    assert any("SYNC_FANOUT_SPREAD_SECONDS" in r.getMessage() and r.levelno == logging.WARNING for r in caplog.records)


def test_spread_zero_is_allowed_and_sends_everything_at_once(monkeypatch):
    monkeypatch.setenv("SYNC_FANOUT_SPREAD_SECONDS", "0")
    repo = InMemoryRepository()
    add_accounts(repo, 12)
    sender = FakeSender()
    handler.dispatch(engine_of(repo), fanout(), sender=sender)
    assert {e["DelaySeconds"] for e in sender.entries} == {0}


# ── [팬아웃 송신 실패] ─────────────────────────────────────────────────────────────────────────────────────────────

def test_only_the_failed_entries_are_resent_once():
    repo = InMemoryRepository()
    add_accounts(repo, 10)
    sender = FakeSender(fail_first=3)
    out = handler.handle_batch(engine_of(repo), {"Records": [record(fanout())]}, sender=sender)
    assert out == {"batchItemFailures": []}
    assert len(sender.batches) == 2
    first, retry = sender.batches
    assert len(first) == 10 and len(retry) == 3
    assert [e["Id"] for e in retry] == [e["Id"] for e in first[:3]]
    assert [e["MessageBody"] for e in retry] == [e["MessageBody"] for e in first[:3]]
    ids = {c["commandId"] for c in sender.commands()}
    assert len(ids) == 10                           # every child reached the queue at least once


def test_persistent_send_failure_fails_the_fanout_record_and_redelivery_resends_same_command_ids():
    repo = InMemoryRepository()
    add_accounts(repo, 10)
    probe = FakeSender()
    handler.dispatch(engine_of(repo), fanout(), sender=probe)
    first_ids = {c["commandId"] for c in probe.commands()}

    bad_id = probe.entries[4]["Id"]
    sender = FakeSender(always_fail={bad_id})
    out = handler.handle_batch(engine_of(repo), {"Records": [record(fanout(), "fan-1")]}, sender=sender)
    assert out == {"batchItemFailures": [{"itemIdentifier": "fan-1"}]}
    assert len(sender.batches) == 2 and len(sender.batches[1]) == 1       # retried once, then gave up

    healthy = FakeSender()
    out = handler.handle_batch(engine_of(repo), {"Records": [record(fanout(), "fan-1")]}, sender=healthy)
    assert out == {"batchItemFailures": []}
    assert {c["commandId"] for c in healthy.commands()} == first_ids


# ── [메시지 크기] ─────────────────────────────────────────────────────────────────────────────────────────────────

def test_1000_accounts_children_are_small_and_batches_have_at_most_ten_entries():
    repo = InMemoryRepository()
    for i in range(1000):
        a = make_account(id=f"acc_{i:04d}_" + "x" * 20, customer_id=f"cus_{i % 25:02d}_" + "y" * 20,
                         aws_account_id=f"{200000000000 + i}")
        repo.accounts[a.id] = a
    sender = FakeSender()
    handler.dispatch(engine_of(repo), fanout("TAG_RECONCILE"), sender=sender)
    assert len(sender.entries) == 1000
    assert all(len(b) <= 10 for b in sender.batches)
    assert all(len(e["MessageBody"].encode("utf-8")) < 1024 for e in sender.entries)
    assert all(len({e["Id"] for e in b}) == len(b) for b in sender.batches)       # Ids unique within every call


# ── [기존 중복 RUNNING / 바쁨] ─────────────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def one():
    repo = InMemoryRepository()
    acc = make_account()
    repo.accounts[acc.id] = acc
    return repo, acc, Engine(repo, FakeSessions(), FakeDiscovery())


def test_two_fresh_running_rows_mean_busy_then_stale_rows_are_failed_and_a_new_run_starts(one):
    repo, acc, eng = one
    add_run(repo, acc, rid="r1")
    add_run(repo, acc, rid="r2")
    assert eng.sync_account(acc.id, "DAILY") == {"skipped": "BUSY"}
    assert len(repo.runs) == 2 and all(r.status == "RUNNING" for r in repo.runs.values())
    for r in repo.runs.values():
        r.heartbeat_at = now() - timedelta(minutes=21)
        r.started_at = now() - timedelta(minutes=30)
    eng.sync_account(acc.id, "DAILY")
    assert repo.runs["r1"].status == "FAILED" and repo.runs["r2"].status == "FAILED"
    new = [r for rid, r in repo.runs.items() if rid not in ("r1", "r2")]
    assert len(new) == 1 and new[0].mode == "DAILY"


def test_claim_returns_an_id_only_when_no_fresh_running_row_exists(one):
    repo, acc, _ = one
    stale = timedelta(minutes=20)
    first = repo.claim_sync_run(acc.customer_id, acc.id, "DAILY", stale)
    assert first is not None
    assert repo.claim_sync_run(acc.customer_id, acc.id, "TAG_RECONCILE", stale) is None
    assert sum(r.status == "RUNNING" for r in repo.runs.values()) == 1
    repo.finish_sync_run(acc.customer_id, first, "SUCCEEDED", {})
    assert repo.claim_sync_run(acc.customer_id, acc.id, "DAILY", stale) is not None


def test_claim_is_per_account(one):
    repo, acc, _ = one
    other = make_account(id="acc_2", aws_account_id="999999999999")
    repo.accounts[other.id] = other
    assert repo.claim_sync_run(acc.customer_id, acc.id, "DAILY", timedelta(minutes=20)) is not None
    assert repo.claim_sync_run(other.customer_id, other.id, "DAILY", timedelta(minutes=20)) is not None


@pytest.mark.parametrize("mode", ["DAILY", "TAG_RECONCILE"])
def test_busy_scheduled_child_is_deferred_with_a_counted_copy(one, mode):
    repo, acc, eng = one
    add_run(repo, acc)
    sender = FakeSender()
    cmd = child(acc, mode)
    out = handler.handle_batch(eng, {"Records": [record(cmd)]}, sender=sender)
    assert out == {"batchItemFailures": []}
    assert len(sender.entries) == 1
    e, c = sender.entries[0], sender.commands()[0]
    assert e["DelaySeconds"] == 300
    assert c["payload"]["deferrals"] == 1 and c["payload"]["mode"] == mode
    assert c["commandId"].endswith("-d1") and c["type"] == "SYNC_ACCOUNT"
    assert (c["customerId"], c["cloudAccountId"]) == (acc.customer_id, acc.id)
    assert handler.dispatch(eng, cmd, sender=FakeSender())["status"] == "DEFERRED"
    assert len(repo.runs) == 1                                          # no new run


def test_deferral_limit_stops_resending_and_logs_one_warning(one, caplog):
    repo, acc, eng = one
    add_run(repo, acc)
    sender = FakeSender()
    with caplog.at_level(logging.WARNING):
        out = handler.dispatch(eng, child(acc, deferrals=5), sender=sender)
    assert out["status"] == "SKIPPED_BUSY" and sender.entries == []
    assert len([r for r in caplog.records if r.levelno == logging.WARNING and "SKIPPED_BUSY" in r.getMessage()]) == 1
    # one below the limit still defers, as the 5th copy
    s2 = FakeSender()
    assert handler.dispatch(eng, child(acc, deferrals=4), sender=s2)["status"] == "DEFERRED"
    assert s2.commands()[0]["payload"]["deferrals"] == 5


def test_on_demand_sync_account_is_skipped_not_deferred_and_not_failed(one):
    repo, acc, eng = one
    add_run(repo, acc)
    sender = FakeSender()
    cmd = {"schemaVersion": 1, "commandId": "c-1", "type": "SYNC_ACCOUNT", "customerId": acc.customer_id,
           "cloudAccountId": acc.id, "payload": {"mode": "ON_DEMAND"}}
    assert handler.dispatch(eng, cmd, sender=sender)["status"] == "SKIPPED_BUSY"
    out = handler.handle_batch(eng, {"Records": [record(cmd)]}, sender=sender)
    assert out == {"batchItemFailures": []} and sender.entries == [] and len(repo.runs) == 1


def test_inline_tag_reconcile_from_an_event_is_ignored_when_busy(one, monkeypatch):
    repo, acc, eng = one
    monkeypatch.setattr(events, "RECONCILE_DEBOUNCE", timedelta(0))
    add_run(repo, acc, started_ago=timedelta(minutes=15))              # long-running but heartbeating
    ev = tag_event()
    out = events.handle_tag_event(eng, ev)
    assert out["status"] == "IGNORED" or out.get("accountSync") == {"skipped": "BUSY"}
    assert len(repo.runs) == 1
    res = handler.handle_batch(eng, {"Records": [{"messageId": "e1", "body": json.dumps(ev)}]}, sender=FakeSender())
    assert res == {"batchItemFailures": []} and len(repo.runs) == 1


def tag_event(name: str = "CreateTags") -> dict:
    return {"version": "0", "id": "e-1", "detail-type": "AWS API Call via CloudTrail", "source": "aws.ec2",
            "account": ACCOUNT_ID, "region": "ap-northeast-2",
            "detail": {"eventName": name, "requestParameters": {
                "resourcesSet": {"items": [{"resourceId": "i-0abc"}]},
                "tagSet": {"items": [{"key": "Monitoring", "value": "on"}]}}}}


# ── [최근 실행 스킵 없음] ──────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("prior_mode,prior_status", [
    ("ON_DEMAND", "SUCCEEDED"), ("ON_DEMAND", "FAILED"), ("TAG_RECONCILE", "SUCCEEDED"), ("ON_DEMAND", "PARTIAL"),
    ("DAILY", "SUCCEEDED"),
])
def test_scheduled_run_ignores_a_finished_run_from_25_minutes_ago(one, prior_mode, prior_status):
    repo, acc, eng = one
    add_run(repo, acc, mode=prior_mode, status=prior_status, started_ago=timedelta(minutes=25), rid="old")
    sender = FakeSender()
    out = handler.dispatch(eng, child(acc, "TAG_RECONCILE"), sender=sender)
    assert out["status"] == "OK"
    assert len(repo.runs) == 2 and sender.entries == []
    new = next(r for rid, r in repo.runs.items() if rid != "old")
    assert new.mode == "TAG_RECONCILE" and new.status in ("SUCCEEDED", "PARTIAL", "FAILED")


def test_scheduled_run_ignores_a_run_that_finished_one_minute_ago(one):
    repo, acc, eng = one
    add_run(repo, acc, status="SUCCEEDED", started_ago=timedelta(minutes=2), rid="old")
    assert handler.dispatch(eng, child(acc, "DAILY"), sender=FakeSender())["status"] == "OK"
    assert len(repo.runs) == 2


# ── [디바운스 공존] ───────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("prior_status", ["SUCCEEDED", "FAILED"])
def test_debounced_event_is_picked_up_by_the_next_scheduled_run(world, monkeypatch, prior_status):
    repo, sessions, disc, eng, acc = world
    monkeypatch.setattr(events, "RECONCILE_DEBOUNCE", timedelta(minutes=10))
    add_run(repo, acc, status=prior_status, started_ago=timedelta(minutes=5), rid="old")
    disc.resources = [ec2()]
    out = events.handle_tag_event(eng, tag_event())
    assert out == {"status": "IGNORED", "reason": "account sync ran recently"}
    assert repo.list_resources(acc.id) == []
    assert handler.dispatch(eng, child(acc, "TAG_RECONCILE"), sender=FakeSender())["status"] == "OK"
    rows = repo.list_resources(acc.id)
    assert [(r.resource_key, r.monitoring_state) for r in rows] == [("i-0abc", "MONITORED")]


# ── [파싱 호환] ───────────────────────────────────────────────────────────────────────────────────────────────────

def _old_handler():
    # tests/fixtures/handler_before_123.py.txt is handler.py as of origin/main before #123 (byte-for-byte copy).
    spec = importlib.util.spec_from_loader("handler_before_123", loader=None)
    mod = importlib.util.module_from_spec(spec)
    exec(compile((FIXTURES / "handler_before_123.py.txt").read_text(encoding="utf-8"), "handler_before_123", "exec"),
         mod.__dict__)
    sys.modules.setdefault("handler_before_123", mod)
    return mod


def test_old_handler_accepts_a_sync_account_with_deferrals(one):
    repo, acc, eng = one
    old = _old_handler()
    cmd = old.parse(json.dumps(child(acc, "TAG_RECONCILE", deferrals=2)))
    out = old.dispatch(eng, cmd)
    assert out["status"] == "OK"
    assert list(repo.runs.values())[0].status in ("SUCCEEDED", "PARTIAL", "FAILED")


@pytest.mark.parametrize("bad", ["1", True, 1.5, None])
def test_new_handler_rejects_non_integer_deferrals(one, bad):
    _, acc, _ = one
    cmd = child(acc, "TAG_RECONCILE")
    cmd["payload"]["deferrals"] = bad
    if bad is None:
        assert handler.parse(json.dumps(cmd))["payload"]["deferrals"] is None     # null means absent, like other keys
        return
    with pytest.raises(handler.InvalidCommand):
        handler.parse(json.dumps(cmd))


def test_new_handler_accepts_integer_deferrals(one):
    _, acc, _ = one
    assert handler.parse(json.dumps(child(acc, "DAILY", deferrals=3)))["payload"]["deferrals"] == 3


# ── [되돌리기: 엔진 revert] ───────────────────────────────────────────────────────────────────────────────────────

def test_reverted_engine_drops_the_fanout_command_quietly_and_finishes_queued_children(one, caplog):
    repo, acc, eng = one
    old = _old_handler()
    event = {"Records": [record(fanout(), "f1"), record(child(acc, "DAILY", deferrals=1), "c1")]}
    with caplog.at_level(logging.ERROR):
        out = old.handle_batch(eng, event)
    assert out == {"batchItemFailures": []}                                   # nothing for the DLQ
    assert any("unknown type" in r.getMessage() for r in caplog.records)
    assert len(repo.runs) == 1
    assert list(repo.runs.values())[0].status in ("SUCCEEDED", "PARTIAL", "FAILED")


# ── [DLQ 0 시뮬레이션] ────────────────────────────────────────────────────────────────────────────────────────────

def simulate(monkeypatch, n: int, sync_s: int, batch: int, spread: int, *, visibility=720, max_receive=5,
             concurrency=5, lambda_s=120, margin_s=30) -> tuple[int, int, int]:
    """SQS + event-source model on a virtual clock. Returns (max receive count, DLQ messages, deleted messages).
    The real handler.handle_batch runs every invocation, so the time-budget rule (batchItemFailures) is the real one."""
    monkeypatch.setenv("SYNC_FANOUT_SPREAD_SECONDS", str(spread))
    repo = InMemoryRepository()
    add_accounts(repo, n)
    eng = engine_of(repo)
    clock = [0.0]

    def fake_sync(account_id: str, mode: str) -> dict:
        clock[0] += sync_s
        return {"created": 0}

    eng.sync_account = fake_sync                       # type: ignore[method-assign]
    sender = FakeSender()
    handler.handle_batch(eng, {"Records": [record(fanout())]}, sender=sender)
    msgs = [{"body": e["MessageBody"], "visible": float(e["DelaySeconds"]), "count": 0, "done": False}
            for e in sender.entries]
    assert len(msgs) == n
    slots = [0.0] * concurrency
    dlq = deleted = 0
    while any(not m["done"] for m in msgs):
        i = min(range(concurrency), key=lambda k: slots[k])
        live = [m for m in msgs if not m["done"]]
        t = max(slots[i], min(m["visible"] for m in live))
        ready = sorted((m for m in live if m["visible"] <= t), key=lambda m: m["visible"])
        taken = []
        for m in ready:
            if len(taken) == batch:
                break
            if m["count"] >= max_receive:               # receive number max_receive+1 goes to the DLQ instead
                m["done"], dlq = True, dlq + 1
                continue
            m["count"] += 1
            taken.append(m)
        if not taken:
            slots[i] = t
            continue
        clock[0] = t
        start = t
        recs = [{"messageId": str(k), "body": m["body"]} for k, m in enumerate(taken)]
        remaining = lambda: int((lambda_s - (clock[0] - start)) * 1000)      # noqa: E731
        res = handler.handle_batch(eng, {"Records": recs}, remaining, margin_s * 1000, sender=FakeSender())
        elapsed = clock[0] - start
        if elapsed > lambda_s:                          # Lambda timeout: the whole batch comes back
            failed = {str(k) for k in range(len(taken))}
            elapsed = lambda_s
        else:
            failed = {f["itemIdentifier"] for f in res["batchItemFailures"]}
        for k, m in enumerate(taken):
            if str(k) in failed:
                m["visible"] = start + visibility
            else:
                m["done"], deleted = True, deleted + 1
        slots[i] = start + elapsed
    return max(m["count"] for m in msgs), dlq, deleted


def test_batch_size_one_delivers_each_message_once_and_the_dlq_stays_empty(monkeypatch):
    max_rc, dlq, deleted = simulate(monkeypatch, n=200, sync_s=90, batch=1, spread=10)
    assert (max_rc, dlq, deleted) == (1, 0, 200)


def test_batch_size_five_without_spread_overruns_the_lambda_and_reaches_the_dlq(monkeypatch):
    _, dlq, _ = simulate(monkeypatch, n=200, sync_s=90, batch=5, spread=0)
    assert dlq >= 1


# ── [바쁨 미룸 총량 / heartbeat 멈춤] ─────────────────────────────────────────────────────────────────────────────

def test_dead_process_run_is_replaced_within_the_deferral_budget(one):
    repo, acc, eng = one
    dead = add_run(repo, acc, mode="DAILY", started_ago=timedelta(minutes=7), heartbeat_ago=timedelta(minutes=6),
                   rid="dead")
    sender = FakeSender()
    cmd, waited, rounds = child(acc, "DAILY"), 0, 0
    while True:
        rounds += 1
        assert rounds <= 7, "never replaced the dead run"
        out = handler.dispatch(eng, cmd, sender=sender)
        if out["status"] != "DEFERRED":
            break
        entry = sender.entries[-1]
        waited += entry["DelaySeconds"]
        for r in repo.runs.values():                    # the clock moves on by the delay
            r.started_at -= timedelta(seconds=entry["DelaySeconds"])
            r.heartbeat_at -= timedelta(seconds=entry["DelaySeconds"])
        cmd = handler.parse(json.dumps(sender.commands()[-1]))
    assert out["status"] == "OK"
    assert waited <= 5 * 300
    assert dead.status == "FAILED"
    assert len([r for rid, r in repo.runs.items() if rid != "dead"]) == 1


def test_default_settings_and_the_start_check():
    from alarm_engine import wiring
    s = wiring.sync_settings_from_env({})
    assert (s.max_deferrals, s.defer_seconds, s.fanout_spread_seconds) == (5, 300, 10)
    # budget must exceed STALE_RUN_AFTER (20 min) + engine time limit (120 s) = 1320 s
    for deferrals, secs in ((4, 300), (4, 330), (1, 900), (2, 600)):
        with pytest.raises((ValueError, RuntimeError)):
            wiring.sync_settings_from_env({"SYNC_BUSY_MAX_DEFERRALS": str(deferrals),
                                           "SYNC_BUSY_DEFER_SECONDS": str(secs)})
    ok = wiring.sync_settings_from_env({"SYNC_BUSY_MAX_DEFERRALS": "5", "SYNC_BUSY_DEFER_SECONDS": "300"})
    assert ok.max_deferrals * ok.defer_seconds > 1320
    assert wiring.sync_settings_from_env({"SYNC_BUSY_MAX_DEFERRALS": "3", "SYNC_BUSY_DEFER_SECONDS": "450"})


# ── [하드코딩 금지] 큐 URL은 COMMANDS_QUEUE_URL 에서만 ─────────────────────────────────────────────────────────────

class FakeSqs:
    def __init__(self, failed: list[str] | None = None):
        self.calls: list[dict] = []
        self.failed = failed or []

    def send_message_batch(self, **kw):
        self.calls.append(kw)
        return {"Successful": [{"Id": e["Id"]} for e in kw["Entries"] if e["Id"] not in self.failed],
                "Failed": [{"Id": i, "SenderFault": False, "Code": "InternalError"} for i in self.failed]}


def test_command_sender_uses_only_the_environment_queue_url():
    from alarm_engine import wiring
    url = "https://queue.example.invalid/alarm-commands"
    fake = FakeSqs(failed=["b"])
    made: list[tuple] = []

    def factory(*a, **kw):
        made.append((a, kw))
        return fake

    sender = wiring.build_command_sender({"COMMANDS_QUEUE_URL": url, "AWS_REGION": "eu-test-1"}, factory)
    entries = [{"Id": "a", "MessageBody": "{}", "DelaySeconds": 0}, {"Id": "b", "MessageBody": "{}", "DelaySeconds": 5}]
    assert sender.send_batch(entries) == ["b"]
    assert fake.calls == [{"QueueUrl": url, "Entries": entries}]
    assert made[0][0][0] == "sqs"


def test_command_sender_without_queue_url_fails_at_build_time():
    from alarm_engine import wiring
    with pytest.raises(RuntimeError, match="COMMANDS_QUEUE_URL"):
        wiring.build_command_sender({}, lambda *a, **k: FakeSqs())


# ── [시작 시 실패] build_engine / lambda_handler 초기화가 설정 검사를 실제로 부른다 ─────────────────────────────────

@pytest.fixture
def start_env(monkeypatch):
    """build_engine with every external piece replaced: no boto3 client, no DB; make_engine returns a sentinel."""
    import boto3

    from alarm_engine import pg_repository, wiring
    sentinel = object()
    monkeypatch.setattr(handler, "_ENGINE", None)
    monkeypatch.delenv("AWS_LAMBDA_FUNCTION_NAME", raising=False)
    monkeypatch.delenv("DATABASE_URL_SECRET_ARN", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@db.invalid/x")
    monkeypatch.setenv("COMMANDS_QUEUE_URL", "https://queue.example.invalid/alarm-commands")
    monkeypatch.setenv("AWS_REGION", "eu-test-1")
    monkeypatch.setattr(boto3, "client", lambda *a, **k: object())
    monkeypatch.setattr(pg_repository, "PgRepository", lambda url: object())
    monkeypatch.setattr(wiring, "make_engine", lambda repo, sessions: sentinel)
    return sentinel


def test_build_engine_accepts_valid_settings(start_env):
    from alarm_engine import wiring
    assert wiring.build_engine() is start_env


@pytest.mark.parametrize("deferrals,secs", [(4, 330), (4, 300), (1, 900)])
def test_build_engine_refuses_to_start_when_the_deferral_budget_is_too_small(start_env, monkeypatch, deferrals, secs):
    from alarm_engine import wiring
    monkeypatch.setenv("SYNC_BUSY_MAX_DEFERRALS", str(deferrals))
    monkeypatch.setenv("SYNC_BUSY_DEFER_SECONDS", str(secs))
    with pytest.raises((ValueError, RuntimeError)):
        wiring.build_engine()


def test_build_engine_accepts_the_boundary_just_above_the_limit(start_env, monkeypatch):
    from alarm_engine import wiring
    monkeypatch.setenv("SYNC_BUSY_MAX_DEFERRALS", "4")
    monkeypatch.setenv("SYNC_BUSY_DEFER_SECONDS", "331")        # 1324 s > 1320 s
    assert wiring.build_engine() is start_env


def test_lambda_handler_init_fails_the_whole_batch_and_caches_nothing_on_bad_settings(start_env, monkeypatch, caplog):
    monkeypatch.setenv("SYNC_BUSY_MAX_DEFERRALS", "4")
    monkeypatch.setenv("SYNC_BUSY_DEFER_SECONDS", "330")
    recs = [record(fanout(), "m1"), record(fanout("DAILY"), "m2")]
    with caplog.at_level(logging.ERROR):
        out = handler.lambda_handler({"Records": recs}, None)
    assert [f["itemIdentifier"] for f in out["batchItemFailures"]] == ["m1", "m2"]
    assert handler._ENGINE is None
    assert "engine init failed" in caplog.text
