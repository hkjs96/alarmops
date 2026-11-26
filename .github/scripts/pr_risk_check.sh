#!/usr/bin/env bash
# Official PR risk verdict (D-62). Usage: bash .github/scripts/pr_risk_check.sh <pr-head-sha>
#
# Run by the hub (and, as information only, by the `risk` job of ci.yml). The classifier is taken from origin/main, never from
# the PR, so a PR cannot change the rules that judge it. The base is FIXED to origin/main: there is no environment variable
# or option to change it. The script first runs `git fetch origin main` (a failure stops it, so a stale main cannot be used);
# only inside GitHub Actions, where actions/checkout has just fetched all branches and has no credentials, the fetch is skipped.
# The printed JSON line carries the head SHA; the hub merges a `low` PR only if that SHA is still the PR's head at merge time.
#
# The head must already be in the local repository (`git fetch origin pull/<n>/head` or the PR branch).
# Output: one JSON line on stdout (see pr_risk.py), the table on stderr / $GITHUB_STEP_SUMMARY.
# Exit non-zero (and print no JSON) when it cannot judge: treat that as `human`.
set -euo pipefail

sha="${1:-}"
# 40 hex digits only: this also rejects anything that starts with `-`.
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: pr_risk_check.sh <40-hex head sha>" >&2
  exit 2
fi
base_ref="origin/main"

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  git fetch --quiet origin main
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git cat-file -e "${sha}^{commit}"
git show "$base_ref:.github/scripts/pr_risk.py" > "$tmp/pr_risk.py"

git diff --name-status --no-renames "$base_ref...$sha" > "$tmp/name-status.txt"
git diff --raw --no-renames "$base_ref...$sha" > "$tmp/raw.txt"

python3 -I "$tmp/pr_risk.py" --head "$sha" --raw "$tmp/raw.txt" < "$tmp/name-status.txt"
