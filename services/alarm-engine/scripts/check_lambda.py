"""Smoke check of build/ (run after build_lambda.py): layout, wheels for the target arch, handler importable from build/ only."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"


def check(arch_tag: str = "aarch64") -> list[str]:
    problems: list[str] = []
    if not (BUILD / "alarm_engine" / "handler.py").is_file():
        return [f"{BUILD}/alarm_engine/handler.py missing (run npm run build:engine-lambda)"]
    if not any(BUILD.glob("psycopg_binary/*.so")):
        problems.append("psycopg_binary extension missing")
    elif not any(arch_tag in p.name for p in BUILD.glob("psycopg_binary/*.so")):
        problems.append(f"psycopg_binary wheel is not for {arch_tag}")
    if not (BUILD / "typing_extensions.py").is_file():
        problems.append("typing_extensions missing")
    if any(BUILD.glob("alarm_engine/**/__pycache__")):
        problems.append("__pycache__ copied into build")
    # Import only from build/ (-I ignores the editable install and PYTHONPATH of the dev environment).
    code = (f"import sys; sys.path.insert(0, {str(BUILD)!r}); import alarm_engine.handler as h; "
            f"assert h.__file__.startswith({str(BUILD)!r}), h.__file__; assert callable(h.lambda_handler)")
    r = subprocess.run([sys.executable, "-I", "-B", "-c", code], capture_output=True, text=True)
    if r.returncode:
        problems.append("import alarm_engine.handler from build/ failed: " + r.stderr.strip().splitlines()[-1:][0])
    return problems


if __name__ == "__main__":
    found = check()
    for p in found:
        print("FAIL:", p)
    sys.exit(1 if found else 0)
