"""Contract: the JSON the TS SqsCommandPublisher sends (shared fixture) is accepted by the handler's parser."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from alarm_engine.handler import InvalidCommand, parse

FIXTURE = Path(__file__).parent / "fixtures" / "offboard-account.command.json"
TS_FIXTURE = Path(__file__).parents[3] / "packages" / "api" / "test" / "fixtures" / "offboard-account.command.json"


def test_fixture_parses_into_the_offboard_command():
    cmd = parse(FIXTURE.read_text())
    assert cmd["type"] == "OFFBOARD_ACCOUNT"
    assert cmd["commandId"] == "offboard-ob_1-acc_1"
    assert (cmd["customerId"], cmd["cloudAccountId"]) == ("cus_1", "acc_1")
    assert cmd["payload"] == {"offboardingId": "ob_1"}


def test_python_and_ts_fixture_are_identical():
    if TS_FIXTURE.exists():  # the services/ tree may be packaged alone; vitest asserts the same pair from the TS side
        assert json.loads(TS_FIXTURE.read_text()) == json.loads(FIXTURE.read_text())


@pytest.mark.parametrize("drop", ["schemaVersion", "commandId", "customerId", "cloudAccountId"])
def test_required_top_level_fields(drop):
    body = json.loads(FIXTURE.read_text())
    del body[drop]
    with pytest.raises(InvalidCommand):
        parse(json.dumps(body))


# Monitoring commands (D-16): the API (packages/api/src/monitoringApi.ts) publishes these; its vitest asserts the body it
# sends equals the TS-side copy of the same fixture, and this test asserts the handler's validator accepts the Python copy.
MONITORING_FIXTURES = {
    "stop-monitoring": ("STOP_MONITORING", {"resourceId": "res_a", "deleteAlarms": True}),
    "set-monitoring-tag": ("SET_MONITORING_TAG", {"resourceId": "res_h", "value": "on"}),
}


@pytest.mark.parametrize("name", sorted(MONITORING_FIXTURES))
def test_monitoring_fixture_is_accepted_by_the_handler_validator(name):
    path = Path(__file__).parent / "fixtures" / f"{name}.command.json"
    cmd = parse(path.read_text())
    assert (cmd["type"], cmd["payload"]) == MONITORING_FIXTURES[name]


@pytest.mark.parametrize("name", sorted(MONITORING_FIXTURES))
def test_monitoring_python_and_ts_fixture_are_identical(name):
    py = Path(__file__).parent / "fixtures" / f"{name}.command.json"
    ts = Path(__file__).parents[3] / "packages" / "api" / "test" / "fixtures" / f"{name}.command.json"
    if ts.exists():
        assert json.loads(ts.read_text()) == json.loads(py.read_text())


def test_stop_monitoring_payload_must_match_the_api_shape():
    body = json.loads((Path(__file__).parent / "fixtures" / "stop-monitoring.command.json").read_text())
    for bad in ({"resourceId": "res_a"}, {"resourceId": "res_a", "deleteAlarms": "true"}, {"deleteAlarms": True}):
        with pytest.raises(InvalidCommand):
            parse(json.dumps({**body, "payload": bad}))
