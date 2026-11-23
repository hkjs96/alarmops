#!/usr/bin/env bash
# Decides which ci.yml jobs a change needs. Prints "name=true|false" lines (appended to $GITHUB_OUTPUT by the workflow).
#
# Usage:
#   ci-changes.sh            reads EVENT_NAME, BASE_SHA, HEAD_SHA from the environment and runs git diff BASE...HEAD
#   ci-changes.sh --stdin    reads NUL-separated changed file names from stdin; EVENT_NAME still applies
#
# Fail-safe: anything that cannot be judged (not a pull_request event, no base/head, git diff fails, empty file list,
# a path that matches no rule, the decision code itself failing or printing an incomplete answer) turns every job on.
# Renames are reported as a delete of the old path plus an add of the new one (--no-renames), so both are judged.
# The mapping table lives in the header of ci.yml; keep both in sync.
set -uo pipefail

JOBS=(test e2e e2e_live engine db infra)

all_true() {
  local j
  for j in "${JOBS[@]}"; do echo "$j=true"; done
  echo "all=true"
  echo "docs_only=false"
}

# Outer layer: run the decision in a child and accept only a complete answer.
if [ -z "${CI_CHANGES_INNER:-}" ]; then
  out=$(CI_CHANGES_INNER=1 bash "$0" "$@")
  rc=$?
  ok=true
  [ "$rc" -eq 0 ] || ok=false
  for k in "${JOBS[@]}" all docs_only; do
    printf '%s\n' "$out" | grep -Eq "^$k=(true|false)$" || ok=false
  done
  if [ "$ok" = true ]; then printf '%s\n' "$out"; else echo "ci-changes: failed or incomplete (rc=$rc) -> running everything" >&2; all_true; fi
  exit 0
fi

emit() { # emit <all|none|selected>; selected reads the flag_* variables
  local j v
  for j in "${JOBS[@]}"; do
    case "$1" in
      all) v=true ;;
      none) v=false ;;
      *) eval "v=\${flag_$j:-false}" ;;
    esac
    echo "$j=$v"
  done
  echo "all=$([ "$1" = all ] && echo true || echo false)"
  echo "docs_only=$([ "$1" = none ] && echo true || echo false)"
}

fail_safe() { echo "ci-changes: $1 -> running everything" >&2; emit all; exit 0; }

if [ "${EVENT_NAME:-}" != "pull_request" ]; then
  fail_safe "event '${EVENT_NAME:-unset}' is not pull_request"
fi

list=$(mktemp) || fail_safe "mktemp failed"
trap 'rm -f "$list"' EXIT
if [ "${1:-}" = "--stdin" ]; then
  cat > "$list" || fail_safe "reading stdin failed"
else
  if [ -z "${BASE_SHA:-}" ] || [ -z "${HEAD_SHA:-}" ]; then fail_safe "BASE_SHA or HEAD_SHA missing"; fi
  git -c core.quotepath=false diff --name-only --no-renames -z "$BASE_SHA...$HEAD_SHA" > "$list" || fail_safe "git diff failed"
fi

if [ ! -s "$list" ]; then fail_safe "empty file list"; fi

for j in "${JOBS[@]}"; do eval "flag_$j=false"; done
set_flags() { local j; for j in "$@"; do eval "flag_$j=true"; done; }

while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  case "$f" in
    # Shared config, the workflows and this decision code itself: everything runs.
    .github/workflows/*|.github/scripts/ci-changes.*|package.json|package-lock.json|tsconfig*|*/tsconfig*|.npmrc|.nvmrc|.node-version|.python-version)
      fail_safe "shared file changed: $f" ;;
    # Not code, but a test reads it (found by grepping the tests for paths outside their own area).
    # ci-changes.test.mjs checks that every docs/ path the tests read is listed here.
    docs/specs/alarm-rules.md) set_flags engine ;;                        # services/alarm-engine/tests/test_golden_alarm_rules.py
    docs/SETUP-PROD-DB.md) set_flags infra ;;                             # infra/test/test_templates.py
    packages/api/test/fixtures/offboard-account.command.json) set_flags test e2e e2e_live engine ;;   # alarm-engine test_command_contract.py
    services/alarm-engine/tests/fixtures/offboard-account.command.json) set_flags test engine infra ;; # packages/api sqs-command-publisher test
    tools/vercel-cli/*) set_flags infra ;;                                # infra/test/test_templates.py
    # Docs folder and root-level markdown/dotfiles: no job checks them. (*.md inside an area follows the area rule.)
    docs/*|.claude/worktrees/*|.env.example|.gitignore) ;;
    apps/*) set_flags test e2e e2e_live ;;
    packages/store-sql/*) set_flags test e2e e2e_live db ;;
    packages/*) set_flags test e2e e2e_live ;;
    services/ingest/*) set_flags test ;;
    services/alarm-engine/*) set_flags engine infra ;;
    db/sql/*) set_flags test e2e_live engine db infra ;;
    db/*) set_flags test e2e_live engine db ;;
    infra/*) set_flags infra ;;
    .github/scripts/*) set_flags infra db ;;
    */*) fail_safe "unmapped path: $f" ;;
    *.md) ;;  # root-level markdown (README.md, CLAUDE.md)
    *) fail_safe "unmapped path: $f" ;;
  esac
done < "$list"

# Only no-CI paths changed -> nothing to run.
any=false
for j in "${JOBS[@]}"; do
  eval "[ \"\$flag_$j\" = true ]" && any=true
done
if [ "$any" = false ]; then emit none; else emit selected; fi
