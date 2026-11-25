#!/usr/bin/env bash
# 리허설 검증 (#122, GO-LIVE 4-6의 4항목). 시험 큐 1개를 만들고 결과표를 남긴다.
# 사용: bash verify.sh --profile rehearsal-b --confirm-account 12자리 [--run-id ID]
# 사람 관문(y 입력)이 있다. 입력이 없으면(비대화형) 해당 항목은 SKIP 으로 기록한다.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
RH_ALLOWED=" --profile --confirm-account --run-id "
rh_env_check
rh_parse_args "$@"
[ -n "$RH_RUN_ID" ] || RH_RUN_ID="v$(date +%Y%m%d%H%M%S)"
rh_check_run_id
rh_guard 1
rh_log_open "$RH_RUN_ID" truncate

FAILS=0
queue="alarmops-rehearsal-$RH_RUN_ID"
url=""

rh_row() {  # $1=항목 $2=PASS|FAIL|TIMEOUT|SKIP $3=비고
  local label
  case "$2" in
    PASS) label="PASS (됐다)" ;;
    FAIL) label="FAIL (안 됐다)"; FAILS=$((FAILS + 1)) ;;
    TIMEOUT) label="FAIL (TIMEOUT, 원인 미상)"; FAILS=$((FAILS + 1)) ;;
    *) label="SKIP" ;;
  esac
  rh_say "| $1 | $label | $3 |"
}

rh_say "# 리허설 검증 $RH_PROFILE ($RH_ACCT) runId=$RH_RUN_ID"
rh_say "참고: 아래 표의 라 항목은 정책 시뮬레이션(실측 아님)이다. 나머지는 실제 호출 결과다."
rh_say ""
rh_say "| 항목 | 결과 | 비고 |"
rh_say "|---|---|---|"

# 시험 큐 생성 (보존 최소, 리허설 태그)
rc=0
url="$(aws_r sqs create-queue --queue-name "$queue" --attributes MessageRetentionPeriod=60 \
  --tags "AlarmOpsRehearsal=true,AlarmOpsRehearsalRun=$RH_RUN_ID" --query QueueUrl --output text)" || rc=$?
if [ "$rc" -eq 0 ] && [ -n "$url" ]; then
  rh_log "QUEUE: $queue"
  rh_log "QUEUE_URL: $url"
else
  url=""
  rh_row "(준비) 시험 큐 생성" FAIL "create-queue 실패(종료 코드 $rc)"
fi

metric_sum() {  # $1 = Invocations | FailedInvocations
  aws_r cloudwatch get-metric-statistics --namespace AWS/Events --metric-name "$1" \
    --dimensions "Name=RuleName,Value=AlarmOps-TagChange" \
    --start-time "$START" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --period 60 --statistics Sum --query 'Datapoints[].Sum' --output text \
    | awk '{ s = 0; for (i = 1; i <= NF; i++) s += $i; print s }' || echo 0
}
failed_seen() { local f; f="$(metric_sum FailedInvocations)"; [ "${f%%.*}" -gt 0 ] 2>/dev/null; }
alarms_exist() { local a; mapfile -t a < <(rh_run_alarms "$queue"); [ "${#a[@]}" -gt 0 ]; }
alarms_gone() { ! alarms_exist; }

A_STATE=SKIP; B_STATE=SKIP
START="$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

# (가) 미허용 차단 - 허용 목록 추가 전
if [ -n "$url" ] && rh_ask "(가) 이 계정이 허용 목록(bus-allowlist)에 아직 없고 중앙에서 멈춘 상태입니까?"; then
  if aws_r sqs tag-queue --queue-url "$url" --tags Monitoring=on >/dev/null; then
    if rh_poll failed_seen; then
      inv="$(metric_sum Invocations)"; fl="$(metric_sum FailedInvocations)"
      rh_log "AlarmOps-TagChange Invocations=$inv FailedInvocations=$fl"
      if rh_ask "(가) 콘솔에서 이 큐에 대한 중앙 처리 흔적이 없음을 확인했습니까?"; then
        rh_row "(가) 미허용 계정 차단" PASS "Invocations=$inv FailedInvocations=$fl, 중앙 처리 없음(사람 확인)"
        A_STATE=PASS
      else
        rh_row "(가) 미허용 계정 차단" SKIP "FailedInvocations=$fl 이나 중앙 처리 없음은 사람 미확인"
      fi
    else
      rh_row "(가) 미허용 계정 차단" TIMEOUT "FailedInvocations 가 ${RH_WAIT_SECONDS}초 안에 늘지 않음"
    fi
  else
    rh_row "(가) 미허용 계정 차단" FAIL "tag-queue 실패"
  fi
  if rh_ask "이제 중앙에서 bus-allowlist add 로 이 계정을 허용한 뒤 계속합니까?"; then B_STATE=GO; fi
else
  rh_row "(가) 미허용 계정 차단" SKIP "사람 확인 없음 또는 큐 없음"
fi

# (나) 태그 → 알람 생성
if [ "$B_STATE" = GO ]; then
  aws_r sqs untag-queue --queue-url "$url" --tag-keys Monitoring >/dev/null || true
  if aws_r sqs tag-queue --queue-url "$url" --tags Monitoring=on >/dev/null; then
    if rh_poll alarms_exist; then
      mapfile -t own < <(rh_run_alarms "$queue")
      for n in "${own[@]}"; do rh_log "ALARM: $n"; done
      rh_row "(나) 태그 → 알람 생성" PASS "ManagedBy=AlarmOps, 차원 QueueName=$queue 알람 ${#own[@]}개"
      B_STATE=PASS
    else
      rh_row "(나) 태그 → 알람 생성" TIMEOUT "${RH_WAIT_SECONDS}초 안에 알람이 안 생김(디바운스 10분 포함)"
    fi
  else
    rh_row "(나) 태그 → 알람 생성" FAIL "tag-queue 실패"
  fi
else
  rh_row "(나) 태그 → 알람 생성" SKIP "허용 목록 추가 확인 없음"
fi

# (다) 태그 제거 → 알람 유지, STOP_MONITORING 으로만 삭제
if [ "$B_STATE" = PASS ]; then
  mapfile -t own < <(rh_run_alarms "$queue")
  before="$(rh_alarm_total)"
  if aws_r sqs untag-queue --queue-url "$url" --tag-keys Monitoring >/dev/null; then
    sleep "$RH_POLL_INTERVAL"
    mapfile -t kept < <(rh_run_alarms "$queue")
    if [ "${#kept[@]}" -ne "${#own[@]}" ]; then
      rh_row "(다) 태그 제거 → 알람 유지" FAIL "태그를 뗀 뒤 알람이 ${#own[@]}개에서 ${#kept[@]}개로 바뀜(D-16 위반)"
    elif rh_ask "(다) 콘솔에서 NEEDS_REVIEW 표시를 확인하고 STOP_MONITORING 을 실행했습니까?"; then
      if rh_poll alarms_gone; then
        after="$(rh_alarm_total)"
        if [ "$after" -eq $((before - ${#own[@]})) ]; then
          rh_row "(다) 태그 제거 → 알람 유지" PASS "제거 직후 유지, STOP_MONITORING 뒤 그 알람만 삭제(계정 알람 $before→$after)"
        else
          rh_row "(다) 태그 제거 → 알람 유지" FAIL "다른 알람 수가 변함($before→$after, 삭제 예상 ${#own[@]})"
        fi
      else
        rh_row "(다) 태그 제거 → 알람 유지" TIMEOUT "STOP_MONITORING 뒤에도 알람이 남음"
      fi
    else
      rh_row "(다) 태그 제거 → 알람 유지" SKIP "알람은 유지됨. NEEDS_REVIEW·STOP_MONITORING 은 사람 미확인"
    fi
  else
    rh_row "(다) 태그 제거 → 알람 유지" FAIL "untag-queue 실패"
  fi
else
  rh_row "(다) 태그 제거 → 알람 유지" SKIP "(나)가 통과하지 않음"
fi

# (라) ManagedBy 거부 - 정책 시뮬레이션. 알람 쓰기는 요청 태그 ManagedBy 가 있어야만 허용된다.
role_arn="arn:aws:iam::${RH_ACCT}:role/AlarmOps-AlarmWriter"
alarm_arn="arn:aws:cloudwatch:${RH_REGION}:${RH_ACCT}:alarm:rehearsal-sim-$RH_RUN_ID"
sim() {  # 나머지 인자 = 추가 옵션. 판정 문자열 출력
  aws_r iam simulate-principal-policy --policy-source-arn "$role_arn" \
    --action-names cloudwatch:PutMetricAlarm --resource-arns "$alarm_arn" "$@" \
    --query 'EvaluationResults[0].EvalDecision' --output text
}
rc=0
ctl="$(sim --context-entries "ContextKeyName=aws:RequestTag/ManagedBy,ContextKeyValues=AlarmOps,ContextKeyType=string")" || rc=$?
neg="$(sim)" || rc=$?
if [ "$rc" -ne 0 ]; then
  rh_row "(라) ManagedBy 거부" FAIL "시뮬레이션 호출 실패(종료 코드 $rc)"
elif [ "$ctl" != allowed ]; then
  rh_row "(라) ManagedBy 거부" FAIL "허용 대조군(태그 있음)이 $ctl (allowed 여야 함)"
elif [ "$neg" = implicitDeny ] || [ "$neg" = explicitDeny ]; then
  rh_row "(라) ManagedBy 거부" PASS "대조군 allowed, 태그 없는 요청 $neg"
else
  rh_row "(라) ManagedBy 거부" FAIL "태그 없는 요청이 $neg (거부여야 함)"
fi

rh_say ""
rh_say "시험 큐: $queue (정리는 cleanup.sh --run-id $RH_RUN_ID)"
if [ "$FAILS" -gt 0 ]; then rh_say "실패 항목 $FAILS개"; exit 1; fi
exit 0
