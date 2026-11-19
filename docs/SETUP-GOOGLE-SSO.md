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
- **Google 계정 묶기(켜져 있음):** 처음 로그인하면 Google이 알려 준 계정 id(`sub`)가 그 사용자 행에 묶인다. 이후에는 같은 Google 계정만 들어온다. 메일 주소가 다른 사람에게 재배정되어도 그 사람은 들어오지 못한다(서버 로그에 `sub_mismatch`, 화면에는 같은 안내). 묶음 값 자체는 어디에도 보이지 않고, Users 화면에는 "Google linked: yes/no"만 나온다.
- **묶음 풀기:** 정당하게 Google 계정이 바뀐 사람(퇴사 후 재입사, 계정 이전 등)은 ADMIN이 **Settings › Users › 그 사용자 › Clear Google link**로 푼다(확인 단계가 있다. API는 `PATCH /users/{id} {clearGoogleSub: true}`, 감사 `user.update`). 다음 로그인에서 새 계정이 묶인다. 자기 자신의 묶음은 풀 수 없다(다른 ADMIN이 한다).
- **고객사 로그인 도메인(켜져 있음):** 고객에 `loginDomains`가 등록되어 있으면, 사용자 행이 없고 직원 허용 목록(`SSO_ALLOWED_DOMAINS`/`SSO_ALLOWED_EMAILS`)에도 없는 주소가 그 도메인으로 로그인할 때 그 고객의 **읽기 전용 포털 사용자(VIEWER)** 가 자동으로 만들어진다(감사 `user.enrol_domain`). 조건: 도메인이 정확히 **한 곳의 활성 고객**에만 등록되어 있다. 둘 이상이면 거절, 무료 메일 도메인(gmail.com 등)은 등록 자체가 안 된다. **직원 규칙이 이긴다**: 허용 목록에 있는 주소는 자동 등록되지 않는다. 이미 있는 DISABLED 사용자는 되살리지 않는다. 도메인을 빼도 이미 만들어진 사용자는 ADMIN이 비활성화할 때까지 남는다.
- 로그인 도메인을 정하는 곳: 고객 화면(이슈 #63, 고객 온보딩)이다. 그 화면이 나오기 전에는 API(`PATCH /customers/{id}` `{loginDomains:[...]}`, ADMIN)로 넣는다.
- 로그인에 성공하면 사용자 행의 마지막 로그인 시각(`lastLoginAt`)이 갱신되어 Users 화면의 "Last sign-in"에 나온다. 갱신이 실패해도 로그인은 막히지 않는다(서버 로그 `[sso] touchLastLogin failed`).

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
   - 한국어 화면(11/19 확인): **Google 인증 플랫폼** → **개요** → **시작하기** → 프로젝트 구성 ① 앱 정보(앱 이름, 사용자 지원 이메일) ② 대상(**내부**/**외부**) ③ 연락처 정보 ④ 완료 → **만들기**.
   - 범위: 왼쪽 **데이터 액세스** → **범위 추가 또는 삭제** → `.../auth/userinfo.email`과 `openid`만 체크 → **업데이트** → 아래 **Save**. 둘 다 "민감하지 않은 범위"라 앱 인증(검수)이 필요 없다.
   - **외부**로 만들었으면 왼쪽 **대상** → 게시 상태 **앱 게시**(프로덕션으로 푸시)를 누른다. 테스트 상태로 두면 테스트 사용자로 등록한 주소만 로그인된다.
3. 클라이언트를 만든다.
   - 어디서: APIs & Services › Credentials › Create credentials › OAuth client ID
   - 값: 유형 **Web application**, 이름 `alarmops-console`
   - 값: **Authorized redirect URIs**에 `<CONSOLE_ORIGIN>/auth/google/callback` 한 줄. 예: `https://console.example.com/auth/google/callback`. PoC(D-57)는 `https://alarmops.vercel.app/auth/google/callback`

   > **주의** 주소는 글자 하나까지 같아야 한다(`https`, 끝에 `/` 없음, 콜백 경로까지). 틀리면 Google이 `redirect_uri_mismatch`를 보여 준다.
   - 값: Authorized JavaScript origins는 비워 둔다.
4. 만들면 나오는 **Client ID**와 **Client secret**을 비밀번호 관리자에 저장한다.
   - 확인: Client ID가 `….apps.googleusercontent.com`으로 끝난다.

## 2. Vercel에 값 네 개 넣기

1. 어디서: Vercel 프로젝트 › Settings › Environment Variables, 환경은 **Production**.
2. 아래 표대로 넣는다.

| 이름 | 값 | 종류 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | 1단계의 Client ID | **Config** |
| `GOOGLE_CLIENT_SECRET` | 1단계의 Client secret | **Secret** |
| `SSO_ALLOWED_DOMAINS` | `mz.co.kr,megazone.com` (쉼표로 구분, 공백 있어도 됨) | **Config** |
| `SSO_ALLOWED_EMAILS` | 예외 주소, 쉼표로 구분. 없으면 이 변수를 만들지 않는다 | **Secret** 권장 |

> **참고** Vercel 화면의 **Type**은 이제 **Config**(예전 Plain)/**Secret**(예전 Sensitive)이다. 배포 점검(`check-console-deploy-env.mjs`)은 Vercel이 내려 주는 값을 읽는다. Sensitive 값은 내려오지 않으므로, 점검해야 하는 `GOOGLE_CLIENT_ID`와 `SSO_ALLOWED_DOMAINS`는 Plain으로 둔다. 비밀 값(`GOOGLE_CLIENT_SECRET`)과 개인 주소는 Sensitive로 둔다. 비밀은 어느 경우에도 빌드에 전달되지 않는다.

> **주의** 도메인에는 `*`, `*.mz.co.kr`, `@mz.co.kr`, 공백 섞인 값을 쓰지 않는다. 그런 항목은 무시되고(경고 로그), 유효한 항목이 하나도 없으면 로그인이 꺼진다. "모두 허용"은 없다.

3. 값을 바꿨으면 다시 배포한다(GitHub Actions의 배포 워크플로).
   - 확인: 배포 점검 단계가 통과한다. `GOOGLE_CLIENT_ID is not set` 또는 `SSO_ALLOWED_DOMAINS is not set`이 나오면 1~2번을 다시 본다.

## 3. 첫 관리자(ADMIN) 사용자 행 만들기

**첫 관리자만** DB에 직접 한 줄을 넣는다(아직 로그인할 사람이 없으니 화면을 쓸 수 없다). 개발용 시드(`db/prisma/seed.ts`)는 `admin@msp.example` 같은 가짜 사용자만 만들며 운영 DB에는 쓰지 않는다. 첫 관리자가 로그인한 뒤의 사용자(직원·고객 담당자)는 **Settings › Users 화면**에서 추가한다(5단계).

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
3. 다시 배포한다. 확인: 새 주소로 로그인된다. 뺀 주소는 다음 로그인부터 거절되며, 이미 로그인한 세션은 최대 8시간 남는다. 바로 끊어야 하면 **Settings › Users에서 비활성화**한다(요청마다 확인한다). 화면을 쓸 수 없을 때만 DB에서 그 사용자 행의 `status`를 `DISABLED`로 바꾼다(SQL은 예비 수단).
4. 도메인이나 주소를 허용해도 **사용자 행이 없으면 로그인되지 않는다.** 직원은 ADMIN이 Settings › Users › Add user에서 등록한다(역할 ADMIN/OPERATOR/VIEWER). 화면은 직원 주소가 허용 도메인 밖이면 등록 전에 경고한다.

## 6. 알려진 빈틈

- **첫 관리자는 DB에 직접 넣는다**(3단계). 그 뒤는 Settings › Users 화면이다. 마지막 활성 전 고객 범위 ADMIN은 강등·비활성화할 수 없다(409 `LAST_ADMIN`).
- **로그인 도메인 입력 화면은 이슈 #63(고객 화면)** 에서 나온다. 그 전에는 API로 넣는다(위 "먼저 알아 둘 것").
- **Google 계정이 없는 고객은 로그인할 수 없다.** 메일 링크 로그인은 다음 작업이다.
- `GOOGLE_CLIENT_SECRET`은 Sensitive라 배포 점검이 값을 볼 수 없다. 빠져 있으면 배포는 통과하고, 로그인 화면이 "unavailable"을 보여 준다(4단계에서 확인).

## 7. 막혔을 때

| 증상 | 원인 | 해결 |
|---|---|---|
| Google 화면에 `redirect_uri_mismatch` | 1단계 3번의 주소가 `CONSOLE_ORIGIN`과 다르다 | 주소를 `<CONSOLE_ORIGIN>/auth/google/callback`과 한 글자도 다르지 않게 고친다 |
| Google 화면에 `access_denied`, 또는 "앱이 확인되지 않음" | 동의 화면이 Testing이고 테스트 사용자가 아니다 | 게시 상태를 In production으로 하거나 Internal로 바꾼다 |
| "Sign-in didn't complete"(`?sso=failed`), Vercel **Logs**에 `[sso] sign-in failed: token: token_rejected` | Google이 토큰 교환을 거절했다. 대개 `GOOGLE_CLIENT_SECRET` 값이 틀렸다(복사할 때 공백·일부 누락) | Vercel에서 `GOOGLE_CLIENT_SECRET`을 지우고 다시 넣는다(Secret, Production). `GOOGLE_CLIENT_ID`도 같은 클라이언트 것인지 본다. 그다음 GitHub Actions **deploy-console**로 다시 배포한다(11/19 실제로 겪음) |
| 버튼이 비활성이거나 "Google sign-in is unavailable" | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SSO_ALLOWED_*`, `SESSION_SECRET` 중 런타임에 없는 것이 있다 | 2단계 표를 확인하고 다시 배포한다. 서버 로그의 `[sso] … unavailable: <이유>`를 본다 |
| 허용한 주소인데 "can't sign in" | DB에 그 주소의 활성 사용자 행이 없다. 고객이 중지된 포털 사용자도 같다 | Settings › Users에서 행과 상태를 본다(없으면 3단계의 확인 SELECT). 서버 로그에 `no_user` (로그인 도메인 자동 등록이 거절되었으면 `(enrol DOMAIN_UNKNOWN 등)`이 붙는다) |
| 사용자는 있는데 거절되고 로그에 `sub_mismatch` | 그 행에 다른 Google 계정이 묶여 있다(또는 그 Google 계정이 다른 사용자에 묶여 있다) | 본인 계정이 맞으면 다른 ADMIN이 Users 화면에서 Clear Google link 후 다시 로그인한다 |
| 직원인데 거절되고 로그에 `staff_outside_fence` | 주소가 허용 도메인·예외 주소에 없다 | 5단계로 목록에 추가한다 |
| "Sign-in didn't complete. Try again." | 로그인 중간에 10분이 지났거나 쿠키가 막혔다 | 처음부터 다시 한다. 다른 사이트에서 열었다면 콘솔 주소로 직접 들어간다 |
| 배포 점검 실패: `SSO_ALLOWED_DOMAINS …` | 값이 비었거나 `*`, 공백, `@` 항목이 있다 | 2단계 주의를 본다 |
| 로그인 직후 `/login?ended=1` | 세션은 만들어졌지만 사용자가 비활성이 되었다 | 사용자 행 `status`를 확인한다 |
