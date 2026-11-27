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

rh_die() { printf '오류: %s\n' "$(rh_mask "$1")" >&2; exit "${2:-1}"; }

# 마스킹은 두 단계다.
#  rh_mask_data: 데이터 경로(aws_r 의 stdout 반환. 호출자가 알람·큐 이름, URL 을 파싱한다). 확실한 것만 가린다:
#    ExternalId 원문, ASIA/AKIA 키 ID, Authorization 키워드 뒤의 스킴+값(Basic·Bearer), 키워드 뒤의 값(security-token,
#    session_token, secret_access_key, secret_key, access_token, x-amz-sso_bearer_token, bearer, authorization, password;
#    키워드와 값 사이에 : 또는 = 가 있을 때만 값으로 본다(공백만 있는 "Password Expiry" 같은 이름은 건드리지 않는다. JSON 의 ": " 형태는 포함).
#    x-amz-signature·signature 도 키워드다. 값은 공백·따옴표·쉼표·&·; 에서 끝난다). 문장 속 "basic monitoring" 같은 일반 영어는 가리지 않는다(스킴 단독 규칙 없음).
#    sed 의 I(대소문자 무시) 플래그는 GNU sed 전용이다(Git Bash 포함, BSD/macOS sed 는 다를 수 있다).
#  rh_mask: 사람에게 보이는 경로(rh_say, rh_log, rh_die, aws_r 의 stderr, rp_mask). rh_mask_data 에 더해 긴 토큰 휴리스틱:
#    (1) 40자 이상이면서 + / = % 중 하나를 포함, (2) 80자 이상 단일 토큰,
#    (3) 정확히 40자이고 [A-Za-z0-9/+] 로만 이루어졌으며 대문자·소문자·숫자를 모두 포함(AWS 비밀 액세스 키 모양). - _ . 가 붙은
#    토큰은 (3) 에서 제외한다(이름·ARN 조각, 앞뒤가 . 인 경우 포함).
#    긴 이름·ARN·URL 경로가 걸리지 않게 "arn:aws" 를 포함한 단어는 건드리지 않는다. "://" URL 은 ? 앞(경로)만 건너뛰고
#    ? 뒤(쿼리 값, 예: presigned 서명)는 위 규칙과 "hex 64자 이상 값" 규칙으로 검사한다. URL 의 userinfo(://user:pw@)는 ://****@ 로 가린다(사람 경로만).
#    정확히 40자 규칙의 "뒤가 ." 예외는 . 다음이 영숫자일 때(점이 있는 이름)만이다. 문장 끝 마침표 앞의 비밀은 가린다. awk 는 구간 표현식 {n,} 를 쓰지 않는다(mawk 호환).
rh_mask_data() {
  local t="$1"
  if [ -n "$RH_EID" ]; then t="${t//"$RH_EID"/****}"; fi
  t="$(printf '%s\n' "$t" | sed -E \
    -e 's/(ASIA|AKIA)[A-Z0-9]{12,}/****/g' \
    -e "s/(authorization[\"' ]*[=:][=:\"' ]*)(basic|bearer)[ ]+[^[:space:],\"'&;)}]+/\\1****/Ig" \
    -e "s/(security-token|session_?token|secret_?access_?key|secret_?key|access_?token|x-amz-sso_bearer_token|x-amz-signature|signature|bearer|authorization|password)[\"' ]*[=:][=:\"' ]*[^[:space:],\"'&;)}]+/\\1=****/Ig")"
  printf '%s' "$t"
}

rh_mask() {
  local t
  t="$(rh_mask_data "$1")"
  t="$(printf '%s\n' "$t" | sed -E 's#(://)[^/@[:space:]]+@#\1****@#g' | awk '
    function isalnum40(tok) {   # 정확히 40자, [A-Za-z0-9/+] 로만, 대문자·소문자·숫자 모두
      return (length(tok) == 40 && tok ~ /^[A-Za-z0-9\/+]+$/ && tok ~ /[A-Z]/ && tok ~ /[a-z]/ && tok ~ /[0-9]/)
    }
    function maskplain(w,   out, tok, rest, before, after, after2) {
      out = ""; rest = w
      while (match(rest, /[A-Za-z0-9+\/=%_-]+/)) {
        tok = substr(rest, RSTART, RLENGTH)
        before = (RSTART > 1) ? substr(rest, RSTART - 1, 1) : ""
        after = substr(rest, RSTART + RLENGTH, 1)
        after2 = substr(rest, RSTART + RLENGTH + 1, 1)
        if ((length(tok) >= 40 && tok ~ /[+\/=%]/) || length(tok) >= 80) tok = "****"
        else if (before != "." && !(after == "." && after2 ~ /[A-Za-z0-9]/) && isalnum40(tok)) tok = "****"
        out = out substr(rest, 1, RSTART - 1) tok
        rest = substr(rest, RSTART + RLENGTH)
      }
      return out rest
    }
    function maskquery(q,   n, parts, i, eq, val, out) {   # & 로 나눠 값이 hex 64자 이상이면 가리고(서명 모양) 나머지는 maskplain
      n = split(q, parts, "&"); out = ""
      for (i = 1; i <= n; i++) {
        eq = index(parts[i], "="); val = (eq > 0) ? substr(parts[i], eq + 1) : ""
        if (eq > 0 && length(val) >= 64 && val ~ /^[0-9A-Fa-f]+$/) parts[i] = substr(parts[i], 1, eq) "****"
        else parts[i] = maskplain(parts[i])
        out = out (i > 1 ? "&" : "") parts[i]
      }
      return out
    }
    function maskword(w,   q) {
      if (index(w, "arn:aws")) return w
      if (index(w, "://")) {   # URL: 경로는 이름이라 건너뛰고 쿼리 값만 검사한다
        q = index(w, "?")
        if (q == 0) return w
        return substr(w, 1, q) maskquery(substr(w, q + 1))
      }
      return maskplain(w)
    }
    {
      out = ""; s = $0
      while (match(s, /[^ \t"\047,]+/)) {
        rs = RSTART; rl = RLENGTH   # maskword 안의 match 가 RSTART/RLENGTH 를 덮어쓴다
        out = out substr(s, 1, rs - 1) maskword(substr(s, rs, rl))
        s = substr(s, rs + rl)
      }
      print out s
    }')"
  printf '%s' "$t"
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

# 모든 aws 호출은 이 래퍼로만. stdout 은 rh_mask_data(데이터 경로), stderr 은 rh_mask(사람에게 보임)를 거친다.
aws_r() {
  local out rc=0 errf err
  rh_tmpfile; errf="$RH_TMPF"
  out="$(aws --profile "$RH_PROFILE" --region "$RH_REGION" "$@" 2>"$errf" </dev/null)" || rc=$?   # stdin 을 넘기지 않는다(사람 응답을 aws 가 먹지 않게)
  if [ -n "$out" ]; then printf '%s\n' "$(rh_mask_data "$out")"; fi   # 데이터 경로: 긴 토큰 휴리스틱을 쓰지 않는다
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

# (다) 유지 대기 안내: 사람에게(stderr) 언제까지 기다리는지와 그동안 Stop 을 누르지 말라고 알린다.
rh_hold_notice() {
  local mins=$(( (RH_WAIT_SECONDS + 59) / 60 )) until=""
  until="$(date -d "@$(( $(date +%s) + RH_WAIT_SECONDS ))" +%H:%M 2>/dev/null || true)"
  {
    printf '\n>>> (다) 태그를 뗐습니다. 약 %s분%s 동안 알람이 그대로 남는지 지켜봅니다.\n' "$mins" "${until:+(${until}까지)}"
    printf '>>> 이 동안 콘솔에서 Stop monitoring 을 누르지 마세요. 누르면 알람이 지워져 D-16 위반(FAIL)으로 잘못 판정됩니다.\n'
    printf '>>> Needs review 표시는 지금 봐도 됩니다. Stop 은 대기가 끝나고 여기서 물어볼 때 누릅니다.\n\n'
  } >&2
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

# 이름 목록 -> JSON 배열 문자열 한 개(stdout). aws CLI 는 리스트형 인자 값이 `[` 로 시작하면 JSON 으로 해석하므로
# `--alarm-names "[SQS] ..."` 는 "Invalid JSON" 으로 실패한다. 엔진 알람 이름은 `[{type}] ...` 이라 `--alarm-names` 에는
# 항상 이 함수의 결과(JSON 배열 하나)를 넘긴다: --alarm-names "$(rh_json_array "${names[@]}")". 백슬래시와 큰따옴표는 이스케이프한다.
rh_json_array() {
  local out="" first=1 n
  for n in "$@"; do
    n="${n//$'\r'/}"
    n="${n//\\/\\\\}"
    n="${n//\"/\\\"}"
    if [ "$first" = 1 ]; then first=0; else out="$out,"; fi
    out="$out\"$n\""
  done
  printf '[%s]' "$out"
}

# 이 큐를 차원(QueueName)으로 가진 ManagedBy=AlarmOps 알람 이름을 전역 배열 RH_ALARMS 에 담는다 (B2, B10).
# 조회가 하나라도 실패하면 1을 돌려준다(없음과 구분). 프로세스 치환·명령 치환으로 부르지 말고
# 직접 호출해 종료 코드를 확인할 것.
rh_run_alarms() {
  local q="$1" js cand name arn tags pc
  RH_ALARMS=()
  js="$(aws_r cloudwatch describe-alarms)" || js="$(aws_r cloudwatch describe-alarms)" || return 1   # 일시 오류는 한 번 다시 시도한다
  # 아래 파이프라인은 파일 맨 위의 set -o pipefail 에 기대어 python 이 실패하면 cand 대입도 실패시켜 return 1 이 되게 한다.
  # pipefail 이 꺼지면 python 실패가 빈 cand("알람 없음")로 보여 fail-open 이 되므로 그 설정을 지우지 말 것.
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
