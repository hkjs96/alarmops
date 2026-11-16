# infra/aws — 중앙 계정 인프라

배포는 사람이 시작하는 GitHub Actions(OIDC)로만 한다. 에이전트는 배포 명령을 실행하지 않는다. 이 폴더의 템플릿은 `cfn-lint`와 `infra/test`(구조 테스트)로 오프라인 검증한다.

## 중앙 이벤트 버스와 허용 목록 (B1, D-07, D-43)

`central-bus.yaml`: 이벤트 버스 `alarmops-central`과 버스 리소스 정책. 정책의 Principal은 파라미터 `AllowedAccountIds`(쉼표로 구분한 12자리 계정 ID)이며, 비어 있으면 정책이 만들어지지 않아 고객 계정은 아무도 넣지 못한다. 고객 연결 스택의 `CentralEventBusArn` 파라미터에는 이 스택의 출력 `CentralBusArn`을 준다.

### 목록을 어디에 두는가 — 결정: CloudFormation 스택 파라미터, 변경은 워크플로 한 곳

| 선택지 | 판단 |
|---|---|
| 저장소에 파일로 체크인 | 고객 계정 ID와 고객의 대응이 저장소 기록에 남고, 해지 때 기록에서 지워지지 않는다. 반려 |
| DB 내보내기를 배포 때 읽기 | Actions에 운영 DB 자격증명이 필요하다. D-40·보안 방침과 충돌. 반려 |
| SSM 파라미터 목록 | 정책으로 바꾸는 단계가 하나 더 생기고, 목록과 실제 정책이 어긋날 수 있다. 반려 |
| **스택 파라미터** | 목록이 곧 정책이라 어긋날 수 없고, 스택 이력(CloudTrail)이 변경 기록이 된다. 채택 |

DB가 연결 정보의 원본이고(`CloudAccount`), 버스의 목록은 그 사본이다. 사본을 바꾸는 일은 `.github/workflows/bus-allowlist.yml` 하나만 한다. 계정 하나를 `add`/`remove`로 바꾸며(전체 덮어쓰기 없음), 현재 값을 스택에서 읽어 `.github/scripts/bus-allowlist.mjs`로 새 목록을 계산하고(멱등: 없는 계정 제거도 성공), 이전 템플릿을 그대로 쓰는 `update-stack`으로 이 파라미터만 바꾼다. 끝나면 `describe-event-bus`로 정책에 계정이 없는지(제거) 또는 있는지(추가) 확인한다.

### 연결 때 (add)

고객이 스택을 만들기 전에 사람이 `bus-allowlist`를 `action=add`로 실행한다. 허용 전에 보낸 이벤트는 버스가 거절하고 고객 쪽 규칙은 실패로 재시도하다 버린다(평소 알람 상태 변화는 허용 뒤 다음 변화부터 들어온다).

### 해지 때 (remove, D-43 단계 `BUS_ALLOWLIST_REMOVED`)

1. 콘솔에서 고객이 `TERMINATED`가 되고 `ALARMS_DELETED`, `CUSTOMER_STACK_REMOVED`, `ACCOUNTS_DISABLED`가 끝난다.
2. 사람이 Actions에서 `bus-allowlist`를 실행한다. `action=remove`, `account_id`(계정마다 한 번), `reference`=offboardingId, `confirm`=계정 ID 다시 입력. `central` 환경의 승인자가 승인해야 돈다.
3. 워크플로가 성공하면(정책에서 계정이 사라진 것을 확인) 사람이 콘솔 체크리스트의 `BUS_ALLOWLIST_REMOVED`를 완료로 표시한다. 자동 표시는 하지 않는다. 이 단계는 `MANUAL`이다.
4. 그 뒤에도 해당 계정에서 이벤트가 오면 목록에서 빠진 것이므로 버스가 거절한다(백엔드에는 닿지 않음). 이미 허용된 상태에서 온 이벤트는 D-43대로 "정리 필요"로 처리된다.

필요한 GitHub 설정(사람이 한 번): `central` 환경(브랜치 `main`만, 필수 승인자), 변수 `CENTRAL_BUS_DEPLOY_ROLE_ARN`(OIDC로 맡는 배포 역할; 버스 스택의 `DescribeStacks`/`UpdateStack`과 `events:DescribeEventBus` 정도만 허용). 스택 이름은 `alarmops-central-bus`로 가정한다. 버스 이름은 스택 출력 `BusName`에서 읽는다(하드코딩 없음; 출력이 없는 옛 스택이면 워크플로가 멈추므로 먼저 현재 템플릿으로 갱신).

OIDC 신뢰 정책(AWS 쪽 역할): `token.actions.githubusercontent.com:aud = sts.amazonaws.com`, `token.actions.githubusercontent.com:sub = repo:hkjs96/alarmops:environment:central` (와일드카드 금지). 워크플로 작업에는 `if: github.ref == 'refs/heads/main'`이 있다. 워크플로의 `uses:`를 전체 커밋 SHA로 고정하는 일은 TODO로 표시돼 있다(저장소에 복사할 실제 SHA가 아직 없다).

### 정책 조건과 ingest 규칙

버스 정책은 `events:source`가 `aws.*`이고 `events:detail-type`이 `CloudWatch Alarm State Change` 또는 `AWS API Call via CloudTrail`인 호출만 허용한다. 고객 계정은 이 정책을 통과해도 `detail` 안의 내용을 마음대로 쓸 수 있다. **ingest는 이벤트 최상위 `account` 필드(EventBridge가 호출자 기준으로 채움)만 믿고**, `detail` 안의 계정 ID나 알람 ARN의 계정은 최상위 `account`와 같을 때만 쓴다.

## 중앙 배포 묶음 `central.yaml` (SAM, #47, D-48, D-49)

순서: (1) `central-bus.yaml`(버스, 스택 `alarmops-central-bus`) → (2) `central.yaml`(스택 `alarmops-central`, 워크플로 `deploy-central`). `central.yaml`은 버스를 이름(`CentralBusName`)으로 참조하므로 버스가 먼저 있어야 한다. 옛 `alarm-commands-queue.yaml`은 `central.yaml`로 합치고 삭제했다(큐 정책이 역할·규칙 ARN을 서로 참조해서 스택을 나누면 순환한다). 아직 배포된 적이 없다는 전제이며, 이미 배포했다면 큐 이름 `alarmops-alarm-commands`가 충돌하니 먼저 알린다.

| 구성 | 내용 |
|---|---|
| 수집 Lambda 3개 | `ingest-webhook`(HTTP API `POST /ingest/v1/{source}`, 속도 제한, 접근 로그 없음: 토큰이 쿼리에 올 수 있다), `ingest-eventbridge`(중앙 버스 규칙: `aws.cloudwatch`의 알람 상태·구성 변경), `alert-consumer`(`alert-events` 소비, 부분 실패 보고). 각 함수 권한은 `alert-events` SendMessage + 수집 DB 비밀 읽기뿐 |
| 큐 | `alarmops-alert-events`(+DLQ), `alarmops-alarm-commands`(+DLQ). 표준·SSE·`maxReceiveCount` 5, DLQ 비어 있지 않음 알람(`AlarmTopicArn` 선택), `aws:SecureTransport` Deny. 가시성: 명령 큐 720초(엔진 제한 시간 최대 120초의 6배), 이벤트 큐 180초(소비자 30초의 6배) |
| 알람 엔진 | Python 3.12, `alarm-commands` 소비(`ReportBatchItemFailures`), 예약 동시성 + 이벤트 소스 `MaximumConcurrency`(파라미터, 기본 10 / 5) |
| 중앙 역할 `AlarmOpsCentral-Engine` | 고객 스택 `CentralRoleArn`이 가리키는 역할이자 **엔진 Lambda 실행 역할**(결정: 하나로 합침. 고객이 신뢰하는 신원이 곧 DB 비밀과 큐를 가진 코드이고, 현재 `StsSessionFactory`가 Lambda 자격증명으로 바로 `AssumeRole` 한다). `sts:AssumeRole`은 `arn:aws:iam::*:role/AlarmOps-*`만, 호출에 `sts:ExternalId`가 없으면 거부(`Null sts:ExternalId = false`, 값 검사는 고객 쪽). `AlarmOps-Remediator`는 명시적 Deny(가드레일일 뿐이고, Slack 승인 자체는 백엔드 코드가 강제한다). 그 밖: 명령 큐 Receive/Delete, 엔진 DB 비밀 읽기, 자기 로그 그룹 |
| `AlarmOpsCentral-RemediatorCaller` | 고객 스택 `RemediatorCallerRoleArn`. 중앙 역할만 맡을 수 있고 고객 `AlarmOps-Remediator` 맡기만 허용(ExternalId 필수, 값은 고객 쪽이 검사). 중앙 역할의 `AssumeRemediatorCaller` 권한과 엔진 환경 변수 `REMEDIATOR_CALLER_ROLE_ARN`은 `RemediationExecution=true`일 때만 생긴다(기본 false를 IAM이 강제, D-15). 큐·비밀·조회 권한 없음. **엔진이 `EXECUTE_REMEDIATION` 때 중앙 역할 → 이 역할 → 고객 역할 두 단계로 맡도록 backend 변경 필요**(환경 변수 `REMEDIATOR_CALLER_ROLE_ARN`). 그때까지 `RemediationExecution=false` |
| Vercel 역할 `AlarmOpsCentral-VercelConsole` (D-49) | 신뢰: 공급자 `oidc.vercel.com`(Global 발급자), `aud = https://vercel.com/<팀>`, `sub = owner:<팀>:project:<프로젝트>:environment:production`, 모두 정확히 일치(와일드카드 없음). 권한: `alarm-commands`의 `sqs:SendMessage` 하나. `SesIdentityArn`(검증된 SES 신원)과 `SesFromAddress`를 주면 그 신원·그 From 주소로만 `ses:SendEmail`이 추가된다(D-52, 기본 꺼짐) |
| DB 비밀 2개 | `EngineDbSecret`, `IngestDbSecret`(Secrets Manager, 이름은 파라미터). 템플릿에는 값이 없고 사람이 넣는다. 엔진과 수집이 서로 다른 DB 사용자를 쓴다(B10) |

중앙 쪽 역할 이름은 모두 `AlarmOpsCentral-` 접두사다. 중앙 역할이 맡을 수 있는 `AlarmOps-*`에 중앙 계정 자신의 역할이 걸리지 않게 하기 위해서다.

### 버스 규칙 → `alarm-commands` (CloudTrail 태그 이벤트)

규칙 `alarmops-tag-events-to-commands`(중앙 버스): 패턴 `source` 접두사 `aws.` + `detail-type` `AWS API Call via CloudTrail` + `detail.eventSource` 접미사 `.amazonaws.com` + `detail.eventName`은 엔진 `TAG_EVENTS` 12개(고객 `TagChangeRule`과 같은 목록) + `detail.errorCode` 없음(실패한 호출은 태그를 바꾸지 않았다). 대상은 `alarm-commands`, 규칙 DLQ `alarmops-tag-events-rule-dlq`(재시도 10회·1시간). 이벤트가 어느 고객 계정에서 왔는지는 봉투 최상위 `account`만 믿는다(엔진 `events.py`). 큐 정책(보안 검토 반영):

- Allow `events.amazonaws.com` `sqs:SendMessage`, 조건은 `ArnEquals aws:SourceArn` = **이 규칙의 ARN** 하나. 어떤 Allow에도 `Principal "*"`나 `aws:SourceAccount`만 거는 조건은 없다.
- `DenySendFromOthers`: `ArnNotEquals aws:PrincipalArn` = Vercel 역할 **그리고** `ArnNotEquals aws:SourceArn` = 규칙 ARN(한 `Condition` 안의 두 키는 AND). 보낼 수 있는 쪽은 Vercel 역할과 그 규칙뿐이다.
- 수신·삭제는 중앙 역할만(그 밖은 Deny). DLQ도 같다: `alarm-commands` DLQ는 중앙 역할과 선택 파라미터 `DlqOpsRoleArn`(break-glass 운영 역할)만 읽는다. 이 Deny는 `StartMessageMoveTask`(재처리)도 막으므로, DLQ를 되돌리려면 `DlqOpsRoleArn`을 정해 스택을 갱신하고(승인 필요) 그 역할로 하고 끝나면 비운다. 세 DLQ 모두 `aws:SecureTransport` Deny.
- `alert-events`: 송신은 웹훅·EventBridge·소비자 함수 역할 셋만, 수신은 소비자 역할만(그 밖은 Deny). SAM이 만드는 SQS 이벤트 소스 권한은 큐 하나로 한정된다.
- 규칙 DLQ 정책도 같은 규칙 ARN 하나에만 `SendMessage`를 허용한다.

### 코드 위치(후속 backend 패키징 단계가 만들 산출물, 여기서는 빌드하지 않는다)

| `CodeUri` (템플릿 기준) | 내용 |
|---|---|
| `../../services/ingest/dist/webhook/` | `index.mjs`가 `handler`를 내보냄(`makeWebhookHandler`를 저장소·SQS에 연결) |
| `../../services/ingest/dist/eventbridge/` | `index.mjs` `handler`(`makeEventBridgeHandler`) |
| `../../services/ingest/dist/consumer/` | `index.mjs` `handler`(`makeConsumerHandler`) |
| `../../services/alarm-engine/build/` | `alarm_engine/` 패키지와 의존성(psycopg 포함)을 최상위에. 핸들러 `alarm_engine.handler.lambda_handler` |

backend와 맞춰야 하는 환경 변수(현재 엔진 코드는 `DATABASE_URL`을 직접 읽는다): DB에 접속하는 모든 Lambda는 `DATABASE_URL_SECRET_ARN`(Secrets Manager ARN, 값은 콜드 스타트에 읽는다. 연결 문자열을 Lambda 환경 변수에 두지 않는다), 수집은 `ALERT_EVENTS_QUEUE_URL`, 엔진은 `ALARMOPS_REMEDIATION_EXECUTION`, `REMEDIATOR_CALLER_ROLE_ARN`.

### 실행과 사람이 하는 일

- 워크플로 `.github/workflows/deploy-central.yml`: `workflow_dispatch`, `main`에서만(`if: github.ref == 'refs/heads/main'`), 환경 `central`(승인), OIDC. cfn-lint → 구조 테스트 → 빌드 산출물 존재 확인 → `sam validate --lint` → `sam deploy` → 스택 출력을 작업 요약에 표로 남긴다(출력은 ARN·URL·계정 ID뿐, 비밀 없음). 환경 변수(`central` 환경, 비밀 아님): `CENTRAL_DEPLOY_ROLE_ARN`, `VERCEL_OIDC_PROVIDER_ARN`, `VERCEL_TEAM_SLUG`, `VERCEL_PROJECT_NAME`, 선택 `SES_IDENTITY_ARN`, `SES_FROM_ADDRESS`, `ALARM_TOPIC_ARN`, `CENTRAL_BUS_NAME`.
- 배포 역할(`CENTRAL_DEPLOY_ROLE_ARN`)의 신뢰: `token.actions.githubusercontent.com:aud = sts.amazonaws.com`, `...:sub = repo:hkjs96/alarmops:environment:central`. 권한은 이 스택으로 한정: CloudFormation(스택 `alarmops-central`, SAM 관리 스택, 변환 `AWS::Serverless-2016-10-31`), SAM 관리 S3 버킷(`--resolve-s3`) 객체 쓰기, 이 스택이 만드는 리소스(Lambda, SQS, Events, Logs, Secrets Manager, CloudWatch 알람, API Gateway v2) 생성·변경, `AlarmOpsCentral-*` 역할의 생성·변경과 `iam:PassRole`(권한 상한으로 그 밖의 역할은 못 건드리게), 버스 스택 `DescribeStacks`. 정확한 정책은 사람이 만들고 검토한다(저장소에 두지 않는다).
- Lambda 동시성 한도: 새 계정은 계정 한도가 10이라 예약 동시성을 둘 수 없다(예약하지 않은 몫이 최소 100 남아야 한다). 먼저 Service Quotas에서 올린다. 기본 예약 합계는 40(엔진 10 + 소비자 10 + 웹훅 10 + EventBridge 수집 10)이므로 계정 한도는 140 이상이어야 한다.
- 변경 세트 승인 2단계: 워크플로는 `plan`(변경 세트를 만들기만 하고 실행하지 않음, IAM 변경을 요약표 맨 위에 출력) → `apply`(그 변경 세트를 ID로 실행) 두 작업이며, 둘 다 `central` 환경 승인을 받는다. 승인자는 `plan` 요약의 IAM 표를 읽고 `apply`를 승인한다.
- 배포 역할 권한 범위(필수): 역할·정책 생성·변경은 `arn:aws:iam::<계정>:role/AlarmOpsCentral-*`에만(`iam:CreateRole`, `PutRolePolicy`, `AttachRolePolicy` 등), `iam:PassRole`은 `AlarmOpsCentral-*`와 SAM이 만드는 함수 역할(`alarmops-central-*`)에 `iam:PassedToService=lambda.amazonaws.com` 조건으로만, 그리고 이 배포 역할이 만드는 모든 역할에 **권한 경계**(permissions boundary) 정책을 붙이도록 `iam:PermissionsBoundary` 조건을 건다. 경계 안에는 이 템플릿이 쓰는 서비스(sqs, secretsmanager, logs, events, lambda, sts:AssumeRole, ses:SendEmail)만 넣는다. 그래야 배포 역할이 탈취돼도 임의 관리자 역할을 만들 수 없다.
- 변수는 저장소 변수가 아니라 `central` **환경** 변수다(Settings → Environments → central → Variables). 추가 선택 변수: `DLQ_OPS_ROLE_ARN`, `REMEDIATION_EXECUTION`(기본 false). 환경 변수는 환경 규칙(main만, 승인)을 통과한 작업만 읽는다.
- 오프라인 검증: `cfn-lint infra/aws/central.yaml infra/aws/central-bus.yaml infra/customer-stack/template.yaml`, `python -m unittest discover -s infra/test -v`, `sam validate --lint --template-file infra/aws/central.yaml`(SAM CLI 필요. CI는 cfn-lint의 SAM 변환으로 같은 템플릿을 검사하고 `sam validate`는 워크플로가 돌린다).

## 콘솔 배포 전 환경 검사

콘솔 배포 워크플로는 아직 없다(`deploy-central`은 AWS 중앙 스택용이다). 콘솔 배포를 만들 때 **배포 단계보다 앞서** 다음 단계를 넣어야 한다(실패하면 배포하지 않는다).

```yaml
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 20 }
      - name: Check the console deploy environment
        env:
          CONSOLE_ORIGIN: ${{ vars.CONSOLE_ORIGIN }}
          TRUSTED_PROXY: ${{ vars.TRUSTED_PROXY }}
          # MOCK_API and E2E_ALLOW_MOCK are deliberately NOT listed: they must not exist.
        run: node .github/scripts/check-console-deploy-env.mjs
```

- 규칙: `CONSOLE_ORIGIN`이 설정돼 있고 `https://host[:port]` 형태(경로·끝 슬래시·자격증명 없음), `TRUSTED_PROXY`가 정확히 `1`, `MOCK_API`와 `E2E_ALLOW_MOCK`은 값이 비어 있어도 **존재하면 실패**.
- 이 스크립트는 단계의 `env:`만 본다. 런타임 설정(ECS 작업 정의, Lambda 환경 변수 등)을 `KEY=VALUE` 파일로 만들어 배포한다면 같은 스크립트를 파일 인자로 한 번 더 부른다: `node .github/scripts/check-console-deploy-env.mjs <파일>`. 이때는 파일만 검사한다. 미래의 배포 작업은 **실제로 배포하는 설정**을 검사해야 한다(검사한 값과 배포한 값이 달라지면 의미가 없다).
- 단계의 `env:`에 `MOCK_API: ${{ vars.MOCK_API }}`처럼 적으면 변수가 비어 있어도 키가 생겨 실패한다. 적지 않는다.
- 테스트: `node --test .github/scripts/check-console-deploy-env.test.mjs` (CI `db`·`infra` 작업이 실행).

## CDN: HTML은 캐시하지 않는다 (nonce CSP)

콘솔은 요청마다 새 nonce를 넣은 CSP를 응답 헤더로 보내고(`apps/console/src/lib/csp.ts`, `middleware.ts`), 같은 nonce가 HTML 안의 `<script nonce=...>`에 들어간다. CDN이나 로드 밸런서가 HTML을 캐시하면 다른 사용자에게 **이전 요청의 nonce가 든 HTML**이 나가고 헤더의 nonce와 어긋나 화면이 깨지며, 캐시된 nonce를 알면 스크립트 주입 방어가 약해진다. 요구 사항:

- HTML 문서(`text/html`, 즉 `/_next/static/` 이외 모든 경로, 특히 `/`, 로그인, `/auth/*`)는 CDN에서 **캐시 안 함**: 캐시 정책은 Caching disabled(TTL 0) 또는 오리진의 `Cache-Control: no-store`를 존중. 오리진이 보내는 `Content-Security-Policy` 헤더는 CDN이 지우거나 덮어쓰지 않는다.
- 캐시해도 되는 것은 파일 이름에 해시가 있는 `/_next/static/*`(불변)과 공개 정적 자원뿐이다. `/api/*`도 캐시하지 않는다.
- CloudFront라면 기본 동작(`*`)에 `CachingDisabled` 관리형 정책 + `AllViewer` 오리진 요청 정책(Host·`X-Forwarded-*`·쿠키 전달), `/_next/static/*` 동작에만 `CachingOptimized`. `TRUSTED_PROXY=1`이므로 오리진 앞의 프록시가 `X-Forwarded-Host`를 **덮어쓰는** 구성이어야 한다(apps/console/README.md).
- 배포 뒤 확인(사람): `curl -sI https://<콘솔>/ | grep -i -E "cache-control|x-cache|age"`에서 `Age`가 없고 `X-Cache`가 `Miss`/`Bypass`, 두 번 요청한 응답의 CSP nonce가 서로 달라야 한다.
