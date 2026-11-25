#!/usr/bin/env bash
# 시험 계정에 고객 연결 스택 설치 (#122). 쓰기 호출이 있다. 사람이 시험 계정(B·C)에서 실행한다.
# 사용: REHEARSAL_EXTERNAL_ID=... bash install.sh --profile rehearsal-b --confirm-account 12자리
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
RH_ALLOWED=" --profile --confirm-account "
rh_env_check
rh_parse_args "$@"
rh_guard 1
[ -n "$RH_EID" ] || rh_die "REHEARSAL_EXTERNAL_ID 환경변수가 필요하다(인자로 받지 않는다)"
[[ "$RH_EID" =~ ^[A-Za-z0-9+=,.@:/_-]{16,128}$ ]] || rh_die "ExternalId 형식이 템플릿 제약(16~128자)과 맞지 않는다"
[[ "$RH_CENTRAL_ROLE_ARN" =~ ^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$ ]] || rh_die "centralRoleArn 형식 오류"
[[ "$RH_CENTRAL_BUS_ARN" =~ ^arn:aws[a-z-]*:events:ap-northeast-2:[0-9]{12}:event-bus/[A-Za-z0-9._-]+$ ]] || rh_die "centralEventBusArn 형식 오류"
rh_log_open "install-$(date +%Y%m%d-%H%M%S)" truncate
rh_say "# install $RH_PROFILE ($RH_ACCT) stack=$RH_STACK_NAME_CONST"

# ExternalId 는 환경변수 → 600 임시 파일(--cli-input-json)로만 aws 에 전달한다.
input="$(rh_tmpfile)"
RH_CENTRAL_ROLE_ARN="$RH_CENTRAL_ROLE_ARN" RH_CENTRAL_BUS_ARN="$RH_CENTRAL_BUS_ARN" RH_STACK_NAME_CONST="$RH_STACK_NAME_CONST" \
"$RH_PY" -c '
import json, os
e = os.environ
doc = {
    "StackName": e["RH_STACK_NAME_CONST"],
    "Parameters": [
        {"ParameterKey": "CentralRoleArn", "ParameterValue": e["RH_CENTRAL_ROLE_ARN"]},
        {"ParameterKey": "CentralEventBusArn", "ParameterValue": e["RH_CENTRAL_BUS_ARN"]},
        {"ParameterKey": "ExternalId", "ParameterValue": e["REHEARSAL_EXTERNAL_ID"]},
        {"ParameterKey": "EnableAlarmWriter", "ParameterValue": "true"},
    ],
    "Capabilities": ["CAPABILITY_NAMED_IAM"],
    "Tags": [{"Key": "AlarmOpsRehearsal", "Value": "true"}],
}
print(json.dumps(doc))
' >"$input"
tpl="file://$(rh_native_path "$RH_TEMPLATE")"
inp="file://$(rh_native_path "$input")"

op=create-stack; waiter=stack-create-complete
if existing="$(aws_r cloudformation describe-stacks --stack-name "$RH_STACK_NAME_CONST" 2>/dev/null)"; then
  if printf '%s' "$existing" | "$RH_PY" -c '
import json, sys
tags = json.load(sys.stdin)["Stacks"][0].get("Tags", [])
sys.exit(0 if any(t.get("Key") == "AlarmOpsRehearsal" and t.get("Value") == "true" for t in tags) else 1)
'; then
    op=update-stack; waiter=stack-update-complete
  else
    rh_die "같은 이름 스택이 있지만 AlarmOpsRehearsal=true 태그가 없다. 리허설이 만든 것이 아니므로 건드리지 않는다"
  fi
fi

rc=0
aws_r cloudformation "$op" --cli-input-json "$inp" --template-body "$tpl" >/dev/null || rc=$?
if [ "$rc" -ne 0 ]; then rh_say "FAIL: $op 실패(종료 코드 $rc)"; exit "$rc"; fi
rh_say "$op 요청함. 완료를 기다린다"
aws_r cloudformation wait "$waiter" --stack-name "$RH_STACK_NAME_CONST" || { rh_say "FAIL: $waiter 대기 실패"; exit 1; }
rh_say "OK: 설치 완료. 다음: 사람이 콘솔에서 7-4 연결 확인 후 verify.sh"
