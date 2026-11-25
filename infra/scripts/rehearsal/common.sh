#!/usr/bin/env bash
# 리허설 하네스 공통 함수 (#122). 다른 스크립트가 source 한다. 단독 실행 대상 아님.
# 사람이 시험 계정(rehearsal-*)에서만 실행한다. 에이전트 실행·상시 자격증명·중앙/개발 계정은 거부한다.
# set -x 금지: ExternalId가 추적 출력에 나올 수 있다.
set -euo pipefail

RH_REGION="ap-northeast-2"
RH_STACK_NAME_CONST="alarmops-customer"
RH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RH_REPO="$(cd "$RH_DIR/../../.." && pwd)"
RH_TEMPLATE="$RH_REPO/infra/customer-stack/template.yaml"
RH_EID="${REHEARSAL_EXTERNAL_ID:-}"
RH_POLL_INTERVAL="${REHEARSAL_POLL_INTERVAL:-30}"
RH_WAIT_SECONDS="${REHEARSAL_WAIT_SECONDS:-900}"   # 디바운스 10분 + 여유 5분(R9)

RH_PROFILE=""; RH_CONFIRM=""; RH_CONFIRM_GIVEN=0; RH_RUN_ID=""; RH_STACK=0; RH_STACK_NAME=""
RH_LOG=""; RH_TMPS=(); RH_TMPF=""; RH_ALARMS=()
RH_ALLOWED=" --profile "

rh_die() { printf '오류: %s\n' "$1" >&2; exit "${2:-1}"; }

rh_mask() {
  if [ -n "$RH_EID" ]; then printf '%s' "${1//"$RH_EID"/****}"; else printf '%s' "$1"; fi
}

rh_cleanup_tmps() {
  local f
  for f in ${RH_TMPS[@]+"${RH_TMPS[@]}"}; do rm -f "$f"; done
}
trap rh_cleanup_tmps EXIT

# 권한 600 임시 파일. 경로는 전역 RH_TMPF 로 돌려준다. 명령 치환($(...))으로 부르지 않는다:
# 서브셸에서는 RH_TMPS 등록이 사라져 EXIT 트랩이 지우지 못한다.
rh_tmpfile() {
  RH_TMPF="$(umask 077; mktemp)"
  RH_TMPS+=("$RH_TMPF")
}

rh_native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

rh_find_python() {
  local c
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then RH_PY="$c"; return 0; fi
  done
  rh_die "python3 또는 python이 필요하다"
}

# 1) 에이전트·상시 자격증명 거부 (aws를 부르기 전)
rh_env_check() {
  local v
  for v in CLAUDECODE CLAUDE_CODE_ENTRYPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
           AWS_DEFAULT_PROFILE AWS_PROFILE; do
    if [ -n "${!v+set}" ]; then
      rh_die "환경변수 $v 가 설정되어 있다. 에이전트 세션이나 상시 자격증명에서는 실행하지 않는다. 사람이 별도 터미널에서 --profile 로만 실행한다." 2
    fi
  done
}

# 인자 파싱. 스크립트가 RH_ALLOWED 에 허용 플래그를 적는다.
rh_parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --stack) [[ "$RH_ALLOWED" == *" --stack "* ]] || rh_die "알 수 없는 인자: $1" 2; RH_STACK=1; shift ;;
      --profile|--confirm-account|--run-id|--stack-name)
        [[ "$RH_ALLOWED" == *" $1 "* ]] || rh_die "알 수 없는 인자: $1" 2
        [ $# -ge 2 ] || rh_die "$1 에 값이 필요하다" 2
        case "$1" in
          --profile) RH_PROFILE="$2" ;;
          --confirm-account) RH_CONFIRM="$2"; RH_CONFIRM_GIVEN=1 ;;
          --run-id) RH_RUN_ID="$2" ;;
          --stack-name) RH_STACK_NAME="$2" ;;
        esac
        shift 2 ;;
      *) rh_die "알 수 없는 인자: $1" 2 ;;
    esac
  done
}

# 모든 aws 호출은 이 래퍼로만. 출력은 ExternalId 마스킹을 거친다.
aws_r() {
  local out rc=0 errf err
  rh_tmpfile; errf="$RH_TMPF"
  out="$(aws --profile "$RH_PROFILE" --region "$RH_REGION" "$@" 2>"$errf" </dev/null)" || rc=$?   # stdin 을 넘기지 않는다(사람 응답을 aws 가 먹지 않게)
  if [ -n "$out" ]; then printf '%s\n' "$(rh_mask "$out")"; fi
  if [ -s "$errf" ]; then
    err="$(cat "$errf")"
    printf '%s\n' "$(rh_mask "$err")" >&2
  fi
  rm -f "$errf"
  return "$rc"
}

# 계정 표(accounts.local.json) 읽기 → RH_* 전역
rh_load_accounts() {
  local file="${REHEARSAL_ACCOUNTS_FILE:-$RH_DIR/accounts.local.json}" out F
  [ -f "$file" ] || rh_die "계정 표가 없다: $file (accounts.local.json 은 저장소에 올리지 않는 로컬 파일이다)"
  out="$("$RH_PY" -c '
import json, re, sys
f, p = sys.argv[1], sys.argv[2]
d = json.load(open(f, encoding="utf-8"))
def acct(arn):
    m = re.match(r"^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:(\d{12}):", arn or "")
    return m.group(1) if m else ""
role, bus = d.get("centralRoleArn", ""), d.get("centralEventBusArn", "")
for v in (d.get("profiles", {}).get(p, ""), d.get("centralAccountId", ""), d.get("devAccountId", ""),
          " ".join(str(x) for x in d.get("denyAccounts", [])), role, bus, acct(role), acct(bus)):
    print(v)
' "$(rh_native_path "$file")" "$RH_PROFILE" 2>/dev/null | tr -d '\r')" || rh_die "계정 표를 읽지 못했다: $file"
  mapfile -t F <<<"$out"
  RH_TABLE_ACCT="${F[0]:-}"; RH_CENTRAL_ACCT="${F[1]:-}"; RH_DEV_ACCT="${F[2]:-}"; RH_DENY_ACCTS="${F[3]:-}"
  RH_CENTRAL_ROLE_ARN="${F[4]:-}"; RH_CENTRAL_BUS_ARN="${F[5]:-}"
  RH_ROLE_ACCT="${F[6]:-}"; RH_BUS_ACCT="${F[7]:-}"
  [[ "$RH_TABLE_ACCT" =~ ^[0-9]{12}$ ]] || rh_die "프로필 $RH_PROFILE 이 계정 표에 없다"
  [[ "$RH_CENTRAL_ACCT" =~ ^[0-9]{12}$ && "$RH_DEV_ACCT" =~ ^[0-9]{12}$ ]] || rh_die "계정 표에 centralAccountId·devAccountId 가 필요하다"
  if [ -n "$RH_CENTRAL_ROLE_ARN" ] && [ -z "$RH_ROLE_ACCT" ]; then rh_die "centralRoleArn 형식 오류"; fi
  if [ -n "$RH_CENTRAL_BUS_ARN" ] && [ -z "$RH_BUS_ACCT" ]; then rh_die "centralEventBusArn 형식 오류"; fi
}

rh_deny_check() {  # $1 = 검사할 계정
  local a="$1" d
  for d in "$RH_CENTRAL_ACCT" "$RH_DEV_ACCT" "$RH_ROLE_ACCT" "$RH_BUS_ACCT" $RH_DENY_ACCTS; do
    if [ -n "$d" ] && [ "$a" = "$d" ]; then
      rh_die "계정 $a 는 중앙·개발·거부 목록 계정이거나 중앙 역할/버스의 계정이다. 시험 계정(B·C)에서만 실행한다." 3
    fi
  done
}

# 안전 관문. $1 = confirm 필수 여부(1/0)
rh_guard() {
  local need_confirm="$1" ident
  rh_env_check
  [[ "$RH_PROFILE" =~ ^rehearsal-[a-z0-9-]+$ ]] || rh_die "--profile 은 ^rehearsal-[a-z0-9-]+\$ 형식이어야 한다" 2
  rh_find_python
  rh_load_accounts
  if [ "$RH_CONFIRM_GIVEN" = 0 ] && [ -t 0 ]; then
    read -r -p "대상 계정 12자리를 다시 입력하세요: " RH_CONFIRM || true
    RH_CONFIRM_GIVEN=1
  fi
  if [ "$RH_CONFIRM_GIVEN" = 1 ] || [ "$need_confirm" = 1 ]; then
    [[ "$RH_CONFIRM" =~ ^[0-9]{12}$ ]] || rh_die "--confirm-account 12자리가 필요하다" 2
    [ "$RH_CONFIRM" = "$RH_TABLE_ACCT" ] || rh_die "입력한 계정이 계정 표의 $RH_PROFILE 계정과 다르다" 2
  fi
  rh_deny_check "$RH_TABLE_ACCT"
  ident="$(aws_r sts get-caller-identity --query Account --output text)" || rh_die "sts get-caller-identity 실패"
  [[ "$ident" =~ ^[0-9]{12}$ ]] || rh_die "계정 식별 결과가 이상하다"
  [ "$ident" = "$RH_TABLE_ACCT" ] || rh_die "프로필이 실제로 가리키는 계정($ident)이 계정 표와 다르다"
  rh_deny_check "$ident"
  RH_ACCT="$ident"
}

rh_check_run_id() {
  [[ "$RH_RUN_ID" =~ ^[A-Za-z0-9_-]{1,50}$ ]] || rh_die "--run-id 는 영문·숫자·_- 50자 이내여야 한다" 2
}

# 로그: rehearsal-logs/<profile>/<name>.md, 권한 600
rh_log_open() {  # $1=파일 이름(확장자 제외) $2=truncate 여부
  local base="${REHEARSAL_LOG_DIR:-$RH_REPO/rehearsal-logs}" dir
  dir="$base/$RH_PROFILE"
  (umask 077; mkdir -p "$dir")
  RH_LOG="$dir/$1.md"
  if [ "${2:-}" = truncate ]; then (umask 077; : >"$RH_LOG"); else (umask 077; : >>"$RH_LOG"); fi
  chmod 600 "$RH_LOG"
}

rh_log() { if [ -n "$RH_LOG" ]; then printf '%s\n' "$(rh_mask "$1")" >>"$RH_LOG"; fi; }
rh_say() { printf '%s\n' "$(rh_mask "$1")"; rh_log "$1"; }

rh_ask() {  # 사람 확인. y 면 0. 입력이 없으면(비대화형) 1
  local ans
  printf '%s [y/N] ' "$1" >&2
  read -r ans || { printf '\n' >&2; return 1; }
  [[ "$ans" == y || "$ans" == Y ]]
}

# 폴링: 명령(함수)이 성공하면 0, 상한(RH_WAIT_SECONDS) 안에 안 되면 1
rh_poll() {
  local start now
  start=$(date +%s)
  while :; do
    if "$@"; then return 0; fi
    now=$(date +%s)
    [ $((now - start)) -ge "$RH_WAIT_SECONDS" ] && return 1
    sleep "$RH_POLL_INTERVAL"
  done
}

# 이 큐를 차원(QueueName)으로 가진 ManagedBy=AlarmOps 알람 이름을 전역 배열 RH_ALARMS 에 담는다 (B2, B10).
# 조회가 하나라도 실패하면 1을 돌려준다(없음과 구분). 프로세스 치환·명령 치환으로 부르지 말고
# 직접 호출해 종료 코드를 확인할 것.
rh_run_alarms() {
  local q="$1" js cand name arn tags pc
  RH_ALARMS=()
  js="$(aws_r cloudwatch describe-alarms)" || return 1
  cand="$(printf '%s' "$js" | "$RH_PY" -c '
import json, sys
q = sys.argv[1]
for a in json.load(sys.stdin).get("MetricAlarms", []):
    if any(d.get("Name") == "QueueName" and d.get("Value") == q for d in a.get("Dimensions", [])):
        print(a["AlarmName"] + "\t" + a.get("AlarmArn", ""))
' "$q" | tr -d '\r')" || return 1
  [ -n "$cand" ] || return 0
  while IFS=$'\t' read -r name arn; do
    [ -n "$name" ] || continue
    tags="$(aws_r cloudwatch list-tags-for-resource --resource-arn "$arn")" || { RH_ALARMS=(); return 1; }
    pc=0
    printf '%s' "$tags" | "$RH_PY" -c '
import json, sys
try:
    t = json.load(sys.stdin).get("Tags", [])
except Exception:
    sys.exit(2)
sys.exit(0 if any(x.get("Key") == "ManagedBy" and x.get("Value") == "AlarmOps" for x in t) else 1)
' || pc=$?
    case "$pc" in
      0) RH_ALARMS+=("$name") ;;
      1) ;;
      *) RH_ALARMS=(); return 1 ;;
    esac
  done <<<"$cand"
  return 0
}
