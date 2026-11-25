#!/usr/bin/env bash
# 리허설 정리 (#122). 이번 runId 가 만든 것만 지운다.
# 사용: bash cleanup.sh --profile rehearsal-b --confirm-account 12자리 --run-id ID [--stack [--stack-name alarmops-customer]]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
RH_ALLOWED=" --profile --confirm-account --run-id --stack --stack-name "
rh_env_check
rh_parse_args "$@"
[ -n "$RH_RUN_ID" ] || rh_die "--run-id 가 필요하다" 2
rh_check_run_id
if [ -n "$RH_STACK_NAME" ] && [ "$RH_STACK_NAME" != "$RH_STACK_NAME_CONST" ]; then
  rh_die "스택 이름은 $RH_STACK_NAME_CONST 만 허용한다" 2
fi
rh_guard 1
rh_log_open "cleanup-$RH_RUN_ID"
rh_say "# cleanup $RH_PROFILE ($RH_ACCT) runId=$RH_RUN_ID"

status=0
run_log="${REHEARSAL_LOG_DIR:-$RH_REPO/rehearsal-logs}/$RH_PROFILE/$RH_RUN_ID.md"
queues=()
if [ -f "$run_log" ]; then
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in "QUEUE: "*) queues+=("${line#QUEUE: }") ;; esac
  done <"$run_log"
else
  rh_say "경고: runId 로그가 없다($run_log). 알람·큐는 지우지 않는다"
  status=1
fi

for q in ${queues[@]+"${queues[@]}"}; do
  [[ "$q" =~ ^alarmops-rehearsal-[A-Za-z0-9_-]+$ ]] || { rh_say "건너뜀: 이상한 큐 이름 $q"; continue; }
  # 1) 소유 확인을 먼저 한다: 큐가 AlarmOpsRehearsal=true 이고 AlarmOpsRehearsalRun == --run-id 일 때만
  #    그 큐의 알람과 큐를 지운다. 확인할 수 없거나 불일치면 둘 다 건드리지 않는다.
  rh_tmpfile; errf="$RH_TMPF"
  rc=0; qurl="$(aws_r sqs get-queue-url --queue-name "$q" --query QueueUrl --output text 2>"$errf")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$qurl" ]; then
    if grep -qE 'QueueDoesNotExist|NonExistentQueue' "$errf" 2>/dev/null; then
      rh_say "큐 없음: $q (소유를 확인할 수 없어 알람도 지우지 않는다)"
    else
      rh_say "FAIL: get-queue-url $q 실패(종료 코드 $rc). 알람·큐를 지우지 않는다"; status=1
    fi
    rm -f "$errf"; continue
  fi
  rm -f "$errf"
  rc=0; qtags="$(aws_r sqs list-queue-tags --queue-url "$qurl")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    rh_say "FAIL: list-queue-tags $q 실패(종료 코드 $rc). 소유 확인 불가, 알람·큐를 지우지 않는다"; status=1; continue
  fi
  own=0
  printf '%s' "$qtags" | "$RH_PY" -c '
import json, sys
t = json.load(sys.stdin).get("Tags") or {}
sys.exit(0 if t.get("AlarmOpsRehearsal") == "true" and t.get("AlarmOpsRehearsalRun") == sys.argv[1] else 1)
' "$RH_RUN_ID" || own=$?
  if [ "$own" -ne 0 ]; then
    rh_say "유지: 큐 $q 는 이 run 소유가 아니다(AlarmOpsRehearsal=true 와 AlarmOpsRehearsalRun=$RH_RUN_ID 필요). 알람도 지우지 않는다"
    continue
  fi
  # 2) 알람: 이번 run 의 큐 ∧ ManagedBy=AlarmOps ∧ 차원 QueueName=그 큐. 조회 실패는 '없음'이 아니다.
  if ! rh_run_alarms "$q"; then
    rh_say "FAIL: $q 의 알람 조회 실패. 삭제를 멈춘다(알람·큐 모두 유지)"; status=1; continue
  fi
  names=("${RH_ALARMS[@]+"${RH_ALARMS[@]}"}")
  if [ "${#names[@]}" -gt 0 ]; then
    i=0
    while [ "$i" -lt "${#names[@]}" ]; do
      chunk=("${names[@]:$i:50}")
      if aws_r cloudwatch delete-alarms --alarm-names "${chunk[@]}" >/dev/null; then
        rh_say "알람 삭제: ${chunk[*]}"
      else
        rh_say "FAIL: delete-alarms"; status=1
      fi
      i=$((i + 50))
    done
  else
    rh_say "삭제할 알람 없음: $q"
  fi
  # 3) 큐
  if aws_r sqs delete-queue --queue-url "$qurl" >/dev/null; then rh_say "큐 삭제: $q"; else rh_say "FAIL: delete-queue $q"; status=1; fi
done

# 스택: --stack 이고 이름이 alarmops-customer 이며 스택 태그 AlarmOpsRehearsal=true 일 때만
if [ "$RH_STACK" = 1 ]; then
  sdesc=""
  if sdesc="$(aws_r cloudformation describe-stacks --stack-name "$RH_STACK_NAME_CONST" 2>/dev/null)"; then
    if printf '%s' "$sdesc" | "$RH_PY" -c '
import json, sys
tags = json.load(sys.stdin)["Stacks"][0].get("Tags", [])
sys.exit(0 if any(t.get("Key") == "AlarmOpsRehearsal" and t.get("Value") == "true" for t in tags) else 1)
'; then
      if aws_r cloudformation delete-stack --stack-name "$RH_STACK_NAME_CONST" >/dev/null; then
        rh_say "스택 삭제 요청: $RH_STACK_NAME_CONST"
        aws_r cloudformation wait stack-delete-complete --stack-name "$RH_STACK_NAME_CONST" || { rh_say "경고: 삭제 완료 대기 실패"; status=1; }
      else
        rh_say "FAIL: delete-stack"; status=1
      fi
    else
      rh_say "스택 유지: AlarmOpsRehearsal=true 태그가 없다"
    fi
  else
    rh_say "스택 없음: $RH_STACK_NAME_CONST"
  fi
fi

rh_say ""
rh_say "## 사람 몫 (OFFBOARDING 순서)"
rh_say "1. 콘솔에서 이 계정 연결을 비활성화한다"
rh_say "2. 중앙에서 bus-allowlist remove 로 이 계정을 허용 목록에서 뺀다"
rh_say "3. (스택을 남겼다면) 사람이 판단해 고객 스택을 삭제한다. 남은 리소스가 없는지 눈으로 확인한다"
exit "$status"
