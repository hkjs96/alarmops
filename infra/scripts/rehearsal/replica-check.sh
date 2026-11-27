#!/usr/bin/env bash
# AlarmWriter 복제 역할 실측 (#159, GO-LIVE 4단계 "1회 수동 실측"). 시뮬레이션이 못 보는 CloudWatch의 실제 태그 조건 처리를 본다.
# 사용: bash replica-check.sh --profile rehearsal-b --confirm-account 12자리 [--cleanup-only]
# 사전 준비: 별도 터미널에서 SSO 로그인(프로필 rehearsal-<이름>). 종료 코드 1~5 는 표가 나오기 전 중단일 수 있다(GO-LIVE 4단계).
# 원본 AlarmOps-AlarmWriter 의 권한 정책·권한 경계를 그대로 복사한 임시 역할 AlarmOpsRehearsal-WriterReplica 를 만들고,
# 본인 SSO 역할로 assume 해서 6개((a)~(f))를 확인하고, 정보 행 (g)(D-63 알려진 한계, 종료 코드에 영향 없음)를 덧붙인다. 끝나면(실패·중단 포함) 만든 것을 모두 지운다.
# 임시 자격증명은 출력·로그·부모 셸 환경변수에 두지 않는다(호출마다 서브셸 안에서만 export).
# 종료 코드: 전부 PASS 0, 그 밖 1, 인자·안전 관문 거부 2 이상.
# 선택 모드 --probe-resource-tag-deny: (a)~(f) 표를 돌리지 않고(대신 쓴다), 원본 정책에 명시적 Deny(DenyOverwriteUnmanaged)를 더한 두 변형
#   (null = Null aws:ResourceTag/ManagedBy, stringnotequals = StringNotEquals)이 "태그 없는 기존 알람 덮어쓰기"만 막고 새 알람 생성·관리 알람
#   수정·삭제는 막지 않는지 잰다. probe 알람 이름은 `[AlarmOpsRehearsal] probe-<변형>-<new|unmanaged|canary|other>`(D-63: `[` 로 시작해야 생성이 닿는다). 측정이라 판정이 "사용 불가"여도 종료 코드 0. 준비·오류로 중단하면 1(안전 관문 거부는 2 이상). 같은 정리 규칙을 쓴다.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

CLEANUP_ONLY=0
PROBE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--cleanup-only" ]; then CLEANUP_ONLY=1
  elif [ "$a" = "--probe-resource-tag-deny" ]; then PROBE=1
  else ARGS+=("$a"); fi
done
RH_ALLOWED=" --profile --confirm-account "
rh_env_check
# 이 스크립트만 더 엄격하다: 엔드포인트·설정 파일·CA 번들을 바꾸는 변수는 임시 자격증명이 엉뚱한 곳으로 가게 할 수 있다.
for v in AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_CA_BUNDLE $(compgen -v | grep '^AWS_ENDPOINT_URL' || true); do
  if [ -n "${!v+set}" ]; then
    rh_die "환경변수 $v 가 설정되어 있다. replica-check 는 임시 자격증명을 쓰므로 엔드포인트·설정 파일·CA 번들 재지정 변수를 비운 터미널에서만 실행한다." 2
  fi
done
rh_parse_args ${ARGS[@]+"${ARGS[@]}"}
rh_guard 1
if [ "$CLEANUP_ONLY" = 1 ]; then rh_log_open replica-check; else rh_log_open replica-check truncate; fi

ORIG_ROLE="AlarmOps-AlarmWriter"
POLICY_NAME="manage-alarmops-alarms"
REPLICA="AlarmOpsRehearsal-WriterReplica"
# D-63: 관리 알람(엔진이 만드는 모양)은 이름이 `[` 로 시작한다. AlarmWriter 의 생성 허용 Resource 가 `alarm:[*` 라서다.
# ALARM_U 는 고객 알람처럼 `[` 로 시작하지 않는다((f): 덮어쓰기 거부가 기대값). ALARM_V 는 `[` 로 시작하는 태그 없는 알람((g): 알려진 한계).
# 이름에 공백·대괄호가 있으니 모든 인자는 따옴표로 감싼다(Git Bash).
ALARM_T="[AlarmOpsRehearsal] replica-test"
ALARM_U="AlarmOpsRehearsal-replica-unmanaged"
ALARM_V="[AlarmOpsRehearsal] replica-unmanaged-bracket"
ALARM_NS="AlarmOpsRehearsal"                         # 이 스크립트가 만드는 모든 알람의 Namespace. 다르면 우리가 만든 알람이 아니다
PROBE_POLICY="probe-deny"
PROBE_VARIANTS=(null stringnotequals)
PROBE_SUFFIXES=(new unmanaged canary other)         # probe 이름은 이 스크립트 전용 접두어("[AlarmOpsRehearsal] probe-")라 시작할 때 지워도 된다. `[` 로 시작해야 원본 정책의 생성 허용(D-63)이 닿는다
probe_alarm_names() {
  local v x
  for v in "${PROBE_VARIANTS[@]}"; do for x in "${PROBE_SUFFIXES[@]}"; do printf '%s\n' "[AlarmOpsRehearsal] probe-$v-$x"; done; done
}
PROBE_WAIT="${REHEARSAL_PROBE_WAIT:-20}"            # 정책을 바꾼 뒤 전파 대기(초). 바꾼 Deny가 늦게 퍼지면 p2 가 잘못 ALLOWED 로 나온다
RETRIES="${REHEARSAL_ASSUME_RETRIES:-12}"           # 12 x 5초 = 약 60초 (IAM 전파)
RETRY_INTERVAL="${REHEARSAL_ASSUME_INTERVAL:-5}"
RP_AK=""; RP_SK=""; RP_ST=""                        # 임시 자격증명. export 하지 않는다.
RP_OUT=""; RP_ERR=""; RP_RC=0
DO_CLEANUP=0; CLEAN_FAIL=0; FAILS=0

rp_mask() {  # 정확한 값 치환을 더하고, 자격증명 모양 마스킹은 common.sh rh_mask 가 한다
  local t="$1" v
  for v in "$RP_AK" "$RP_SK" "$RP_ST"; do
    if [ -n "$v" ]; then t="${t//"$v"/****}"; fi
  done
  rh_mask "$t"
}

# $1 = person|replica, 나머지 = aws 인자. 결과: RP_OUT(\r 제거), RP_ERR(마스킹됨), RP_RC. 아무것도 출력하지 않는다.
# replica 는 서브셸 안에서만 자격증명을 export 한다. 출력 임시 파일은 읽자마자 지운다.
rp_exec() {
  local who="$1" outf errf
  shift
  rh_tmpfile; outf="$RH_TMPF"
  rh_tmpfile; errf="$RH_TMPF"
  RP_RC=0
  if [ "$who" = replica ]; then
    (
      unset AWS_PROFILE AWS_DEFAULT_PROFILE
      export AWS_ACCESS_KEY_ID="$RP_AK" AWS_SECRET_ACCESS_KEY="$RP_SK" AWS_SESSION_TOKEN="$RP_ST"
      aws --region "$RH_REGION" "$@" >"$outf" 2>"$errf" </dev/null
    ) || RP_RC=$?
  else
    aws --profile "$RH_PROFILE" --region "$RH_REGION" "$@" >"$outf" 2>"$errf" </dev/null || RP_RC=$?
  fi
  RP_OUT="$(tr -d '\r' <"$outf")"
  RP_ERR="$(rp_mask "$(tr -d '\r' <"$errf")")"
  rm -f "$outf" "$errf"
}

# assume-role: 필요한 값 3개만 text 로 받는다. 임시 파일·here-string 을 거치지 않고 명령 치환과 매개변수 확장으로만 나눈다.
# 성공하면 RP_AK RP_SK RP_ST 를 채운다. 실패하면 비운다(RP_RC != 0).
rp_assume() {
  local out rest errf
  rh_tmpfile; errf="$RH_TMPF"
  RP_RC=0
  out="$(aws --profile "$RH_PROFILE" --region "$RH_REGION" sts assume-role --role-arn "$ROLE_ARN" \
    --role-session-name alarmops-replica-check --duration-seconds 900 \
    --query '[Credentials.AccessKeyId,Credentials.SecretAccessKey,Credentials.SessionToken]' --output text \
    2>"$errf" </dev/null)" || RP_RC=$?
  RP_ERR="$(rp_mask "$(tr -d '\r' <"$errf")")"
  rm -f "$errf"
  if [ "$RP_RC" -eq 0 ]; then
    out="${out//$'\r'/}"
    RP_AK="${out%%$'\t'*}"; rest="${out#*$'\t'}"
    RP_SK="${rest%%$'\t'*}"; RP_ST="${rest#*$'\t'}"
    if [[ ! "$RP_AK" =~ ^[A-Z0-9]+$ ]] || [ -z "$RP_SK" ] || [ -z "$RP_ST" ] || [ "$RP_SK" = "$RP_ST" ] \
       || [[ "$RP_ST" == *[[:space:]]* ]] || [ "$RP_ST" = None ]; then
      RP_RC=1
      RP_ERR="assume-role 응답 형식이 이상하다"
    fi
  fi
  out=""; rest=""
  if [ "$RP_RC" -ne 0 ]; then RP_AK=""; RP_SK=""; RP_ST=""; fi
}

# 마지막 호출의 오류 코드만(메시지는 쓰지 않는다)
rp_code() {
  local c
  c="$(printf '%s\n' "$RP_ERR" | sed -nE 's/.*An error occurred \(([A-Za-z0-9._]+)\).*/\1/p' | head -n 1)" || true
  printf '%s' "${c:-unknown}"
}

rp_cell_of_last() {  # 직전 rp_exec 결과(실패) → DENIED | ERROR(코드). 오류 메시지는 쓰지 않는다
  local code
  code="$(rp_code)"
  case "$code" in AccessDenied*) printf 'DENIED' ;; *) printf 'ERROR(%s)' "$code" ;; esac
}

# 이름이 겹치는 알람이 있으면 그것이 이 스크립트가 만든 것인지 본다(Namespace 가 AlarmOpsRehearsal 인 메트릭 알람만 우리 것).
# $@ = 알람 이름. 결과: RP_OWN(없거나 우리 것) / RP_SKIP("이름 (사유)": 다른 Namespace·복합 알람·Namespace 없는 메트릭 수식 알람).
# 조회(describe-alarms)가 실패하면 1 을 돌려준다. 이름이 `[` 로 시작하므로 JSON 배열로 넘긴다.
rp_split_owned() {
  local out n line k nm why found
  RP_OWN=(); RP_SKIP=()
  rp_exec person cloudwatch describe-alarms --alarm-names "$(rh_json_array "$@")" --alarm-types MetricAlarm CompositeAlarm --output json
  [ "$RP_RC" -eq 0 ] || return 1
  out="$(printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
ns = sys.argv[1]
d = json.load(sys.stdin)
for a in d.get("MetricAlarms", []):
    if a.get("Namespace") != ns:
        print(a["AlarmName"] + "\tNamespace " + str(a.get("Namespace")))
for a in d.get("CompositeAlarms", []):
    print(a["AlarmName"] + "\tcomposite alarm")
' "$ALARM_NS" | tr -d '\r')" || return 1
  for n in "$@"; do
    found=0
    while IFS=$'\t' read -r nm why; do
      if [ -n "$nm" ] && [ "$nm" = "$n" ]; then found=1; RP_SKIP+=("$n ($why)"); break; fi
    done <<<"$out"
    if [ "$found" = 0 ]; then RP_OWN+=("$n"); fi
  done
  return 0
}

# 시작 전 점검: 시험·probe 알람 이름과 같은 이름의 알람이 우리 것이 아니면 아무것도 만들지 않고 중단한다(지우거나 덮어쓰지 않는다).
rp_precheck_names() {
  local k
  rp_split_owned "$@" || { rp_fail_exec "시작 전 점검 실패: 같은 이름의 알람이 있는지 조회하지 못했다. 아무것도 만들지 않았다"; exit 1; }
  if [ "${#RP_SKIP[@]}" -gt 0 ]; then
    for k in "${RP_SKIP[@]}"; do
      rp_note "오류: 알람 $k 이 이미 있고 이 스크립트가 만든 것이 아니다(만든 알람은 Namespace $ALARM_NS). 지우거나 덮어쓰지 않고 중단한다. 이름이 겹치는 고객 알람인지 확인한다. 아무것도 만들지 않았다"
    done
    exit 1
  fi
}

rp_note() {  # 사람에게(stderr)와 로그에 알린다. 이미 마스킹된 문장만 넣을 것
  printf '%s\n' "$1" >&2
  rh_log "$1"
}

rp_fail_exec() {  # 호출 실패를 오류 코드와 함께 알린다(메시지 본문은 마스킹해서 stderr 에만)
  rp_note "오류: $1 (코드 $(rp_code))"
  if [ -n "$RP_ERR" ]; then printf '%s\n' "$RP_ERR" >&2; fi
}

# 정리용 삭제: 이름이 같아도 이 스크립트가 만든 알람(Namespace AlarmOpsRehearsal)이 아니면 지우지 않고 건너뛴다. $1=표시 이름 나머지=알람 이름
rp_delete_alarms_owned() {
  local label="$1" k
  shift
  if ! rp_split_owned "$@"; then
    rp_fail_exec "$label 삭제 전 점검 실패(같은 이름의 알람을 조회하지 못해 지우지 않았다)"; CLEAN_FAIL=$((CLEAN_FAIL + 1)); return
  fi
  if [ "${#RP_SKIP[@]}" -gt 0 ]; then
    for k in "${RP_SKIP[@]}"; do rh_say "- 건너뜀(이 스크립트가 만든 알람이 아님): $k"; done
  fi
  if [ "${#RP_OWN[@]}" -eq 0 ]; then return; fi
  local own=("${RP_OWN[@]}")
  rp_exec person cloudwatch delete-alarms --alarm-names "$(rh_json_array "${own[@]}")"
  if [ "$RP_RC" -eq 0 ]; then rh_say "- $label 삭제(없으면 건너뜀): ${own[*]}"
  else rp_fail_exec "$label 삭제 실패"; CLEAN_FAIL=$((CLEAN_FAIL + 1)); fi
}

rp_cleanup() {
  local c
  CLEAN_FAIL=0
  rh_say ""
  rh_say "## 정리"
  rp_delete_alarms_owned "시험 알람" "$ALARM_T" "$ALARM_U" "$ALARM_V"
  if [ "$PROBE" = 1 ] || [ "$CLEANUP_ONLY" = 1 ]; then   # 실측 모드 잔여물. 일반 실행은 이 호출을 하지 않는다
    local pn=()
    mapfile -t pn < <(probe_alarm_names)
    pn=("${pn[@]%$'\r'}")
    rp_delete_alarms_owned "실측 알람" "${pn[@]}"
  fi

  rp_exec person iam get-role --role-name "$REPLICA"
  if [ "$RP_RC" -ne 0 ]; then
    if printf '%s' "$RP_ERR" | grep -q 'NoSuchEntity'; then rh_say "- 복제 역할 없음: 지울 것 없음"
    else rp_fail_exec "복제 역할 조회 실패"; CLEAN_FAIL=$((CLEAN_FAIL + 1)); fi
  else
    c=0
    printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
t = json.load(sys.stdin).get("Role", {}).get("Tags", [])
sys.exit(0 if any(x.get("Key") == "AlarmOpsRehearsal" and x.get("Value") == "true" for x in t) else 1)
' || c=$?
    if [ "$c" -ne 0 ]; then
      rp_note "오류: 역할 $REPLICA 에 AlarmOpsRehearsal=true 태그가 없어 지우지 않는다. 직접 만든 역할이 아닌지 확인한다"
      CLEAN_FAIL=$((CLEAN_FAIL + 1))
    else
      if [ "$PROBE" = 1 ] || [ "$CLEANUP_ONLY" = 1 ]; then
        rp_exec person iam delete-role-policy --role-name "$REPLICA" --policy-name "$PROBE_POLICY"
        if [ "$RP_RC" -eq 0 ] || printf '%s' "$RP_ERR" | grep -q 'NoSuchEntity'; then rh_say "- 인라인 정책 삭제(없으면 건너뜀): $PROBE_POLICY"
        else rp_fail_exec "인라인 정책 삭제 실패($PROBE_POLICY)"; CLEAN_FAIL=$((CLEAN_FAIL + 1)); fi
      fi
      rp_exec person iam delete-role-policy --role-name "$REPLICA" --policy-name "$POLICY_NAME"
      if [ "$RP_RC" -eq 0 ] || printf '%s' "$RP_ERR" | grep -q 'NoSuchEntity'; then rh_say "- 인라인 정책 삭제: $POLICY_NAME"
      else rp_fail_exec "인라인 정책 삭제 실패"; CLEAN_FAIL=$((CLEAN_FAIL + 1)); fi
      rp_exec person iam delete-role --role-name "$REPLICA"
      if [ "$RP_RC" -eq 0 ]; then rh_say "- 역할 삭제: $REPLICA"
      else rp_fail_exec "역할 삭제 실패"; CLEAN_FAIL=$((CLEAN_FAIL + 1)); fi
    fi
  fi
  if [ "$CLEAN_FAIL" -gt 0 ]; then
    rh_say "경고: 정리 실패 ${CLEAN_FAIL}건. 임시 역할·알람이 남았을 수 있다. 다시 정리한다:"
    rh_say "  bash infra/scripts/rehearsal/replica-check.sh --profile $RH_PROFILE --confirm-account <12자리> --cleanup-only"
  fi
}

rp_on_exit() {
  local rc=$?
  trap - EXIT INT TERM HUP
  set +e
  if [ "$DO_CLEANUP" = 1 ]; then rp_cleanup; fi   # 정리 오류는 알리기만 한다. 결과(rc)를 덮지 않는다
  RP_AK=""; RP_SK=""; RP_ST=""; RP_OUT=""
  rh_cleanup_tmps
  exit "$rc"
}
trap rp_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

rh_say "# 복제 역할 실측 $RH_PROFILE ($RH_ACCT)"

if [ "$CLEANUP_ONLY" = 1 ]; then
  rp_cleanup
  if [ "$CLEAN_FAIL" -gt 0 ]; then exit 1; fi
  exit 0
fi

# ---- 1) 본인이 SSO assumed-role 인가 (2번째 경로 조각 = 역할 이름)
rp_exec person sts get-caller-identity --query Arn --output text
[ "$RP_RC" -eq 0 ] || { rp_fail_exec "sts get-caller-identity 실패"; exit 1; }
CALLER_ROLE=""
if [[ "$RP_OUT" =~ ^arn:aws[a-z-]*:sts::${RH_ACCT}:assumed-role/(AWSReservedSSO_[A-Za-z0-9_+=,.@-]+)/[^/]+$ ]]; then
  CALLER_ROLE="${BASH_REMATCH[1]}"
fi
if [ -z "$CALLER_ROLE" ]; then
  rh_die "이 프로필은 SSO 역할(assumed-role/AWSReservedSSO_...)이 아니다. 복제 역할의 신뢰 대상을 본인 SSO 역할로만 좁힐 수 있어 중단한다. 별도 터미널에서 aws sso login 으로 만든 rehearsal-* 프로필로 실행한다" 4
fi

# ---- 2) 원본 역할·정책 읽기 (없으면 아무것도 만들지 않고 거부)
rp_exec person iam get-role --role-name "$ORIG_ROLE"
if [ "$RP_RC" -ne 0 ]; then rp_fail_exec "원본 역할 $ORIG_ROLE 을 읽지 못했다. 아무것도 만들지 않았다"; exit 1; fi
BOUNDARY="$(printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
print(json.load(sys.stdin).get("Role", {}).get("PermissionsBoundary", {}).get("PermissionsBoundaryArn", ""))
' | tr -d '\r')" || rh_die "원본 역할 응답을 해석하지 못했다"
rp_exec person iam get-role-policy --role-name "$ORIG_ROLE" --policy-name "$POLICY_NAME"
if [ "$RP_RC" -ne 0 ]; then rp_fail_exec "원본 정책 $ORIG_ROLE/$POLICY_NAME 을 읽지 못했다. 아무것도 만들지 않았다"; exit 1; fi
rh_tmpfile; POLICY_FILE="$RH_TMPF"
printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
print(json.dumps(json.load(sys.stdin)["PolicyDocument"], separators=(",", ":")))
' >"$POLICY_FILE" || rh_die "원본 정책 응답을 해석하지 못했다"
[ -s "$POLICY_FILE" ] || rh_die "원본 정책이 비어 있다"

# ---- 2b) 본인 SSO 역할의 정확한 ARN(경로 포함). 신뢰 정책은 와일드카드 없이 이 ARN 하나로 고정한다
rp_exec person iam get-role --role-name "$CALLER_ROLE"
if [ "$RP_RC" -ne 0 ]; then rp_fail_exec "본인 SSO 역할 $CALLER_ROLE 의 ARN 을 읽지 못했다(iam:GetRole 필요). 아무것도 만들지 않았다"; exit 1; fi
CALLER_ARN="$(printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
print(json.load(sys.stdin).get("Role", {}).get("Arn", ""))
' | tr -d '\r')" || rh_die "본인 역할 응답을 해석하지 못했다"
if [[ "$CALLER_ARN" == *[\*\?]* ]] || [[ "$CALLER_ARN" != "arn:"*":iam::${RH_ACCT}:role/"* ]] \
   || { [[ "$CALLER_ARN" != *"/${CALLER_ROLE}" ]]; }; then
  rh_die "본인 SSO 역할 ARN 이 예상과 다르다. 아무것도 만들지 않았다" 1
fi

# ---- 3) 복제 역할이 이미 있으면 멈춘다(재사용·덮어쓰기 금지)
rp_exec person iam get-role --role-name "$REPLICA"
if [ "$RP_RC" -eq 0 ]; then
  rh_die "역할 $REPLICA 가 이미 있다. 재사용·덮어쓰지 않는다. 이전 실행의 잔여물이면 --cleanup-only 로 먼저 정리한다: bash infra/scripts/rehearsal/replica-check.sh --profile $RH_PROFILE --confirm-account <12자리> --cleanup-only" 5
fi
printf '%s' "$RP_ERR" | grep -q 'NoSuchEntity' || { rp_fail_exec "복제 역할 조회 실패"; exit 1; }

# ---- 3b) 같은 이름의 알람이 우리 것이 아니면 중단한다(정리·시작 삭제가 고객 알람을 지우지 않게). 아직 아무것도 만들지 않았다
PRECHECK_NAMES=("$ALARM_T" "$ALARM_U" "$ALARM_V")
if [ "$PROBE" = 1 ]; then
  mapfile -t _pn < <(probe_alarm_names)
  PRECHECK_NAMES+=("${_pn[@]%$'\r'}")
fi
rp_precheck_names "${PRECHECK_NAMES[@]}"

# ---- 4) 복제 역할 생성. 이 시점부터 종료 시 정리한다
DO_CLEANUP=1
rh_tmpfile; TRUST_FILE="$RH_TMPF"
printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::%s:root"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:PrincipalArn":"%s"}}}]}' \
  "$RH_ACCT" "$CALLER_ARN" >"$TRUST_FILE"
BOUNDARY_ARGS=()
if [ -n "$BOUNDARY" ]; then BOUNDARY_ARGS=(--permissions-boundary "$BOUNDARY"); fi
rp_exec person iam create-role --role-name "$REPLICA" \
  --assume-role-policy-document "file://$(rh_native_path "$TRUST_FILE")" \
  --description "AlarmOps rehearsal replica of AlarmWriter (temporary)" \
  --tags Key=AlarmOpsRehearsal,Value=true ${BOUNDARY_ARGS[@]+"${BOUNDARY_ARGS[@]}"}
[ "$RP_RC" -eq 0 ] || { rp_fail_exec "복제 역할 생성 실패"; exit 1; }
rp_exec person iam put-role-policy --role-name "$REPLICA" --policy-name "$POLICY_NAME" \
  --policy-document "file://$(rh_native_path "$POLICY_FILE")"
[ "$RP_RC" -eq 0 ] || { rp_fail_exec "인라인 정책 부착 실패"; exit 1; }
rh_say "복제 역할 생성: $REPLICA (경계: ${BOUNDARY:-없음}, 신뢰: $CALLER_ROLE)"

# ---- 실측 모드: (a)~(f) 대신 Deny 변형 두 개를 잰다
if [ "$PROBE" = 1 ]; then
  ROLE_ARN="arn:aws:iam::${RH_ACCT}:role/${REPLICA}"
  BASE=(--namespace AlarmOpsRehearsal --metric-name ReplicaCheck --statistic Average --period 60
        --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanThreshold)
  # 다시 assume 하고(전파 대기 재시도) 읽기가 될 때까지 기다린다. 실패하면 1 로 중단(정리는 트랩이)
  rp_ready() {
    local got=0 ok=0 last="" i
    for ((i = 1; i <= RETRIES; i++)); do
      rp_assume
      if [ "$RP_RC" -eq 0 ]; then got=1; break; fi
      last="$(rp_code)"
      [ "$i" -lt "$RETRIES" ] && sleep "$RETRY_INTERVAL"
    done
    if [ "$got" -ne 1 ]; then rp_note "오류: 복제 역할 assume ${RETRIES}회 시도 실패, 오류 코드 $last"; exit 1; fi
    for ((i = 1; i <= RETRIES; i++)); do
      rp_exec replica cloudwatch describe-alarms --max-records 1 --output json
      if [ "$RP_RC" -eq 0 ]; then ok=1; break; fi
      last="$(rp_code)"
      [ "$i" -lt "$RETRIES" ] && sleep "$RETRY_INTERVAL"
    done
    if [ "$ok" -ne 1 ]; then rp_note "오류: 정책 전파(DescribeAlarms) ${RETRIES}회 시도 실패, 오류 코드 $last"; exit 1; fi
  }
  rp_cell() {  # 직전 rp_exec 결과 → ALLOWED | DENIED | ERROR(코드). 오류 메시지는 쓰지 않는다
    local code
    if [ "$RP_RC" -eq 0 ]; then printf 'ALLOWED'; return; fi
    code="$(rp_code)"
    case "$code" in AccessDenied*) printf 'DENIED' ;; *) printf 'ERROR(%s)' "$code" ;; esac
  }
  rp_cond() {  # 변형 이름 → Deny 조건(JSON)
    case "$1" in
      null) printf '{"Null":{"aws:ResourceTag/ManagedBy":"true"}}' ;;
      stringnotequals) printf '{"StringNotEquals":{"aws:ResourceTag/ManagedBy":"AlarmOps"}}' ;;
    esac
  }

  # 시작: probe 알람 이름 전부를 본인 자격증명으로 먼저 지운다(없으면 건너뜀). 남은 태그·설정이 p2 대상을 오염시키지 않게 한다
  mapfile -t PROBE_ALL < <(probe_alarm_names)
  PROBE_ALL=("${PROBE_ALL[@]%$'\r'}")
  rp_exec person cloudwatch delete-alarms --alarm-names "$(rh_json_array "${PROBE_ALL[@]}")"
  [ "$RP_RC" -eq 0 ] || { rp_fail_exec "준비 실패: 이전 probe 알람 삭제"; exit 1; }
  # 준비 알람: $1=이름 $2=ManagedBy 값(비면 태그 없이). 태그 없는 알람에 ManagedBy 가 보이면 준비 실패로 중단한다
  rp_prep_alarm() {
    if [ -n "$2" ]; then
      rp_exec person cloudwatch put-metric-alarm --alarm-name "$1" "${BASE[@]}" --tags "Key=ManagedBy,Value=$2"
    else
      rp_exec person cloudwatch put-metric-alarm --alarm-name "$1" "${BASE[@]}"
    fi
    [ "$RP_RC" -eq 0 ] || { rp_fail_exec "준비 실패: 본인 자격증명으로 알람 $1 생성"; exit 1; }
    [ -z "$2" ] || return 0
    rp_exec person cloudwatch list-tags-for-resource --resource-arn "arn:aws:cloudwatch:${RH_REGION}:${RH_ACCT}:alarm:$1" --output json
    [ "$RP_RC" -eq 0 ] || { rp_fail_exec "준비 실패: 알람 $1 의 태그를 확인하지 못함"; exit 1; }
    if printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
t = json.load(sys.stdin).get("Tags", [])
sys.exit(0 if any(x.get("Key") == "ManagedBy" for x in t) else 1)
'; then rp_note "오류: 준비 실패: 태그 없이 만든 알람 $1 에 ManagedBy 태그가 있다"; exit 1; fi
  }
  # 덮어쓰기 시도: $1=알람 이름 $2=임계값. ManagedBy=AlarmOps 요청 태그를 단다
  rp_overwrite() {
    rp_exec replica cloudwatch put-metric-alarm --alarm-name "$1" --namespace AlarmOpsRehearsal \
      --metric-name ReplicaCheck --statistic Average --period 60 --evaluation-periods 1 --threshold "$2" \
      --comparison-operator GreaterThanThreshold --tags Key=ManagedBy,Value=AlarmOps
  }

  rp_ready
  rh_say ""
  rh_say "| 변형 | p1 새 알람 생성 | p2 태그없는 알람 덮어쓰기 | p3 관리 알람 수정 | p4 관리 알람 삭제 | 판정 |"
  rh_say "|---|---|---|---|---|---|"
  STAR=0; NOTES=""; vi=0
  for v in "${PROBE_VARIANTS[@]}"; do
    NEW="[AlarmOpsRehearsal] probe-$v-new"; UN="[AlarmOpsRehearsal] probe-$v-unmanaged"
    CAN="[AlarmOpsRehearsal] probe-$v-canary"; OTH="[AlarmOpsRehearsal] probe-$v-other"
    # 1) 앞 변형의 Deny 를 지운다. 두 번째부터는 전파를 기다리고 다시 assume 한다(옛 정책이 남아 거짓 "사용 가능"이 나오지 않게)
    rp_exec person iam delete-role-policy --role-name "$REPLICA" --policy-name "$PROBE_POLICY"
    if [ "$RP_RC" -ne 0 ] && ! printf '%s' "$RP_ERR" | grep -q 'NoSuchEntity'; then rp_fail_exec "이전 Deny 정책 삭제 실패"; exit 1; fi
    if [ "$vi" -gt 0 ]; then
      if [ "$PROBE_WAIT" -gt 0 ] 2>/dev/null; then sleep "$PROBE_WAIT"; fi
      rp_ready
    fi
    # 2) 카나리 A: Deny 가 없는 상태에서는 원본 정책의 구멍으로 덮어쓰기가 ALLOWED 여야 한다. 아니면 옛 Deny 가 남았거나 구멍이 없다
    rp_prep_alarm "$CAN" ""
    rp_overwrite "$CAN" 2
    if [ "$(rp_cell)" != ALLOWED ]; then
      rp_note "오류: 카나리 실패($v): Deny 가 없는 상태인데 태그 없는 알람 덮어쓰기가 $(rp_cell). 옛 정책이 남았거나 원본 정책에 구멍이 없다. 첫 변형(null)이면 구멍이 없는 것이니 일반 모드 (f) 결과를 보고, 오류 줄과 종료 코드만 허브에 보낸다. 두 번째 변형이면 REHEARSAL_PROBE_WAIT=60 으로 다시 실행한다"
      exit 1
    fi
    rp_exec person cloudwatch delete-alarms --alarm-names "$(rh_json_array "$CAN")"
    # 3) 준비: 태그 없는 알람(p2 대상), ManagedBy=Other 알람(Deny 카나리 B)
    rp_prep_alarm "$UN" ""
    rp_prep_alarm "$OTH" "Other"
    # 4) Deny 변형을 별도 인라인 정책으로 붙이고 다시 assume
    rh_tmpfile; DENY_FILE="$RH_TMPF"
    printf '{"Version":"2012-10-17","Statement":[{"Sid":"DenyOverwriteUnmanaged","Effect":"Deny","Action":"cloudwatch:PutMetricAlarm","Resource":"arn:aws:cloudwatch:*:%s:alarm:*","Condition":%s}]}' \
      "$RH_ACCT" "$(rp_cond "$v")" >"$DENY_FILE"
    rp_exec person iam put-role-policy --role-name "$REPLICA" --policy-name "$PROBE_POLICY" \
      --policy-document "file://$(rh_native_path "$DENY_FILE")"
    [ "$RP_RC" -eq 0 ] || { rp_fail_exec "Deny 정책($v) 부착 실패"; exit 1; }
    if [ "$PROBE_WAIT" -gt 0 ] 2>/dev/null; then sleep "$PROBE_WAIT"; fi
    rp_ready
    # 5) 카나리 B: ManagedBy=Other 알람 덮어쓰기. 기대값을 변형마다 직접 계산한다.
    #    null: 리소스 태그가 있으니 Null 조건이 안 걸리고 원본 정책(CreateAlarmWithManagedByTag)대로 ALLOWED.
    #    stringnotequals: Other != AlarmOps 라 Deny 가 걸려 DENIED.
    case "$v" in null) exp_b=ALLOWED ;; stringnotequals) exp_b=DENIED ;; esac
    rp_overwrite "$OTH" 2
    got_b="$(rp_cell)"
    if [ "$got_b" != "$exp_b" ]; then
      # null 인데 DENIED: 리소스 태그(ManagedBy=Other)가 있는 알람인데도 Null 조건이 걸렸다 = PutMetricAlarm 평가가 기존 알람의 태그를 못 본다.
      if [ "$v" = null ] && [ "$got_b" = DENIED ]; then why="PutMetricAlarm 평가에 ResourceTag 가 반영되지 않는 것으로 보임"
      else why="Deny 가 반영되지 않았을 수 있다"; fi
      NOTES="$NOTES- $v: 카나리 B 불일치(기대 $exp_b, 실제 $got_b): $why
"
    fi

    # p1 새 알람 + ManagedBy 요청 태그
    rp_exec replica cloudwatch put-metric-alarm --alarm-name "$NEW" "${BASE[@]}" --tags Key=ManagedBy,Value=AlarmOps
    c1="$(rp_cell)"; star=""
    if [ "$c1" != ALLOWED ]; then   # p3·p4 도 재도록 본인 자격증명이 태그 달린 관리 알람을 대신 만든다(표에 * 표시)
      rp_exec person cloudwatch put-metric-alarm --alarm-name "$NEW" "${BASE[@]}" --tags Key=ManagedBy,Value=AlarmOps
      if [ "$RP_RC" -eq 0 ]; then star="*"; STAR=1; else star="?"; fi
    fi
    # p2 태그 없는 기존 알람을 ManagedBy 요청 태그로 덮어쓰기. 전파 지연을 보려고 REHEARSAL_PROBE_WAIT 간격으로 두 번 잰다
    rp_overwrite "$UN" 2
    c2a="$(rp_cell)"
    if [ "$PROBE_WAIT" -gt 0 ] 2>/dev/null; then sleep "$PROBE_WAIT"; fi
    rp_overwrite "$UN" 2
    c2="$(rp_cell)"
    # 본인 자격증명으로 임계값이 실제로 바뀌었는지 본다(거부됐어도 확인: 응답과 실제 상태가 다르면 판정을 믿지 않는다)
    rp_exec person cloudwatch describe-alarms --alarm-names "$(rh_json_array "$UN")" --output json
    thr="조회 실패"
    if [ "$RP_RC" -eq 0 ]; then
      thr="$(printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
a = json.load(sys.stdin).get("MetricAlarms", [])
print("%g" % a[0]["Threshold"] if a else "")
' | tr -d '\r')" || thr=""
      case "$thr" in 2) thr="임계값 1→2 변경됨" ;; 1) thr="임계값 1 그대로" ;; "") thr="알람 없음" ;; *) thr="임계값 $thr" ;; esac
    fi
    unstable=0
    if [ "$c2a" != "$c2" ]; then
      unstable=1; NOTES="$NOTES- $v: p2 1차 $c2a, 2차 $c2 (결과가 달라 판정하지 않는다)
"
    fi
    [ "$got_b" = "$exp_b" ] || unstable=1
    if [ "$unstable" = 1 ]; then c2="불안정"
    elif [ "$c2" = ALLOWED ]; then c2="ALLOWED ($thr)"
    elif [ "$c2" = DENIED ] && [ "$thr" != "임계값 1 그대로" ]; then c2="DENIED (확인 필요: $thr)"; fi
    if [ "$star" = "?" ]; then
      c3="ERROR(준비 실패)"; c4="ERROR(준비 실패)"
    else
      # p3 관리 알람 수정(엔진의 제자리 갱신, D-08): 태그 없이 임계값만 바꾼다
      rp_exec replica cloudwatch put-metric-alarm --alarm-name "$NEW" --namespace AlarmOpsRehearsal \
        --metric-name ReplicaCheck --statistic Average --period 60 --evaluation-periods 1 --threshold 2 \
        --comparison-operator GreaterThanThreshold
      c3="$(rp_cell)$star"
      # p4 관리 알람 삭제
      rp_exec replica cloudwatch delete-alarms --alarm-names "$(rh_json_array "$NEW")"
      c4="$(rp_cell)$star"
    fi
    verdict="사용 불가"
    if [ "$unstable" = 1 ]; then verdict="재측정"
    elif [ "$c1" = ALLOWED ] && [ "$c2" = DENIED ] && [ "$c3" = ALLOWED ] && [ "$c4" = ALLOWED ]; then verdict="사용 가능"; fi
    rh_say "| $v | $c1 | $c2 | $c3 | $c4 | $verdict |"
    vi=$((vi + 1))
  done
  if [ -n "$NOTES" ]; then rh_say ""; rh_say "$NOTES"; fi
  rh_say ""
  if [ "$STAR" = 1 ]; then rh_say "* p1 이 거부돼서 본인 자격증명이 ManagedBy=AlarmOps 태그를 달아 대신 만든 알람으로 p3·p4 를 쟀다."; fi
  rh_say "측정 완료(판정과 무관하게 종료 코드 0). 이 표와 그 아래 사유 줄만 허브에 보낸다(자격증명·로그는 보내지 않는다)"
  exit 0
fi

rh_say ""
rh_say "| 항목 | 결과 | 비고 |"
rh_say "|---|---|---|"
HOLD=0; HELD=""
rp_row() {  # $1=항목 $2=PASS|FAIL $3=비고. HOLD=1 이면 표시를 미뤘다가(HELD) 나중에 순서대로 출력한다
  if [ "$2" = FAIL ]; then FAILS=$((FAILS + 1)); fi
  if [ "$HOLD" = 1 ]; then HELD="| $1 | $2 | $3 |"; else rh_say "| $1 | $2 | $3 |"; fi
}

# ---- 5) assume (IAM 전파 대기 재시도)
ROLE_ARN="arn:aws:iam::${RH_ACCT}:role/${REPLICA}"
got=0; last=""
for ((i = 1; i <= RETRIES; i++)); do
  rp_assume
  if [ "$RP_RC" -eq 0 ]; then got=1; break; fi
  last="$(rp_code)"
  [ "$i" -lt "$RETRIES" ] && sleep "$RETRY_INTERVAL"
done
if [ "$got" -ne 1 ]; then
  rp_row "(준비) 복제 역할 assume" FAIL "${RETRIES}회 시도 실패, 오류 코드 $last"
  rh_say ""; rh_say "실패 항목 ${FAILS}개. 이 표만 허브에 보낸다"
  exit 1
fi

# 정책 전파 확인: 정책이 허용하는 읽기가 될 때까지(정책 미전파 상태에서 (가) 거부가 우연히 통과하지 않게)
ok=0; last=""
for ((i = 1; i <= RETRIES; i++)); do
  rp_exec replica cloudwatch describe-alarms --max-records 1 --output json
  if [ "$RP_RC" -eq 0 ]; then ok=1; break; fi
  last="$(rp_code)"
  [ "$i" -lt "$RETRIES" ] && sleep "$RETRY_INTERVAL"
done
if [ "$ok" -ne 1 ]; then
  rp_row "(준비) 정책 전파(DescribeAlarms)" FAIL "${RETRIES}회 시도 실패, 오류 코드 $last"
  rh_say ""; rh_say "실패 항목 ${FAILS}개. 이 표만 허브에 보낸다"
  exit 1
fi

ARN_T="arn:aws:cloudwatch:${RH_REGION}:${RH_ACCT}:alarm:${ALARM_T}"
ARN_U="arn:aws:cloudwatch:${RH_REGION}:${RH_ACCT}:alarm:${ALARM_U}"
ARN_V="arn:aws:cloudwatch:${RH_REGION}:${RH_ACCT}:alarm:${ALARM_V}"
BASE=(--namespace AlarmOpsRehearsal --metric-name ReplicaCheck --statistic Average --period 60
      --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanThreshold)

expect_denied() {  # $1=항목 ; 직전 rp_exec 결과를 판정
  local code
  if [ "$RP_RC" -eq 0 ]; then rp_row "$1" FAIL "성공함(AccessDenied 여야 함)"; return; fi
  code="$(rp_code)"
  case "$code" in
    AccessDenied*) rp_row "$1" PASS "$code" ;;
    *) rp_row "$1" FAIL "오류 코드 $code (AccessDenied 여야 함)" ;;
  esac
}

# (a) 태그 없는 PutMetricAlarm
rp_exec replica cloudwatch put-metric-alarm --alarm-name "$ALARM_T" "${BASE[@]}"
a_created=0; [ "$RP_RC" -eq 0 ] && a_created=1
expect_denied "(a) 태그 없는 PutMetricAlarm → 거부"
if [ "$a_created" = 1 ]; then   # 잘못 만들어졌다: (b)가 새로 만들기를 시험하도록 치운다
  rp_exec person cloudwatch delete-alarms --alarm-names "$(rh_json_array "$ALARM_T")"
fi

# (b) ManagedBy=AlarmOps 태그를 단 PutMetricAlarm
rp_exec replica cloudwatch put-metric-alarm --alarm-name "$ALARM_T" "${BASE[@]}" --tags Key=ManagedBy,Value=AlarmOps
if [ "$RP_RC" -ne 0 ]; then
  rp_row "(b) ManagedBy=AlarmOps 태그로 PutMetricAlarm → 성공" FAIL "오류 코드 $(rp_code)"
else
  rp_exec person cloudwatch list-tags-for-resource --resource-arn "$ARN_T" --output json
  t=0
  if [ "$RP_RC" -eq 0 ]; then
    printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
t = json.load(sys.stdin).get("Tags", [])
sys.exit(0 if any(x.get("Key") == "ManagedBy" and x.get("Value") == "AlarmOps" for x in t) else 1)
' || t=$?
  else
    t=9
  fi
  if [ "$t" -eq 0 ]; then rp_row "(b) ManagedBy=AlarmOps 태그로 PutMetricAlarm → 성공" PASS "성공, list-tags 에서 ManagedBy=AlarmOps 확인"
  elif [ "$RP_RC" -ne 0 ]; then rp_row "(b) ManagedBy=AlarmOps 태그로 PutMetricAlarm → 성공" FAIL "생성은 성공, list-tags 실패(코드 $(rp_code))"
  else rp_row "(b) ManagedBy=AlarmOps 태그로 PutMetricAlarm → 성공" FAIL "생성은 성공했으나 ManagedBy=AlarmOps 태그가 보이지 않음"
  fi
fi

# ALARM_U: 본인 자격증명으로 ManagedBy 없는 알람을 만든다. 만든 알람에 ManagedBy 가 붙어 있지 않은지도 본다.
U_REASON=""
rp_make_u() {
  rp_exec person cloudwatch put-metric-alarm --alarm-name "$ALARM_U" "${BASE[@]}"
  if [ "$RP_RC" -ne 0 ]; then U_REASON="본인 자격증명으로 알람 생성 오류 코드 $(rp_code)"; return 1; fi
  rp_exec person cloudwatch list-tags-for-resource --resource-arn "$ARN_U" --output json
  if [ "$RP_RC" -ne 0 ]; then U_REASON="만든 알람의 태그를 확인하지 못함(코드 $(rp_code))"; return 1; fi
  if printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
t = json.load(sys.stdin).get("Tags", [])
sys.exit(0 if any(x.get("Key") == "ManagedBy" for x in t) else 1)
'; then U_REASON="만든 알람에 ManagedBy 태그가 이미 붙어 있음"; return 1; fi
  return 0
}
u_prepared=0
if rp_make_u; then u_prepared=1; fi

# (f) 복제 역할이 태그 없는 기존 알람(ALARM_U)을 ManagedBy 요청 태그로 덮어쓸 수 있는가. (c)(d)보다 먼저 본다:
#     (c)(d)가 알람 상태(태그·존재)를 바꾸기 전의 깨끗한 알람에서 판정해야 한다. 표에는 (e) 다음에 순서대로 낸다.
#     CreateAlarmWithManagedByTag 는 요청 태그 조건만 보지만(D-63) Resource 가 alarm:[* 라서 `[` 로 시작하지 않는 ALARM_U 에는 닿지 않는다(기대: 거부). 설정이 바뀌는지 보려고 임계값을 다르게 보낸다.
F_LABEL="(f) 태그 없는 기존 알람 덮어쓰기(PutMetricAlarm+ManagedBy 요청 태그) → 거부"
f_overwrote=0
HOLD=1
if [ "$u_prepared" != 1 ]; then
  rp_row "$F_LABEL" FAIL "준비 실패: $U_REASON"
else
  rp_exec replica cloudwatch put-metric-alarm --alarm-name "$ALARM_U" --namespace AlarmOpsRehearsal \
    --metric-name ReplicaCheck --statistic Average --period 60 --evaluation-periods 1 --threshold 2 \
    --comparison-operator GreaterThanThreshold --tags Key=ManagedBy,Value=AlarmOps
  if [ "$RP_RC" -ne 0 ]; then
    expect_denied "$F_LABEL"
  else
    f_overwrote=1
    thr=""; tagnote="조회 실패"
    rp_exec person cloudwatch describe-alarms --alarm-names "$(rh_json_array "$ALARM_U")" --output json
    if [ "$RP_RC" -eq 0 ]; then
      thr="$(printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
a = json.load(sys.stdin).get("MetricAlarms", [])
print("%g" % a[0]["Threshold"] if a else "")
' | tr -d '\r')" || thr=""
    else
      thr="조회 실패(코드 $(rp_code))"
    fi
    case "$thr" in
      2) thr="임계값 1→2 변경됨" ;;
      1) thr="임계값 1 그대로" ;;
      "") thr="임계값 알 수 없음(알람 없음)" ;;
      *) thr="임계값 $thr" ;;
    esac
    rp_exec person cloudwatch list-tags-for-resource --resource-arn "$ARN_U" --output json
    if [ "$RP_RC" -eq 0 ]; then
      if printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
t = json.load(sys.stdin).get("Tags", [])
sys.exit(0 if any(x.get("Key") == "ManagedBy" and x.get("Value") == "AlarmOps" for x in t) else 1)
'; then tagnote="태그 ManagedBy=AlarmOps 붙음"; else tagnote="태그 ManagedBy 없음"; fi
    else
      tagnote="태그 조회 실패(코드 $(rp_code))"
    fi
    rp_row "$F_LABEL" FAIL "스택 갱신 필요(D-63 이전 템플릿) — 갱신 후에도 FAIL 이면 정책 결함 ($thr, $tagnote)"
  fi
fi
HOLD=0

# (f)가 덮어썼다면 알람이 오염됐다(설정·ManagedBy 태그). (c)(d)를 위해 지우고 태그 없이 다시 만든다. 못 하면 (c)(d)는 준비 실패.
if [ "$f_overwrote" = 1 ]; then
  rp_exec person cloudwatch delete-alarms --alarm-names "$(rh_json_array "$ALARM_U")"
  if [ "$RP_RC" -ne 0 ]; then
    u_prepared=0; U_REASON="(f)로 덮어써진 알람을 지우지 못함(코드 $(rp_code))"
  elif rp_make_u; then
    u_prepared=1
  else
    u_prepared=0; U_REASON="(f) 뒤 알람 재생성 실패: $U_REASON"
  fi
fi

# (c)(d)
D_LABEL="(d) 태그 없는 알람 DeleteAlarms → 거부 (#87 미확인 항목)"   # 준비 실패 행도 같은 이름을 쓴다
if [ "$u_prepared" != 1 ]; then
  prep="준비 실패: $U_REASON"
  rp_row "(c) 태그 없는 알람에 TagResource(ManagedBy) → 거부" FAIL "$prep"
  rp_row "$D_LABEL" FAIL "$prep"
else
  rp_exec replica cloudwatch tag-resource --resource-arn "$ARN_U" --tags Key=ManagedBy,Value=AlarmOps
  expect_denied "(c) 태그 없는 알람에 TagResource(ManagedBy) → 거부"
  rp_exec replica cloudwatch delete-alarms --alarm-names "$(rh_json_array "$ALARM_U")"
  expect_denied "$D_LABEL"
fi

# (e) 관리 알람 삭제
rp_exec replica cloudwatch delete-alarms --alarm-names "$(rh_json_array "$ALARM_T")"
if [ "$RP_RC" -eq 0 ]; then rp_row "(e) ManagedBy=AlarmOps 알람 DeleteAlarms → 성공" PASS "성공"
else rp_row "(e) ManagedBy=AlarmOps 알람 DeleteAlarms → 성공" FAIL "오류 코드 $(rp_code)"; fi
rh_say "$HELD"

# (g) 참고(정보 행, 종료 코드에 영향 없음): 이름이 `[` 로 시작하는 태그 없는 알람은 생성 허용(alarm:[*)에 닿아 덮어쓰기가 가능하다(D-63 남는 위험).
#     보호는 엔진의 사전 점검(NotOwned)뿐이다. FAIL 이 아니라 "알려진 한계"로 보여 준다. 준비·조회 실패도 FAIL 로 치지 않는다.
G_LABEL="(g) 이름이 [ 로 시작하는 태그 없는 알람 덮어쓰기 → 알려진 한계(D-63)"
g_row() { rh_say "| $G_LABEL | 정보 | $1 |"; }
rp_exec person cloudwatch put-metric-alarm --alarm-name "$ALARM_V" "${BASE[@]}"
if [ "$RP_RC" -ne 0 ]; then
  g_row "준비 실패: 본인 자격증명으로 알람 생성 오류 코드 $(rp_code). 측정하지 않음"
else
  rp_exec replica cloudwatch put-metric-alarm --alarm-name "$ALARM_V" --namespace AlarmOpsRehearsal \
    --metric-name ReplicaCheck --statistic Average --period 60 --evaluation-periods 1 --threshold 2 \
    --comparison-operator GreaterThanThreshold --tags Key=ManagedBy,Value=AlarmOps
  if [ "$RP_RC" -eq 0 ]; then
    g_row "ALLOWED: 예상된 한계. 엔진의 사전 점검(NotOwned)이 유일한 보호. 고객 안내: 이름이 [ 로 시작하는 알람은 AlarmOps용"
  else
    g_cell="$(rp_cell_of_last)"
    case "$g_cell" in
      DENIED) g_row "DENIED: 이 계정에서는 [ 이름의 태그 없는 알람 덮어쓰기도 막힘(D-63 남는 위험이 더 작음)" ;;
      *) g_row "$g_cell: 판정하지 못함(거부가 아닌 오류). 이 계정에서 [ 이름 알람 덮어쓰기가 막히는지는 모른다. 다시 실행하고, 같으면 오류 코드를 허브에 보낸다" ;;
    esac
  fi
fi

rh_say ""
if [ "$FAILS" -gt 0 ]; then
  rh_say "실패 항목 ${FAILS}개. 이 표만 허브에 보낸다(자격증명·로그는 보내지 않는다)"
  exit 1
fi
rh_say "전부 PASS"
exit 0
