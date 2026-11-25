#!/usr/bin/env bash
# 중앙 배포 역할에 신뢰 정책 변경용 임시 권한을 붙이고(grant) 떼는(revoke) 스크립트.
# 절차 배경: infra/aws/deploy-role-policy.md 4장. 사람이 별도 터미널에서 SSO 프로필로만 실행한다.
#
#   infra/scripts/trust-change.sh grant  --profile <p> --role <AlarmOpsCentral-...|alarmops-central-...>
#   infra/scripts/trust-change.sh revoke --profile <p> --role <같은 이름>
#
# grant : AlarmOpsDeployCentral 에 인라인 정책 AlarmOpsDeployCentral-TrustChange 를 붙인다
#         (iam:UpdateAssumeRolePolicy, Resource 는 그 역할 ARN 하나, 지금 + 1시간 뒤 만료).
# revoke: 스택 alarmops-central 이 진행 중이거나 UPDATE_ROLLBACK_FAILED 이면 거부한다. 아니면 정책을 지운다.
# set -x 금지.
set -euo pipefail

TC_REGION="ap-northeast-2"
TC_STACK="alarmops-central"
TC_DEPLOY_ROLE="AlarmOpsDeployCentral"
TC_POLICY="AlarmOpsDeployCentral-TrustChange"
TC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TC_REPO="$(cd "$TC_DIR/../.." && pwd)"

TC_MODE=""; TC_PROFILE=""; TC_ROLE=""; TC_TMPS=(); TC_LOG=""

die() { printf '오류: %s\n' "$1" >&2; exit "${2:-1}"; }

cleanup() { local f; for f in ${TC_TMPS[@]+"${TC_TMPS[@]}"}; do rm -f "$f"; done; }
trap cleanup EXIT

log() { if [ -n "$TC_LOG" ]; then printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$TC_LOG"; fi; }
say() { printf '%s\n' "$1"; log "$1"; }

native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# 모든 aws 호출은 프로필·리전을 고정하는 이 래퍼로만. stdin 은 넘기지 않는다(사람 입력을 aws 가 먹지 않게).
aws_t() { aws --profile "$TC_PROFILE" --region "$TC_REGION" "$@" </dev/null; }

# 1) 에이전트·상시 자격증명 거부 (aws 를 부르기 전)
for v in CLAUDECODE CLAUDE_CODE_ENTRYPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
         AWS_DEFAULT_PROFILE AWS_PROFILE AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE AWS_ROLE_ARN \
         AWS_WEB_IDENTITY_TOKEN_FILE $(compgen -v | grep -E '^(AWS_ENDPOINT_URL|AWS_CONTAINER_)' || true); do
  if [ -n "${!v+set}" ]; then
    die "환경변수 $v 가 설정되어 있다. 에이전트 세션이나 상시 자격증명에서는 실행하지 않는다. 사람이 별도 터미널에서 --profile 로만 실행한다." 2
  fi
done

# 2) 인자
usage() { die "사용법: trust-change.sh grant|revoke --profile <프로필> --role <AlarmOpsCentral-...|alarmops-central-...>" 2; }
[ $# -ge 1 ] || usage
TC_MODE="$1"; shift
case "$TC_MODE" in grant|revoke) ;; *) usage ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    --profile|--role)
      [ $# -ge 2 ] || die "$1 에 값이 필요하다" 2
      if [ "$1" = "--profile" ]; then TC_PROFILE="$2"; else TC_ROLE="$2"; fi
      shift 2 ;;
    *) die "알 수 없는 인자: $1" 2 ;;
  esac
done
[ -n "$TC_PROFILE" ] || die "--profile 이 필요하다" 2
[ -n "$TC_ROLE" ] || die "--role 이 필요하다" 2

# 사람이 터미널에서 직접 실행하는 스크립트다. 표준 입력이 TTY 가 아니면(파이프·리다이렉트·자동 실행) 거부한다.
# TRUST_CHANGE_TEST_NO_TTY=1 은 infra/test 의 단위 테스트가 가짜 aws 와 파이프 입력을 쓰려는 용도다. 실제 aws 를
# 쓰는 운영 실행에서는 이 변수를 설정하지 않는다. 이 변수는 TTY 검사만 건너뛰며, 계정 12자리 재입력·역할 이름 검사·
# 환경변수 거부는 그대로 적용된다(실제 자격 증명 경로는 AWS_* 거부와 --profile 로 막혀 있다).
if [ ! -t 0 ] && [ "${TRUST_CHANGE_TEST_NO_TTY:-}" != 1 ]; then
  die "표준 입력이 터미널이 아니다. 사람이 터미널에서 직접 실행한다." 2
fi

# 프로필: dev 또는 중앙 계정용 central, central-<이름>. 리허설·고객 프로필은 받지 않는다.
[[ "$TC_PROFILE" =~ ^(dev|central(-[a-z0-9]+)*)$ ]] || die "--profile 은 dev 또는 central[-이름] 형식이어야 한다" 2

# 역할 이름: 중앙 역할 두 패턴만. 배포 역할(AlarmOpsDeploy*)과 고객 역할(AlarmOps-*)은 여기서 걸린다.
[[ "$TC_ROLE" =~ ^AlarmOpsCentral-[A-Za-z0-9-]+$ || "$TC_ROLE" =~ ^alarmops-central-[A-Za-z0-9-]+$ ]] \
  || die "--role '$TC_ROLE' 은 허용하지 않는다. AlarmOpsCentral-<이름> 또는 alarmops-central-<이름> 만 받는다(배포 역할·고객 역할·와일드카드 불가)." 2

# 3) 계정 확인: 화면에 보이고 사람이 12자리를 다시 입력해야 한다
ACCT="$(aws_t sts get-caller-identity --query Account --output text | tr -d '\r')" || die "sts get-caller-identity 실패"
[[ "$ACCT" =~ ^[0-9]{12}$ ]] || die "계정 식별 결과가 이상하다"

LOGDIR="${TRUST_CHANGE_LOG_DIR:-$TC_REPO/trust-change-logs}"
(umask 077; mkdir -p "$LOGDIR")
TC_LOG="$LOGDIR/$TC_PROFILE.log"
(umask 077; : >>"$TC_LOG"); chmod 600 "$TC_LOG"
log "시작 mode=$TC_MODE profile=$TC_PROFILE role=$TC_ROLE"

printf '대상 계정: %s (프로필 %s, 리전 %s)\n' "$ACCT" "$TC_PROFILE" "$TC_REGION"
CONFIRM=""
printf '대상 계정 12자리를 다시 입력하세요: ' >&2
read -r CONFIRM || CONFIRM=""
CONFIRM="${CONFIRM%$'\r'}"
if [ "$CONFIRM" != "$ACCT" ]; then
  log "계정 재입력 불일치: 중단"
  die "입력한 계정이 현재 계정과 다르다. 중단한다." 2
fi
log "계정 재입력 일치: $ACCT"

ROLE_ARN="arn:aws:iam::${ACCT}:role/${TC_ROLE}"

if [ "$TC_MODE" = grant ]; then
  EXPIRES="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
  [[ "$EXPIRES" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "만료 시각 계산 실패"
  TMPF="$(umask 077; mktemp)"; TC_TMPS+=("$TMPF")
  cat >"$TMPF" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrustChangeOneRole",
      "Effect": "Allow",
      "Action": "iam:UpdateAssumeRolePolicy",
      "Resource": "${ROLE_ARN}",
      "Condition": {
        "DateLessThan": {
          "aws:CurrentTime": "${EXPIRES}"
        }
      }
    }
  ]
}
EOF
  say "붙이는 정책: $TC_POLICY -> $TC_DEPLOY_ROLE, 대상 $ROLE_ARN, 만료 $EXPIRES"
  aws_t iam put-role-policy --role-name "$TC_DEPLOY_ROLE" --policy-name "$TC_POLICY" \
    --policy-document "file://$(native_path "$TMPF")" || die "put-role-policy 실패"
  say "붙였다. 만료 $EXPIRES (UTC). apply 가 끝나면 'trust-change.sh revoke' 로 지운다."
  say "대상 역할 $TC_ROLE 의 현재 신뢰 정책:"
  aws_t iam get-role --role-name "$TC_ROLE" --query Role.AssumeRolePolicyDocument --output json \
    || die "get-role 실패(정책은 이미 붙었다. 필요 없으면 revoke 한다)"
  exit 0
fi

# revoke
STATUS="$(aws_t cloudformation describe-stacks --stack-name "$TC_STACK" --query 'Stacks[0].StackStatus' --output text | tr -d '\r')" \
  || die "스택 $TC_STACK 상태를 읽지 못했다. 상태를 모르면 지우지 않는다(정책은 만료 시각에 효력이 없어진다)."
case "$STATUS" in
  *_IN_PROGRESS)
    die "스택 $TC_STACK 이 $STATUS 이다. 진행 중에는 롤백이 신뢰 정책 변경을 다시 부를 수 있어 정책을 지우지 않는다. 끝난 뒤 다시 실행한다." 3 ;;
  UPDATE_ROLLBACK_FAILED)
    die "스택 $TC_STACK 이 UPDATE_ROLLBACK_FAILED 이다. 롤백 계속(Continue update rollback)이 같은 권한을 요구할 수 있어 지우지 않는다. 콘솔에서 롤백을 끝낸 뒤 다시 실행한다." 3 ;;
esac
say "스택 $TC_STACK 상태: $STATUS"
NAMES="$(aws_t iam list-role-policies --role-name "$TC_DEPLOY_ROLE" --query PolicyNames --output text | tr -d '\r')" \
  || die "list-role-policies 실패"
case $'\t'"$NAMES"$'\t' in
  *$'\t'"$TC_POLICY"$'\t'*) ;;
  *) say "정책 $TC_POLICY 이 이미 없다. 할 일 없음."; exit 0 ;;
esac
aws_t iam delete-role-policy --role-name "$TC_DEPLOY_ROLE" --policy-name "$TC_POLICY" || die "delete-role-policy 실패"
say "지웠다: $TC_POLICY"
