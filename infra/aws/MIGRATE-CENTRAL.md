# 중앙 계정 옮기기 (D-58)

중앙 AWS 계정을 다른 계정으로 옮기는 절차다. 새 계정은 Control Tower(CT) 계정이어도 되고 일반 계정이어도 된다.

- 고객은 스택을 **다시 설치하지 않는다.** 스택을 **업데이트**하고 파라미터만 바꾼다.
- ExternalId는 그대로 쓴다. 고객 쪽 역할 ARN도 바뀌지 않는다.
- 사람이 한다. AWS 콘솔과 본인 터미널 작업은 SSO·MFA로 한다. 에이전트에게 시키지 않는다.
- 이 문서는 새 중앙도 서울(`ap-northeast-2`)·상용 파티션(`aws`)이라고 본다. 아니면 5절의 "후속"이 먼저다.
- 참조: `docs/GO-LIVE.md` 4단계, `infra/aws/deploy-role-policy.md`, `infra/aws/README.md`, `infra/customer-stack/README.md`

## 한눈에 보기

| 순서 | 하는 일 | 절 |
|---|---|---|
| 1 | 새 중앙 계정 준비 | 1 |
| 2 | 새 중앙 배포 | 2-1 |
| 3 | 새 버스 허용 목록에 고객 계정 추가 | 2-2 |
| 4 | 고객이 스택 업데이트 | 2-3, 3 |
| 5 | 확인 (Vercel 변수·DB 포함) | 2-4, 4 |
| 6 | 옛 허용 목록에서 고객 제거 | 2-5 |
| 7 | 옛 중앙 내림 | 2-6 |
| - | 문제가 생기면 되돌리기 | 6 |

## 1. 새 중앙 계정 준비 체크리스트

값은 옛 계정에서 복사하지 않는다. 계정 ID가 들어간 값(ARN, URL)은 모두 새로 만든다. 새 값은 적어 둔다. 비밀은 적지 않는다.

- [ ] **버스 스택**
  - 어디서: 새 계정 AWS 콘솔(서울) → CloudFormation → 스택 만들기
  - 누를 것: `infra/aws/central-bus.yaml`을 스택 이름 `alarmops-central-bus`로 올린다. `BusName`은 기본값, `AllowedAccountIds`는 **비워 둔다**.
  - 확인: 생성 완료. 출력에 `CentralBusArn`, `BusName`이 있다.
  - 참조: `docs/GO-LIVE.md` 4-1 "버스 스택"
- [ ] **GitHub OIDC 공급자**
  - 어디서: IAM → 자격 증명 공급자 → OpenID Connect
  - 누를 것: URL `https://token.actions.githubusercontent.com`, 대상 `sts.amazonaws.com`
  - 확인: 목록에 보인다.
- [ ] **Vercel OIDC 공급자**
  - 어디서: Vercel 프로젝트 Settings → Security → OIDC federation(발급자 모드 **Global** 또는 **Team**)과 같은 IAM 화면
  - 누를 것: URL `https://oidc.vercel.com`, 대상 `https://vercel.com/<팀 슬러그>`
  - Team 방식이면 URL을 `https://oidc.vercel.com/<팀 슬러그>`로 한다.
  - 확인: 공급자 ARN(`arn:aws:iam::<새 계정 ID>:oidc-provider/oidc.vercel.com` 또는 `.../oidc.vercel.com/<팀 슬러그>`)을 적어 둔다.
- [ ] **권한 경계 정책**
  - 어디서: IAM → 정책 → 정책 만들기
  - 누를 것: `infra/aws/deploy-role-policy.md`의 권한 경계 정책 JSON. **배포 역할보다 먼저** 만든다.
  - 확인: 이름이 중앙 스택 파라미터 `PermissionsBoundaryName`과 같다.
- [ ] **배포 역할 2개**
  - 어디서: IAM → 역할 → 웹 ID
  - 누를 것: `infra/aws/deploy-role-policy.md`대로 만든다.
    - 중앙 배포 역할: 신뢰 `sub` = `repo:<GITHUB_REPO_SUBJECT>:environment:central`(`deploy-role-policy.md` 1절의 불변 ID 형식)
    - `AlarmOpsDeployBus`: 신뢰 `sub` = `repo:<GITHUB_REPO_SUBJECT>:environment:central-bus`
  - 확인: 두 ARN을 적어 둔다. 신뢰 정책의 공급자 ARN이 **새 계정** 것이다. 와일드카드가 없다.
- [ ] **SAM 아티팩트 버킷**
  - 어디서: S3 → 버킷 만들기(서울)
  - 누를 것: 새 버킷을 만든다. 옛 버킷을 재사용하지 않는다.
  - 확인: 중앙 배포 역할 정책이 이 버킷을 가리킨다. (`infra/aws/deploy-role-policy.md` 5번의 6단계)
- [ ] **Lambda 동시 실행 한도**
  - 어디서: Service Quotas
  - 누를 것: Lambda 동시 실행 한도 상향 요청
  - 확인: 140 이상. 승인 전에는 배포하지 않는다.
- [ ] **GitHub 환경 변수**
  - 어디서: GitHub → Settings → Environments. 환경 `central`, `central-bus`는 이미 있다. 새로 만들지 않는다.
  - 누를 것: 아래 값을 새 값으로 바꾼다.

    | 환경 | 변수 | 새 값 |
    |---|---|---|
    | `central` | `CENTRAL_DEPLOY_ROLE_ARN` | 새 중앙 배포 역할 ARN |
    | `central` | `VERCEL_OIDC_PROVIDER_ARN` | 새 Vercel 공급자 ARN |
    | `central` | `SAM_ARTIFACT_BUCKET` | 새 버킷 이름 |
    | `central` | `SES_IDENTITY_ARN`, `ALARM_TOPIC_ARN` | 새 계정 값(쓸 때만) |
    | `central-bus` | `CENTRAL_BUS_DEPLOY_ROLE_ARN` | 새 `AlarmOpsDeployBus` ARN |

  - 확인: `VERCEL_TEAM_SLUG`, `VERCEL_PROJECT_NAME`은 그대로다. 옛 계정의 ARN이 남지 않았다.
  - 주의: 바꾸는 순간 `deploy-central`과 `bus-allowlist`는 새 계정만 가리킨다. 옛 버스에서 고객을 제거할 때(2-5)의 주의를 본다.
  - 참조: `docs/GO-LIVE.md` 4-2
- [ ] **비밀(값 재사용 금지)**
  - 어디서: 배포 뒤 새 계정 Secrets Manager
  - 누를 것: 새 비밀 `EngineDbSecret`, `IngestDbSecret`에 새 값을 넣는다. 수집 웹훅 토큰 등 다른 비밀도 새로 만든다. 옛 계정에서 값을 복사하지 않는다.
  - 확인: 옛 값과 새 값이 다르다.
- [ ] **DB 사용자(D-56)**
  - 어디서: Supabase SQL 편집기, `db/sql/roles.sql`
  - 누를 것: 엔진용·수집용 DB 사용자를 **새 이름과 새 비밀번호로 따로 만든다**(예 `alarmops_engine_2`). 옛 사용자는 옛 중앙이 내려갈 때까지 그대로 둔다. 새 사용자의 연결 주소를 새 비밀에 넣는다.
  - 확인: 새 엔진이 DB를 읽는다. 옛 중앙을 내린(2-6) 뒤 옛 DB 사용자를 지운다.
  - 참조: `docs/SETUP-PROD-DB.md` 6~7단계, `docs/GO-LIVE.md` 4-4

## 2. 전환 순서

옛 중앙과 새 중앙이 한동안 같이 떠 있다. 둘은 같은 DB를 읽는다. 고객 한 곳은 한 시점에 한 버스에만 이벤트를 보낸다.

### 2-1. 새 중앙을 배포한다

- 어디서: GitHub → Actions → `deploy-central`(브랜치 `main`)
- 누를 것: `plan`의 IAM 변경 표를 읽고 승인, `apply` 승인
- 확인: 출력표 `alarmops-central outputs`에 `CentralRoleArn`, `CentralBusArn`, `AlarmCommandsQueueUrl`, `VercelConsoleRoleArn`, `CentralAccountId`가 있다. 값을 적어 둔다.
- 유실 구간: 없다. 고객은 아직 옛 중앙으로 보낸다.

### 2-2. 새 버스 허용 목록에 고객 계정을 추가한다

- 어디서: Actions → `bus-allowlist`(브랜치 `main`). 이때 변수는 새 계정을 가리킨다.
- 누를 것: `action`을 `add`로 바꾼다(첫 값이 `remove`다). `account_id`, `reference`, `confirm`을 넣고 `central-bus` 승인. 고객마다 한 번씩.
- 확인: 요약의 `accounts allowed now`가 늘었다. 워크플로가 초록색이다.
- 유실 구간: 없다. 이 단계는 **고객 업데이트(2-3)보다 먼저** 한다. 허용 전에 새 버스로 가는 이벤트는 버스가 거절한다.

### 2-3. 고객이 스택을 업데이트한다

- 어디서: 고객 AWS 콘솔의 CloudFormation. 절차와 안내문은 3절.
- 누를 것: 고객에게 새 `CentralRoleArn`, 새 `CentralEventBusArn`(Remediator를 켠 고객은 `RemediatorCallerRoleArn`도)을 보낸다. 고객 한 곳씩, 업무 시간에 한다.
- 확인: 고객이 완료를 알린다. 3-3의 확인을 한다.
- 유실 구간:
  - 업데이트하는 몇 분 동안 알람 상태 변화·태그 변경 이벤트가 어느 버스로도 안 갈 수 있다.
  - 고객 역할 신뢰가 새 중앙으로 바뀐 순간부터 **옛 중앙은 그 고객 계정을 조회할 수 없다.** 옛 엔진의 그 고객 동기화는 실패한다.
- 대응:
  - 중복은 걱정하지 않는다. 같은 이벤트·명령은 한 번만 처리한다(명령은 `commandId`로 한 번만 처리, `docs/decisions/DECISIONS.md` 참조).
  - 놓친 태그 변경은 **시간별 태그 정합 런**(`mode=tag_reconcile`, `docs/specs/alarm-sync.md`)이 한 시간 안에 메운다.
  - 알람 상태 변화는 바뀔 때만 이벤트가 나간다. 업데이트 중에 바뀐 알람은 이벤트를 놓칠 수 있고 정합 런이 못 메울 수 있다. 업데이트 직후 그 고객의 알람 목록을 콘솔에서 한 번 확인한다.

### 2-4. 확인한다

- 어디서: 콘솔, 새 계정 CloudWatch 로그
- 누를 것: 3-3의 확인을 고객마다 한다. 이어서 4절의 Vercel 변수와 DB 확인을 한다.
- 확인:
  - 새 계정 `ingest-eventbridge` 로그에 고객 이벤트가 온다.
  - 콘솔 "연결 확인"이 성공한다(새 엔진이 `AssumeRole`).
  - 옛 버스에는 그 고객 이벤트가 더 이상 오지 않는다.
- 유실 구간: Vercel 변수를 바꾸는 배포 중에 일부 명령이 옛 큐로 갈 수 있다. 옛 엔진이 아직 있으므로 처리된다. 옛 중앙은 큐가 빌 때까지 둔다.
- 이 확인은 최소 하루 둔다. 시간별 정합 런이 여러 번 도는 것을 본다.

### 2-5. 옛 허용 목록에서 고객을 제거한다

- 어디서: Actions → `bus-allowlist`
- 누를 것: `action=remove`, `account_id`, `reference`, `confirm`, `central-bus` 승인. 고객마다 한 번씩.
- 확인: 요약에서 계정이 사라졌다. 워크플로가 정책에서 계정이 없음을 직접 확인한다.
- **주의** 워크플로는 `CENTRAL_BUS_DEPLOY_ROLE_ARN`이 가리키는 계정의 버스를 바꾼다. 1에서 새 값으로 바꿨으므로, 옛 버스를 고치려면 변수를 잠시 옛 `AlarmOpsDeployBus` ARN으로 되돌렸다가 끝나면 새 값으로 되돌린다. 또는 옛 계정에서 사람이 콘솔로 `alarmops-central-bus`의 `AllowedAccountIds`에서 계정을 뺀다.
- 유실 구간: 업데이트를 놓친 고객이 있으면 그 고객 이벤트가 거절된다. 제거 전에 2-4에서 모든 고객을 확인한다.

### 2-6. 옛 중앙을 내린다

- 어디서: 옛 계정 CloudFormation(사람, SSO·MFA)
- 누를 것: 옛 큐와 DLQ가 비었는지 본다. 비었으면 `alarmops-central`, 이어서 `alarmops-central-bus`를 삭제한다. 옛 비밀은 삭제 예약(7일 이상)으로 둔다.
- 확인: 스택 삭제 완료. 옛 큐에 남은 메시지가 없었다.
- 유실 구간: 옛 큐에 남은 메시지. 비운 뒤에 내리면 없다.
- 정리: 옛 계정의 GitHub OIDC 공급자, 배포 역할 2개, 경계 정책, SAM 버킷, 옛 DB 사용자를 지운다. 옛 CloudTrail 기록은 지우기 전에 보관한다.

## 3. 고객 스택 업데이트 절차

### 3-1. 파라미터

이름은 `infra/customer-stack/template.yaml`에서 확인했다.

| 파라미터 | 바꾸는가 | 새 값 |
|---|---|---|
| `CentralRoleArn` | **바꾼다** | 새 중앙 출력 `CentralRoleArn` |
| `CentralEventBusArn` | **바꾼다** | 새 중앙 출력 `CentralBusArn` |
| `RemediatorCallerRoleArn` | `EnableRemediator=true`인 고객만 바꾼다 | 새 중앙 출력 `RemediatorCallerRoleArn` |
| `ExternalId` | **유지** | 바꾸지 않는다 |
| `EnableAlarmWriter`, `EnableTagWriter`, `EnableRemediator`, `AlarmScope`, `PermissionsBoundaryArn` | 유지 | 그대로 |

> **참고** `RemediatorCallerRoleArn`도 중앙 계정의 역할이라 계정 ID가 바뀐다. D-58은 두 파라미터만 말한다. Remediator를 켠 고객은 세 개를 바꾼다. 안 바꾸면 `AlarmOps-Remediator`가 옛 중앙을 계속 신뢰한다(후속 5).

### 3-2. 업데이트하기

- 어디서: 고객 AWS 콘솔 → 서울 리전 → CloudFormation → 연결 스택
- 누를 것:
  1. 스택을 골라 **업데이트**를 누른다.
  2. **"현재 템플릿 사용"**을 고른다.
  3. 파라미터 화면에서 `CentralRoleArn`, `CentralEventBusArn`(해당하면 `RemediatorCallerRoleArn`)만 바꾼다. `ExternalId`와 나머지는 손대지 않는다.
  4. 마지막 화면에서 IAM 리소스 생성 확인란에 체크하고 제출한다.
- 확인: 상태가 `UPDATE_COMPLETE`. 출력 `ReaderRoleArn`, `EventForwarderRoleArn` 등이 업데이트 전과 같다. 변경 세트를 볼 수 있으면 역할 신뢰 정책, 규칙 대상, 포워더 정책만 바뀌고 **교체(Replacement)가 없어야** 한다. 교체가 있으면 멈추고 허브에 묻는다. 역할 ARN이 바뀌면 DB 값이 틀려진다.

### 3-3. 업데이트 전후 확인

업데이트 전:
- [ ] 새 버스 허용 목록에 이 고객 계정이 있다(2-2).
- [ ] 콘솔 연결 상태가 정상이다(옛 중앙 기준).
- [ ] 고객 스택의 `ExternalId`가 콘솔의 값과 같다. 값을 채팅·이슈에 붙이지 않는다. 두 화면을 나란히 본다.

업데이트 후:
- [ ] 스택 `UPDATE_COMPLETE`, 역할 ARN 출력이 전과 같다.
- [ ] 고객 IAM에서 `AlarmOps-Reader` 신뢰 정책의 `Principal`이 새 중앙 역할 ARN이다.
- [ ] 콘솔 "연결 확인"이 성공한다.
- [ ] 고객 계정에서 `Monitoring` 태그를 한 번 바꾸면 새 계정 `ingest-eventbridge` 로그에 이벤트가 온다.
- [ ] 같은 이벤트가 옛 계정 로그에는 없다.

### 3-4. 고객 안내문 (템플릿)

```
제목: [AlarmOps] 연결 스택 업데이트 요청 (약 10분, 재설치 아님)

안녕하세요. 저희 쪽 AlarmOps 연결 계정이 바뀝니다.
고객님 계정의 스택을 다시 만들 필요는 없습니다. 기존 스택에서 값만 바꾸면 됩니다.

언제: <날짜·시간> (약 10분)
어디서: AWS 콘솔 → 서울 리전 → CloudFormation → 스택 <스택 이름>

1. 스택을 고르고 "업데이트"를 누릅니다.
2. "현재 템플릿 사용"을 고르고 다음으로 갑니다.
3. 아래 값만 바꿉니다. 다른 값(특히 ExternalId)은 그대로 둡니다.
   - CentralRoleArn     : <새 값>
   - CentralEventBusArn : <새 값>
   - (Remediator를 켠 경우만) RemediatorCallerRoleArn : <새 값>
4. 마지막 화면에서 IAM 리소스 생성 확인란에 체크하고 제출합니다.
5. 상태가 UPDATE_COMPLETE가 되면 알려 주세요.

바뀌는 것: 고객님 계정의 역할을 맡는 저희 쪽 주체, 이벤트를 받는 주소.
안 바뀌는 것: 역할 이름·권한, ExternalId, 켜 둔 기능.
업데이트하는 몇 분 동안 알람 이벤트가 전달되지 않을 수 있습니다. 저희가 나중에 다시 맞춥니다.
문제가 생기면 같은 화면에서 이전 값으로 되돌릴 수 있습니다.

문의: <담당자>
```

## 4. 콘솔과 DB에서 바꿀 것

### 4-1. Vercel 변수 (Production)

- 어디서: Vercel 프로젝트 Settings → Environment Variables(Production). 모두 일반 변수다.
- 누를 것: 아래 값을 새 출력값으로 바꾸고 `deploy-console`을 실행해 승인한다(새 값은 새 배포부터 쓰인다).

| 변수 | 새 값 | 출력 이름 |
|---|---|---|
| `CENTRAL_ROLE_ARN` | 새 중앙 역할 ARN | `CentralRoleArn` |
| `CENTRAL_EVENT_BUS_ARN` | 새 버스 ARN | `CentralBusArn` |
| `REMEDIATOR_CALLER_ROLE_ARN` | 새 값(Remediator 고객이 있을 때만) | `RemediatorCallerRoleArn` |
| `ALARM_COMMANDS_QUEUE_URL` | 새 명령 큐 URL | `AlarmCommandsQueueUrl` |
| `ALARM_COMMANDS_EXPECTED_ACCOUNT` | 새 계정 ID 12자리 | `CentralAccountId` |
| `AWS_ROLE_ARN` | 새 Vercel 콘솔 역할 ARN | `VercelConsoleRoleArn` |

- **`ALARM_COMMANDS_QUEUE_URL`, `ALARM_COMMANDS_EXPECTED_ACCOUNT`, `AWS_ROLE_ARN` 셋은 한꺼번에 바꾼다.** URL의 계정이 `EXPECTED_ACCOUNT`와 다르면 시작 때 오류가 난다(`packages/api/src/sqsCommandPublisher.ts`). `AWS_ROLE_ARN`이 옛 값이면 새 큐에 보낼 권한이 없다.
- `CENTRAL_ROLE_ARN`, `CENTRAL_EVENT_BUS_ARN`, `REMEDIATOR_CALLER_ROLE_ARN`은 **새로 연결하는 고객의 안내 키트**에 쓰인다(`apps/console/src/lib/server/central.ts`). 기존 고객에게는 3절로 직접 알린다.
- 시점: 2-4. 모든 고객이 업데이트한 뒤 바꾼다. 먼저 바꾸면 새 명령이 새 큐로 가는데 새 엔진이 그 고객 역할을 아직 못 맡을 수 있다.
- 확인: 배포 뒤 콘솔에서 명령 하나(예 동기화)를 보내 새 큐 메시지가 처리되는 것을 새 엔진 로그에서 본다. 503 `COMMANDS_UNAVAILABLE`이면 위 셋 중 빠진 값이 있다.
- `AWS_ROLE_ARN`은 Vercel 런타임에만 둔다(회사 PC `.env`, CI, 에이전트 세션 금지).

### 4-2. DB에 저장된 고객 역할 ARN

코드를 grep으로 확인한 결과, **바꿀 것이 없다.**

- DB `CloudAccount`의 `readerRoleArn`, `eventForwarderRoleArn`, `alarmWriterRoleArn`, `tagWriterRoleArn`, `remediatorRoleArn`은 **고객 계정의 역할**(`arn:aws:iam::<고객 계정>:role/AlarmOps-*`)이다. 중앙을 옮겨도 그대로다.
- 엔진은 이 값을 읽어 `AssumeRole`한다(`services/alarm-engine/src/alarm_engine/pg_repository.py`, `aws.py`). 중앙 역할 ARN은 DB에 없다. 엔진은 자기 Lambda 자격증명으로 맡는다.
- `ExternalId`도 DB에 있고 그대로 쓴다.
- 고객 스택을 업데이트해도 역할 이름이 안 바뀐다(3-2에서 교체 없음을 확인).
- 확인: `grep -rn "CENTRAL_ROLE_ARN\|CENTRAL_EVENT_BUS_ARN" services packages db`에 결과가 없다. 중앙 값은 환경변수로만 읽힌다(`apps/console/src/lib/server/central.ts`).

## 5. 하드코딩 점검 결과

범위: `infra/`, `services/`, `packages/api/src`, `.github/`. 방법: 12자리 숫자, `ap-northeast-2`, `us-east-1`, `arn:aws:`, `"aws"`를 grep했다. 테스트 파일은 뺐다. 콘솔 두 곳은 범위 밖이지만 같은 문제라 적었다.

| 위치 | 하드코딩 | 옮길 때 영향 | 후속 |
|---|---|---|---|
| `packages/api/src/onboardingApi.ts` 113행 `roleArn()` | 파티션 `aws` 고정(`arn:aws:iam::<계정>:role/...`) | 상용 파티션 안에서는 없다. 다른 파티션(GovCloud·중국) 고객이면 틀린 ARN이 DB에 저장된다 | 1 |
| `packages/api/src/sqsCommandPublisher.ts` 7·8행 | 리전 `ap-northeast-2`, 큐 URL 정규식이 `sqs.ap-northeast-2.amazonaws.com` 고정 | 서울 안에서는 없다. 다른 리전이면 시작 때 오류 | 2 |
| `infra/customer-stack/template.yaml` 35행 | `CentralEventBusArn` 패턴이 `events:ap-northeast-2` 고정(파티션은 `aws[a-z-]*`로 열려 있음) | 새 버스가 서울이면 없다. 다른 리전이면 템플릿 수정이 필요해 "파라미터만 업데이트"가 깨진다 | 2 |
| `apps/console/src/lib/server/central.ts` 4·5행 (범위 밖) | `ROLE_RE`가 `arn:aws:iam::`, `BUS_RE`가 `ap-northeast-2` 고정 | 새 값이 안 맞으면 키트에서 값이 빠진다. 상용·서울이면 없다 | 2, 3 |
| `apps/console/src/lib/server/sqs-client.ts` 22행 (범위 밖) | SQS 클라이언트 리전 `ap-northeast-2` | 다른 리전이면 큐와 어긋난다 | 2 |
| `packages/api/src/memoryRepo.ts` 384·385행 | `arn:aws:iam::`, 기본 리전 | 시험용 메모리 저장소. 영향 없다 | - |
| `infra/customer-stack/template.yaml` 25·51행 | 설명문 예시의 `arn:aws:...`, 계정 ID | 설명일 뿐 | - |
| `services/ingest/src/lambda/runtime.ts` 39행, `services/alarm-engine/.../wiring.py` 52·79행 | `AWS_REGION`이 없을 때 `ap-northeast-2` | Lambda에는 항상 `AWS_REGION`이 있다 | - |
| `services/alarm-engine/.../pg_repository.py` 90행, `aws.py` 86행, `dimensions.py` 31행 | 고객 계정의 `regions`가 비면 `ap-northeast-2` | 고객 리소스 리전 기본값이다. 중앙 위치와 무관 | - |
| `services/alarm-engine/.../resource_types/cloudfront.py`·`route53.py`·`waf.py`, `collectors/groups.py` 408행, `offboard.py` 33행, `handler.py` 147행 | `us-east-1` | CloudFront·Route 53 같은 글로벌 서비스의 지표 리전이다. 중앙 위치와 무관 | 정상 |
| `services/alarm-engine/.../collectors/core.py` 75행 `partition_of()` | 고객 Reader 역할 ARN에서 파티션을 읽고, 없을 때만 `aws` | 좋은 방식이다. 영향 없다 | 정상 |
| `.github/workflows/deploy-central.yml` 49행, `bus-allowlist.yml` 49행 | `AWS_REGION: ap-northeast-2` | 서울 안에서는 없다. 계정 ID는 없다(ARN은 환경 변수) | 정상 |
| `infra/aws/central.yaml`, `central-bus.yaml` | 계정 ID·리전·파티션 없음. `AWS::Partition`, `AWS::AccountId` 사용 | 영향 없다 | 정상 |
| `infra/aws/deploy-role-policy.md` | `<ACCOUNT_ID>`, `<REGION>`, `<PARTITION>` 자리표시자 | 새 계정 값으로 채운다(1절) | 정상 |

결론: 서울 리전·상용 파티션 안에서 계정만 옮기면 코드를 고치지 않아도 된다. 계정 ID 하드코딩은 찾지 못했다(테스트 제외).

### 후속

코드는 이 이슈에서 고치지 않는다. 필요하면 이슈를 따로 만든다.

1. (backend) `roleArn()`이 파티션을 고정한다. 고객 계정의 파티션을 받거나 설정에서 읽게 한다. 지금은 상용 파티션 고객만 받으므로 급하지 않다.
2. (backend, console, infra) 리전을 `ap-northeast-2`로 고정한 곳이 넷이다(큐 URL 정규식, 콘솔 SQS 클라이언트, 콘솔 `BUS_RE`, 고객 스택의 `CentralEventBusArn` 패턴). 서울 밖으로 옮길 계획이 생기면 같이 푼다. 고객 스택 패턴을 먼저 풀어 두어야 "파라미터만 업데이트"가 유지된다.
3. (console) `central.ts`의 `ROLE_RE`·`BUS_RE`가 파티션 `aws`를 고정한다. 고객 스택 템플릿처럼 `aws[a-z-]*`로 맞춘다.
4. (infra) `bus-allowlist`는 `CENTRAL_BUS_DEPLOY_ROLE_ARN`이 가리키는 한 계정의 버스만 바꾼다. 옛 버스에서 제거하려면 변수를 되돌려야 한다(2-5). 필요하면 대상을 고르는 입력을 만든다.
5. (허브) D-58은 파라미터를 둘만 적었다. Remediator를 켠 고객은 `RemediatorCallerRoleArn`까지 셋이다(3-1). D-58 문구 보강 여부를 정한다.

## 6. 되돌리기

**옛 중앙은 2-6 전까지 내리지 않는다.** 그러면 아래가 모두 가능하다.

| 상황 | 되돌리는 법 | 확인 |
|---|---|---|
| 새 중앙 배포 실패(2-1) | 새 계정 스택을 지우고 다시 한다. 고객은 영향이 없다 | 옛 중앙이 정상 |
| 고객 한 곳의 업데이트가 실패하거나 이벤트가 안 온다(2-3) | 같은 절차(3-2)로 `CentralRoleArn`, `CentralEventBusArn`(해당하면 `RemediatorCallerRoleArn`)을 **옛 값**으로 업데이트한다. 옛 허용 목록에 이 고객이 아직 있다. `ExternalId`는 그대로다 | 옛 버스에 이벤트가 오고 옛 엔진이 `AssumeRole`한다 |
| CloudFormation이 자동 롤백했다 | `UPDATE_ROLLBACK_COMPLETE`면 고객은 옛 값 그대로다. `UPDATE_ROLLBACK_FAILED`면 "롤백 계속"을 누르고, 안 되면 허브에 묻는다 | 신뢰 정책이 옛 값 |
| Vercel 변수 교체 뒤 명령이 실패(2-4) | 4-1의 변수를 옛 값으로 되돌리고 `deploy-console`을 다시 실행한다. 옛 큐가 살아 있어야 한다 | 시험 명령이 옛 큐에서 처리된다 |
| 새 중앙을 못 쓰겠다 | 모든 고객을 옛 값으로 되돌리고, Vercel 변수를 되돌리고, 새 버스 허용 목록에서 고객을 `remove`한 뒤 새 중앙을 내린다 | 옛 중앙만 쓰인다 |
| 옛 허용 목록에서 이미 제거(2-5)한 뒤 문제 | 옛 버스에 `add`로 고객을 다시 넣고(2-5의 주의), 고객 스택을 옛 값으로 업데이트한다 | 옛 버스에 이벤트가 온다 |
| 옛 중앙을 이미 내린(2-6) 뒤 문제 | 되돌리기 어렵다. 옛 중앙을 다시 올리려면 두 스택 배포, 비밀 입력, 모든 고객 재업데이트가 필요하다. 새 중앙을 고치는 쪽으로 간다 | 그래서 2-4 확인을 길게 한다 |

되돌린 뒤 놓친 태그 변경은 시간별 정합 런이 메운다. 되돌린 고객은 알람 목록을 한 번 확인한다.
