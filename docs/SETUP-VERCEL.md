# Vercel 콘솔 배포 따라 하기

이 문서는 AlarmOps 콘솔을 Vercel에 처음 배포하는 사람을 위한 화면별 순서다. `docs/GO-LIVE.md` 3-1~3-4·3-6은 체크 항목만 두고 이 문서의 단계를 그대로 가져다 쓴다(문서 포털에서는 그 자리에 펼쳐 보인다). 화면별 순서는 이 문서 한 곳에서만 고친다.

- 처음 한 번만 하면 된다.
- 1시간쯤 걸린다.
- 끝나면 `https://<프로젝트>.vercel.app/login`에 운영 콘솔이 열린다. 배포는 GitHub Actions에서 본인이 승인할 때만 일어난다(D-53).

> **참고** 버튼·메뉴 이름은 11/18에 Vercel·GitHub 공식 문서에서 확인했다. 각 단계 끝에 출처를 적었다. 문서에도 이름이 없는 곳은 **(화면 이름 확인 필요)**로 남겼다. 화면 이름이 조금 달라도 **용도**가 같은 것을 고른다. 다르면 허브에 알려 이 문서를 고친다.

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

1. **어디서:** https://vercel.com 에 로그인한다(파일럿에는 회사 계정, PoC 동안은 개인 계정도 된다, D-57).
   **누를 것:** 대시보드의 **team switcher**(팀 전환 메뉴).
   **확인:** 쓸 범위가 선택되어 있다. 파일럿에는 회사 팀 `<팀>`(Pro), PoC 동안은 개인 Hobby 범위도 된다(D-57).

2. **어디서:** 팀의 **Settings** → 요금제 화면 **(화면 이름 확인 필요)**.
   **확인:** 파일럿에서는 요금제가 **Pro**다. 운영 조건이 Vercel Pro이기 때문이다(D-10). PoC 동안 개인 Hobby를 쓰면 이 확인은 건너뛴다(D-57).

   > **주의** 개인(Hobby) 범위에 프로젝트를 만들면 이후 토큰·Team ID가 모두 그 범위로 묶인다. Hobby는 되돌리기도 바로 전 배포로만 된다. PoC 동안은 Hobby를 써도 되지만(D-57), 파일럿 전에 회사 Pro 팀으로 옮긴다.

출처: `docs/decisions/DECISIONS.md` D-10, https://vercel.com/docs/monorepos, https://vercel.com/docs/instant-rollback

## 2. GitHub 저장소 가져오기(Import)

> **참고** 아래 화면 이름은 2026-11-19에 실제 **New Project** 화면으로 확인했다(사용자 캡처). 이 저장소는 앱이 둘(`apps/console` Next.js, `services/alarm-engine` Python)이라 Vercel이 "여러 앱"으로 알아본다. 그래서 일반적인 가져오기 화면과 다르다.

1. **어디서:** Vercel 대시보드.
   **누를 것:** **Create New** → **Project**.
   **확인:** **Import Git Repository** 목록이 보인다.

2. **어디서:** 같은 화면. 목록에 `hkjs96/alarmops`가 없을 때만 한다.
   **누를 것:** GitHub 연결·권한 조정 링크 **(화면 이름 확인 필요)** → GitHub 화면에서 Vercel 앱의 저장소 접근을 **Only select repositories**(선택한 저장소만) **(화면 이름 확인 필요)** → `hkjs96/alarmops` 하나만 고르고 저장.
   **확인:** Vercel 목록에 `hkjs96/alarmops`가 보인다.

   > **주의** **All repositories**(모든 저장소)를 고르지 않는다. 이 저장소 하나만 준다.

3. **어디서:** **Import Git Repository**의 `hkjs96/alarmops` 줄.
   **누를 것:** **Import**.
   **확인:** **New Project** 화면이 열리고, 맨 위에 "Importing from GitHub `hkjs96/alarmops` `main`"이 보인다.

4. **어디서:** **New Project** 화면의 **Vercel Team**.
   **입력할 것:** PoC 동안은 개인 **Hobby** 범위를 써도 된다(D-57). 회사 Pro 팀이 생기면 그 팀을 고른다.
   **확인:** 고른 범위를 메모해 둔다. 5단계 토큰의 Scope와 6단계 Team ID가 모두 이 범위다.

   > **주의 (Hobby로 진행할 때, D-57)** Hobby는 개인 무료 범위다. 실제 고객 데이터·실제 고객 연락처는 넣지 않는다(시험용 데이터만). 파일럿 전에 회사 Pro 팀으로 새 프로젝트를 만들어 옮긴다. 옮길 때는 5~8단계(토큰, ID, GitHub 시크릿, 환경변수)를 새 팀 기준으로 다시 한다.

5. **어디서:** 같은 화면의 **Project Name**.
   **입력할 것:** `alarmops-console`처럼 콘솔임을 알 수 있는 이름. 이 이름이 production 주소(`<프로젝트>.vercel.app`, 4단계)가 된다.

6. **어디서:** 같은 화면의 **Root Directory**(`./`)와 **Application Preset**(**Services**) 아래.
   **확인:** "Multiple applications detected in this directory"라는 문장과, 앱 목록 `apps/console`(**console**, Next.js)과 `services/alarm-engine`(**alarm-engine**, Python)이 보인다.

7. **어디서:** 앱 목록의 **console**(Next.js) 줄.
   **누를 것:** **Import single project →**.
   **확인:** console 하나만 가져오는 설정 화면으로 바뀐다. 맨 위가 "Importing from GitHub `hkjs96/alarmops` `main` `apps/console`"로 바뀌고, **Root Directory**가 `apps/console`, **Application Preset**이 **Next.js**다. 아래에 **Build and Output Settings**, **Environment Variables**(둘 다 접힘)와 **Deploy** 버튼이 있다(11/19 실제 화면 확인). **Project Name**이 `alarmops`로 바뀌어 있으면 `alarmops-console`로 다시 고친다.

   > **주의** **alarm-engine** 줄은 누르지 않는다. 알람 엔진은 Vercel이 아니라 AWS Lambda로 배포한다(D-09, GO-LIVE 4단계).

   > **주의** 아래의 **Import multi-service project**와 **Copy prompt**는 쓰지 않는다. `vercel.json`을 만들어 여러 앱을 한 프로젝트로 묶으라는 제안인데, 이 저장소는 콘솔 하나만 Vercel에 올린다. `vercel.json`도 만들지 않는다.

8. **어디서:** 바뀐 화면의 **Build and Output Settings**(접힌 칸, 펼쳐서 확인).
   **입력할 것:** 아무것도 바꾸지 않는다. **Build Command**, **Output Directory**, **Install Command** 세 칸 모두 회색 기본값이고 오른쪽 연필 스위치(Override)가 꺼져 있으면 된다(11/19 실제 화면 확인).
   - 이유: 저장소는 루트 `package.json`의 npm workspaces(`apps/*`, `packages/*`, `services/*`, `db`)다. Vercel은 npm workspaces를 지원한다. 저장소에는 `vercel.json`이 없다.
   - 실제 빌드는 Vercel이 아니라 GitHub Actions가 한다. 워크플로가 저장소 루트에서 `npm ci --ignore-scripts`를 먼저 돌리고 `vercel build --prod`를 실행한다.

9. **어디서:** **Environment Variables**(접힌 칸).
   **입력할 것:** 비워 둔다. 펼쳐 봤다면 **Key**·**Value** 칸을 비운 채 두면 되고, **Import .env**·**Add More**도 누르지 않는다. 값은 8단계에서 넣는다.

10. **누를 것:** **Deploy**.
    **확인:** 첫 자동 배포가 시작된다.
    - **Verify Your Identity** 창이 뜨면 Vercel 계정 메일로 온 6자리 코드를 넣고 **Verify Code**를 누른다. 정상 본인 확인이다.
    - 1~2분 뒤 **Deployed to Production**이 나오고 미리보기에 `Misconfigured: CONSOLE_ORIGIN is required in production.`이 보이면 **예상된 결과**다(환경변수가 아직 없음). 8단계 뒤에 사라진다. **Onboard Your Agent**, **Add Domain**, **Enable Speed Insights**는 누르지 않는다. **Continue to Project**로 넘어간다(11/19 실제 화면 확인).

11. **어디서:** 배포 진행 화면 또는 프로젝트 → **Deployments** → 진행 중인 배포의 `⋮` 메뉴.
    **누를 것:** 취소(Cancel) **(화면 이름 확인 필요)**.
    **확인:** 배포 상태가 Canceled다.
    - 이미 실패(Error)로 끝났으면 그대로 둔다. 환경변수가 없어서 실패하는 것은 예상된 결과다. 프로젝트는 만들어졌고 해가 없다.
    - 이미 성공(Ready)했으면 9단계 전까지 그 주소를 쓰지 않는다. 환경변수가 없는 콘솔은 production에서 모든 요청에 503을 준다(`CONSOLE_ORIGIN` 없음).

12. **어디서:** 프로젝트 → **Settings** → **Build and Deployment** → **Root Directory**.
    **확인:** `apps/console`이다. **Include files outside the root directory in the Build Step**이 켜져 있다(기본값). 끄면 `packages/*`를 못 읽어 빌드가 실패한다.

출처: 실제 New Project 화면(2026-11-19), https://vercel.com/docs/monorepos, https://vercel.com/docs/builds/configure-a-build, `.github/workflows/deploy-console.yml` 머리 주석, 루트 `package.json`

## 3. Git 자동 배포 끄기 (D-53)

이걸 끄지 않으면 main에 푸시할 때마다 승인·검사 없이 Vercel이 바로 배포한다. 아래 둘 중 **하나**를 한다.

1. **방법 A(권장): Git 연결 해제.**
   **어디서:** 프로젝트 → **Settings** → **Git**. 왼쪽 메뉴에 **Git**이 안 보이면 왼쪽 위 **Find**(단축키 `F`)에 `git`을 치고 **Git — `<프로젝트>` / Settings**를 고른다. 팀 이름(`… projects / Settings`)으로 된 항목은 팀 설정이라 고르지 않는다(11/19 실제 화면 확인).
   **누를 것:** **Connected Git Repository** 칸의 `hkjs96/alarmops` 줄 오른쪽 **Disconnect** → **Remove Git Connection** 창에서 **Remove Connection**. 창의 "설정은 유지된다" 안내대로 프로젝트 설정·환경변수는 지워지지 않는다(11/19 실제 화면 확인).
   **확인:** 연결된 저장소가 없다고 나온다. 워크플로는 Git 연결 없이도 `vercel pull`·`vercel deploy`로 배포한다.

2. **방법 B: 빌드 건너뛰기.**
   **어디서:** 프로젝트 → **Settings** → **Build and Deployment** → **Ignored Build Step**.
   **입력할 것:** **Don't build anything**을 고른다.
   **누를 것:** **Save**.
   **확인:** 저장 후 다시 열어도 그 값이다.
   - 이 방법은 푸시마다 배포가 생겼다가 `CANCELED`로 끝난다. 취소된 빌드도 배포 횟수와 동시 빌드 한도에 들어간다. 그래서 방법 A를 권한다.

3. **확인:** 다음에 main에 머지가 일어난 뒤 프로젝트 → **Deployments**를 연다. 방법 A면 새 배포가 없다. 방법 B면 새 배포가 `CANCELED`다.

   > **주의** 새 배포가 Ready로 생겼으면 설정이 저장되지 않은 것이다. 바로 다시 한다.

출처: https://vercel.com/docs/project-configuration/git-settings, https://vercel.com/docs/project-configuration/project-settings (Ignored Build Step), https://vercel.com/docs/monorepos

## 4. production 주소 적어 두기

1. **어디서:** 프로젝트 → **Settings** → **Domains**(또는 프로젝트 첫 화면의 Domains 칸).
   **확인:** `<프로젝트>.vercel.app` 모양 주소가 있다.
2. **입력할 것:** `https://<프로젝트>.vercel.app`를 메모한다. 8단계 `CONSOLE_ORIGIN`에 그대로 쓴다. 스모크 검사가 이 주소를 부른다.

   > **주의** 배포마다 생기는 긴 주소(`<프로젝트>-<글자>-<팀>.vercel.app`)가 아니다. Domains에 있는 짧은 production 주소를 쓴다. 긴 주소는 10단계의 보호를 받는다.

출처: D-54, https://vercel.com/docs/project-configuration/project-settings

## 5. Vercel 토큰 만들기

1. **어디서:** https://vercel.com/account/tokens (열면 `vercel.com/account/settings/tokens`로 바뀐다. 계정 **Settings** → **Tokens**의 **Create Token** 칸).
2. **입력할 것:** (11/19 실제 화면: **TOKEN NAME**, **SCOPE**, **EXPIRATION** 세 칸. 개인 Hobby 범위를 고르면 프로젝트 목록은 따로 나오지 않는다.)
   - 토큰 이름: `alarmops-deploy-console`처럼 용도를 알 수 있게
   - **Scope**: 2-4에서 고른 범위(회사 팀 `<팀>`, PoC 동안은 개인 Hobby 범위)를 고른다. **Full Account**를 고르지 않는다. 팀을 고르면 프로젝트 목록이 열린다. **All Projects**를 고른다.
   - 만료(expiration): 기한을 둔다(예: 90일).
3. **누를 것:** **Create**.
   **확인:** 토큰 값이 화면에 **한 번만** 보인다. 복사해 바로 7단계 5번에서 GitHub에 넣는다. 다시 볼 수 없다.

   > **참고** Scope에서 이 프로젝트 하나만 고르면(프로젝트 범위 토큰) 더 좁다. 이 워크플로(`vercel pull`·`vercel deploy`)가 프로젝트 범위 토큰으로 되는지는 아직 시험하지 않았다. 처음에는 팀의 **All Projects**로 하고, 바꾸려면 허브에 묻는다.

   > **주의** 토큰 값은 GitHub 환경 시크릿 말고 어디에도 적지 않는다. 창을 닫아 값을 잃었으면 지우고 새로 만든다.

   > **주의** 만료일을 달력에 적는다. 만료되면 배포가 `vercel pull` 단계에서 실패한다.

출처: https://vercel.com/docs/accounts/access-tokens

## 6. Team ID와 Project ID 찾기

1. **어디서:** 프로젝트 → **Settings** → **Project Basics**(예전 이름 General).
   **확인:** **Project ID** 칸(`prj_…`). 복사해 둔다.
2. **어디서:** 왼쪽 위 팀 이름 → 팀 **Settings** → **Team Basics**(예전 이름 General) → 아래로 내려 **Team ID**. Hobby 개인 범위에도 있다.
   **확인:** Team ID 칸(`team_…`). 복사해 둔다. 이 값이 `VERCEL_ORG_ID`다.
   - 바로 가는 주소: `https://vercel.com/teams/<팀>/settings#team-id`
3. 다른 방법: 본인 PC에서 `vercel link`를 한 뒤 생기는 `.vercel/project.json`의 `orgId`·`projectId`.

   > **주의** `.vercel/project.json`은 커밋하지 않는다. 다 쓰면 `.vercel` 폴더를 지운다.

두 값은 비밀이 아니지만 워크플로가 시크릿으로 읽으므로 시크릿으로 넣는다.

출처: https://vercel.com/docs/accounts/create-a-team (Find your team ID), https://vercel.com/docs/project-configuration/project-settings (General settings)

## 7. GitHub `production` 환경과 시크릿

워크플로 `deploy-console`은 `environment: production`에서 돈다. 시크릿 세 개는 이 환경의 **환경 시크릿**이어야 한다(`.github/workflows/deploy-console.yml`).

> **참고** 비공개 저장소의 환경은 GitHub Team(조직) 또는 GitHub Pro(개인)에서만 만들 수 있다. Settings에 **Environments**가 없으면 요금제를 확인한다.

1. **어디서:** GitHub 저장소 `hkjs96/alarmops` → **Settings** → 왼쪽 **Environments** → **New environment**.
   **입력할 것:** 이름 `production` (글자 그대로).
   **누를 것:** **Configure environment**.
   **확인:** `production` 환경 설정 화면이 열린다.

   > **주의** 목록에 이미 있는 `dev`(개발 DB 마이그레이션용, 시크릿 2개)는 건드리지 않는다. `production-db`(운영 DB)도 재사용하지 않는다. 각각 다른 환경이다.

2. **어디서:** 같은 화면의 **Required reviewers**.
   **입력할 것:** 체크하고 **Search for people or teams…** 칸에 본인 `<사용자명>`을 넣는다(최대 6명, 한 명만 승인하면 된다).
   - **Prevent self-review**: 승인자가 본인 한 명뿐이면 **켜지 않는다.** 켜면 실행한 사람(본인)이 승인할 수 없어 배포가 멈춘다. 승인자가 두 명 이상이 되면 켠다.
   **누를 것:** **Save protection rules**.

3. **어디서:** 같은 화면의 **Allow administrators to bypass configured protection rules**.
   **입력할 것:** 체크를 **끈다.** 켜 두면 관리자는 승인 없이 배포할 수 있다.
   **누를 것:** **Save protection rules**.

4. **어디서:** 같은 화면의 **Deployment branches** 드롭다운.
   **입력할 것:** **Selected branches and tags** → **Add deployment branch or tag rule** → "Ref type"에서 **Branch** → 이름 `main` → **Add rule**.
   **확인:** 다시 열어도 `main` 하나만 있다.

   > **주의** 수동 실행은 고른 브랜치의 워크플로 파일로 돈다. 브랜치 제한이 없으면 다른 브랜치가 이 시크릿을 읽을 수 있다. 워크플로에도 `main`만 허용하는 조건이 있지만 이 제한이 첫 번째 관문이다.

5. **어디서:** 같은 화면의 **Environment secrets** → **Add environment secret**(11/19 실제 화면). 아래 **Environment variables** 칸이 아니다.
   **입력할 것:** 이름과 값을 넣고 **Add secret**. 세 개를 하나씩 넣는다. 이름은 글자 그대로.

   | 이름 | 값 |
   |---|---|
   | `VERCEL_TOKEN` | 5단계 토큰 |
   | `VERCEL_ORG_ID` | 6단계 Team ID |
   | `VERCEL_PROJECT_ID` | 6단계 Project ID |

   **확인:** `production` 화면에 세 이름이 보인다(값은 안 보인다).

   > **주의** **Repository secrets**(저장소 시크릿)에 넣지 않는다. 저장소 시크릿은 모든 워크플로가 읽는다. 환경 시크릿은 승인 등 규칙을 통과한 작업만 읽는다. 이름이 틀리거나 저장소 시크릿에 넣으면 배포가 `Secret VERCEL_… is not set in the production environment`로 멈춘다.

출처: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments, `.github/workflows/deploy-console.yml`

## 8. Vercel 환경변수 넣기 (Production만)

> **참고** Vercel은 예전 **Sensitive** 스위치를 **Type**의 **Config**/**Secret** 두 가지로 바꿨다. 이 저장소 문서의 "Plain"은 **Config**, "Sensitive"는 **Secret**이다. 예전에 만든 Sensitive 변수는 Secret으로 보인다.

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
2. **입력할 것:** **Type**에서 **Config** 또는 **Secret**을 고른다. 아래 표의 "종류" 열대로 한다.
3. **입력할 것:** Key(이름), **Value**(값).
4. **입력할 것:** 적용 환경은 **Production만** 고른다. Preview, Development는 고르지 않는다.
5. **누를 것:** **Save**.
   **확인:** 목록에 이름, 환경 `Production`, **Config** 또는 **Secret** 표시가 보인다.

   > **주의** **Secret 값은 저장 뒤 읽을 수 없고 `vercel pull`로 내려오지 않는다.** 배포 전 검사(`check-console-deploy-env.mjs`)는 내려온 값만 본다. 그래서 검사가 읽는 변수(`CONSOLE_ORIGIN`, `TRUSTED_PROXY`, `GOOGLE_CLIENT_ID`, `SSO_ALLOWED_DOMAINS`)는 반드시 **Config**다. Secret으로 넣으면 검사가 "not set"으로 실패한다.

   > **주의** 저장한 Secret을 Config로 바꿀 수 없다. 잘못 넣었으면 지우고 Config로 새로 만든다.

   > **참고** 팀에 "Production은 다른 값" 정책이 켜져 있으면 **Production must use a separate value.**가 뜬다. Production만 고르면 해당 없다.

### 8-3. 넣을 변수

| 변수 | 값 | 종류 | 언제 |
|---|---|---|---|
| `CONSOLE_ORIGIN` | `https://<프로젝트>.vercel.app` (4단계) | **Config 필수** | 지금 |
| `TRUSTED_PROXY` | `1` | **Config 필수** | 지금 |
| `DATABASE_URL` | 운영 DB Transaction pooler(6543) 주소. **PoC 동안(D-57)은 개발 DB 주소**(회사 PC 설정의 `DATABASE_URL`과 같은 값) | Secret | 지금 |
| `DATABASE_POOLER` | `transaction` | Config | 지금 |
| `SESSION_SECRET` | 8-1의 값 | Secret | 지금 |
| `TICK_SECRET` | 8-1의 값. GO-LIVE 3-5에서 Supabase Vault `tick_secret`에 같은 값을 넣는다 | Secret | 지금 |
| `VERIFY_HASH_SECRET` | 8-1의 값. 연락처 확인 링크 한도 계산에 쓴다(#63에서 연결) | Secret | 지금 |
| `GOOGLE_CLIENT_ID` | `docs/SETUP-GOOGLE-SSO.md` | **Config 필수** | 지금 |
| `GOOGLE_CLIENT_SECRET` | 같은 가이드 | Secret | 지금 |
| `SSO_ALLOWED_DOMAINS` | 같은 가이드 | **Config 필수** | 지금 |
| `SSO_ALLOWED_EMAILS` | 예외 주소(없으면 만들지 않음) | Secret 권장 | 선택 |
| `ALARM_COMMANDS_QUEUE_URL` | GO-LIVE 4-5 | Config | 4단계 후 |
| `ALARM_COMMANDS_EXPECTED_ACCOUNT` | GO-LIVE 4-5 | Config | 4단계 후 |
| `AWS_ROLE_ARN` | GO-LIVE 4-5(Vercel OIDC 역할, D-49) | Config | 4단계 후 |
| `CENTRAL_ROLE_ARN` | 중앙 배포 출력 `CentralRoleArn`. 고객 연결 키트에 쓴다(`apps/console/README.md`) | Config | 4단계 후 |
| `CENTRAL_EVENT_BUS_ARN` | 중앙 배포 출력 `CentralBusArn`. 고객 연결 키트에 쓴다 | Config | 4단계 후 |
| `REMEDIATOR_CALLER_ROLE_ARN` | 중앙 배포 출력 | Config | 4단계 후, Remediator 쓸 때만 |
| `MOCK_API`, `E2E_ALLOW_MOCK` | — | — | **절대 넣지 않는다** |

값 규칙:

- `CONSOLE_ORIGIN`: 우선 `https://<프로젝트>.vercel.app`(D-54). 파일럿 전에 `https://console.<도메인>`으로 바꾼다(GO-LIVE 1-4). `https://호스트`까지만 쓴다. 끝의 `/`, 경로, `?`, `#`, 사용자 정보가 있으면 검사가 실패한다. `http://`도 안 된다.
- `TRUSTED_PROXY`: 정확히 `1`. `true`나 ` 1`(공백)은 안 된다.
- `DATABASE_URL`: 끝에 `?pgbouncer=true&connection_limit=1`. 만드는 법은 `docs/SETUP-PROD-DB.md` 3단계.
- `SSO_ALLOWED_DOMAINS`: 쉼표 구분 도메인. `*`, 공백 섞인 항목, `@`가 든 항목은 안 된다.
- `SSO_ALLOWED_EMAILS`: Config로 넣으면 검사가 항목마다 정확한 주소인지 본다. Secret으로 두면 검사하지 않는다.
- Secret 변수(`DATABASE_URL`, `SESSION_SECRET`, `TICK_SECRET`, `VERIFY_HASH_SECRET`, `GOOGLE_CLIENT_SECRET`)는 검사가 볼 수 없다. 빠지면 배포는 통과하고 실행 중에 실패한다(로그인 unavailable, 틱 503). 그래서 넣은 뒤 목록에서 이름을 눈으로 확인한다.
- "4단계 후" 변수는 지금 넣지 않는다. GO-LIVE 4-5에서 넣는다.

6. **확인:** 목록에 `MOCK_API`, `E2E_ALLOW_MOCK`이 **없다**. 값이 비어 있어도 있으면 검사가 실패한다.

출처: https://vercel.com/docs/environment-variables/sensitive-environment-variables, https://vercel.com/docs/environment-variables/managing-environment-variables, `.github/scripts/check-console-deploy-env.mjs`, `.github/scripts/strip-deploy-env.mjs`, `docs/SETUP-GOOGLE-SSO.md`, `apps/console/README.md`

## 9. 첫 배포

> **참고** 시작 전에 4단계에서 적어 둔 주소와 8단계에 넣은 `CONSOLE_ORIGIN`이 같은지 본다. 스모크 검사는 이 주소를 부른다.

1. **어디서:** GitHub 저장소 → **Actions** 탭 → 왼쪽 목록 **deploy-console**.
   **누를 것:** 실행 목록 위의 **Run workflow**.
2. **입력할 것:** **Branch** 드롭다운 = `main`. 이 워크플로에는 다른 입력칸이 없다.
   **누를 것:** 초록색 **Run workflow**.
   **확인:** 새 실행이 목록 맨 위에 생기고 승인 대기 상태다. 바로 실행되면 7단계 2번(Required reviewers)이 빠진 것이다. 취소하고 7단계로 간다.

   > **주의** `main` 말고 다른 브랜치를 고르면 작업이 건너뛰어진다(Skipped).

3. **어디서:** 실행 화면의 알림.
   **누를 것:** **Review deployments** → `production` 체크 → **Approve and deploy**.
   **확인:** 작업 `deploy`가 시작된다. 이때부터 작업이 환경 시크릿을 읽는다.

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

출처: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow, https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments, `.github/workflows/deploy-console.yml`, `.github/scripts/smoke-console.mjs`

## 10. Deployment Protection 확인

목표: production 주소는 공개, 미리보기와 배포별 주소는 보호.

1. **어디서:** 프로젝트 → **Settings** → **Deployment Protection**.
   **입력할 것:** **Vercel Authentication**을 켜고 범위를 **Standard Protection**으로 한다. Standard Protection은 production 도메인을 **뺀** 모든 주소를 보호한다.
   **누를 것:** **Save** **(버튼 이름 확인 필요)**.
   **확인:** 로그아웃한 브라우저(시크릿 창)에서 `https://<프로젝트>.vercel.app/login`이 Vercel 로그인 화면이 아니라 콘솔 로그인 화면이다.

   > **주의** **All Deployments**를 고르면 production 도메인도 막혀 스모크가 401로 실패한다.

   > **참고** Standard Protection에서는 배포마다 생기는 긴 주소(요약의 `Deployment: …`)가 production 배포라도 보호된다. 그래서 스모크는 `CONSOLE_ORIGIN`을 부른다. 정상이다.

2. 고쳤으면 9단계 1번부터 다시 한다.

출처: https://vercel.com/docs/deployment-protection

## 11. 스모크 검사가 실패했을 때 되돌리기

> **주의** 실패한 배포는 이미 production에 올라가 있다. 바로 되돌린다.

1. **어디서:** Vercel 프로젝트 첫 화면의 **Production Deployment** 칸.
   **누를 것:** **Instant Rollback** → 창에서 직전 정상 배포를 고른다(더 오래된 배포는 **Choose another deployment**) → **Continue** → 내용 확인 → **Confirm Rollback**.
   - 다른 길: **Deployments** 목록(브랜치 `main`으로 거르면 편하다) → 배포 줄의 `⋮` → **Instant Rollback**.
   - 다른 방법: 본인 터미널에서 `vercel rollback <직전 배포 주소 또는 ID>`.
   - 첫 배포라 직전 배포가 없으면 되돌릴 것이 없다. 3번으로 간다.
   **확인:** 성공 메시지가 뜨고, Production Deployment 칸에 되돌린 배포가 표시된다. 환경변수는 바뀌지 않는다.

2. **어디서:** 본인 Git Bash.
   ```bash
   curl -s -o /dev/null -w "%{http_code}" https://<프로젝트>.vercel.app/login
   curl -s -o /dev/null -w "%{http_code}" -X POST https://<프로젝트>.vercel.app/api/internal/tick
   ```
   **확인:** 첫 줄 `200`, 둘째 줄 `401`.

3. 아래 [막혔을 때](#막혔을-때)에서 원인을 고치고 9단계를 다시 한다.

4. **되돌리기 해제(꼭 한다).** 되돌린 뒤에는 Vercel이 production 도메인 자동 연결을 끈다. 그래서 9단계로 새로 배포해도 `<프로젝트>.vercel.app`은 **예전 배포를 계속 가리킨다.**
   **어디서:** 프로젝트 첫 화면의 Production Deployment 칸에 생긴 **Manage**.
   **누를 것:** 9단계에서 새로 만든 배포를 고른다 → **Confirm**.
   - 다른 방법: `vercel promote <새 배포 주소>`.
   **확인:** Production Deployment 칸이 새 배포다. 2번의 `curl` 두 줄을 다시 해서 `200`, `401`이 나온다.

   > **주의** 되돌린 상태에서 9단계를 다시 하면, 그 실행의 스모크는 **예전 배포**를 검사한다. 초록이어도 새 배포가 검사된 것이 아니다. 4번을 한 뒤 2번 `curl`로 직접 확인한다.

   > **주의** 되돌린 동안 1분 틱이 멈출 수 있다. GO-LIVE 3-5의 4번으로 확인한다.

출처: https://vercel.com/docs/instant-rollback, https://vercel.com/docs/deployments/rollback-production-deployment, `docs/security/reviews/deploy-workflows.md` N4

## 막혔을 때

| 화면에 나온 글 | 할 일 |
|---|---|
| 작업 `deploy`가 Skipped | `main`이 아닌 브랜치로 실행했다. 9단계 2번 |
| `Secret VERCEL_TOKEN is not set in the production environment` (ORG_ID, PROJECT_ID도 같은 모양) | 저장소 시크릿에 넣었거나 이름이 다르다. 7단계 5번 |
| `Pull the production environment` 단계 실패 | 토큰 만료·범위 오류, 또는 ID가 다른 팀·프로젝트 것. 5·6단계 |
| `CONSOLE_ORIGIN is not set (...)` | 없거나 Secret으로 넣었다. Config로 다시 만든다. 8-2 |
| `CONSOLE_ORIGIN is not a URL` / `must be an https origin` | `https://<프로젝트>.vercel.app` 모양으로 고친다 |
| `CONSOLE_ORIGIN must be only scheme://host[:port], ...` | 끝의 `/`나 경로를 지운다 |
| `TRUSTED_PROXY must be exactly 1` | Config로 `1`. 공백 없이 |
| `MOCK_API must not be present ...` / `E2E_ALLOW_MOCK must not be present ...` | 변수 자체를 지운다. 빈 값도 안 된다 |
| `GOOGLE_CLIENT_ID is not set (...)` | Config로 넣는다 |
| `SSO_ALLOWED_DOMAINS is not set or empty ...` | Config로 넣는다 |
| `SSO_ALLOWED_DOMAINS entry #N is not a plain domain ...` | N번째 항목의 `*`·공백·`@`를 없앤다 |
| `SSO_ALLOWED_EMAILS entry #N is not an exact e-mail address` | N번째 주소를 고치거나 Secret으로 다시 만든다 |
| `unexpected output from vercel deploy (...)` | 허브에 실행 링크를 알린다. 11단계 2번으로 확인 |
| `smoke: GET /login answered 503, expected 200` | 실행 중 `CONSOLE_ORIGIN`이 빠졌다. 8단계 확인 후 11단계 |
| `smoke: GET /login contains a mock marker (...)` | `MOCK_API`가 들어갔다. 지우고 11단계 |
| `smoke: POST /api/internal/tick answered 503: TICK_SECRET is not configured ...` | `TICK_SECRET`이 없거나 32자 미만. 넣고 11단계 → 9단계 |
| `smoke: POST /api/internal/tick answered 401 but not with the console error body (...)` | Deployment Protection이 막고 있다. 10단계 |
| `smoke: CSP ...` / `two requests got the same CSP nonce (HTML cached?)` | 허브에 알린다. CDN을 뒀으면 GO-LIVE 3-7 |
| `smoke: request failed after 5 tries: ...` | 주소가 틀렸거나 배포가 안 떴다. 4단계 주소와 `CONSOLE_ORIGIN` 비교 |
| `/login`에 "unavailable"이 보임 | `GOOGLE_CLIENT_SECRET`·`SESSION_SECRET`(Secret)이 빠졌다. 8단계 목록 확인 |
| 새로 배포했는데 주소가 예전 화면 | 되돌리기 상태다. 11단계 4번 |
| main 머지 뒤 Vercel에 새 배포가 Ready로 생김 | Git 자동 배포가 켜져 있다. 3단계 |
