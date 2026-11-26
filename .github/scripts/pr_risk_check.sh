#!/usr/bin/env bash
# Official PR risk verdict (D-62). Usage: bash .github/scripts/pr_risk_check.sh <pr-head-sha>
#
# Run by the hub (and, as information only, by the `risk` job of ci.yml). The classifier is taken from the BASE branch
# (origin/main by default), never from the PR, so a PR cannot change the rules that judge it. The printed JSON line carries
# the head SHA; the hub merges a `low` PR only if that SHA is still the PR's head at merge time.
#
# Environment
#   PR_AUTHOR  login of the PR author (hub: gh pr view <n> --json author -q .author.login)
#   PR_TITLE   PR title             (hub: gh pr view <n> --json title -q .title)
#   BASE_REF   base to compare with (default origin/main; run `git fetch origin main <head>` first)
# Output: one JSON line on stdout (see pr_risk.py), the table on stderr / $GITHUB_STEP_SUMMARY.
# Exit non-zero (and print no JSON) when it cannot judge: treat that as `human`.
set -euo pipefail

sha="${1:-}"
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: pr_risk_check.sh <40-hex head sha>" >&2
  exit 2
fi
base_ref="${BASE_REF:-origin/main}"
: "${PR_AUTHOR:?PR_AUTHOR is required}"
: "${PR_TITLE=}"
export PR_AUTHOR PR_TITLE

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git cat-file -e "${sha}^{commit}"
merge_base="$(git merge-base "$base_ref" "$sha")"
git show "$base_ref:.github/scripts/pr_risk.py" > "$tmp/pr_risk.py"

git diff --name-status --no-renames "$base_ref...$sha" > "$tmp/name-status.txt"
git diff --numstat --no-renames "$base_ref...$sha" > "$tmp/numstat.txt"
git diff --raw --no-renames "$base_ref...$sha" > "$tmp/raw.txt"
git log --format=%ae "$merge_base..$sha" > "$tmp/emails.txt"

python3 -I "$tmp/pr_risk.py" --base "$merge_base" --head "$sha" \
  --numstat "$tmp/numstat.txt" --raw "$tmp/raw.txt" --emails "$tmp/emails.txt" < "$tmp/name-status.txt"
