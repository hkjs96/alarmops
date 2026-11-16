"""Smoke test of the Lambda artifact. Needs build/ (npm run build:engine-lambda, which downloads wheels); skipped when absent
so the unit test run stays offline. CI runs the build first (see services/alarm-engine/README.md)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_build_script_targets_the_template_arch():
    b = load("build_lambda")
    assert "manylinux2014_aarch64" in b.PLATFORMS["arm64"] and "manylinux2014_x86_64" in b.PLATFORMS["x86_64"]
    req = (SCRIPTS.parent / "requirements-lambda.txt").read_text()
    assert "psycopg[binary]==" in req and "typing-extensions==" in req  # exact pins


def test_built_artifact_layout():
    c = load("check_lambda")
    if not (c.BUILD / "alarm_engine").is_dir():
        pytest.skip("build/ not built")
    assert c.check() == []
