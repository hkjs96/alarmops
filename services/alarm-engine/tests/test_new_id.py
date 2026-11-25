"""new_id must stay unique across process restarts (Lambda cold starts re-imported a counter that began at 1)."""

from __future__ import annotations

import importlib

from alarm_engine import repository


def test_ids_unique_within_process():
    ids = {repository.new_id("res") for _ in range(2000)}
    assert len(ids) == 2000
    assert all(i.startswith("res_") for i in ids)


def test_ids_do_not_repeat_after_module_reload():
    importlib.reload(repository)              # start from a fresh "process" regardless of earlier tests
    before = [repository.new_id("res") for _ in range(50)]
    try:
        importlib.reload(repository)          # what a cold start does to module state
        after = [repository.new_id("res") for _ in range(50)]
    finally:
        importlib.reload(repository)
    assert not set(before) & set(after)
