# 리허설 하네스 계약 (#122)

`infra/scripts/rehearsal/*.sh` 구현자는 구현 전에 이 문서와 `infra/test/rehearsal_support.py`, `infra/test/test_rehearsal_harness.py`를 읽는다.
이슈 수용 기준에는 없는 형식(플래그 이름, 환경변수, 결과표 문자열)은 이 문서가 정한다. 테스트는 이 문서를 따른다. 다른 형식이 필요하면 이 문서와 테스트를 같은 PR에서 함께 고친다.

실행: 저장소 루트에서 `python -m unittest discover -s infra/test`. 가짜 `aws`(`infra/test/fake_aws.py`)가 PATH 맨 앞에 놓이고 모든 호출을 기록한다. 실제 AWS에는 접속하지 않는다.

## 스크립트와 플래그

| 스크립트 | 플래그 |
|---|---|
| `common.sh` | 다른 스크립트가 source한다. 단독 실행 대상 아님 |
| `preflight.sh` | `--profile NAME` (필수). 쓰기 호출 없음 |
| `install.sh` | `--profile`, `--confirm-account 12자리` |
| `verify.sh` | `--profile`, `--confirm-account`, `--run-id ID` (생략 시 시각 기반 기본값) |
| `cleanup.sh` | `--profile`, `--confirm-account`, `--run-id ID` (필수), `--stack` (선택), `--stack-name N` (선택, 기본 `alarmops-customer`) |

- 스크립트는 `bash 스크립트경로 플래그...`로 실행한다(실행 권한에 의존하지 않는다).
- 모든 `aws` 호출에 `--profile <값> --region ap-northeast-2`를 붙인다. 계정 검증용 `sts get-caller-identity`도 같다.
- `--confirm-account`는 사람이 입력한 계정 번호 12자리다. 대응표의 계정과 다르거나 없으면 쓰기 호출 전에 거부한다.

## 환경변수

| 이름 | 뜻 |
|---|---|
| `REHEARSAL_EXTERNAL_ID` | ExternalId. 환경변수로만 받는다(인자 금지). install에서 없으면 거부 |
| `REHEARSAL_ACCOUNTS_FILE` | `accounts.local.json` 경로. 기본값은 스크립트 옆 |
| `REHEARSAL_LOG_DIR` | `rehearsal-logs` 디렉터리를 대체. 기본값은 저장소 루트의 `rehearsal-logs` |
| `REHEARSAL_POLL_INTERVAL`, `REHEARSAL_WAIT_SECONDS` | 폴링 간격과 최대 대기(초). 테스트는 둘 다 0 |

거부 대상 환경변수: `AWS_ACCESS_KEY_ID`, `AWS_SESSION_TOKEN`, `AWS_DEFAULT_PROFILE`, `AWS_PROFILE`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`. 하나라도 있으면 aws를 부르기 전에 0이 아닌 코드로 끝난다.

## accounts.local.json

```json
{"centralAccountId": "…", "devAccountId": "…", "denyAccounts": ["…"],
 "centralRoleArn": "arn:aws:iam::<중앙>:role/…", "centralEventBusArn": "arn:aws:events:ap-northeast-2:<중앙>:event-bus/…",
 "profiles": {"rehearsal-a": "111111111111"}}
```

프로필이 표에 없거나 표 파일이 없으면 거부한다.

## 로그와 결과표

- 경로: `<REHEARSAL_LOG_DIR>/<profile>/<runId>.md`. 파일 권한 600(umask와 무관하게 스크립트가 보장). 이슈 초안의 `<시각>.md`는 runId 기본값을 시각으로 하는 것으로 읽는다.
- 결과표는 한 검사당 한 줄이다. 줄에 `PASS`, `FAIL`, `SKIP` 중 하나가 들어간다.
- "(라)" 행: AlarmWriter 시뮬레이션. 수용 기준의 "verify (라)"를 가리키며 줄에 문자열 `(라)`를 넣는다.
  - 허용 대조군(`aws:RequestTag/ManagedBy` 있음)이 `allowed`가 아니면 이 줄은 FAIL.
  - 태그 없는 요청이 `allowed`이면 FAIL.
  - 태그 없는 요청의 판정(`implicitDeny` 또는 `explicitDeny`)은 AWS가 돌려준 문자열 그대로 줄에 적고, 두 값을 서로 바꿔 적지 않는다.
- 결과표(같은 파일)에 문구 `정책 시뮬레이션(실측 아님)`을 적는다.
- `iam simulate-principal-policy`는 항상 `--resource-arns`를 준다. 정책 원본은 `--policy-source-arn arn:aws:iam::<계정>:role/…AlarmOps-AlarmWriter`, 동작은 `cloudwatch:PutMetricAlarm`.
- 큐 이름은 runId마다 달라야 하고, verify는 시험 큐를 하나 만든다(태그 `AlarmOpsRehearsal=true`).
- 로그, 표준 출력·오류, aws 인자 어디에도 ExternalId 원문을 쓰지 않는다. CloudFormation에는 파일(`file://`)이나 표준 입력으로 전달한다.

## cleanup 범위

- 알람 삭제: runId 로그의 큐 ∧ 알람 태그 `ManagedBy=AlarmOps` ∧ 차원 이름 `QueueName`이고 값이 그 큐 이름. 값이 같아도 차원 이름이 다르면(InstanceId 등) 건드리지 않는다.
- 큐 삭제: 큐 태그 `AlarmOpsRehearsal=true` ∧ 해당 runId 로그에 있는 큐.
- 스택 삭제: `--stack`이 있고, 스택 이름이 `alarmops-customer`(또는 같은 이름으로 준 `--stack-name`)이고, 스택 태그 `AlarmOpsRehearsal=true`일 때만. 이름이 `alarmops-customer`가 아니면 `--stack-name`을 줘도 거부한다.

## 테스트로 검증하지 않는 수용 기준 (사람 몫)

B·C 계정 태그 흐름, untag 후 NEEDS_REVIEW와 STOP_MONITORING, 허용 목록 대조군(FailedInvocations), OFFBOARDING 뒤 잔여 리소스. 실계정이 필요하다.

## 문서 수용 기준

`docs/GO-LIVE.md`에서 "태그를 떼"가 들어간 문장은 D-16대로 "알람은 남고 콘솔이 확인 필요(NEEDS_REVIEW)로 표시"한다고 쓴다. `GoLiveDoc` 테스트가 검사한다. 현재 6단계의 문장은 아직 옛 표현이라 이 테스트는 구현 PR에서 문서를 고칠 때까지 실패한다.

## 플랫폼

가짜 aws 래퍼는 Python 경로를 슬래시로 바꿔 인용해서 쓴다. 로그 권한 검사는 Windows에서 Git Bash `stat`을 쓴다. Windows(Git Bash) 실행은 이 PR을 작성한 환경에서 확인하지 못했다. Windows PC에서 한 번 돌려 결과를 PR에 남긴다.
