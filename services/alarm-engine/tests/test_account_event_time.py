"""#154: CloudTrail tag events record CloudAccount.firstEventAt / lastEventAt (same 1-minute rule as the ingest path)."""

from __future__ import annotations

import logging
from datetime import timedelta

import pytest

from alarm_engine import events
from alarm_engine.engine import Engine
from alarm_engine.repository import InMemoryRepository, now
from conftest import ACCOUNT_ID, FakeDiscovery, FakeSessions, make_account
from test_periodic_sync import tag_event


@pytest.fixture
def one():
    repo = InMemoryRepository()
    acc = make_account()
    repo.accounts[acc.id] = acc
    return repo, acc, Engine(repo, FakeSessions(), FakeDiscovery())


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def test_active_account_tag_event_sets_first_and_last_event_at(one):
    repo, acc, eng = one
    t = now() - timedelta(seconds=5)
    ev = tag_event()
    ev["time"] = iso(t)
    events.handle_tag_event(eng, ev)
    first, last = repo.event_times[acc.id]
    assert first == last and abs((first - t).total_seconds()) < 1


def test_missing_or_unparsable_time_uses_now(one):
    repo, acc, eng = one
    ev = tag_event()
    ev["time"] = "not-a-time"
    events.handle_tag_event(eng, ev)
    first, _ = repo.event_times[acc.id]
    assert abs((now() - first).total_seconds()) < 5


def test_second_event_within_60s_keeps_last_and_after_60s_advances_it(one):
    repo, acc, eng = one
    t0 = now() - timedelta(minutes=10)
    for delta, expect_last in ((0, 0), (30, 0), (61, 61)):
        ev = tag_event()
        ev["time"] = iso(t0 + timedelta(seconds=delta))
        events.handle_tag_event(eng, ev)
        first, last = repo.event_times[acc.id]
        assert abs((first - t0).total_seconds()) < 1
        assert abs((last - (t0 + timedelta(seconds=expect_last))).total_seconds()) < 1


def test_future_event_time_is_capped_at_now(one):
    repo, acc, eng = one
    ev = tag_event()
    ev["time"] = iso(now() + timedelta(days=3))
    events.handle_tag_event(eng, ev)
    first, last = repo.event_times[acc.id]
    assert first <= now() and last <= now()


def test_event_is_recorded_even_when_it_names_no_supported_resource(one):
    repo, acc, eng = one
    ev = tag_event()
    ev["detail"]["requestParameters"] = {}
    assert events.handle_tag_event(eng, ev)["reason"] == "no supported resource"
    assert acc.id in repo.event_times


@pytest.mark.parametrize("mutate", [
    lambda e: e.update({"detail-type": "Other"}),
    lambda e: e.update({"source": "custom.x"}),
    lambda e: e["detail"].update({"errorCode": "AccessDenied"}),
    lambda e: e.update({"account": "bad"}),
    lambda e: e["detail"].update({"eventName": "RunInstances"}),
    lambda e: e.update({"account": "999999999999"}),
])
def test_malformed_or_unknown_account_events_do_not_write(one, mutate):
    repo, _, eng = one
    ev = tag_event()
    mutate(ev)
    assert events.handle_tag_event(eng, ev)["status"] == "IGNORED"
    assert repo.event_times == {}


def test_inactive_account_does_not_write(one):
    repo, acc, eng = one
    repo.disabled_accounts.add(acc.id)
    events.handle_tag_event(eng, tag_event())
    assert repo.event_times == {}


def test_write_is_scoped_to_customer_and_account(one):
    repo, acc, _ = one
    repo.record_account_event("cus_other", acc.id, None)
    assert repo.event_times == {}


def test_failing_write_does_not_change_the_handler_result(one, caplog):
    repo, acc, eng = one
    expected = events.handle_tag_event(eng, tag_event())

    class Boom(Exception):
        sqlstate = "42501"

    def raising(*a, **k):
        raise Boom(f"secret message {ACCOUNT_ID}")

    repo2, acc2 = InMemoryRepository(), make_account()
    repo2.accounts[acc2.id] = acc2
    repo2.record_account_event = raising  # type: ignore[method-assign]
    with caplog.at_level(logging.WARNING):
        out = events.handle_tag_event(Engine(repo2, FakeSessions(), FakeDiscovery()), tag_event())
    assert out == expected
    text = " ".join(r.getMessage() for r in caplog.records if "account_event_time" in r.getMessage())
    assert "42501" in text and "Boom" in text
    assert ACCOUNT_ID not in text and "secret" not in text
