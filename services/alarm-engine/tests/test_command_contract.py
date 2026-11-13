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
