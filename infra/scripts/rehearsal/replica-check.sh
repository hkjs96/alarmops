#!/usr/bin/env bash
# AlarmWriter 복제 역할 실측 (#159, GO-LIVE 4단계 "1회 수동 실측"). 시뮬레이션이 못 보는 CloudWatch의 실제 태그 조건 처리를 본다.
# 사용: bash replica-check.sh --profile rehearsal-b --confirm-account 12자리 [--cleanup-only]
# 원본 AlarmOps-AlarmWriter 의 권한 정책·권한 경계를 그대로 복사한 임시 역할 AlarmOpsRehearsal-WriterReplica 를 만들고,
# 본인 SSO 역할로 assume 해서 5개를 확인한다. 끝나면(실패·중단 포함) 만든 것을 모두 지운다.
# 임시 자격증명은 출력·로그·부모 셸 환경변수에 두지 않는다(호출마다 서브셸 안에서만 export).
# 종료 코드: 전부 PASS 0, 그 밖 1, 인자·안전 관문 거부 2 이상.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

CLEANUP_ONLY=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--cleanup-only" ]; then CLEANUP_ONLY=1; else ARGS+=("$a"); fi
done
RH_ALLOWED=" --profile --confirm-account "
rh_env_check
rh_parse_args ${ARGS[@]+"${ARGS[@]}"}
rh_guard 1
if [ "$CLEANUP_ONLY" = 1 ]; then rh_log_open replica-check; else rh_log_open replica-check truncate; fi

ORIG_ROLE="AlarmOps-AlarmWriter"
POLICY_NAME="manage-alarmops-alarms"
REPLICA="AlarmOpsRehearsal-WriterReplica"
ALARM_T="AlarmOpsRehearsal-replica-test"
ALARM_U="AlarmOpsRehearsal-replica-unmanaged"
RETRIES="${REHEARSAL_ASSUME_RETRIES:-12}"           # 12 x 5초 = 약 60초 (IAM 전파)
RETRY_INTERVAL="${REHEARSAL_ASSUME_INTERVAL:-5}"
RP_AK=""; RP_SK=""; RP_ST=""                        # 임시 자격증명. export 하지 않는다.
RP_OUT=""; RP_ERR=""; RP_RC=0
DO_CLEANUP=0; CLEAN_FAIL=0; FAILS=0

rp_mask() {
  local t v
  t="$(rh_mask "$1")"
  for v in "$RP_AK" "$RP_SK" "$RP_ST"; do
    if [ -n "$v" ]; then t="${t//"$v"/****}"; fi
  done
  printf '%s' "$t" | sed -E 's/(ASIA|AKIA)[A-Z0-9]{12,}/****/g; s#[A-Za-z0-9+/=]{40,}#****#g'
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

# 마지막 호출의 오류 코드만(메시지는 쓰지 않는다)
rp_code() {
  local c
  c="$(printf '%s\n' "$RP_ERR" | sed -nE 's/.*An error occurred \(([A-Za-z0-9._]+)\).*/\1/p' | head -n 1)" || true
  printf '%s' "${c:-unknown}"
}

rp_note() {  # 사람에게(stderr)와 로그에 알린다. 이미 마스킹된 문장만 넣을 것
  printf '%s\n' "$1" >&2
  rh_log "$1"
}

rp_fail_exec() {  # 호출 실패를 오류 코드와 함께 알린다(메시지 본문은 마스킹해서 stderr 에만)
  rp_note "오류: $1 (코드 $(rp_code))"
  if [ -n "$RP_ERR" ]; then printf '%s\n' "$RP_ERR" >&2; fi
}

rp_cleanup() {
  local c
  CLEAN_FAIL=0
  rh_say ""
  rh_say "## 정리"
  rp_exec person cloudwatch delete-alarms --alarm-names "$ALARM_T" "$ALARM_U"
  if [ "$RP_RC" -eq 0 ]; then rh_say "- 시험 알람 삭제(없으면 건너뜀): $ALARM_T, $ALARM_U"
  else rp_fail_exec "시험 알람 삭제 실패"; CLEAN_FAIL=$((CLEAN_FAIL + 1)); fi

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
  trap - EXIT INT TERM
  set +e
  if [ "$DO_CLEANUP" = 1 ]; then rp_cleanup; fi   # 정리 오류는 알리기만 한다. 결과(rc)를 덮지 않는다
  RP_AK=""; RP_SK=""; RP_ST=""; RP_OUT=""
  rh_cleanup_tmps
  exit "$rc"
}
trap rp_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

# ---- 3) 복제 역할이 이미 있으면 멈춘다(재사용·덮어쓰기 금지)
rp_exec person iam get-role --role-name "$REPLICA"
if [ "$RP_RC" -eq 0 ]; then
  rh_die "역할 $REPLICA 가 이미 있다. 재사용·덮어쓰지 않는다. 이전 실행의 잔여물이면 --cleanup-only 로 먼저 정리한다: bash infra/scripts/rehearsal/replica-check.sh --profile $RH_PROFILE --confirm-account <12자리> --cleanup-only" 5
fi
printf '%s' "$RP_ERR" | grep -q 'NoSuchEntity' || { rp_fail_exec "복제 역할 조회 실패"; exit 1; }

# ---- 4) 복제 역할 생성. 이 시점부터 종료 시 정리한다
DO_CLEANUP=1
rh_tmpfile; TRUST_FILE="$RH_TMPF"
printf '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::%s:root"},"Action":"sts:AssumeRole","Condition":{"ArnLike":{"aws:PrincipalArn":"arn:aws:iam::%s:role/aws-reserved/sso.amazonaws.com/*%s"}}}]}' \
  "$RH_ACCT" "$RH_ACCT" "$CALLER_ROLE" >"$TRUST_FILE"
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

rh_say ""
rh_say "| 항목 | 결과 | 비고 |"
rh_say "|---|---|---|"
rp_row() {  # $1=항목 $2=PASS|FAIL $3=비고
  if [ "$2" = FAIL ]; then FAILS=$((FAILS + 1)); fi
  rh_say "| $1 | $2 | $3 |"
}

# ---- 5) assume (IAM 전파 대기 재시도)
ROLE_ARN="arn:aws:iam::${RH_ACCT}:role/${REPLICA}"
got=0; last=""
for ((i = 1; i <= RETRIES; i++)); do
  rp_exec person sts assume-role --role-arn "$ROLE_ARN" --role-session-name alarmops-replica-check \
    --duration-seconds 900 --output json
  if [ "$RP_RC" -eq 0 ]; then got=1; break; fi
  last="$(rp_code)"
  [ "$i" -lt "$RETRIES" ] && sleep "$RETRY_INTERVAL"
done
if [ "$got" -ne 1 ]; then
  rp_row "(준비) 복제 역할 assume" FAIL "${RETRIES}회 시도 실패, 오류 코드 $last"
  rh_say ""; rh_say "실패 항목 ${FAILS}개. 이 표만 허브에 보낸다"
  exit 1
fi
CREDS="$(printf '%s' "$RP_OUT" | "$RH_PY" -c '
import json, sys
c = json.load(sys.stdin)["Credentials"]
print(c["AccessKeyId"]); print(c["SecretAccessKey"]); print(c["SessionToken"])
' | tr -d '\r')" || { RP_OUT=""; rh_die "assume-role 응답을 해석하지 못했다"; }
RP_OUT=""
{ IFS= read -r RP_AK; IFS= read -r RP_SK; IFS= read -r RP_ST; } <<<"$CREDS"
CREDS=""
if [ -z "$RP_AK" ] || [ -z "$RP_SK" ] || [ -z "$RP_ST" ]; then rh_die "assume-role 자격증명이 비었다"; fi

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
  rp_exec person cloudwatch delete-alarms --alarm-names "$ALARM_T"
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

# (c)(d) 본인 자격증명으로 ManagedBy 없는 알람을 만들고 복제 역할로 건드려 본다
rp_exec person cloudwatch put-metric-alarm --alarm-name "$ALARM_U" "${BASE[@]}"
if [ "$RP_RC" -ne 0 ]; then
  prep="준비 실패: 본인 자격증명으로 알람 생성 오류 코드 $(rp_code)"
  rp_row "(c) 태그 없는 알람에 TagResource(ManagedBy) → 거부" FAIL "$prep"
  rp_row "(d) 태그 없는 알람 DeleteAlarms → 거부" FAIL "$prep"
else
  rp_exec replica cloudwatch tag-resource --resource-arn "$ARN_U" --tags Key=ManagedBy,Value=AlarmOps
  expect_denied "(c) 태그 없는 알람에 TagResource(ManagedBy) → 거부"
  rp_exec replica cloudwatch delete-alarms --alarm-names "$ALARM_U"
  expect_denied "(d) 태그 없는 알람 DeleteAlarms → 거부 (#87 미확인 항목)"
fi

# (e) 관리 알람 삭제
rp_exec replica cloudwatch delete-alarms --alarm-names "$ALARM_T"
if [ "$RP_RC" -eq 0 ]; then rp_row "(e) ManagedBy=AlarmOps 알람 DeleteAlarms → 성공" PASS "성공"
else rp_row "(e) ManagedBy=AlarmOps 알람 DeleteAlarms → 성공" FAIL "오류 코드 $(rp_code)"; fi

rh_say ""
if [ "$FAILS" -gt 0 ]; then
  rh_say "실패 항목 ${FAILS}개. 이 표만 허브에 보낸다(자격증명·로그는 보내지 않는다)"
  exit 1
fi
rh_say "전부 PASS"
exit 0
