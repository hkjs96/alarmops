# Vercel 콘솔 배포 따라 하기

이 문서는 AlarmOps 콘솔을 Vercel에 처음 배포하는 사람을 위한 화면별 순서다. `docs/GO-LIVE.md` 3-1~3-4가 **무엇을** 하는지 적었다면, 이 문서는 **어디를 누르고 무엇을 적는지** 적는다.

- 처음 한 번만 하면 된다.
- 1시간쯤 걸린다.
- 끝나면 `https://<프로젝트>.vercel.app/login`에 운영 콘솔이 열린다. 배포는 GitHub Actions에서 본인이 승인할 때만 일어난다(D-53).

> **참고** 이 문서를 쓸 때 작업 세션에서 vercel.com과 docs.github.com 공식 문서를 열 수 없었다. 그래서 버튼·메뉴 이름은 저장소 문서(`docs/GO-LIVE.md`, `docs/SETUP-SUPABASE.md`, `docs/SETUP-PROD-DB.md`)와 워크플로 주석에 이미 적힌 이름을 썼다. 저장소에도 없는 이름에는 **(화면 이름 확인 필요)**를 붙였다. 화면 이름이 조금 달라도 **용도**가 같은 것을 고른다. 다르면 허브에 알려 이 문서를 고친다.

> **주의** 토큰·비밀 값은 채팅, 이슈, PR, 커밋 어디에도 붙여 넣지 않는다. 비밀번호 관리자, GitHub 환경 시크릿, Vercel 환경변수 세 곳에만 둔다.

> **주의** Vercel 화면에서 **Redeploy**나 CLI의 `vercel deploy`로 직접 배포하지 않는다. 배포는 GitHub Actions `deploy-console`로만 한다(D-53). 예외는 11단계의 되돌리기뿐이다.

## 목차

1. [Vercel 계정·팀 확인](#1-vercel-계정팀-확인)
2. [GitHub 저장소 가져오기(Import)](#2-github-저장소-가져오기import)
3. [Git 자동 배포 끄기](#3-git-자동-배포-끄기-d-53)
4. [production 주소 적어 두기](#4-production-주소-적어-두기)
5. [Vercel 토큰 만들기](#5-vercel-토큰-만들기)
6. [Team ID와 Project ID 찾기](#6-team-id와-project-id-찾기)
7. [GitHub `production` 환경과 시크릿](#7-github-production-환경과-시크릿)
8. [Vercel 환경변수 넣기](#8-vercel-환경변수-넣기-production만)
9. [첫 배포](#9-첫-배포)
10. [Deployment Protection 확인](#10-deployment-protection-확인)
11. [스모크 검사가 실패했을 때 되돌리기](#11-스모크-검사가-실패했을-때-되돌리기)
12. [막혔을 때](#막혔을-때)

## 1. Vercel 계정·팀 확인

1. **어디서:** https://vercel.com 에 회사 계정으로 로그인한다.
   **누를 것:** 화면 왼쪽 위의 팀 이름(팀 전환 메뉴) **(화면 이름 확인 필요)**.
   **확인:** 회사 팀 `<팀>`이 선택되어 있다. 개인 계정(Hobby) 범위가 아니다.

2. **어디서:** 팀의 **Settings** → 요금제 화면 **(화면 이름 확인 필요)**.
   **확인:** 요금제가 **Pro**다. 운영 조건이 Vercel Pro이기 때문이다(D-10).

   > **주의** 개인(Hobby) 범위에 프로젝트를 만들면 이후 토큰·Team ID가 모두 그 범위로 묶인다. 처음부터 회사 팀을 고른다.

출처: `docs/decisions/DECISIONS.md` D-10. (vercel.com 문서는 열지 못했다.)

## 2. GitHub 저장소 가져오기(Import)

1. **어디서:** Vercel 대시보드(회사 팀 선택된 상태).
   **누를 것:** **Add New...** → **Project** **(화면 이름 확인 필요)**.
   **확인:** "Import Git Repository" 목록이 보인다 **(화면 이름 확인 필요)**.

2. **어디서:** 같은 화면. 목록에 `hkjs96/alarmops`가 없을 때만 한다.
   **누를 것:** GitHub 연결·권한 조정 링크 **(화면 이름 확인 필요)** → GitHub 화면에서 Vercel 앱의 저장소 접근을 **Only select repositories**(선택한 저장소만) **(화면 이름 확인 필요)** → `hkjs96/alarmops` 하나만 고르고 저장.
   **확인:** Vercel 목록에 `hkjs96/alarmops`가 보인다.

   > **주의** **All repositories**(모든 저장소)를 고르지 않는다. 이 저장소 하나만 준다.

3. **어디서:** 목록의 `hkjs96/alarmops` 줄.
   **누를 것:** **Import**.
   **확인:** 프로젝트 설정 화면(Configure Project) **(화면 이름 확인 필요)**이 열린다.

4. **어디서:** 같은 화면의 **Framework Preset**.
   **입력할 것:** **Next.js**.

5. **어디서:** 같은 화면의 **Root Directory** → **Edit** **(버튼 이름 확인 필요)**.
   **입력할 것:** `apps/console`을 고르고 확인.
   **확인:** Root Directory 칸에 `apps/console`이 보인다.

6. **어디서:** 같은 화면의 빌드·설치 설정(Build and Output Settings) **(화면 이름 확인 필요)**.
   **입력할 것:** 아무것도 바꾸지 않는다. Build Command, Install Command, Output Directory 모두 기본값으로 둔다.
   - 이유: 저장소는 루트 `package.json`의 npm workspaces(`apps/*`, `packages/*`, `services/*`, `db`)다. 저장소에 `vercel.json`이 없고, 문서도 사용자 지정 설치 명령을 요구하지 않는다.
   - 실제 빌드는 Vercel이 아니라 GitHub Actions가 한다. 워크플로가 저장소 루트에서 `npm ci --ignore-scripts`를 먼저 돌리고 `vercel build --prod`를 실행한다. 그래서 여기 설정은 대부분 쓰이지 않는다.

7. **어디서:** 같은 화면의 Environment Variables 칸.
   **입력할 것:** 지금은 비워 둔다. 8단계에서 넣는다.

8. **누를 것:** **Deploy**.
   **확인:** 첫 자동 배포가 시작된다.

9. **어디서:** 배포 진행 화면 또는 프로젝트 → **Deployments** → 진행 중인 배포의 `...` 메뉴.
   **누를 것:** **Cancel Deployment** **(화면 이름 확인 필요)**.
   **확인:** 배포 상태가 Canceled다.
   - 이미 실패(Error)로 끝났으면 그대로 둔다. 환경변수가 없어서 실패하는 것은 예상된 결과다. 프로젝트는 만들어졌고 해가 없다.
   - 이미 성공(Ready)했으면 9단계 전까지 그 주소를 쓰지 않는다. 환경변수가 없는 콘솔은 production에서 모든 요청에 503을 준다(`CONSOLE_ORIGIN` 없음).

10. **어디서:** 프로젝트 → **Settings** → General의 Root Directory 칸.
    **확인:** `apps/console`이다. 그 아래 **Include source files outside of the Root Directory**가 켜져 있다(기본값). 끄면 `packages/*`를 못 읽어 빌드가 실패한다.

출처: `.github/workflows/deploy-console.yml` 머리 주석, `docs/GO-LIVE.md` 3-1, 루트 `package.json`. (vercel.com/docs/monorepos, vercel.com/docs/projects 는 열지 못했다.)

## 3. Git 자동 배포 끄기 (D-53)

이걸 끄지 않으면 main에 푸시할 때마다 승인·검사 없이 Vercel이 바로 배포한다.

1. **어디서:** 프로젝트 → **Settings** → **Git**.
   **누를 것:** **Ignored Build Step** 칸.
   **입력할 것:** 동작을 "항상 건너뜀"으로 한다. 선택 목록이 있으면 빌드를 하지 않는 항목(예: "Don't build anything") **(화면 이름 확인 필요)**을 고른다. 명령을 적는 칸이면 `exit 0`을 적는다.
   **누를 것:** **Save**.
   **확인:** 저장 후 다시 열어도 그 값이다.

2. 다른 방법: 같은 화면에서 Git 연결을 해제한다(**Disconnect**) **(버튼 이름 확인 필요)**. 워크플로는 Git 연결 없이도 `vercel pull`·`vercel deploy`로 배포한다. 둘 중 하나만 하면 된다.

3. **확인:** 다음에 main에 머지가 일어난 뒤 프로젝트 → **Deployments**를 연다. 새 배포가 없거나 "Canceled/Ignored"로 표시된다 **(표시 이름 확인 필요)**.

   > **주의** 새 배포가 Ready로 생겼으면 1번이 저장되지 않은 것이다. 바로 1번을 다시 한다.

출처: `docs/GO-LIVE.md` 3-1, `deploy-console.yml` 머리 주석. (vercel.com/docs/project-configuration/git-settings 는 열지 못했다.)

## 4. production 주소 적어 두기

1. **어디서:** 프로젝트 → **Settings** → **Domains**(또는 프로젝트 첫 화면의 Domains 칸).
   **확인:** `<프로젝트>.vercel.app` 모양 주소가 있다.
2. **입력할 것:** `https://<프로젝트>.vercel.app`를 메모한다. 8단계 `CONSOLE_ORIGIN`에 그대로 쓴다. 스모크 검사가 이 주소를 부른다.

   > **주의** 배포마다 생기는 긴 주소(`<프로젝트>-<글자>-<팀>.vercel.app`)가 아니다. Domains에 있는 짧은 production 주소를 쓴다.

출처: `docs/GO-LIVE.md` 3-1의 6번, D-54.

## 5. Vercel 토큰 만들기

1. **어디서:** 오른쪽 위 프로필 → **Account Settings** → **Tokens**.
   **누를 것:** 새 토큰 만들기 **(버튼 이름 확인 필요)**.
2. **입력할 것:**
   - 이름: `alarmops-deploy-console`처럼 용도를 알 수 있게
   - Scope: 회사 팀 `<팀>` (개인 계정 아님)
   - Expiration: 만료일을 둔다(예: 90일). "만료 없음"을 고르지 않는다.
3. **누를 것:** 만들기 **(버튼 이름 확인 필요)**.
   **확인:** 토큰 값이 화면에 **한 번만** 보인다. 복사해 바로 7단계 4번에서 GitHub에 넣는다.

   > **주의** 토큰 값은 GitHub 환경 시크릿 말고 어디에도 적지 않는다. 창을 닫아 값을 잃었으면 지우고 새로 만든다.

   > **주의** 만료일을 달력에 적는다. 만료되면 배포가 `vercel pull` 단계에서 실패한다.

출처: `docs/GO-LIVE.md` 3-2의 1번. (vercel.com/docs/rest-api 의 토큰 절은 열지 못했다.)

## 6. Team ID와 Project ID 찾기

1. **어디서:** 프로젝트 → **Settings** → **General**.
   **확인:** **Project ID** 칸(`prj_`로 시작) **(접두어 확인 필요)**. 복사해 둔다.
2. **어디서:** 팀 → **Settings** → General **(위치 확인 필요)**.
   **확인:** **Team ID** 칸(`team_`로 시작) **(접두어 확인 필요)**. 복사해 둔다. 이 값이 `VERCEL_ORG_ID`다.
3. 다른 방법: 본인 PC에서 `vercel link`를 한 뒤 생기는 `.vercel/project.json`의 `orgId`·`projectId`.

   > **주의** `.vercel/project.json`은 커밋하지 않는다. 다 쓰면 `.vercel` 폴더를 지운다.

두 값은 비밀이 아니지만 워크플로가 시크릿으로 읽으므로 시크릿으로 넣는다.

출처: `docs/GO-LIVE.md` 3-2의 2번.

## 7. GitHub `production` 환경과 시크릿

워크플로 `deploy-console`은 `environment: production`에서 돈다. 시크릿 세 개는 이 환경의 **환경 시크릿**이어야 한다(`.github/workflows/deploy-console.yml`).

1. **어디서:** GitHub 저장소 `hkjs96/alarmops` → **Settings** → **Environments** → **New environment**.
   **입력할 것:** 이름 `production` (글자 그대로).
   **누를 것:** **Configure environment** **(버튼 이름 확인 필요)**.
   **확인:** `production` 환경 설정 화면이 열린다.

   > **주의** `production-db`(운영 DB), `dev`(개발 DB)를 재사용하지 않는다. 각각 다른 환경이다.

2. **어디서:** 같은 화면의 **Required reviewers**.
   **입력할 것:** 체크하고 본인 `<사용자명>`을 넣는다.
   - **Prevent self-review**: 승인자가 본인 한 명뿐이면 **켜지 않는다.** 켜면 실행한 사람(본인)이 승인할 수 없어 배포가 멈춘다. 승인자가 두 명 이상이 되면 켠다.
   **누를 것:** **Save protection rules** **(버튼 이름 확인 필요)**.

3. **어디서:** 같은 화면의 **Allow administrators to bypass configured protection rules**.
   **입력할 것:** **끈다.** 켜 두면 관리자는 승인 없이 배포할 수 있다.

4. **어디서:** 같은 화면의 **Deployment branches and tags**.
   **입력할 것:** **Selected branches and tags** **(항목 이름 확인 필요)** → 규칙 추가 **(버튼 이름 확인 필요)** → `main` → 저장.
   **확인:** 다시 열어도 `main` 하나만 있다.

   > **주의** 수동 실행은 고른 브랜치의 워크플로 파일로 돈다. 브랜치 제한이 없으면 다른 브랜치가 이 시크릿을 읽을 수 있다. 워크플로에도 `main`만 허용하는 조건이 있지만 이 제한이 첫 번째 관문이다.

5. **어디서:** 같은 화면의 **Environment secrets** → **Add environment secret**.
   **입력할 것:** 세 개를 하나씩 넣는다. 이름은 글자 그대로.

   | Name | Value |
   |---|---|
   | `VERCEL_TOKEN` | 5단계 토큰 |
   | `VERCEL_ORG_ID` | 6단계 Team ID |
   | `VERCEL_PROJECT_ID` | 6단계 Project ID |

   **확인:** `production` 화면에 세 이름이 보인다(값은 안 보인다).

   > **주의** **Repository secrets**(저장소 시크릿)에 넣지 않는다. 저장소 시크릿은 모든 워크플로가 읽는다. 이름이 틀리거나 저장소 시크릿에 넣으면 배포가 `Secret VERCEL_… is not set in the production environment`로 멈춘다.

출처: `.github/workflows/deploy-console.yml`, `docs/GO-LIVE.md` 3-2, `docs/SETUP-PROD-DB.md` 4단계. (docs.github.com 의 "Managing environments for deployment" 는 열지 못했다.)

## 8. Vercel 환경변수 넣기 (Production만)

### 8-1. 비밀 만들기

1. **어디서:** 본인 PC의 Git Bash.
   **입력할 것:** 아래 명령을 **세 번** 실행한다. `SESSION_SECRET`, `TICK_SECRET`, `VERIFY_HASH_SECRET`에 하나씩 쓴다.
   ```bash
   openssl rand -base64 48
   ```
   **확인:** 64자가 나온다(32자 이상이어야 한다). 비밀번호 관리자에 이름과 함께 저장한다.

   > **주의** 회사 PC 개발용 설정의 `SESSION_SECRET`과 다른 값을 쓴다. 세 값도 서로 다르게 한다.

### 8-2. 변수 하나 넣는 법

1. **어디서:** 프로젝트 → **Settings** → **Environment Variables**.
2. **입력할 것:** Key 칸에 이름, Value 칸에 값 **(칸 이름 확인 필요)**.
3. **입력할 것:** Environments 체크는 **Production만** 켠다. Preview, Development는 끈다.
4. **입력할 것:** **Sensitive** 스위치는 아래 표의 "Sensitive?" 열대로 한다.
5. **누를 것:** **Save** **(버튼 이름 확인 필요)**.
   **확인:** 목록에 이름과 환경 `Production`이 보인다.

   > **주의** **Sensitive로 넣은 값은 `vercel pull`로 내려오지 않는다.** 배포 전 검사(`check-console-deploy-env.mjs`)는 내려온 값만 본다. 그래서 검사가 읽는 변수(`CONSOLE_ORIGIN`, `TRUSTED_PROXY`, `GOOGLE_CLIENT_ID`, `SSO_ALLOWED_DOMAINS`)는 반드시 **Plain**이다. Sensitive로 넣으면 검사가 "not set"으로 실패한다.

   > **주의** 이미 만든 변수의 Sensitive 여부는 바꾸지 못할 수 있다 **(확인 필요)**. 그러면 지우고 새로 만든다.

### 8-3. 넣을 변수

| 변수 | 값 | Sensitive? | 언제 |
|---|---|---|---|
| `CONSOLE_ORIGIN` | `https://<프로젝트>.vercel.app` (4단계) | **Plain 필수** | 지금 |
| `TRUSTED_PROXY` | `1` | **Plain 필수** | 지금 |
| `DATABASE_URL` | 운영 DB Transaction pooler(6543) 주소 | Sensitive | 지금 |
| `DATABASE_POOLER` | `transaction` | Plain | 지금 |
| `SESSION_SECRET` | 8-1의 값 | Sensitive | 지금 |
| `TICK_SECRET` | 8-1의 값 | Sensitive | 지금 |
| `VERIFY_HASH_SECRET` | 8-1의 값 | Sensitive | 지금 |
| `GOOGLE_CLIENT_ID` | `docs/SETUP-GOOGLE-SSO.md` | **Plain 필수** | 지금 |
| `GOOGLE_CLIENT_SECRET` | 같은 가이드 | Sensitive | 지금 |
| `SSO_ALLOWED_DOMAINS` | 같은 가이드 | **Plain 필수** | 지금 |
| `SSO_ALLOWED_EMAILS` | 예외 주소(없으면 만들지 않음) | Sensitive 권장 | 선택 |
| `ALARM_COMMANDS_QUEUE_URL` | 4-5 | Plain | 4단계 후 |
| `ALARM_COMMANDS_EXPECTED_ACCOUNT` | 4-5 | Plain | 4단계 후 |
| `AWS_ROLE_ARN` | 4-5 | Plain | 4단계 후 |
| `CENTRAL_ROLE_ARN` | 중앙 배포 출력 `CentralRoleArn` | Plain | 4단계 후 |
| `CENTRAL_EVENT_BUS_ARN` | 중앙 배포 출력 `CentralBusArn` | Plain | 4단계 후 |
| `REMEDIATOR_CALLER_ROLE_ARN` | 중앙 배포 출력 | Plain | 4단계 후, Remediator 쓸 때만 |
| `MOCK_API`, `E2E_ALLOW_MOCK` | — | — | **절대 넣지 않는다** |

값 규칙:

- `CONSOLE_ORIGIN`: `https://호스트`까지만 쓴다. 끝의 `/`, 경로, `?`, `#`, 사용자 정보가 있으면 검사가 실패한다. `http://`도 안 된다.
- `TRUSTED_PROXY`: 정확히 `1`. `true`나 ` 1`(공백)은 안 된다.
- `DATABASE_URL`: 끝에 `?pgbouncer=true&connection_limit=1`. 만드는 법은 `docs/SETUP-PROD-DB.md` 3단계.
- `SSO_ALLOWED_DOMAINS`: 쉼표 구분 도메인. `*`, 공백 섞인 항목, `@`가 든 항목은 안 된다.
- `SSO_ALLOWED_EMAILS`: Plain으로 넣으면 검사가 항목마다 정확한 주소인지 본다. Sensitive로 두면 검사하지 않는다.
- Sensitive 변수(`DATABASE_URL`, `SESSION_SECRET`, `TICK_SECRET`, `VERIFY_HASH_SECRET`, `GOOGLE_CLIENT_SECRET`)는 검사가 볼 수 없다. 빠지면 배포는 통과하고 실행 중에 실패한다(로그인 unavailable, 틱 503). 그래서 넣은 뒤 목록에서 이름을 눈으로 확인한다.
- "4단계 후" 변수는 지금 넣지 않는다. GO-LIVE 4-5에서 넣는다.

6. **확인:** 목록에 `MOCK_API`, `E2E_ALLOW_MOCK`이 **없다**. 값이 비어 있어도 있으면 검사가 실패한다.

출처: `.github/scripts/check-console-deploy-env.mjs`, `.github/scripts/strip-deploy-env.mjs`, `docs/GO-LIVE.md` 3-3, `docs/SETUP-GOOGLE-SSO.md`, `apps/console/README.md`. (vercel.com/docs/environment-variables 는 열지 못했다.)

## 9. 첫 배포

1. **어디서:** GitHub 저장소 → **Actions** 탭 → 왼쪽 목록 **deploy-console**.
   **누를 것:** 오른쪽 **Run workflow**.
2. **입력할 것:** **Use workflow from**(브랜치) **(칸 이름 확인 필요)** = `main`. 이 워크플로에는 다른 입력칸이 없다.
   **누를 것:** 초록색 **Run workflow**.
   **확인:** 새 실행이 목록 맨 위에 생기고 "Waiting" 상태다. 바로 실행되면 7단계 2번(Required reviewers)이 빠진 것이다. 취소하고 7단계로 간다.

   > **주의** `main` 말고 다른 브랜치를 고르면 작업이 건너뛰어진다(Skipped).

3. **어디서:** 실행 화면의 **Review deployments**.
   **누를 것:** `production` 체크 → **Approve and deploy**.
   **확인:** 작업 `deploy`가 시작된다.

4. **어디서:** 실행 로그. 아래 단계가 차례로 초록이어야 한다.
   - `Check the Vercel settings are present`
   - `Pull the production environment from Vercel`
   - `Check the console deploy environment` → `console deploy environment ok (...)`
   - `Strip secrets from the pulled environment` → `kept N variable(s): ...`
   - `Build (prebuilt output, production), without the token`
   - `Deploy the prebuilt output`
   - `Smoke check` → `smoke ok (...)`
   - `Delete the pulled environment`

5. **어디서:** 실행 화면 아래의 요약(Summary).
   **확인:** `Deployment: https://….vercel.app`이 보인다.

   스모크 검사(`.github/scripts/smoke-console.mjs`)는 `CONSOLE_ORIGIN` 주소에서 이것을 본다.
   - `GET /login`이 200이고 mock 표식이 없다.
   - CSP `script-src`에 nonce가 있고 `'unsafe-inline'`·`'unsafe-eval'`이 없다. 두 번 요청한 nonce가 다르다.
   - 인증 없는 `POST /api/internal/tick`이 콘솔 자신의 401(`UNAUTHENTICATED`)이다.

6. **어디서:** 브라우저.
   **입력할 것:** `https://<프로젝트>.vercel.app/login`.
   **확인:** 로그인 화면이 보인다. "Mock mode" 같은 문구가 없다.

스모크가 실패하면 바로 11단계로 간다. 새 배포는 이미 production에 올라가 있다.

출처: `.github/workflows/deploy-console.yml`, `.github/scripts/smoke-console.mjs`, `docs/SETUP-SUPABASE.md` 6단계(Run workflow·Review deployments 이름). (docs.github.com 의 "Manually running a workflow", "Reviewing deployments" 는 열지 못했다.)

## 10. Deployment Protection 확인

목표: production 주소는 공개, 배포별 미리보기 주소는 보호.

1. **어디서:** 프로젝트 → **Settings** → **Deployment Protection**.
   **누를 것:** Vercel Authentication 항목 **(화면 이름 확인 필요)**.
   **입력할 것:** **Standard Protection**.
   **누를 것:** **Save**.
   **확인:** 로그아웃한 브라우저(시크릿 창)에서 `https://<프로젝트>.vercel.app/login`이 Vercel 로그인 화면이 아니라 콘솔 로그인 화면이다.

   > **주의** 모든 배포를 보호하는 항목(예: "All Deployments") **(화면 이름 확인 필요)**을 고르면 production 주소도 막혀 스모크가 401로 실패한다.

2. 고쳤으면 9단계 1번부터 다시 한다.

출처: `docs/GO-LIVE.md` 3-4의 6번. (vercel.com/docs/deployment-protection 은 열지 못했다.)

## 11. 스모크 검사가 실패했을 때 되돌리기

> **주의** 실패한 배포는 이미 production에 올라가 있다. 바로 되돌린다.

1. **어디서:** Vercel 프로젝트 → **Deployments**.
   **누를 것:** 직전의 정상 production 배포 줄의 `...` 메뉴 → **Promote to Production**(Instant Rollback). 프로젝트 첫 화면에 **Instant Rollback** 버튼이 있으면 그것을 눌러도 된다 **(버튼 위치 확인 필요)**.
   **확인:** 그 배포가 Production(Current)으로 표시된다 **(표시 이름 확인 필요)**.
   - 다른 방법: 본인 터미널에서 `vercel rollback`.
   - 첫 배포라 직전 배포가 없으면 되돌릴 것이 없다. 3번으로 간다.

2. **어디서:** 본인 Git Bash.
   ```bash
   curl -s -o /dev/null -w "%{http_code}" https://<프로젝트>.vercel.app/login
   curl -s -o /dev/null -w "%{http_code}" -X POST https://<프로젝트>.vercel.app/api/internal/tick
   ```
   **확인:** 첫 줄 `200`, 둘째 줄 `401`.

3. 아래 [막혔을 때](#막혔을-때)에서 원인을 고치고 9단계를 다시 한다.

   > **주의** 되돌린 동안 1분 틱이 멈출 수 있다. GO-LIVE 3-5의 4번으로 확인한다.

출처: `docs/GO-LIVE.md` 3-6. (vercel.com/docs/instant-rollback 은 열지 못했다.)

## 막혔을 때

| 화면에 나온 글 | 할 일 |
|---|---|
| 작업 `deploy`가 Skipped | `main`이 아닌 브랜치로 실행했다. 9단계 2번 |
| `Secret VERCEL_TOKEN is not set in the production environment` (ORG_ID, PROJECT_ID도 같은 모양) | 저장소 시크릿에 넣었거나 이름이 다르다. 7단계 5번 |
| `Pull the production environment` 단계 실패 | 토큰 만료·범위 오류, 또는 ID가 다른 팀·프로젝트 것. 5·6단계 |
| `CONSOLE_ORIGIN is not set (...)` | 없거나 Sensitive로 넣었다. Plain으로 다시 만든다. 8-2 |
| `CONSOLE_ORIGIN is not a URL` / `must be an https origin` | `https://<프로젝트>.vercel.app` 모양으로 고친다 |
| `CONSOLE_ORIGIN must be only scheme://host[:port], ...` | 끝의 `/`나 경로를 지운다 |
| `TRUSTED_PROXY must be exactly 1` | Plain으로 `1`. 공백 없이 |
| `MOCK_API must not be present ...` / `E2E_ALLOW_MOCK must not be present ...` | 변수 자체를 지운다. 빈 값도 안 된다 |
| `GOOGLE_CLIENT_ID is not set (...)` | Plain으로 넣는다 |
| `SSO_ALLOWED_DOMAINS is not set or empty ...` | Plain으로 넣는다 |
| `SSO_ALLOWED_DOMAINS entry #N is not a plain domain ...` | N번째 항목의 `*`·공백·`@`를 없앤다 |
| `SSO_ALLOWED_EMAILS entry #N is not an exact e-mail address` | N번째 주소를 고치거나 Sensitive로 다시 만든다 |
| `unexpected output from vercel deploy (...)` | 허브에 실행 링크를 알린다. 11단계로 확인 |
| `smoke: GET /login answered 503, expected 200` | 실행 중 `CONSOLE_ORIGIN`이 빠졌다. 8단계 확인 후 11단계 |
| `smoke: GET /login contains a mock marker (...)` | `MOCK_API`가 들어갔다. 지우고 11단계 |
| `smoke: POST /api/internal/tick answered 503: TICK_SECRET is not configured ...` | `TICK_SECRET`이 없거나 32자 미만. 넣고 11단계 → 9단계 |
| `smoke: POST /api/internal/tick answered 401 but not with the console error body (...)` | Deployment Protection이 막고 있다. 10단계 |
| `smoke: CSP ...` / `two requests got the same CSP nonce (HTML cached?)` | 허브에 알린다. CDN을 뒀으면 GO-LIVE 3-7 |
| `smoke: request failed after 5 tries: ...` | 주소가 틀렸거나 배포가 안 떴다. 4단계 주소와 `CONSOLE_ORIGIN` 비교 |
| `/login`에 "unavailable"이 보임 | `GOOGLE_CLIENT_SECRET`·`SESSION_SECRET`(Sensitive)이 빠졌다. 8단계 목록 확인 |
| main 머지 뒤 Vercel에 새 배포가 Ready로 생김 | Git 자동 배포가 켜져 있다. 3단계 |
