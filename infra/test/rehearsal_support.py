"""Test harness for infra/scripts/rehearsal/* (issue #122). Not a test module.

Interface the scripts must offer (derived from the issue; tests treat it as the contract):

  scripts      infra/scripts/rehearsal/{common,preflight,install,verify,cleanup}.sh   (run with bash)
  flags        --profile NAME            required, ^rehearsal-[a-z0-9-]+$
               --confirm-account 12DIGIT install/verify/cleanup: the account number typed by the human
               --run-id ID               verify (default: timestamp) and cleanup (required)
               --stack [--stack-name N]  cleanup only; N defaults to alarmops-customer
  env          REHEARSAL_EXTERNAL_ID     the ExternalId (env only, never argv)
               REHEARSAL_ACCOUNTS_FILE   path of accounts.local.json (default: next to the scripts)
               REHEARSAL_LOG_DIR         replaces the `rehearsal-logs` dir; logs live in <dir>/<profile>/<runId>.md
               REHEARSAL_POLL_INTERVAL, REHEARSAL_WAIT_SECONDS   polling knobs; tests set both to 0
  accounts file  {"centralAccountId", "devAccountId", "denyAccounts": [...],
                  "centralRoleArn", "centralEventBusArn", "profiles": {"rehearsal-a": "111111111111", ...}}
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]
REPO = INFRA.parent
SCRIPTS = INFRA / "scripts" / "rehearsal"
FAKE_AWS_PY = Path(__file__).resolve().parent / "fake_aws.py"

PROFILE = "rehearsal-a"
ACCT = "111111111111"        # account of rehearsal-a
CENTRAL = "222222222222"
DEV = "333333333333"
DENIED = "444444444444"
EID = "Xk9-secretEXTID-0123456789abcdef"   # >= 16 chars, must never be echoed
STACK = "alarmops-customer"
REGION = "ap-northeast-2"

BAD_ENV = ("AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_DEFAULT_PROFILE", "AWS_PROFILE",
           "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")


def is_read(op: str) -> bool:
    return op.startswith(("get-", "describe-", "list-", "validate-", "simulate-", "wait"))


class Result:
    def __init__(self, cp: subprocess.CompletedProcess):
        self.code, self.out, self.err = cp.returncode, cp.stdout, cp.stderr

    @property
    def text(self) -> str:
        return self.out + "\n" + self.err


class Sandbox:
    """One temp dir with a fake aws first in PATH, an accounts file, a scenario file and a log dir."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="rehearsal-test-"))
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        wrapper = self.bin / "aws"
        # Forward slashes + shell quoting: a Windows path such as C:\\Users\\x\\python.exe would otherwise be
        # at the mercy of bash backslash rules. Git Bash accepts C:/... paths. (Windows run: not verified here.)
        py, fake = shlex.quote(Path(sys.executable).as_posix()), shlex.quote(FAKE_AWS_PY.as_posix())
        with open(wrapper, "w", encoding="utf-8", newline="\n") as f:   # LF even on Windows: bash chokes on CRLF
            f.write(f'#!/usr/bin/env bash\nexec {py} {fake} "$@"\n')
        wrapper.chmod(0o755)
        self.calls_file = self.dir / "aws-calls.jsonl"
        self.scenario_file = self.dir / "scenario.json"
        self.accounts_file = self.dir / "accounts.local.json"
        self.log_dir = self.dir / "rehearsal-logs"
        (self.dir / "home").mkdir()
        (self.dir / "tmp").mkdir()
        self.set_accounts()
        self.set_scenario()

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    # --- configuration -------------------------------------------------
    def set_accounts(self, **overrides):
        data = {
            "centralAccountId": CENTRAL,
            "devAccountId": DEV,
            "denyAccounts": [DENIED],
            "centralRoleArn": f"arn:aws:iam::{CENTRAL}:role/AlarmOps-Central-Assume",
            "centralEventBusArn": f"arn:aws:events:{REGION}:{CENTRAL}:event-bus/alarmops-central",
            "profiles": {PROFILE: ACCT, "rehearsal-b": "555555555555", "rehearsal-c": "666666666666"},
        }
        data.update(overrides)
        self.accounts_file.write_text(json.dumps(data))

    def set_scenario(self, **scen):
        scen.setdefault("account", ACCT)
        self.scenario_file.write_text(json.dumps(scen))

    # --- running -------------------------------------------------------
    def env(self, extra=None, external_id=EID) -> dict:
        env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.dir / "home"),
            "TMPDIR": str(self.dir / "tmp"),
            "LANG": "C.UTF-8",
            "FAKE_AWS_LOG": str(self.calls_file),
            "FAKE_AWS_SCENARIO": str(self.scenario_file),
            "REHEARSAL_ACCOUNTS_FILE": str(self.accounts_file),
            "REHEARSAL_LOG_DIR": str(self.log_dir),
            "REHEARSAL_POLL_INTERVAL": "0",
            "REHEARSAL_WAIT_SECONDS": "0",
        }
        if external_id is not None:
            env["REHEARSAL_EXTERNAL_ID"] = external_id
        env.update(extra or {})
        return env

    def run(self, script: str, args: list[str], extra_env=None, external_id=EID) -> Result:
        kw = {}
        if os.name == "posix":   # preexec_fn is POSIX-only; os.umask exists on Windows too, so do not test for it
            kw["preexec_fn"] = lambda: os.umask(0)   # a 600 log must come from the script, not the umask
        cp = subprocess.run(["bash", str(SCRIPTS / script), *args], env=self.env(extra_env, external_id),
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120,
                            cwd=str(self.dir), **kw)
        return Result(cp)

    def good_args(self, script: str, profile=PROFILE, confirm=ACCT, run_id=None, extra=()):
        a = ["--profile", profile] if profile is not None else []
        if script != "preflight.sh" and confirm is not None:
            a += ["--confirm-account", confirm]
        if run_id and script in ("verify.sh", "cleanup.sh"):
            a += ["--run-id", run_id]
        return a + list(extra)

    # --- observation ---------------------------------------------------
    def calls(self) -> list[dict]:
        if not self.calls_file.exists():
            return []
        return [json.loads(l) for l in self.calls_file.read_text(encoding="utf-8").splitlines() if l.strip()]

    def writes(self) -> list[dict]:
        return [c for c in self.calls() if not is_read(c["op"])]

    def log_files(self) -> list[Path]:
        return sorted(p for p in self.log_dir.rglob("*") if p.is_file()) if self.log_dir.exists() else []

    def log_text(self) -> str:
        return "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in self.log_files())

    def report(self, run_id: str) -> str:
        p = self.log_dir / PROFILE / f"{run_id}.md"
        return p.read_text(encoding="utf-8") if p.exists() else ""


def option_values(argv: list[str], name: str) -> list[str]:
    """Values given for an option, in either `--name v` or `--name=v` form."""
    out = []
    for i, a in enumerate(argv):
        if a == name and i + 1 < len(argv):
            out.append(argv[i + 1])
        elif a.startswith(name + "="):
            out.append(a.split("=", 1)[1])
    return out


def call_blob(c: dict) -> str:
    """argv + resolved file:// contents + stdin of one recorded call."""
    return " ".join(c["argv"]) + " " + " ".join(c.get("files", {}).values()) + " " + c.get("stdin", "")


def mode(path: Path) -> int:
    """Permission bits. On Windows Python's stat() only knows read-only, so ask Git Bash's stat instead."""
    if os.name == "posix":
        return stat.S_IMODE(path.stat().st_mode)
    out = subprocess.run(["bash", "-c", 'stat -c %a "$1"', "_", path.as_posix()],
                         capture_output=True, text=True, check=True).stdout.strip()
    return int(out, 8)
