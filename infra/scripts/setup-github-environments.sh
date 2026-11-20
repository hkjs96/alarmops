#!/usr/bin/env bash
# Creates the GitHub environments and variables that the deploy workflows need (D-58). A person runs this once, after the
# bootstrap stack (infra/aws/central-bootstrap.yaml) exists. CloudFormation cannot create GitHub environments.
#
#   - environments: central, central-bus, production (change with --envs)
#   - required reviewer: one person; prevent_self_review=false (a single approver could not approve otherwise)
#   - deployment branches: custom policy with main only
#   - variables: given with --var ENV:NAME=VALUE, or read from the stack outputs with --from-stack
# Safe to run again: environments, branch policies and variables are updated in place.
# Secrets (VERCEL_TOKEN and so on) are never handled here. Set them yourself with `gh secret set` (printed at the end).
#
# Needs: gh (logged in with admin rights on the repo). --from-stack also needs the aws CLI and a session that you opened
# yourself (SSO, MFA) for the central account. This script does not log in to anything.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: setup-github-environments.sh --repo OWNER/REPO --reviewer GITHUB_LOGIN [options]

  --repo OWNER/REPO       repository (required)
  --reviewer LOGIN        required reviewer, a GitHub user login (required)
  --envs a,b,c            environments to create (default: central,central-bus,production)
  --var ENV:NAME=VALUE    set an environment variable; repeatable. Example: --var central:VERCEL_TEAM_SLUG=my-team
  --from-stack            read the bootstrap stack outputs with `aws cloudformation describe-stacks --query` and set
                            central:CENTRAL_DEPLOY_ROLE_ARN, central:VERCEL_OIDC_PROVIDER_ARN, central:SAM_ARTIFACT_BUCKET,
                            central-bus:CENTRAL_BUS_DEPLOY_ROLE_ARN
  --stack-name NAME       bootstrap stack (default: alarmops-central-bootstrap)
  --region REGION         region of the stack (default: ap-northeast-2)
  --profile NAME          aws CLI profile for --from-stack (optional; use the one you signed in with)
  --dry-run               print what would be done, call nothing
  -h, --help
A --var for the same variable wins over --from-stack.
EOF
}

repo="" reviewer="" envs="central,central-bus,production" from_stack=0 dry=0
stack="alarmops-central-bootstrap" region="ap-northeast-2" profile=""
declare -a vars=()

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?}"; shift 2 ;;
    --reviewer) reviewer="${2:?}"; shift 2 ;;
    --envs) envs="${2:?}"; shift 2 ;;
    --var) vars+=("${2:?}"); shift 2 ;;
    --from-stack) from_stack=1; shift ;;
    --stack-name) stack="${2:?}"; shift 2 ;;
    --region) region="${2:?}"; shift 2 ;;
    --profile) profile="${2:?}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$repo" ] && [ -n "$reviewer" ] || { usage >&2; exit 2; }
[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "bad --repo: $repo" >&2; exit 2; }
for part in "${repo%%/*}" "${repo#*/}"; do
  { [ "$part" = "." ] || [ "$part" = ".." ]; } && { echo "bad --repo (component . or ..): $repo" >&2; exit 2; }
done
[[ "$reviewer" =~ ^[A-Za-z0-9-]+$ ]] || { echo "bad --reviewer: $reviewer" >&2; exit 2; }

run() { if [ "$dry" = 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }

stack_output() {
  local args=(cloudformation describe-stacks --region "$region" --stack-name "$stack"
              --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text)
  [ -n "$profile" ] && args+=(--profile "$profile")
  aws "${args[@]}"
}

# ENV:NAME=VALUE pairs, "env:name" -> value. Bash 3 compatible (Git Bash): two parallel arrays.
declare -a kv_key=() kv_val=()
put_kv() {
  local i
  for i in "${!kv_key[@]}"; do
    if [ "${kv_key[$i]}" = "$1" ]; then kv_val[$i]="$2"; return; fi
  done
  kv_key+=("$1"); kv_val+=("$2")
}

if [ "$from_stack" = 1 ]; then
  for m in "central:CENTRAL_DEPLOY_ROLE_ARN:DeployCentralRoleArn" \
           "central:VERCEL_OIDC_PROVIDER_ARN:VercelOidcProviderArn" \
           "central:SAM_ARTIFACT_BUCKET:SamArtifactBucketName" \
           "central-bus:CENTRAL_BUS_DEPLOY_ROLE_ARN:DeployBusRoleArn"; do
    IFS=: read -r e n o <<<"$m"
    if [ "$dry" = 1 ]; then
      echo "DRY-RUN: aws cloudformation describe-stacks --stack-name $stack --query <output $o>  -> $e:$n"
      put_kv "$e:$n" "<output $o>"
    else
      v="$(stack_output "$o")"
      { [ -n "$v" ] && [ "$v" != "None" ]; } || { echo "stack output $o is empty; is $stack complete?" >&2; exit 1; }
      put_kv "$e:$n" "$v"
    fi
  done
fi

for kv in "${vars[@]+"${vars[@]}"}"; do
  [[ "$kv" =~ ^([A-Za-z0-9._-]+):([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || { echo "bad --var (want ENV:NAME=VALUE): ${kv%%=*}" >&2; exit 2; }
  kv_env="${BASH_REMATCH[1]}" kv_name="${BASH_REMATCH[2]}" kv_value="${BASH_REMATCH[3]}"
  shopt -s nocasematch
  if [[ "$kv_name" =~ (TOKEN|SECRET|PASSWORD|PASS|PRIVATE|KEY|CREDENTIAL|AUTH|CERT|APIKEY) ]]; then
    shopt -u nocasematch
    echo "refusing $kv_name: it looks like a secret. Use: gh secret set $kv_name --repo $repo --env $kv_env" >&2
    exit 2
  fi
  shopt -u nocasematch
  case "$kv_value" in
    AKIA*|ghp_*|github_pat_*|-----BEGIN*)
      echo "refusing the value of $kv_name: it looks like a credential. Use gh secret set." >&2
      exit 2 ;;
  esac
  put_kv "$kv_env:$kv_name" "$kv_value"
done

if [ "$dry" = 1 ]; then
  reviewer_id="<id of $reviewer>"
else
  reviewer_id="$(gh api "users/$reviewer" --jq .id)"
fi

IFS=, read -ra env_list <<<"$envs"
for env in "${env_list[@]}"; do
  [[ "$env" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad environment name: $env" >&2; exit 2; }
  echo "== environment $env"
  # PUT creates or replaces the settings. Body: reviewer, prevent_self_review=false, custom branch policy.
  body="$(printf '{"reviewers":[{"type":"User","id":%s}],"prevent_self_review":false,"can_admins_bypass":false,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' "${reviewer_id//[^0-9]/}")"
  if [ "$dry" = 1 ]; then
    echo "DRY-RUN: gh api -X PUT repos/$repo/environments/$env --input - <<< (reviewer $reviewer, prevent_self_review=false, can_admins_bypass=false, custom branch policy)"
  else
    printf '%s' "$body" | gh api -X PUT "repos/$repo/environments/$env" --input - >/dev/null
  fi

  # Branch policy: main only. Remove other custom policies so the result is exactly {main}.
  if [ "$dry" = 1 ]; then
    echo "DRY-RUN: gh api repos/$repo/environments/$env/deployment-branch-policies  (keep/create main, delete the rest)"
  else
    have_main=0
    # List first; a failure here stops the script (set -e) instead of looking like "no policies".
    policies="$(gh api --paginate "repos/$repo/environments/$env/deployment-branch-policies" \
      --jq '.branch_policies[] | [.id, .type, .name] | @tsv')" || { echo "cannot list branch policies of $env" >&2; exit 1; }
    # Keep only type=branch name=main; delete everything else.
    while IFS=$'\t' read -r pid ptype pname; do
      [ -n "$pid" ] || continue
      if [ "$ptype" = "branch" ] && [ "$pname" = "main" ] && [ "$have_main" = 0 ]; then have_main=1
      else gh api -X DELETE "repos/$repo/environments/$env/deployment-branch-policies/$pid" >/dev/null; fi
    done <<<"$policies"
    if [ "$have_main" = 0 ]; then
      gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name=main -f type=branch >/dev/null
    fi
  fi

  for i in "${!kv_key[@]}"; do
    e="${kv_key[$i]%%:*}" n="${kv_key[$i]#*:}"
    [ "$e" = "$env" ] || continue
    if [ "$dry" = 1 ]; then
      echo "DRY-RUN: set variable $n on $env"
    else
      # Update when it exists, create otherwise (idempotent).
      if ! gh api -X PATCH "repos/$repo/environments/$env/variables/$n" -f name="$n" -f value="${kv_val[$i]}" >/dev/null 2>&1; then
        gh api -X POST "repos/$repo/environments/$env/variables" -f name="$n" -f value="${kv_val[$i]}" >/dev/null
      fi
      echo "   variable $n set"
    fi
  done
done

# Variables given for an environment that is not in --envs would be dropped silently; say so.
for k in "${kv_key[@]+"${kv_key[@]}"}"; do
  e="${k%%:*}"; found=0
  for env in "${env_list[@]}"; do [ "$env" = "$e" ] && found=1; done
  [ "$found" = 1 ] || echo "warning: $k belongs to environment $e, which is not in --envs; skipped" >&2
done

cat <<EOF

Done. Not done by this script (secrets; run them yourself, the value is read from a prompt):
  gh secret set VERCEL_TOKEN      --repo $repo --env production
  gh secret set VERCEL_ORG_ID     --repo $repo --env production
  gh secret set VERCEL_PROJECT_ID --repo $repo --env production
Also set by hand: central:VERCEL_TEAM_SLUG and central:VERCEL_PROJECT_NAME (--var), and the optional variables listed in docs/GO-LIVE.md 4-2.
EOF
