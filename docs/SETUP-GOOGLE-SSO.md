# Google 로그인(SSO) 설정

이 문서는 콘솔에 Google 계정으로 로그인하게 만드는 사람을 위한 순서다. 끝까지 하면 배포된 콘솔의 로그인 화면에서 "Sign in with Google"로 들어올 수 있다.

- 처음 한 번만 하면 된다.
- 30분쯤 걸린다.
- 먼저 콘솔이 Vercel에 배포되어 있고 `CONSOLE_ORIGIN`(예: `https://console.example.com`)이 정해져 있어야 한다(`docs/GO-LIVE.md`).

> **참고** Google Cloud 화면의 메뉴 이름은 자주 바뀐다. 이름이 조금 달라도 **용도**가 같은 것을 고르면 된다.

> **주의** 클라이언트 보안 비밀(`GOOGLE_CLIENT_SECRET`)은 채팅, 이슈, PR, 커밋 어디에도 붙여 넣지 않는다. 비밀번호 관리자와 Vercel 두 곳에만 둔다. 허용할 개인 메일 주소도 같다. 저장소에는 넣지 않는다.

## 먼저 알아 둘 것

- 로그인에는 **두 가지 조건**이 모두 필요하다.
  1. Google이 확인해 준 메일 주소가 허용 목록(도메인 또는 예외 주소)에 있다. **직원(MSP)에게만 적용된다.**
  2. 그 주소로 **미리 등록된 사용자 행이 DB에 있고 활성(ACTIVE)** 이다. 역할과 볼 수 있는 고객은 이 행에서 정해진다.
- 허용 목록에만 있고 DB에 행이 없으면 로그인되지 않는다.
- 고객사 담당자(포털 사용자)는 도메인 목록과 상관없이, 관리자가 등록한 활성 포털 사용자 행이 있으면 로그인된다. 이때는 그 고객 데이터만 읽기 전용으로 보인다.
- 실패하면 이유와 상관없이 같은 안내가 나온다("This Google account can't sign in…"). 이유는 서버 로그에만 남는다.
- **Google 계정이 없는 고객은 아직 로그인할 수 없다.** 메일 링크 로그인은 다음 작업이다.
- 고객사 도메인(`loginDomains`)으로 자동 로그인되는 기능은 **아직 켜져 있지 않다**. 지금은 고객 담당자를 한 명씩 등록해야 한다(아래 "알려진 빈틈").

## 목차

1. [Google에서 OAuth 클라이언트 만들기](#1-google에서-oauth-클라이언트-만들기)
2. [Vercel에 값 네 개 넣기](#2-vercel에-값-네-개-넣기)
3. [첫 관리자(ADMIN) 사용자 행 만들기](#3-첫-관리자admin-사용자-행-만들기)
4. [로그인 확인](#4-로그인-확인)
5. [나중에 도메인이나 예외 주소 바꾸기](#5-나중에-도메인이나-예외-주소-바꾸기)
6. [알려진 빈틈](#6-알려진-빈틈)
7. [막혔을 때](#7-막혔을-때)

## 1. Google에서 OAuth 클라이언트 만들기

1. 회사 Google 계정으로 https://console.cloud.google.com 에 들어가 프로젝트를 고르거나 새로 만든다.
   - 값: `alarmops` 처럼 용도가 드러나는 이름
2. 동의 화면(OAuth consent screen, 새 화면에서는 "Google Auth Platform › 브랜딩/대상")을 설정한다.
   - 어디서: APIs & Services › OAuth consent screen
   - 값: 사용자 유형 **Internal**(회사 Workspace 안에서만 쓸 때). 예외 주소(개인 Gmail)나 고객 담당자가 로그인해야 하면 Internal로는 안 되므로 **External**로 하고, 게시 상태를 **In production**으로 둔다(Testing 상태는 등록한 테스트 사용자만, 7일 뒤 만료).
   - 값: 앱 이름 `AlarmOps`, 지원 메일은 회사 주소
   - 확인: 요청 범위(scope)는 `openid`, `email`만 쓴다. 민감한 범위는 추가하지 않는다.
3. 클라이언트를 만든다.
   - 어디서: APIs & Services › Credentials › Create credentials › OAuth client ID
   - 값: 유형 **Web application**, 이름 `alarmops-console`
   - 값: **Authorized redirect URIs**에 `<CONSOLE_ORIGIN>/auth/google/callback` 한 줄. 예: `https://console.example.com/auth/google/callback`

   > **주의** 주소는 글자 하나까지 같아야 한다(`https`, 끝에 `/` 없음, 콜백 경로까지). 틀리면 Google이 `redirect_uri_mismatch`를 보여 준다.
   - 값: Authorized JavaScript origins는 비워 둔다.
4. 만들면 나오는 **Client ID**와 **Client secret**을 비밀번호 관리자에 저장한다.
   - 확인: Client ID가 `….apps.googleusercontent.com`으로 끝난다.

## 2. Vercel에 값 네 개 넣기

1. 어디서: Vercel 프로젝트 › Settings › Environment Variables, 환경은 **Production**.
2. 아래 표대로 넣는다.

| 이름 | 값 | 종류 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | 1단계의 Client ID | **Plain** |
| `GOOGLE_CLIENT_SECRET` | 1단계의 Client secret | **Sensitive** |
| `SSO_ALLOWED_DOMAINS` | `mz.co.kr,megazone.com` (쉼표로 구분, 공백 있어도 됨) | **Plain** |
| `SSO_ALLOWED_EMAILS` | 예외 주소, 쉼표로 구분. 없으면 이 변수를 만들지 않는다 | **Sensitive** 권장 |

> **참고** 배포 점검(`check-console-deploy-env.mjs`)은 Vercel이 내려 주는 값을 읽는다. Sensitive 값은 내려오지 않으므로, 점검해야 하는 `GOOGLE_CLIENT_ID`와 `SSO_ALLOWED_DOMAINS`는 Plain으로 둔다. 비밀 값(`GOOGLE_CLIENT_SECRET`)과 개인 주소는 Sensitive로 둔다. 비밀은 어느 경우에도 빌드에 전달되지 않는다.

> **주의** 도메인에는 `*`, `*.mz.co.kr`, `@mz.co.kr`, 공백 섞인 값을 쓰지 않는다. 그런 항목은 무시되고(경고 로그), 유효한 항목이 하나도 없으면 로그인이 꺼진다. "모두 허용"은 없다.

3. 값을 바꿨으면 다시 배포한다(GitHub Actions의 배포 워크플로).
   - 확인: 배포 점검 단계가 통과한다. `GOOGLE_CLIENT_ID is not set` 또는 `SSO_ALLOWED_DOMAINS is not set`이 나오면 1~2번을 다시 본다.

## 3. 첫 관리자(ADMIN) 사용자 행 만들기

현재 사용자 행을 만드는 곳은 **개발용 시드(`db/prisma/seed.ts`)뿐**이다. 시드는 `admin@msp.example` 같은 가짜 사용자만 만들며 운영 DB에는 쓰지 않는다. 콘솔에 사용자를 추가하는 화면과 API는 아직 없다(6단계 참고). 그래서 **첫 관리자는 DB에 직접 한 줄을 넣어야 한다.**

> **주의** 운영 DB 작업은 사람이 직접, 별도 터미널에서 한다. 에이전트나 자동화에 연결 주소를 주지 않는다. `prisma db push`는 쓰지 않는다.

1. 어디서: Supabase 대시보드 › SQL Editor(운영 프로젝트). 연결 주소를 따로 꺼낼 필요가 없는 가장 안전한 방법이다.
2. 아래 SQL의 값을 바꿔 실행한다.

```sql
INSERT INTO "User" ("id", "email", "name", "role", "status", "updatedAt")
VALUES ('usr_' || substr(md5(random()::text), 1, 12), 'you@mz.co.kr', 'Your Name', 'ADMIN', 'ACTIVE', now());
```

   - 값: `email`은 Google 로그인에 쓰는 주소(대소문자 구분 없음), `customerId`는 **넣지 않는다**(비워 두면 MSP 직원).
   - 확인: `SELECT "email", "role", "status", "customerId" FROM "User";` 에서 그 행이 `ADMIN`, `ACTIVE`, `customerId` 비어 있음으로 나온다.

> **주의** 이 SQL은 감사 기록(AuditLog)을 남기지 않는다. 누가 언제 만들었는지 직접 따로 기록해 둔다.

> **주의** 메일 주소 철자를 한 번 더 확인한다. 한 글자라도 틀리면 그 사람은 로그인되지 않는다.

> **주의** Gmail 같은 예외 주소는 Google이 돌려주는 모양 그대로 등록한다(예: Google 계정 화면에 보이는 주소 전체, 대소문자는 상관없음). 점(.)이나 `+` 별칭을 임의로 바꾸지 않는다.

> **참고** 예외 주소(개인 Gmail)로 들어갈 사람도 같은 방식으로 행이 있어야 한다.

> **참고** Contact(알림 연락처) 행은 로그인에 필요하지 않다. 온콜 목록에 올리려면 나중에 콘솔에서 연결한다.

## 4. 로그인 확인

1. 시크릿 창에서 `<CONSOLE_ORIGIN>/login` 을 연다.
   - 확인: **Sign in with Google** 버튼이 활성이다. 비활성이면 2단계의 값이 런타임에 없다는 뜻이다.
2. 버튼을 눌러 허용한 주소의 Google 계정으로 로그인한다.
   - 확인: 인시던트 목록으로 이동한다.
3. 허용되지 않은 주소(예: 아무 개인 Gmail)로 해 본다.
   - 확인: 로그인 화면에 "This Google account can't sign in to AlarmOps…"가 나오고 세션이 생기지 않는다.

## 5. 나중에 도메인이나 예외 주소 바꾸기

코드는 바꾸지 않는다. Vercel 변수만 바꾼다.

1. 도메인 추가·삭제: `SSO_ALLOWED_DOMAINS` 값을 고친다. 예: `mz.co.kr,megazone.com,newco.com`
2. 예외 주소 추가·삭제: `SSO_ALLOWED_EMAILS` 값을 고친다. 정확한 주소 전체를 쓴다(도메인 전체를 열지 않는다).
3. 다시 배포한다. 확인: 새 주소로 로그인된다. 뺀 주소는 다음 로그인부터 거절되며, 이미 로그인한 세션은 최대 8시간 남는다. 바로 끊어야 하면 그 사용자 행의 `status`를 `DISABLED`로 바꾼다(요청마다 확인한다).
4. 도메인이나 주소를 허용해도 **사용자 행이 없으면 로그인되지 않는다.** 직원은 행을 따로 만들어야 한다(3단계의 SQL, `role`만 `OPERATOR` 또는 `VIEWER`로).

## 6. 알려진 빈틈

- **사용자 추가 화면·API 없음.** Settings › Users 화면은 아직 빈 페이지다. `docs/API-CONTRACT.md`에 `GET/PATCH /users`가 "가입 승인, 역할"로 적혀 있지만 구현되어 있지 않다. 지금은 DB에 직접 넣어야 한다. 백엔드에 사용자 생성·활성화·역할 변경(감사 기록 포함) API가 필요하다.
- **고객 담당자는 한 명씩 등록해야 한다.** 고객사 `loginDomains`로 도메인 전체를 받는 방식(org-tenant R4-3)은 로그인 경로에 아직 연결되지 않았다. 연결하려면 백엔드가 "도메인으로 고객 한 곳을 찾고(둘 이상이면 거절), 그 고객의 VIEWER 포털 사용자를 감사 기록과 함께 만드는" 저장소 메서드를 먼저 추가해야 한다. 무료 메일 도메인(gmail.com 등)은 어떤 경우에도 이 방식에 쓰지 않는다.
- **Google 계정이 없는 고객은 로그인할 수 없다.** 메일 링크 로그인은 다음 작업이다.
- `GOOGLE_CLIENT_SECRET`은 Sensitive라 배포 점검이 값을 볼 수 없다. 빠져 있으면 배포는 통과하고, 로그인 화면이 "unavailable"을 보여 준다(4단계에서 확인).

## 7. 막혔을 때

| 증상 | 원인 | 해결 |
|---|---|---|
| Google 화면에 `redirect_uri_mismatch` | 1단계 3번의 주소가 `CONSOLE_ORIGIN`과 다르다 | 주소를 `<CONSOLE_ORIGIN>/auth/google/callback`과 한 글자도 다르지 않게 고친다 |
| Google 화면에 `access_denied`, 또는 "앱이 확인되지 않음" | 동의 화면이 Testing이고 테스트 사용자가 아니다 | 게시 상태를 In production으로 하거나 Internal로 바꾼다 |
| 버튼이 비활성이거나 "Google sign-in is unavailable" | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SSO_ALLOWED_*`, `SESSION_SECRET` 중 런타임에 없는 것이 있다 | 2단계 표를 확인하고 다시 배포한다. 서버 로그의 `[sso] … unavailable: <이유>`를 본다 |
| 허용한 주소인데 "can't sign in" | DB에 그 주소의 활성 사용자 행이 없다. 고객이 중지된 포털 사용자도 같다 | 3단계의 확인 SELECT로 행과 `status`를 본다. 서버 로그에 `no_user` |
| 직원인데 거절되고 로그에 `staff_outside_fence` | 주소가 허용 도메인·예외 주소에 없다 | 5단계로 목록에 추가한다 |
| "Sign-in didn't complete. Try again." | 로그인 중간에 10분이 지났거나 쿠키가 막혔다 | 처음부터 다시 한다. 다른 사이트에서 열었다면 콘솔 주소로 직접 들어간다 |
| 배포 점검 실패: `SSO_ALLOWED_DOMAINS …` | 값이 비었거나 `*`, 공백, `@` 항목이 있다 | 2단계 주의를 본다 |
| 로그인 직후 `/login?ended=1` | 세션은 만들어졌지만 사용자가 비활성이 되었다 | 사용자 행 `status`를 확인한다 |
