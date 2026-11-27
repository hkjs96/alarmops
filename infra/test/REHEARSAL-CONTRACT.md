# 리허설 하네스 계약 (#122)

`infra/scripts/rehearsal/*.sh` 구현자는 구현 전에 이 문서와 `infra/test/rehearsal_support.py`, `infra/test/test_rehearsal_harness.py`를 읽는다.
이슈 수용 기준에는 없는 형식(플래그 이름, 환경변수, 결과표 문자열)은 이 문서가 정한다. 테스트는 이 문서를 따른다. 다른 형식이 필요하면 이 문서와 테스트를 같은 PR에서 함께 고친다.

실행: 저장소 루트에서 `python -m unittest discover -s infra/test`. 가짜 `aws`(`infra/test/fake_aws.py`)가 PATH 맨 앞에 놓이고 모든 호출을 기록한다. 실제 AWS에는 접속하지 않는다.

가짜 aws의 `--query`는 JMESPath 축소 구현(`a.b`, `a[].b`, `a[*].b`, `a[0]`, 평평한 멀티셀렉트 `[a.b,c.d]`)이다. 그 밖의 식(필터·파이프·함수)은 가짜 aws가 종료 코드 97로 끝나고 테스트가 실패한다. 스크립트는 이 부분집합 안에서 `--query`를 쓰거나, 필터는 응답을 받아 셸·python에서 처리한다. 설치된 jmespath 유무로 판정이 달라지지 않는다.

## 스크립트와 플래그

| 스크립트 | 플래그 |
|---|---|
| `common.sh` | 다른 스크립트가 source한다. 단독 실행 대상 아님 |
| `preflight.sh` | `--profile NAME` (필수). 쓰기 호출 없음 |
| `install.sh` | `--profile`, `--confirm-account 12자리` |
| `verify.sh` | `--profile`, `--confirm-account`, `--run-id ID` (생략 시 시각 기반 기본값) |
| `replica-check.sh` | `--profile`, `--confirm-account`, `--cleanup-only` (#159). 테스트: `test_replica_check.py`. 가짜 aws 의 `iam_roles` 시나리오가 IAM·STS·CloudWatch 상태 모델을 켠다. 환경변수 `REHEARSAL_ASSUME_RETRIES`·`REHEARSAL_ASSUME_INTERVAL`(테스트는 3·0) |
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

프로필이 표에 없거나 표 파일이 없으면 거부한다. 확인 계정이 `centralRoleArn`·`centralEventBusArn`의 계정과 같아도 5개 스크립트(preflight·install·verify·cleanup·replica-check) 모두 거부한다.

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

## replica-check.sh (#159)

- 스크립트 수는 `common.sh` 제외 5개다. 그중 `replica-check.sh`만 runId가 없다. 로그는 `<REHEARSAL_LOG_DIR>/<profile>/replica-check.md`(고정 이름, 권한 600). `--cleanup-only`는 같은 파일에 이어 쓴다.
- 환경변수 거부 목록은 공통(`rh_env_check`)에 `replica-check.sh`만 `AWS_ENDPOINT_URL*`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CA_BUNDLE`를 더한다(기존 verify·install 사용자에게 영향 없음).
- 알람 이름(D-63): 관리 시험 알람 `[AlarmOpsRehearsal] replica-test`와 (g)용 `[AlarmOpsRehearsal] replica-unmanaged-bracket`은 이름이 `[`로 시작한다(AlarmWriter 생성 허용 `alarm:[*`에 닿아야 (b)(e)가 성립). 고객 알람 모양인 `AlarmOpsRehearsal-replica-unmanaged`(`ALARM_U`)는 `[`로 시작하지 않는다((f) 기대값 PASS). 이름에 공백·대괄호가 있어 모든 인자를 따옴표로 감싼다.
- 정리 규칙: 시험 알람 세 개(`[AlarmOpsRehearsal] replica-test`, `AlarmOpsRehearsal-replica-unmanaged`, `[AlarmOpsRehearsal] replica-unmanaged-bracket`)는 고정 이름으로 지운다. 임시 역할 `AlarmOpsRehearsal-WriterReplica`는 태그 `AlarmOpsRehearsal=true`를 확인한 뒤에만(인라인 정책 → 역할 순) 지운다. 태그가 없으면 지우지 않고 실패로 알린다. `cleanup.sh`는 이 역할이 남았으면 경고와 `--cleanup-only` 안내만 하고 직접 지우지 않는다.
- 종료 코드: 전부 PASS 0, FAIL 행 또는 준비·정리 실패 1, 거부 2·3(공통), SSO 프로필 아님 4, 임시 역할이 이미 있음 5.
- 결과표는 (a)~(f) 한 줄씩(`| 항목 | 결과 | 비고 |`)과 정보 행 (g) 한 줄. (g)(`이름이 [ 로 시작하는 태그 없는 알람 덮어쓰기 → 알려진 한계(D-63)`)는 결과 칸이 `정보`이고 PASS·FAIL로 세지 않으며 종료 코드에 영향이 없다(ALLOWED가 예상, 준비 실패도 FAIL 아님).
- 결과표 세부: 비고는 PASS 행에서는 대개 오류 코드(`AccessDenied`)나 "성공"이다. 하지만 (b) PASS("성공, list-tags 에서 ManagedBy=AlarmOps 확인")와 (f) FAIL("기존 고객 알람 덮어쓰기 가능: ... (임계값, 태그)")은 문장이고, 준비 단계 실패 때는 `(준비) 복제 역할 assume`, `(준비) 정책 전파(DescribeAlarms)` 행이 나올 수 있으며 (c)(d)에 "준비 실패: ..." 문장이 들어갈 수 있다. 판정 순서는 (a) (b) (f) (c) (d) (e)이고 표는 (a)~(f) 순으로 낸다. 비고에는 오류 코드와 알람 설정 사실만 쓰고 자격증명·메시지 본문은 쓰지 않는다.
- 실측 모드 `--probe-resource-tag-deny`(replica-check 전용 선택 인자): (a)~(f) 표를 돌리지 않고 대신 쓴다. 변형 `null`(`Null aws:ResourceTag/ManagedBy=true`)·`stringnotequals`(`StringNotEquals aws:ResourceTag/ManagedBy=AlarmOps`)마다 복제 역할에 별도 인라인 정책 `probe-deny`(Sid `DenyOverwriteUnmanaged`, 원본 정책은 그대로)를 붙인다.
  - 시작: probe 알람 이름 전부를 본인 자격증명으로 먼저 지운다(전용 접두어 `[AlarmOpsRehearsal] probe-`, 이름이 `[`로 시작해야 생성 허용이 닿는다). 태그 없이 만든 알람에 `ManagedBy` 태그가 있으면 준비 실패(종료 코드 1). 일반 모드의 `ALARM_T`·`ALARM_U`·`ALARM_V` 는 따로 지운다.
  - 변형마다: 앞 `probe-deny` 삭제(없으면 건너뜀) → (두 번째 변형부터 `REHEARSAL_PROBE_WAIT`초 대기, 기본 20, 테스트 0, 재-assume) → 카나리 A(Deny 없는 상태에서 태그 없는 `-canary` 덮어쓰기가 ALLOWED 여야 함. 아니면 `오류: 카나리 실패`, 종료 코드 1) → 준비(`-unmanaged` 태그 없음, `-other` 는 `ManagedBy=Other`) → 변형 부착·대기·재-assume → 카나리 B(`-other` 덮어쓰기: `null` 은 ALLOWED, `stringnotequals` 는 DENIED 를 기대. 기대값은 변형마다 계산하며 다르면 p2 `불안정`).
  - 측정: p1 새 알람 생성(`--tags ManagedBy=AlarmOps`), p2 `-unmanaged` 를 ManagedBy 요청 태그로 덮어쓰기(`REHEARSAL_PROBE_WAIT` 간격 두 번, 이후 본인 자격증명으로 임계값 확인), p3 p1 알람을 태그 없이 임계값만 수정, p4 p1 알람 삭제. p1 이 거부되면 본인 자격증명이 태그 달린 알람을 대신 만들어 p3·p4 를 재고 값 뒤에 `*`.
  - 셀 값(실제 출력, 메시지 없음): `ALLOWED`, `ALLOWED (임계값 1→2 변경됨)`(또는 `임계값 1 그대로`·`조회 실패`·`알람 없음`), `DENIED`, `DENIED (확인 필요: 임계값 …)`(거부 응답인데 임계값이 바뀜·조회 실패: 판정을 믿지 않고 재측정), `ERROR(코드)`, `ERROR(준비 실패)`(p1 거부 뒤 대체 알람 준비 실패), 값 뒤 `*`, `불안정`(p2 두 번의 결과가 다르거나 카나리 B 불일치). 각 값의 뜻·할 일은 `docs/GO-LIVE.md` 4단계 표. 카나리 불일치·p2 불일치는 표 아래에 사유 줄이 붙는다.
  - 표 `| 변형 | p1 새 알람 생성 | p2 태그없는 알람 덮어쓰기 | p3 관리 알람 수정 | p4 관리 알람 삭제 | 판정 |`. 판정 "사용 가능"은 p1 ALLOWED·p2 정확히 `DENIED`·p3 ALLOWED·p4 ALLOWED 일 때만, `불안정`이면 "재측정", 그 밖은 "사용 불가".
  - 종료 코드: 표를 끝까지 내면 판정과 무관하게 0. 준비 실패·카나리 실패·assume 실패 등 중단은 1(표는 앞 변형 행까지만 나올 수 있음), 안전 관문 거부 2 이상, 역할 이미 있음 5.
  - 정리: 일반 실행은 기존 두 알람만 지운다. 실측 모드와 `--cleanup-only` 는 추가로 probe 알람 8개(변형 2 × new·unmanaged·canary·other)와 `probe-deny` 정책(없으면 건너뜀)을 지운다. 템플릿은 바꾸지 않는다.
- 가짜 aws 추가 키: `cw_person_put_tags`·`iam_stale_probe_deny`·`cw_ignore_deny_first_n_puts`(전파 지연·옛 정책·오염 흉내), `cw_update_ignores_tags`(기존 알람 갱신은 요청 태그를 무시, 실제 CloudWatch 동작), `cw_create_resource_tags`(`request` = 새 알람의 `aws:ResourceTag` 를 요청 태그로 평가, 그 밖 = 비어 있음), `cw_ignore_deny_sid`. 조건 연산자 `StringNotEquals`(없는 키는 true)·`Null` 을 모델링한다. 테스트: `infra/test/test_replica_probe.py`.
- 임시 자격증명은 서브셸 안에서만 쓰고 출력·로그에 쓰지 않는다. 모든 출력은 `common.sh`의 `rh_mask`(ExternalId + 자격증명 모양)를 거친다.
- 가짜 aws: 시나리오 키 `iam_roles`(역할별 `path`·`boundary`·`policies`·`tags`), `caller_arn`, `assume_crlf`, `assume_fail_first`, `cw_overwrite_unmanaged_denied`, `sleep_ops`. 상태는 `$FAKE_AWS_LOG.state`에 둔다.
- 테스트: `infra/test/test_replica_check.py`.
