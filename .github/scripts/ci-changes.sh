#!/usr/bin/env bash
# Decides which ci.yml jobs a change needs. Prints "name=true|false" lines (appended to $GITHUB_OUTPUT by the workflow).
#
# Usage:
#   ci-changes.sh            reads EVENT_NAME, BASE_SHA, HEAD_SHA from the environment and runs git diff BASE...HEAD
#   ci-changes.sh --stdin    reads the changed file names (one per line) from stdin; EVENT_NAME still applies
#
# Fail-safe: anything that cannot be judged (not a pull_request event, no base/head, git diff fails, empty file list,
# a path that matches no rule) turns every job on. The mapping table lives in the header of ci.yml; keep both in sync.
set -uo pipefail

JOBS=(test e2e e2e_live engine db infra)

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

if [ "${1:-}" = "--stdin" ]; then
  files=$(cat)
else
  if [ -z "${BASE_SHA:-}" ] || [ -z "${HEAD_SHA:-}" ]; then fail_safe "BASE_SHA or HEAD_SHA missing"; fi
  files=$(git -c core.quotepath=false diff --name-only "$BASE_SHA...$HEAD_SHA") || fail_safe "git diff failed"
fi

if [ -z "$(printf '%s' "$files" | tr -d '[:space:]')" ]; then fail_safe "empty file list"; fi

for j in "${JOBS[@]}"; do eval "flag_$j=false"; done
set_flags() { local j; for j in "$@"; do eval "flag_$j=true"; done; }

while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    # Shared config and the workflows themselves: everything runs.
    .github/workflows/*|package.json|package-lock.json|tsconfig*|*/tsconfig*|.npmrc|.nvmrc|.node-version|.python-version)
      fail_safe "shared file changed: $f" ;;
    # infra job reads this from outside infra/ (infra/test).
    docs/SETUP-PROD-DB.md) set_flags infra ;;
    docs/*|*.md|.claude/*|.env.example|.gitignore) ;;  # no job checks these
    apps/*) set_flags test e2e e2e_live ;;
    packages/store-sql/*) set_flags test e2e e2e_live db ;;
    packages/*) set_flags test e2e e2e_live ;;
    services/ingest/*) set_flags test ;;
    services/alarm-engine/*) set_flags engine infra ;;
    db/sql/*) set_flags test e2e_live engine db infra ;;
    db/*) set_flags test e2e_live engine db ;;
    infra/*) set_flags infra ;;
    .github/scripts/*) set_flags infra db ;;
    *) fail_safe "unmapped path: $f" ;;
  esac
done <<< "$files"

# Only no-CI paths (docs, *.md, .claude) changed -> nothing to run.
any=false
for j in "${JOBS[@]}"; do
  eval "[ \"\$flag_$j\" = true ]" && any=true
done
if [ "$any" = false ]; then emit none; else emit selected; fi
