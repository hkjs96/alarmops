"""Build the engine Lambda artifact: services/alarm-engine/build/ (SAM CodeUri in infra/aws/central.yaml).

Layout: `alarm_engine/` (this package) next to its vendored dependencies at the top level; handler
`alarm_engine.handler.lambda_handler`, runtime python3.12.

The template runs the function on arm64, so by default binary wheels are fetched for manylinux2014_aarch64.
`ALARMOPS_LAMBDA_ARCH=x86_64` builds for x86_64 instead (must match `Architectures` in the template).
Only wheels are accepted (`--only-binary=:all:`): nothing is compiled or executed from a downloaded package.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
PLATFORMS = {
    "arm64": ["manylinux2014_aarch64", "manylinux_2_28_aarch64"],
    "x86_64": ["manylinux2014_x86_64", "manylinux_2_28_x86_64"],
}


def build(arch: str | None = None) -> Path:
    arch = arch or os.environ.get("ALARMOPS_LAMBDA_ARCH", "arm64")
    if arch not in PLATFORMS:
        raise SystemExit(f"ALARMOPS_LAMBDA_ARCH must be one of {sorted(PLATFORMS)}")
    shutil.rmtree(BUILD, ignore_errors=True)
    BUILD.mkdir(parents=True)
    cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-compile",
           "--target", str(BUILD), "--python-version", "3.12", "--implementation", "cp", "--only-binary=:all:",
           "-r", str(ROOT / "requirements-lambda.txt")]
    for p in PLATFORMS[arch]:
        cmd += ["--platform", p]
    subprocess.run(cmd, check=True)
    shutil.copytree(ROOT / "src" / "alarm_engine", BUILD / "alarm_engine",
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # Not needed at runtime (the runtime provides boto3) and keeps the zip small.
    for stray in ("bin",):
        shutil.rmtree(BUILD / stray, ignore_errors=True)
    print(f"engine lambda artifact ({arch}) written to {BUILD}")
    return BUILD


if __name__ == "__main__":
    build()
