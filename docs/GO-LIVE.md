# 실제 연동 순서 (파일럿 실운영까지)

이 문서는 파일럿을 실운영까지 끌고 갈 사람과 허브를 위한 실행 순서다. 끝까지 따르면 파일럿 고객 1곳의 알람이 사람 손 없이 인시던트·호출·Ack·해결까지 돈다.

**목표**: 파일럿 고객 1곳의 AWS 알람이 들어오면 사람이 손대지 않아도 인시던트가 열린다. 정해진 순서대로 전화·문자가 간다. Ack/해결까지 콘솔에서 끝난다.

**읽는 법**

- 이 문서는 "누가 무엇을 하는가"를 단계별로 적는다.
- **[사람]** 은 자격증명·결제·배포 승인이 필요해 사람이 직접 한다.
- **[에이전트]** 는 허브가 이슈로 배정한다.

> **주의** 비밀값은 어디에도 붙여 넣지 않는다. 두는 곳은 비밀번호 관리자, GitHub/Vercel 시크릿, 회사 PC `.env`뿐이다.

## 목차

- [지금 상태 (11/17)](#지금-상태-1117)
- [1단계 — 결정](#1단계--결정-사람-먼저-다른-단계를-막는다)
- [2단계 — GitHub·DB 기반](#2단계--githubdb-기반-사람-30분)
- [3단계 — 콘솔 배포(Vercel)](#3단계--콘솔-배포vercel-사람--에이전트)
- [4단계 — AWS 중앙 계정(서울)](#4단계--aws-중앙-계정서울-에이전트-템플릿--사람-배포)
- [5단계 — 알림 발송](#5단계--알림-발송-에이전트-1단계-결정-후)
- [6단계 — 알람 자동 생성](#6단계--알람-자동-생성-에이전트)
- [7단계 — 파일럿 고객 연결](#7단계--파일럿-고객-연결-사람)
- [완전 자동으로 도는 것과 사람이 남는 것](#완전-자동으로-도는-것과-사람이-남는-것)
- [진행 순서 요약](#진행-순서-요약)

## 지금 상태 (11/17)

| 영역 | 상태 |
|---|---|
| 콘솔·API·틱(에스컬레이션, 발송 대기열, 보관·파기) | 코드 완료, mock·로컬 Postgres로 검증 |
| 개발 DB(Supabase) | 마이그레이션 0001~0005 적용, Data API 꺼짐 |
| 수집(ingest: 웹훅·EventBridge) | 코드·배포 묶음 완료(#52, #53), **실제 계정 미배포** |
| 알람 엔진(알람 생성·동기화·해지 삭제) | 수집기 29종·CloudTrail 태그 이벤트 완료(#51), 배포 묶음 완료, **실제 계정 미배포** |
| 고객 연결 스택·중앙 버스·명령 큐 | CloudFormation 템플릿 완료, **실제 계정 미배포** |
| 실제 알림 발송(전화·문자·Slack·이메일) | **어댑터 없음** — Slack·SES 정보 대기(#39), 문자·전화 보류(#10) |
| 콘솔 배포(Vercel) | 배포 워크플로 완료(#54), **Vercel 프로젝트 미생성** |

굵게 표시한 것이 채워져야 "완전 자동"이 된다. 코드 쪽에 남은 큰 일은 알림 어댑터(5단계)뿐이고, 나머지는 사람이 계정·환경을 만들고 배포를 승인하는 일이다.

---

## 1단계 — 결정 [사람] (먼저, 다른 단계를 막는다)

- [ ] 문자·전화 업체(Q-API-06, 후보 솔라피) — **11/16 보류**(#10). 나머지를 먼저 진행한다
- [x] 이메일 발송: **AWS SES**(D-52)
- [ ] Slack 워크스페이스·앱, MSP 공용 채널 이름(D-46)
- [x] 콘솔 도메인: 우선 `*.vercel.app`(D-54), 회사 도메인은 파일럿 전 — DNS 담당 확인 필요
- [ ] Google SSO 연결 시점(파일럿 전 필수 여부)
- [ ] 파일럿 고객 1곳과 그 AWS 계정 ID

## 2단계 — GitHub·DB 기반 [사람, 30분]

- [ ] main 브랜치 보호(Rulesets): PR 필수, 필수 검사 `test`, `e2e`, `e2e-live`, `db`, `engine`, `infra` (`docs/SETUP-SUPABASE.md` 9단계)
- [ ] 회사 PC `.env`에 `DATABASE_URL`/`DIRECT_URL` (SETUP-SUPABASE 7단계) → 허브에 "채웠다"고만 알림
- [ ] 회사 PC에서 실제 DB로 콘솔 확인 (순서는 허브가 그때 안내)
  1. seed를 넣는다.
  2. 콘솔을 띄운다.
     ```bash
     LIVE_DEV_LOGIN=1 SESSION_SECRET=<임의 32자> npm run dev -w @alarmops/console
     ```
  3. `/auth/dev-login?as=admin` 로 들어간다.

## 3단계 — 콘솔 배포(Vercel) [사람 + 에이전트]

### [에이전트] 완료: 배포 워크플로 (#46, D-53)

워크플로 파일은 `.github/workflows/deploy-console.yml`이다.

실행 조건:

- `workflow_dispatch`만
- `main`에서만
- 환경 `production`(승인)
- 권한 `contents: read`

워크플로 순서:

1. `npm ci --ignore-scripts`
2. 고정된 Vercel CLI 설치(`tools/vercel-cli`)
   - 정확한 버전 + 락파일
   - `npm ci --ignore-scripts`
   - 토큰 없이
3. `vercel pull --yes --environment=production`
   - 토큰은 환경변수 `VERCEL_TOKEN`으로만 준다.
   - 토큰은 pull·deploy 단계에만 준다.
4. 받은 `.vercel/.env.production.local`을 `check-console-deploy-env.mjs`로 검사한다. 값은 출력하지 않는다.
5. **비밀 제거**: `strip-deploy-env.mjs`가 `CONSOLE_ORIGIN`·`TRUSTED_PROXY`·`NEXT_PUBLIC_*`만 남긴다.
6. `vercel build --prod`(토큰 없음)
7. `vercel deploy --prebuilt --prod`
8. 스모크 검사(`.github/scripts/smoke-console.mjs`)
   - `/login` 200·mock 표식 없음
   - CSP에 nonce가 있고 script-src에 `'unsafe-inline'` 없음
   - 인증 없는 `POST /api/internal/tick`이 401
   - 503이면 `TICK_SECRET` 미설정이라 실패

> **참고** 받은 환경 파일은 실패해도 지운다.

> **참고** `next build`는 mock 없이 돈다.

### [사람] 한 번만 (순서대로)

1. [ ] **Vercel 프로젝트 만들기**
   - 어디서: Vercel에서 이 저장소를 가져온다(Import).
   - 값: Framework Next.js, **Root Directory `apps/console`**
   - 값: "Include source files outside of the Root Directory" 켬(기본)
   - 첫 자동 배포가 시작되면 취소한다.
2. [ ] **Git 자동 배포 끄기**(D-53, 우회 방지)
   - 어디서: Project → Settings → Git
   - 값: **Ignored Build Step**을 `exit 0`(항상 건너뜀)으로 한다. 또는 Git 연결을 해제한다.
   - 확인: main에 푸시해도 Vercel에 새 배포가 생기지 않는다.
3. [ ] **Vercel 토큰과 ID 확인**
   - 토큰 어디서: Account Settings → Tokens
   - 토큰 값: 이 팀 범위 토큰을 만든다. 만료일을 둔다.
   - **조직 ID·프로젝트 ID** 어디서: 프로젝트 Settings → General의 Project ID, 팀 Settings의 Team ID
   - 다른 방법: 로컬에서 `vercel link` 후 `.vercel/project.json`의 `orgId`·`projectId`

   > **주의** 토큰 값은 GitHub 말고 어디에도 적지 않는다.

   > **주의** `.vercel/project.json`은 커밋하지 않는다.
4. [ ] **GitHub `production` 환경**
   - 어디서: Settings → Environments → New environment
   - 값: **Required reviewers**에 본인
   - 값: **Deployment branches** = `main`만
   - 확인: 승인 없이 실행되는 경로가 없다(관리자 우회 허용 끔 권장).
5. [ ] **환경 시크릿**
   - 어디서: 같은 화면 → Environment secrets (저장소 시크릿 아님)
   - 값: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
6. [ ] **Vercel 환경변수(Production)**
   - 값: 아래 [Vercel 환경변수 표](#vercel-환경변수-production).
   - `CONSOLE_ORIGIN`과 `TRUSTED_PROXY`는 **일반(Plain) 변수**로 둔다.
   - 비밀 값(`DATABASE_URL`, `SESSION_SECRET`, `TICK_SECRET`)은 Sensitive로 해도 된다. 런타임은 Vercel에 저장된 값을 쓴다.
   - 주소는 우선 `*.vercel.app`(D-54).

   > **주의** Vercel의 Sensitive 변수는 `vercel pull`로 내려오지 않는다. 그러면 배포 전 검사가 "없음"으로 실패한다.

   남는 위험(R4)은 아래 [남는 위험(R4)](#남는-위험r4)에 따로 적었다.
7. [ ] **첫 배포**
   - 먼저: `CONSOLE_ORIGIN`에 쓸 `*.vercel.app` 주소를 프로젝트 Domains에서 확인한다. 스모크 검사는 이 주소를 부른다.
   - 어디서: Actions → `deploy-console` 실행 → `production` 승인
   - 확인: 로그에서 환경 검사·스모크 통과
8. [ ] **Deployment Protection 확인**
   - 언제: Vercel의 Deployment Protection이 production 주소를 막고 있을 때(스모크가 401로 실패)
   - 값: Standard Protection으로 두어 production 도메인은 공개로 한다.
9. [ ] **스모크 검사가 실패했을 때(되돌리기, N4)**

   > **주의** 배포는 이미 production에 올라가 있다. 바로 되돌린다.

   1. 되돌린다. 둘 중 하나를 한다.
      - 본인 터미널에서 직전 production 배포로 되돌린다.
        ```bash
        vercel rollback
        ```
      - Vercel 대시보드 → Deployments에서 직전의 정상 배포 → **Promote to Production**(Instant Rollback)
   2. 확인한다.
      ```bash
      curl -s -o /dev/null -w "%{http_code}" https://<콘솔>/login
      ```
      - 결과 = 200
      - `POST /api/internal/tick`(인증 없이) = 401
   3. 실패 원인을 고치고 다시 실행한다. 대개 원인은 다음 중 하나다.
      - `TICK_SECRET` 미설정 503
      - 배포 보호 401
      - mock 표식
      - CSP

   > **주의** 되돌린 동안 1분 틱이 멈출 수 있다(pg_cron은 같은 주소를 부른다). 틱 표시를 확인한다.

### 남는 위험(R4)

- 받은 환경 파일에는 `DATABASE_URL`·`SESSION_SECRET`·`TICK_SECRET`·`VERCEL_OIDC_TOKEN`이 들어 있다.
- 받은 직후 검사·비밀 제거 두 단계가 돈다. 이 둘은 저장소의 검증된 스크립트만 쓴다.
- 그 뒤에야 빌드(저장소·npm 코드)가 돈다. 빌드에는 비밀이 없다.
- `npm ci`·CLI 설치는 pull **앞**이라 토큰을 보지 못한다.

> **주의** 같은 러너에서 pull~제거 사이에 도는 코드는 우리 스크립트뿐이어야 한다. 단계를 추가할 때 지킨다.

> **주의** 운영 비밀 회전 주기를 둔다. 의심되면 `SESSION_SECRET`·`TICK_SECRET`·토큰을 바꾼다.

> **주의** 배포 승인자는 워크플로 변경 PR을 같은 기준으로 본다.

### Vercel 환경변수 (Production)

| 변수 | 값 |
|---|---|
| `DATABASE_URL` | Supabase Transaction pooler(6543) — 아래 참고 |
| `DATABASE_POOLER` | `transaction` |
| `SESSION_SECRET` | 32자 이상 임의 값 |
| `TICK_SECRET` | 32자 이상 임의 값(아래 pg_cron과 같은 값) |
| `CONSOLE_ORIGIN` | 아래 참고 |
| `TRUSTED_PROXY` | `1` |
| `ALARM_COMMANDS_QUEUE_URL`, `ALARM_COMMANDS_EXPECTED_ACCOUNT` | 4단계 후 |
| `AWS_ROLE_ARN` | 4단계 후(Vercel OIDC 역할, D-49) |
| `MOCK_API`, `E2E_ALLOW_MOCK` | **넣지 않는다**(배포 검사가 막는다) |

- `DATABASE_URL`: Supabase Transaction pooler(6543, `?pgbouncer=true&connection_limit=1`). 운영 DB는 개발과 별도 프로젝트 권장.
- `CONSOLE_ORIGIN`: 우선 `https://<프로젝트>.vercel.app`(D-54). 파일럿 전에 `https://console.<도메인>`.

### [사람] CDN에서 HTML 캐시 끄기

- nonce CSP 때문이다. 자세한 내용은 `infra/aws/README.md`.

### [사람] 1분 틱

1. Supabase Vault에 `tick_secret`을 저장한다.
2. SQL Editor에서 `docs/API-CONTRACT.md` §5의 `cron.schedule('alarmops-tick', ...)`을 실행한다.
   - 값: URL은 배포 주소
   - 확인: 콘솔 상단 `TICK` 표시가 1분마다 갱신된다.

## 4단계 — AWS 중앙 계정(서울) [에이전트 템플릿 → 사람 배포]

### [에이전트] 중앙 배포 묶음 템플릿 완료 (#47)

`infra/aws/central.yaml`에 들어 있는 것:

- 수집 Lambda 3개
- `alert-events`·`alarm-commands` 큐
- 알람 엔진
- 중앙 역할
- 중앙 버스 → `alarm-commands` 규칙
- Vercel OIDC 역할
- DB 비밀 2개

배포 워크플로는 `.github/workflows/deploy-central.yml`이다. 설명은 `infra/aws/README.md`에 있다.

**Lambda 진입점·패키징·`DATABASE_URL_SECRET_ARN` 읽기는 backend가 완료**(#47).

#### 산출물 만들기

저장소 루트에서 배포 전에 한 번 실행한다.

```bash
npm ci --ignore-scripts && npm run build:lambda -w @alarmops/ingest && npm run build:engine-lambda
```

- 수집 → `services/ingest/dist/{webhook,eventbridge,consumer}/index.mjs`
- 엔진 → `services/alarm-engine/build/`
- 자세한 내용은 `services/ingest/README.md`, `services/alarm-engine/README.md`의 Deploy.

> **참고** 엔진은 wheel을 받으므로 인터넷이 필요하다. 템플릿이 arm64라 기본이 aarch64 wheel이다.

#### 워크플로가 하는 확인

- `deploy-central.yml`의 `plan`이 위 빌드를 직접 한다.
- `prisma generate`는 수집 번들이 쓰지 않아 불필요하다.
- 산출물 매니페스트 체크섬으로 `apply`가 `plan`이 올린 코드와 같은 것만 실행하는지 확인한다(`infra/aws/README.md`).

#### 남은 backend 몫

- 원격 조치의 두 단계 역할 맡기.

### [사람] 한 번만 (순서대로)

1. [ ] **버스 스택**
   - 언제: 아직 없으면
   - 값: `infra/aws/central-bus.yaml`을 스택 `alarmops-central-bus`로 올린다.
   - 참고: `bus-allowlist` 워크플로가 이 스택을 갱신한다.
2. [ ] **AWS에 GitHub OIDC 공급자**
   - 어디서: IAM → 자격 증명 공급자 → OpenID Connect
   - 값: URL `https://token.actions.githubusercontent.com`
   - 값: 대상 `sts.amazonaws.com`
3. [ ] **배포 역할**(웹 ID 역할)
   - **권한 경계 필수**:
     - `AlarmOpsCentral-*` 역할만 만든다.
     - `PassRole`은 Lambda 서비스로만 한다.
     - 만든 역할에는 경계 정책을 붙이게 한다.
   - 신뢰 조건:
     - `token.actions.githubusercontent.com:aud = sts.amazonaws.com`
     - `token.actions.githubusercontent.com:sub = repo:hkjs96/alarmops:environment:central`(와일드카드 금지)
   - 권한: `infra/aws/README.md`의 "실행과 사람이 하는 일" 범위
   - 이 역할로 `bus-allowlist`도 돌리므로 버스 스택 권한도 포함한다.
4. [ ] **GitHub `central` 환경**
   - 어디서: Settings → Environments
   - 값: 배포 브랜치 `main`만
   - 값: 필수 승인자 본인
5. [ ] **Vercel OIDC 공급자 등록(D-49)**
   1. 어디서: Vercel 프로젝트 Settings → Security → Secure backend access with OIDC federation
   2. 발급자 모드를 **Global**로 둔다.
   3. AWS에 OpenID Connect 공급자를 추가한다.
      - 값: URL `https://oidc.vercel.com`
      - 값: 대상 `https://vercel.com/<팀 슬러그>`
   4. 만든 공급자 ARN을 아래 7번 변수에 넣는다.

   > **주의** 팀 발급자 모드는 이 템플릿의 신뢰 키와 맞지 않는다.
6. [ ] **Service Quotas**
   - 값: Lambda 동시 실행 한도를 올린다.
   - 확인: 계정 한도 140 이상
   - 이유: 새 계정 10이면 예약 동시성 설정이 실패한다. 기본 예약 합계가 40이다.

   > **주의 — 중앙 계정 운영 규칙** 엔진 실행 역할이 곧 고객이 신뢰하는 중앙 역할이다(PoC 결정).
   > - 그래서 이 계정에는 다른 Lambda·워크로드를 두지 않는다.
   > - `iam:PassRole`로 이 역할을 넘길 수 있는 주체를 배포 역할로 한정한다.
   > - 개발 계정에서 먼저 확인한다: 중앙 역할 신뢰의 `aws:SourceAccount` 조건이 Lambda 실행에 문제를 일으키지 않는지(함수가 역할을 맡아 시작되는지).
7. [ ] **`central` 환경 변수**
   - 어디서: Settings → Environments → central → Variables (저장소 변수 아님, 비밀 아님)
   - 필수: `CENTRAL_DEPLOY_ROLE_ARN`, `VERCEL_OIDC_PROVIDER_ARN`, `VERCEL_TEAM_SLUG`, `VERCEL_PROJECT_NAME`
   - 선택: `ALARM_TOPIC_ARN`, `CENTRAL_BUS_NAME`(기본 `alarmops-central`)
   - 이메일을 쓸 때만: `SES_IDENTITY_ARN`·`SES_FROM_ADDRESS`(D-52, 서울 리전 SES에서 검증한 신원)
   - 기존 `CENTRAL_BUS_DEPLOY_ROLE_ARN`이 3번 역할과 같으면 그대로 둔다.
8. [ ] **실행**
   1. Actions → `deploy-central` 실행
   2. `plan` 작업 승인
   3. 요약의 **IAM 변경 표**를 읽는다.
   4. `apply` 작업 승인
   - 확인: 완료 요약의 출력표
9. [ ] **DB 비밀 값 넣기**
   - 어디서: 본인 터미널에서 SSO·MFA로
   - 대상: 출력의 `EngineDbSecretArn`, `IngestDbSecretArn` 비밀
   - 값: 연결 문자열. **맨 문자열 그대로, 끝에 `?sslmode=require`를 붙인다.**
   - 넣는 방법: 콘솔 입력, 또는 AWS CLI의 secretsmanager 비밀 값 입력에 `file://`로 파일을 준다. 셸 기록에 남기지 않기 위해서다.

   > **참고** 값은 템플릿·Actions에 없다. 엔진용과 수집용은 서로 다른 DB 사용자다.

   > **주의** Lambda는 `sslmode`가 `require`·`verify-ca`·`verify-full`이 아니면 시작을 거부한다.

   > **참고** 트랜잭션 풀러(포트 6543)면 수집 쪽이 자동으로 풀러 모드로 접속한다.

   > **참고** 인증서 검증에 DB의 CA가 필요하면 URL에 `sslrootcert=`로 번들 안 파일을 지정한다.
10. [ ] **출력값을 Vercel 환경변수(production)에**
    - `ALARM_COMMANDS_QUEUE_URL` = `AlarmCommandsQueueUrl`
    - `ALARM_COMMANDS_EXPECTED_ACCOUNT` = `CentralAccountId`
    - `AWS_ROLE_ARN` = `VercelConsoleRoleArn`

    고객 스택 파라미터:
    - `CentralRoleArn` = 출력 `CentralRoleArn`
    - `CentralEventBusArn` = 출력 `CentralBusArn`
    - (Remediator를 켜는 고객만) `RemediatorCallerRoleArn` = 출력 `RemediatorCallerRoleArn`

    웹훅 주소는 출력 `WebhookUrl`이다.
11. [ ] **DLQ 재처리(break-glass)**

    > **참고** `alarm-commands` DLQ는 중앙 역할만 읽는다(`StartMessageMoveTask`도 막힌다).

    메시지를 되돌려야 하면:
    1. 운영 역할 ARN을 환경 변수 `DLQ_OPS_ROLE_ARN`에 넣고 `deploy-central`로 반영한다.
    2. 그 역할로 재처리한다.
    3. 끝나면 변수를 지우고 다시 반영한다.
12. [ ] (선택, D-52) SES를 쓰면 `ses:Recipients` 조건을 추가해 수신자 범위를 좁히는 것을 검토한다. 지금은 From 주소와 신원만 고정한다.
13. [ ] **권한 실측**(#38)
    1. 시험 계정에 고객 스택을 설치한다.
    2. 확인:
       - 알람 생성(Tags 포함)·삭제가 된다.
       - `ManagedBy` 없는 알람은 거부된다.
       - 시험 계정에서 태그를 바꾸면 `alarm-commands`로 이벤트가 들어와 엔진이 처리한다.
       - 허용 목록에 없는 계정이 보낸 이벤트는 닿지 않는다.

## 5단계 — 알림 발송 [에이전트, 1단계 결정 후]

- [ ] 문자·전화 어댑터(#10): 멱등 키 전달, 오류 문구 가리기, 부분 장애 규칙. 업체 키는 서버 비밀로만
- [ ] Slack·이메일 어댑터 + DEGRADED 감시자 + 10시 요약 + 비상 열람 알림(#39)
- [ ] seed 번호 가드는 이미 있음(#26) — 실제 번호 등록 후 확인 링크로 검증

[사람] 이어서 한다.

1. 업체 키를 Vercel(또는 Lambda) 비밀로 입력한다.
2. 본인 번호로 시험 호출 1건을 한다.

## 6단계 — 알람 자동 생성 [에이전트]

- [x] 알람 엔진 리소스 수집기 29종(#48, #51 완료): `SYNC_ACCOUNT`가 리소스를 찾아 `Monitoring=on` 태그 대상에 알람을 만들고 맞춘다. 이게 있어야 "고객이 태그만 붙이면 알람이 생긴다"가 된다
- [x] CloudTrail 태그 변경 → 즉시 동기화 연결(#51 완료)

## 7단계 — 파일럿 고객 연결 [사람]

1. 콘솔에서 고객사·AWS 계정 등록 → ExternalId 발급
2. `bus-allowlist` 워크플로로 계정 추가(승인)
3. 고객에게 `infra/customer-stack/template.yaml` 설치 요청
   - 파라미터: 중앙 역할 ARN, ExternalId, 중앙 버스 ARN
4. 콘솔 "연결 확인" → 역할별 OK
5. 호출 순서·담당자 등록, 연락처 확인 링크 발송
6. 시험 알람 1건(임계값 낮춘 알람) → 인시던트 열림 → 전화 → Ack → 해결까지 확인
7. 실제 iPhone Safari로 콘솔 확인(#28)

## 완전 자동으로 도는 것과 사람이 남는 것

**자동**: 알람 수신 → 그룹·인시던트 → 호출 순서대로 발송 → 미응답 시 다음 단계 → Ack·해결 기록 → 업무 시간 요약 → 해지 고객 정리·파기.

**사람**:

- 새 고객 연결(스택 설치는 고객 계정)
- 해지 승인
- legal hold
- 비상 번호 열람
- 업체·키 관리
- 배포 승인

## 진행 순서 요약

1. 1단계 결정
2. 2단계(오늘 가능)
3. 3·4단계는 에이전트 템플릿이 먼저, 사람 배포가 뒤
4. 5·6단계는 에이전트
5. 7단계 파일럿
