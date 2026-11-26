#!/usr/bin/env bash
# 리허설 사전 점검 (#122). 쓰기 호출 없음. 사람이 시험 계정(B·C)에서 실행한다.
# 사용: bash preflight.sh --profile rehearsal-b [--confirm-account 12자리]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
RH_ALLOWED=" --profile --confirm-account "
rh_env_check
rh_parse_args "$@"
rh_guard 0
rh_log_open "preflight-$(date +%Y%m%d-%H%M%S)" truncate
rh_say "# preflight $RH_PROFILE ($RH_ACCT)"

fail=0
# R2: 형식
[[ "$RH_CENTRAL_ROLE_ARN" =~ ^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$ ]] \
  || { rh_say "FAIL: centralRoleArn 형식이 IAM 역할 ARN이 아니다"; fail=1; }
[[ "$RH_CENTRAL_BUS_ARN" =~ ^arn:aws[a-z-]*:events:ap-northeast-2:[0-9]{12}:event-bus/[A-Za-z0-9._-]+$ ]] \
  || { rh_say "FAIL: centralEventBusArn 형식이 서울 리전 이벤트 버스 ARN이 아니다"; fail=1; }

# 템플릿 검증(읽기)
if aws_r cloudformation validate-template --template-body "file://$(rh_native_path "$RH_TEMPLATE")" >/dev/null; then
  rh_say "OK: validate-template"
else
  rh_say "FAIL: validate-template"; fail=1
fi

# R1: 기존 스택·역할 탐지 (응답 원문은 기록하지 않고 이름만 뽑는다)
stacks="$(aws_r cloudformation describe-stacks)" || stacks='{}'
names="$(printf '%s' "$stacks" | "$RH_PY" -c '
import json, sys
for s in json.load(sys.stdin).get("Stacks", []):
    print(s.get("StackName", ""))
' | tr -d '\r')" || names=""
while IFS= read -r n; do
  [ -n "$n" ] || continue
  lower="$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')"
  if [ "$n" = "$RH_STACK_NAME_CONST" ]; then
    rh_say "경고: 스택 $n 이 이미 있다. install 은 갱신으로 동작한다"
  elif [[ "$lower" == *alarmops* ]]; then
    rh_say "경고: 이름이 다른 AlarmOps 계열 스택이 있다: $n (역할 이름 충돌 가능)"
  fi
done <<<"$names"
roles="$(aws_r iam list-roles --query 'Roles[].RoleName' --output text)" || roles=""
for r in $roles; do
  case "$r" in AlarmOps-*) rh_say "경고: 기존 역할 $r (스택 밖에서 만든 것이면 충돌한다)" ;; esac
done

# R3: CloudTrail 읽기 기록
trails="$(aws_r cloudtrail describe-trails --query 'trailList[].Name' --output text)" || trails=""
if [ -z "$trails" ] || [ "$trails" = None ]; then
  rh_say "경고: CloudTrail 트레일이 없다. 태그 변경 이벤트가 흐르지 않을 수 있다"
else
  for t in $trails; do
    st="$(aws_r cloudtrail get-trail-status --name "$t" --query IsLogging --output text)" || st="?"
    rh_say "CloudTrail $t IsLogging=$st"
  done
fi

rh_say ""
rh_say "## 사람 관문 체크리스트 (모두 y 여야 install 로 간다)"
for item in "7-1 콘솔에 이 계정을 등록했다(AlarmWriter 켬)" "7-4 연결 확인이 OK 였다"; do
  if rh_ask "$item"; then rh_say "- [x] $item"; else rh_say "- [ ] 미확인: $item"; fi
done

if [ "$fail" -ne 0 ]; then rh_say "preflight 실패"; exit 1; fi
rh_say "preflight 통과(기술 점검). 위 체크리스트의 미확인 항목은 사람이 끝낸 뒤 install 한다."
