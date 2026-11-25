# 실제 연동 순서 (파일럿 실운영까지)

이 문서는 파일럿을 실운영까지 끌고 갈 사람과 허브를 위한 실행 순서다. 끝까지 따르면 파일럿 고객 1곳의 알람이 사람 손 없이 인시던트·호출·Ack·해결까지 돈다.

**목표**: 파일럿 고객 1곳의 AWS 알람이 들어오면 사람이 손대지 않아도 인시던트가 열린다. 정해진 순서대로 전화·문자가 간다. Ack/해결까지 콘솔에서 끝난다.

**읽는 법**

- 이 문서는 "누가 무엇을 하는가"를 단계별로 적는다.
- **[사람]** 은 자격증명·결제·배포 승인이 필요해 사람이 직접 한다.
- **[에이전트]** 는 허브가 이슈로 배정한다.

> **주의** 비밀값은 어디에도 붙여 넣지 않는다. 두는 곳은 비밀번호 관리자, GitHub/Vercel 시크릿, 회사 PC `.env`뿐이다.

## 목차

- [지금 상태 (11/18)](#지금-상태-1118)
- [1단계 — 결정](#1단계--결정-사람-먼저-다른-단계를-막는다)
- [2단계 — GitHub·DB 기반](#2단계--githubdb-기반-사람-30분)
- [3단계 — 콘솔 배포(Vercel)](#3단계--콘솔-배포vercel-사람--에이전트)
- [4단계 — AWS 중앙 계정(서울)](#4단계--aws-중앙-계정서울-에이전트-템플릿--사람-배포)
- [5단계 — 알림 발송](#5단계--알림-발송-에이전트-1단계-결정-후)
- [6단계 — 알람 자동 생성](#6단계--알람-자동-생성-에이전트)
- [7단계 — 파일럿 고객 연결](#7단계--파일럿-고객-연결-사람)
- [완전 자동으로 도는 것과 사람이 남는 것](#완전-자동으로-도는-것과-사람이-남는-것)
- [진행 순서 요약](#진행-순서-요약)

## 지금 상태 (11/18)

| 영역 | 상태 |
|---|---|
| 콘솔·API·틱(에스컬레이션, 발송 대기열, 보관·파기) | 코드 완료, mock·로컬 Postgres로 검증 |
| 로그인 | Google SSO 완료(#70, D-55). **Google OAuth 클라이언트 미생성** → `docs/SETUP-GOOGLE-SSO.md` |
| 고객 온보딩 | API 완료(#68, #71). **화면 작업 중**(#63 고객 등록, #74 사용자 관리) |
| 개발 DB(Supabase) | 마이그레이션 적용, Data API 꺼짐 |
| 운영 DB | 워크플로·DB 사용자·가이드 완료(#72, D-56). **운영 프로젝트 미생성** → `docs/SETUP-PROD-DB.md` |
| 수집(ingest: 웹훅·EventBridge) | 코드·배포 묶음 완료(#52, #53), **실제 계정 미배포** |
| 알람 엔진(알람 생성·동기화·해지 삭제) | 수집기 29종·태그 이벤트 완료(#51), 배포 묶음 완료, **실제 계정 미배포** |
| 고객 연결 스택·중앙 버스·명령 큐 | CloudFormation 템플릿 완료, **실제 계정 미배포** |
| 실제 알림 발송(Slack·이메일·문자·전화) | **어댑터 없음** — Slack·SES 정보 대기(#39), 문자·전화 보류(#10) |
| 콘솔 배포(Vercel) | 배포 워크플로 완료(#54), **Vercel 프로젝트 미생성** |

굵게 표시한 것이 채워져야 "완전 자동"이 된다.

- 코드 쪽에 남은 것: 고객 등록·사용자 관리 화면(#63, #74), 알림 어댑터(#39).
- 나머지는 사람이 계정·환경을 만들고 배포를 승인하는 일이다.

---

## 1단계 — 결정 [사람] (먼저, 다른 단계를 막는다)

끝나면: 5단계(알림 발송)와 7단계(파일럿 연결)를 시작하는 데 필요한 답이 모두 정해져 있고, 허브가 그 답을 안다.

여섯 가지를 정한다. 순서는 상관없다. 정한 것은 허브에 **말로** 알린다.

> **주의** 허브에 알리는 것은 "무엇으로 정했다"뿐이다. 토큰·키·비밀번호·연결 주소는 채팅·이슈·PR에 붙여 넣지 않는다. 값은 5단계에서 Vercel(또는 Lambda) 비밀로 직접 넣는다.

### 1-1. 문자·전화 업체 (보류)

- [ ] 문자·전화 업체(Q-API-06, 후보 솔라피) — **11/16 보류**(#10). 나머지를 먼저 진행한다

1. 지금은 아무것도 하지 않는다. 다른 항목을 먼저 진행한다.
2. 다시 열 때 정할 것: 업체 한 곳(후보 솔라피)과 그 업체 계정을 만들 사람.
   - 누가 답하나: 결제·계약을 할 수 있는 사람(본인 또는 회사 담당).
   - 무엇을 막나: 5단계의 문자·전화 어댑터(#10). 이게 없으면 7단계 시험에서 전화·문자는 가지 않는다.
   - 허브에 말할 것: "업체는 ○○로 정했다". 업체 키는 말하지 않는다.

> **참고** 업체 콜백의 서명 방식도 업체가 정해져야 정할 수 있다(Q-API-06, `docs/API-CONTRACT.md` §10).

### 1-2. 이메일 발송 (정해짐)

- [x] 이메일 발송: **AWS SES**(D-52)

결정은 끝났다. 남은 것은 준비물이다. 4단계에서 쓴다.

1. 보내는 주소 하나를 정한다. 예: 회사 메일 주소 하나.
   - 누가 답하나: 그 메일함을 열어 인증 메일을 누를 수 있는 사람.
2. AWS 콘솔에서 중앙 계정, **서울(ap-northeast-2)** 리전의 SES를 열고 그 주소를 신원(identity)으로 등록해 인증한다.
   - 확인: SES의 신원 목록에서 그 주소가 인증됨으로 보인다.
3. 그 신원의 ARN과 보내는 주소를 적어 둔다. 비밀이 아니다. 4-2에서 `SES_IDENTITY_ARN`·`SES_FROM_ADDRESS`에 넣는다.
   - ARN 모양: `arn:aws:ses:ap-northeast-2:<중앙 계정 ID>:identity/<주소 또는 도메인>`
   - 허브에 말할 것: "SES 주소 인증했다".

> **참고** 도메인이 생기기 전에는 주소 하나만 인증해 sandbox에서 시험한다. sandbox에서는 인증한 주소로만 보낼 수 있다. 파일럿 전에 도메인 인증(DKIM)과 sandbox 해제를 한다(D-52).

- 무엇을 막나: 5단계의 이메일 어댑터(#39).

### 1-3. Slack

- [ ] Slack 워크스페이스·앱, MSP 공용 채널 이름(D-46)

1. 어느 Slack 워크스페이스를 쓸지 정한다.
   - 누가 답하나: 그 워크스페이스에 앱을 설치할 수 있는 관리자.
2. MSP 공용 채널 이름을 정한다. 매일 10:00 요약이 이 채널로 간다(D-46).
   - 채널이 없으면 Slack에서 만든다.
3. Slack 앱을 누가 만들지 정한다. 앱에 줄 권한(봇 토큰 스코프)은 저장소에 아직 적혀 있지 않다. #39에서 정한다.
4. 허브에 말할 것: 워크스페이스 이름, 채널 이름, 앱을 만들 사람.
   - 말하지 않을 것: 봇 토큰, 서명 비밀(Signing Secret). 5단계에서 직접 넣는다.

- 무엇을 막나: 5단계의 Slack 어댑터·10시 요약·비상 열람 알림(#39).

### 1-4. 콘솔 도메인 (우선 정해짐)

- [x] 콘솔 도메인: 우선 `*.vercel.app`(D-54), 회사 도메인은 파일럿 전 — DNS 담당 확인 필요

1. 지금은 3단계에서 Vercel이 주는 `*.vercel.app` 주소를 쓴다. 할 일이 없다.
2. 파일럿 전에 확인할 것: 회사 도메인의 DNS를 누가 바꿀 수 있는가.
   - 누가 답하나: 회사 IT·도메인 담당.
   - 무엇을 막나: 7단계 전에 `CONSOLE_ORIGIN`을 `https://console.<도메인>`으로 바꾸는 일, SES 도메인 인증(1-2).
   - 허브에 말할 것: DNS 담당자가 누구인지, 쓸 도메인.

### 1-5. Google SSO 연결 시점

- [x] Google SSO 연결 시점(파일럿 전 필수 여부) — **파일럿 전 필수, 코드 완료**(#70, D-55)

배포된 콘솔에 로그인하는 방법은 Google SSO 하나뿐이다(개발용 로그인은 회사 PC의 `next dev`에서만 된다). 그래서 파일럿 전에 꼭 필요하다.

1. 정해진 것(D-55)
   - MSP 직원: 허용 도메인(`mz.co.kr`, `megazone.com`)이나 예외 주소이고, DB에 등록된 사용자.
   - 고객사 사람: ADMIN이 등록한 포털 사용자(기본), 또는 고객사에 등록한 로그인 도메인.
2. 사람이 할 일: Google OAuth 클라이언트를 만들고 Vercel에 값을 넣는다. 순서는 `docs/SETUP-GOOGLE-SSO.md`에 있다(3-3, 3-4에서 한다).
3. 허브에 말하지 않을 것: 클라이언트 비밀값.

> **참고** Google 계정이 없는 고객은 아직 로그인할 수 없다. 이메일 링크 로그인은 후속 작업이다.

### 1-6. 파일럿 고객

- [ ] 파일럿 고객 1곳과 그 AWS 계정 ID

1. 파일럿 고객 1곳을 정한다.
2. 그 고객에게서 받을 것:
   - AWS 계정 ID. **숫자 12자리**다.
   - 고객 계정에서 CloudFormation 스택을 만들 수 있는 담당자 이름과 연락처(7단계 3번에서 필요).
   - 누가 답하나: 고객사의 AWS 관리자.
3. 무엇을 막나: 7단계 전체.
4. 허브에 말할 것: "파일럿 고객과 계정 ID를 받았다".

> **주의** 고객 계정 ID는 저장소·이슈·PR·커밋에 적지 않는다. 쓰는 곳은 콘솔의 고객 등록과 `bus-allowlist` 워크플로 입력뿐이다(7단계). 이유는 `infra/aws/README.md`의 "목록을 어디에 두는가".

## 2단계 — GitHub·DB 기반 [사람, 30분]

끝나면: 검사를 통과하지 않은 변경은 main에 못 들어가고, 회사 PC에서 **실제 개발 DB**에 붙은 콘솔을 눈으로 볼 수 있다.

세 가지를 순서대로 한다. 2-2가 끝나야 2-3을 할 수 있다.

### 2-1. main 브랜치 보호 (5분)

- [ ] main 브랜치 보호(Rulesets): PR 필수, 필수 검사 `test`, `e2e`, `e2e-live`, `db`, `engine`, `infra`

> **참고** 화면별 설명은 `docs/SETUP-SUPABASE.md` 9단계

<!-- include: docs/SETUP-SUPABASE.md 9 -->

### 2-2. 회사 PC `.env` 채우기 (15분)

- [ ] 회사 PC `.env`에 `DATABASE_URL`/`DIRECT_URL` (SETUP-SUPABASE 7단계) → 허브에 "채웠다"고만 알림

모든 명령은 **Git Bash**에서 실행한다. 값은 채팅·이슈·PR에 붙여 넣지 않는다. 끝나면 허브에 "채웠다"고만 말한다.

#### 1) 프로젝트 폴더로 가기

> **참고** 회사 PC의 OneDrive가 바탕화면을 동기화한다면 저장소는 `C:\workspace`처럼 동기화되지 않는 곳에 둔다(비밀번호가 든 파일이 클라우드에 올라가지 않게).

Git Bash에서는 `C:\`가 `/c/`로 바뀐다.

```bash
cd /c/Users/<사용자명>/Desktop/workspace
```

- 이미 `alarmops` 폴더가 있으면 들어가서 최신으로 받는다.
  ```bash
  cd alarmops && git checkout main && git pull
  ```
- 없으면 먼저 받는다.
  ```bash
  git clone https://github.com/hkjs96/alarmops.git && cd alarmops
  ```
- 확인: `ls`에 `package.json`, `apps`, `docs`가 보이면 저장소 루트다.

#### 2) `.env` 파일 만들기

```bash
cp .env.example .env
```

- 확인: `ls -a`에 `.env`가 보인다.
- `.env`는 Git에 올라가지 않게 막혀 있다. 아래 명령이 `.gitignore`가 들어간 줄을 출력하면 정상이다.
  ```bash
  git check-ignore -v .env
  ```

#### 3) 넣을 값 준비하기

| 키 | 값 | 어디서 |
|---|---|---|
| `DATABASE_URL` | Transaction pooler 주소(포트 6543) + 끝에 `?pgbouncer=true&connection_limit=1` | 비밀번호 관리자(SETUP-SUPABASE 3단계) |
| `DIRECT_URL` | Session pooler 주소(포트 5432) | 비밀번호 관리자 |
| `SESSION_SECRET` | 32자 이상 임의 값(개발용. 운영 값과 다르게) | 아래 명령 |

비밀번호 관리자에 저장해 둔 주소가 없으면 다시 만든다.

1. Supabase 대시보드에서 `alarmops-dev` 프로젝트를 연다.
2. 위쪽의 **Connect** 버튼을 누른다.
3. **Transaction pooler** 주소(포트 `6543`)를 복사하고, 끝에 `?pgbouncer=true&connection_limit=1`을 붙인다. 이것이 `DATABASE_URL`이다.
4. **Session pooler** 주소(포트 `5432`)를 복사한다. 이것이 `DIRECT_URL`이다.
5. 두 주소 모두 `[YOUR-PASSWORD]` 자리에 DB 비밀번호를 넣는다.

`SESSION_SECRET`은 아래 명령이 출력한 한 줄을 그대로 쓴다.

```bash
openssl rand -base64 48
```

#### 4) `.env`에 값 넣기

```bash
code .env
```

VS Code가 열리지 않으면 `notepad .env`로 연다. 아래 세 줄을 찾아 `=` 뒤에 값을 넣고 저장한다.

```
DATABASE_URL=postgresql://postgres.<프로젝트ID>:<비밀번호>@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
DIRECT_URL=postgresql://postgres.<프로젝트ID>:<비밀번호>@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres
SESSION_SECRET=<3)에서 나온 한 줄>
```

- 값 앞뒤에 따옴표나 공백을 넣지 않는다. 나머지 줄은 그대로 둔다.
- 확인: 아래 명령이 `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET` 세 이름만 출력한다(값은 나오지 않는다).
  ```bash
  grep -oE '^(DATABASE_URL|DIRECT_URL|SESSION_SECRET)=.' .env | cut -d= -f1
  ```

#### 5) 허브에 알리기

허브에 **"채웠다"**고만 말한다.

> **주의** 에이전트는 `.env`를 읽지 못한다. 값은 사람이 직접 넣는다.

### 2-3. 실제 DB로 콘솔 띄워 보기 (15분)

- [ ] 회사 PC에서 실제 DB로 콘솔 확인

모든 명령은 **저장소 루트**에서 **Git Bash**로 실행한다. Node 20.6 이상이 필요하다(`node -v`로 확인).

#### 0) 먼저: 개발 DB에 새 마이그레이션이 적용됐는지

`db/prisma/migrations`가 바뀐 PR이 main에 병합되면 `dev-db` 워크플로가 자동으로 시작되고 **승인을 기다린다**. 승인 전에는 새 테이블·칸이 개발 DB에 없어 콘솔이 500을 낸다.

1. GitHub 저장소 → **Actions** → 왼쪽 **dev-db**.
2. 맨 위 실행이 "Waiting"이면 열어서 **Review deployments** → `dev` 체크 → **Approve and deploy**.
3. 확인: 초록 체크. 로그에 적용된 마이그레이션 이름이 나온다.

#### 1) 최신 코드 받기와 설치

```bash
git checkout main && git pull
```

```bash
npm ci
```

- 처음, 그리고 main을 새로 받을 때마다 한다. 처음에는 몇 분 걸린다.

#### 2) 데모 데이터(seed) 넣기

```bash
node --env-file=.env --import tsx db/prisma/seed.ts
```

- 들어가는 것: 데모 고객 2곳, 데모 직원 3명(admin·operator·viewer), 열린 인시던트 3건.
- 확인: 오류 없이 끝난다. 여러 번 실행해도 데이터가 중복되지 않는다.
- `DATABASE_URL is not set.`이 나오면 `.env`가 비어 있거나 루트가 아닌 곳에서 실행한 것이다.

> **참고** seed는 가짜 이름·가짜 번호만 넣는다. 운영 환경(`NODE_ENV=production`)에서는 실행을 거부한다.

#### 3) 콘솔을 실제 DB 모드로 띄우기

```bash
MOCK_API= LIVE_DEV_LOGIN=1 DATABASE_POOLER=transaction DATABASE_POOL_MAX=10 node --env-file=.env node_modules/next/dist/bin/next dev apps/console -p 3107
```

- `MOCK_API=`(빈 값): 가짜 데이터 모드를 끈다. `.env`에 `MOCK_API=1`이 있어도 이 값이 이긴다.
- `LIVE_DEV_LOGIN=1`: 개발용 로그인 주소를 연다. `next dev`에서만 동작한다.
- `DATABASE_POOLER=transaction`: 6543 포트(pooled 주소)로 붙을 때 필요하다.
- `DATABASE_POOL_MAX=10`: DB 연결 수. 기본값 3은 운영(Vercel)용이라, 회사 PC의 개발 모드에서는 연결을 기다리다 500이 날 수 있다(11/18 실제로 겪음).
- 확인: 터미널에 `Ready`가 나온다. 이 창은 닫지 않는다.

> **주의** `npm run dev -w @alarmops/console`은 쓰지 않는다. 그 명령은 항상 가짜 데이터 모드(`MOCK_API=1`)로 뜬다.

#### 4) 브라우저에서 로그인

```
http://localhost:3107/auth/dev-login?as=admin
```

- `as=` 뒤에는 `admin`, `operator`, `viewer` 중 하나를 쓴다. seed가 만든 데모 직원으로 로그인된다.

#### 5) 확인할 것

- Incidents에 열린 인시던트 3건이 보인다.
- 왼쪽 고객 목록과 Customers에 `Acme Demo`, `Birch Retail`이 보인다.
- 인시던트 하나를 Acknowledge 하고 새로 고침해도 상태가 남아 있다. DB에 저장됐다는 뜻이다.
- Settings › Users에 데모 직원 3명이 보인다.

끝나면 터미널에서 `Ctrl+C`로 콘솔을 끈다.

#### 무시해도 되는 메시지

| 메시지 | 이유 |
|---|---|
| 터미널의 `[webpack.cache.PackFileCacheStrategy] Skipped not serializable cache item …` | 개발 모드 빌드 캐시 경고. 동작과 무관 |
| 브라우저의 `A tree hydrated but some attributes … didn't match` (`nonce="…"` vs `nonce=""`) | 브라우저가 보안상 `nonce` 값을 숨겨서 생기는 개발 모드 경고. 스크립트는 정상 실행되고 운영 빌드에서는 나오지 않는다 |

#### 막혔을 때

오류 문구만 허브에 보낸다. 주소나 비밀번호가 섞여 있으면 그 부분은 지운다.

| 증상 | 원인과 할 일 |
|---|---|
| 500, 터미널에 `column "…" does not exist` | 0)의 `dev-db` 승인이 안 됐다 |
| 500, 터미널에 `[api] unhandled … error: 'Error'` (`code=` 없음) | DB 연결을 기다리다 시간 초과. `DATABASE_POOL_MAX=10`을 붙였는지 본다. 그래도 나면 허브에 그 줄을 보낸다 |
| 500, 터미널에 `ECONNREFUSED`나 timeout | DB에 붙지 못했다. `.env`의 `DATABASE_URL`을 다시 확인한다 |
| 화면에 `NOT_CONFIGURED`(503) | `DATABASE_URL`이 비어 있다. 2-2를 다시 본다 |
| 로그인 주소가 404 | `LIVE_DEV_LOGIN=1`이 빠졌거나 `.env`에 `SESSION_SECRET`이 없다 |
| 인시던트가 0건 | 2) seed를 건너뛰었다 |
| `Module not found` | 1) `npm ci`를 다시 실행한다 |
| `--env-file` 오류 | Node가 20.6보다 낮다. Node를 올린다 |

## 3단계 — 콘솔 배포(Vercel) [사람 + 에이전트]

끝나면: `https://<프로젝트>.vercel.app/login`에서 운영 콘솔이 열린다. 배포는 GitHub Actions에서 본인이 승인할 때만 일어난다. DB가 1분마다 콘솔의 틱을 부른다.

에이전트 몫(배포 워크플로, #46, D-53)은 끝났다. 남은 것은 아래 **[사람]** 절차다. 한 번만 한다. 순서대로 한다. 전체 1시간쯤 걸린다.

준비물:

- Vercel 계정(회사 팀)과 GitHub 저장소 관리자 권한
- 운영에 쓸 DB의 pooled 주소(포트 6543). 만드는 법은 `docs/SETUP-SUPABASE.md` 3단계와 같다.
- 본인 터미널(Git Bash)

> **참고** 운영 DB는 개발과 별도 프로젝트로 둔다. 만드는 순서(프로젝트, Data API 끄기, GitHub `production-db` 환경, `prod-db` 워크플로)는 `docs/SETUP-PROD-DB.md` 1~5단계에 있다.

### 3-1. [사람] Vercel 프로젝트 만들기 (10분)

어디서: Vercel 대시보드(PoC 동안은 개인 Hobby 범위도 된다, D-57. 파일럿 전에 회사 Pro 팀으로 옮긴다)

- [ ] **Vercel 프로젝트 만들기**(회사 팀, Root Directory `apps/console`)
- [ ] **Git 자동 배포 끄기**(D-53, 우회 방지)
- [ ] **production 주소 적어 두기**(3-3의 `CONSOLE_ORIGIN`에 쓴다)

> **참고** 화면별 클릭 순서는 `docs/SETUP-VERCEL.md` 1~4단계

<!-- include: docs/SETUP-VERCEL.md 1~4 -->

### 3-2. [사람] Vercel 토큰·ID와 GitHub `production` 환경 (15분)

어디서: Vercel 대시보드 → GitHub 저장소

- [ ] **Vercel 토큰과 ID 확인**
- [ ] **GitHub `production` 환경**(승인자 본인, `main`만)
- [ ] **환경 시크릿** 세 개(`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`)

> **참고** 화면별 클릭 순서는 `docs/SETUP-VERCEL.md` 5~7단계

<!-- include: docs/SETUP-VERCEL.md 5~7 -->

### 3-3. [사람] Vercel 환경변수 넣기 (15분)

어디서: Google Cloud 콘솔 → 본인 터미널(Git Bash) → Vercel 프로젝트의 환경변수 설정(Production)

- [ ] **Google OAuth 클라이언트**(`GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`의 출처, 3-1에서 적어 둔 주소가 있어야 한다)
- [ ] **Vercel 환경변수(Production)**

먼저 Google에서 클라이언트를 만든다. 리디렉션 주소에 3-1에서 적어 둔 `CONSOLE_ORIGIN`을 쓴다.

> **참고** Google 화면 순서는 `docs/SETUP-GOOGLE-SSO.md` 1단계

<!-- include: docs/SETUP-GOOGLE-SSO.md 1 -->

그다음 Vercel에 변수를 넣는다. 넣을 변수 표는 아래 8-3 하나다.

> **참고** 화면별 클릭 순서는 `docs/SETUP-VERCEL.md` 8단계

<!-- include: docs/SETUP-VERCEL.md 8 -->

남는 위험(R4)은 아래 [남는 위험(R4)](#남는-위험r4)에 따로 적었다.

### 3-4. [사람] 첫 배포 (10분)

어디서: GitHub 저장소의 Actions → Vercel 대시보드 → Supabase SQL Editor(운영 프로젝트)

- [ ] **첫 배포**
- [ ] **Deployment Protection 확인**
- [ ] **첫 관리자(ADMIN)와 Google 로그인 확인**

> **참고** 화면별 클릭 순서는 `docs/SETUP-VERCEL.md` 9~10단계

<!-- include: docs/SETUP-VERCEL.md 9~10 -->

스모크 검사가 실패하면 바로 3-6으로 간다.

배포가 됐으면 첫 관리자 행을 넣고 Google로 로그인해 본다. 배포된 콘솔에는 이 방법으로만 들어간다(1-5).

> **참고** 순서는 `docs/SETUP-GOOGLE-SSO.md` 3~4단계

<!-- include: docs/SETUP-GOOGLE-SSO.md 3~4 -->

### 3-5. [사람] 1분 틱 켜기 (10분)

어디서: Supabase 대시보드(콘솔이 쓰는 DB의 프로젝트)

틱은 DB가 1분마다 콘솔의 `POST /api/internal/tick`을 부르는 것이다. 이게 돌아야 에스컬레이션과 발송 대기열이 움직인다.

1. Supabase에서 확장 `pg_cron`과 `pg_net`이 켜져 있는지 확인한다. 꺼져 있으면 확장(Extensions) 설정을 찾아 켠다.
2. Supabase Vault에 `tick_secret`을 저장한다. (Vercel이 아니라 **Supabase** 대시보드다. 왼쪽 **Integrations** → **Vault** → **Secrets** 탭 → **Add new secret**. 11/19 실제 화면 확인)
   - 이름: 정확히 `tick_secret`
   - 값: 3-3에서 만든 `TICK_SECRET`과 **같은 값**
3. SQL Editor에서 `docs/API-CONTRACT.md` §5의 `cron.schedule('alarmops-tick', ...)`을 실행한다. 아래가 그 SQL이다. `<console-host>` 한 곳만 바꾼다.
   ```sql
   -- Supabase (D-23). 비밀은 Vault에 두고 SQL에 평문으로 쓰지 않는다. 호출 타임아웃은 60초 이상(§5 "예산").
   select cron.schedule('alarmops-tick', '* * * * *', $$
     select net.http_post(
       url     := 'https://<console-host>/api/internal/tick',
       headers := jsonb_build_object('content-type', 'application/json',
                    'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'tick_secret')),
       body    := jsonb_build_object('scheduledAt', to_char(date_trunc('minute', now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:00"Z"')),
       timeout_milliseconds := 60000);
   $$);
   ```
   - 값: URL은 배포 주소. `<console-host>`를 `<프로젝트>.vercel.app`처럼 `https://` 없이 호스트만 넣는다.
   - 비밀 값은 SQL에 쓰지 않는다. SQL은 Vault에서 읽는다.
4. 2분 기다린 뒤 SQL Editor에서 틱이 돌았는지 본다.
   ```sql
   select name, "lastFinishedAt", "lastStatus" from "TickHeartbeat" order by name;
   ```
   - 확인: 행들의 `lastFinishedAt`이 방금 시각이고 1분 뒤 다시 실행하면 바뀌어 있다. `lastStatus`가 `OK`다.

   > **참고** 콘솔 상단의 `PIPELINE OK · TICK 12s` 글자는 지금 고정 문구다(`apps/console/src/components/TopNav.tsx`). 틱 확인에 쓰지 않는다.

   > **참고** 업체 발송기가 아직 없어 발송 잡은 `NOT_CONFIGURED`로 대기열에 남는다(5단계 전까지 정상).

### 3-6. [사람] 스모크 검사가 실패했을 때 되돌리기 (5분)

어디서: Vercel 대시보드 또는 본인 터미널

- [ ] **스모크 검사가 실패했을 때(되돌리기, N4)**
- [ ] **되돌린 뒤 새 배포로 되돌리기 해제**

> **참고** 화면별 클릭 순서는 `docs/SETUP-VERCEL.md` 11단계

<!-- include: docs/SETUP-VERCEL.md 11 -->

### 3-7. [사람] CDN에서 HTML 캐시 끄기 (CDN을 둘 때만)

`*.vercel.app` 주소만 쓰는 동안은 할 일이 없다. 콘솔 앞에 CDN이나 로드 밸런서를 따로 둘 때 한다.

- nonce CSP 때문이다. 자세한 내용은 `infra/aws/README.md`.

1. HTML 문서는 CDN에서 캐시하지 않게 한다. 캐시해도 되는 것은 `/_next/static/*`와 공개 정적 자원뿐이다. `/api/*`도 캐시하지 않는다.
2. 배포 뒤 확인한다.
   ```bash
   curl -sI https://<콘솔>/ | grep -i -E "cache-control|x-cache|age"
   ```
   - 확인: `Age`가 없고 `X-Cache`가 `Miss`/`Bypass`다. 두 번 요청한 응답의 CSP nonce가 서로 다르다.

### 막혔을 때 (3단계)

| 증상 | 원인과 할 일 |
|---|---|
| `deploy-console` 작업이 시작도 안 하고 건너뛰어짐 | `main`이 아닌 브랜치에서 실행했다. `main`을 골라 다시 실행한다 |
| `Secret VERCEL_… is not set in the production environment` | 시크릿을 저장소 시크릿에 넣었거나 이름이 다르다. `docs/SETUP-VERCEL.md` 7단계 5번을 다시 본다 |
| 환경 검사에서 `CONSOLE_ORIGIN`·`TRUSTED_PROXY`가 "없음" | 두 변수를 Sensitive로 넣었다. Config(Plain)로 다시 만든다(`docs/SETUP-VERCEL.md` 8-2) |
| 환경 검사에서 `MOCK_API` 또는 `E2E_ALLOW_MOCK` | Vercel 변수 목록에서 지운다. 빈 값이어도 있으면 안 된다 |
| 환경 검사에서 `CONSOLE_ORIGIN` 형식 오류 | `https://호스트`까지만 쓴다. 끝의 `/`와 경로를 지운다 |
| 스모크: `/api/internal/tick`이 503 | Vercel에 `TICK_SECRET`이 없거나 32자 미만이다. 넣고 다시 배포한다 |
| 스모크: 401인데 콘솔의 응답이 아님 | Deployment Protection이 막고 있다. `docs/SETUP-VERCEL.md` 10단계 |
| 스모크: `/login`에 mock 표식 | `MOCK_API`가 들어갔다. 지우고 다시 배포한다 |
| 모든 주소가 503 | `CONSOLE_ORIGIN`이 없거나 `https://…` 모양이 아니다 |
| `TickHeartbeat`가 안 바뀜 | Vault의 `tick_secret`과 Vercel의 `TICK_SECRET`이 다르거나(401), SQL의 `<console-host>`를 안 바꿨다. 두 값을 맞추고 3-5를 다시 본다 |
| `lastStatus`가 `ERROR` | 허브에 그 행의 `name`과 시각을 알린다. 값(비밀)은 보내지 않는다 |

### 배경 (읽지 않아도 된다)

#### [에이전트] 완료: 배포 워크플로 (#46, D-53)

워크플로 파일은 `.github/workflows/deploy-console.yml`이다.

실행 조건:

- `main` 병합 후 `ci`가 성공하면 자동 실행(`workflow_run`). 콘솔 경로(`apps/`, `packages/`, `tools/vercel-cli/`, `package*.json`, 이 워크플로 파일)가 바뀐 커밋만 배포하고 나머지는 건너뛴다. 수동 실행(`workflow_dispatch`)도 된다
- 자동 실행은 `ci`가 이 저장소의 `main` push에서 성공했을 때만, 그 커밋(`head_sha`)을 배포한다
- `main`에서만
- 환경 `production`(필수 승인자는 사람이 Settings → Environments에서 제거할 수 있다. 환경 이름은 바꾸지 않는다)
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

#### 남는 위험(R4)

- 받은 환경 파일에는 `DATABASE_URL`·`SESSION_SECRET`·`TICK_SECRET`·`VERCEL_OIDC_TOKEN`이 들어 있다.
- 받은 직후 검사·비밀 제거 두 단계가 돈다. 이 둘은 저장소의 검증된 스크립트만 쓴다.
- 그 뒤에야 빌드(저장소·npm 코드)가 돈다. 빌드에는 비밀이 없다.
- `npm ci`·CLI 설치는 pull **앞**이라 토큰을 보지 못한다.

> **주의** 같은 러너에서 pull~제거 사이에 도는 코드는 우리 스크립트뿐이어야 한다. 단계를 추가할 때 지킨다.

> **주의** 운영 비밀 회전 주기를 둔다. 의심되면 `SESSION_SECRET`·`TICK_SECRET`·토큰을 바꾼다.

> **주의** 배포 승인자는 워크플로 변경 PR을 같은 기준으로 본다.

## 4단계 — AWS 중앙 계정(서울) [에이전트 템플릿 → 사람 배포]

끝나면: 중앙 AWS 계정(서울)에 수집 Lambda·큐·알람 엔진이 떠 있다. 콘솔(Vercel)이 명령 큐에 보낼 수 있다. 고객 스택에 넣을 값 세 개(`CentralRoleArn`, `CentralBusArn`, `WebhookUrl`)를 손에 쥔다.

에이전트 몫(템플릿과 배포 워크플로, #47)은 끝났다. 남은 것은 아래 **[사람]** 절차다. 한 번만 한다. 순서대로 한다. 반나절쯤 잡는다(한도 상향 대기 포함).

준비물:

- 중앙 AWS 계정에 SSO·MFA로 들어갈 수 있는 관리자 권한. 리전은 **서울(ap-northeast-2)**.
  - PoC 동안은 회사 CT 조직 안의 사용자 본인 계정(`dev` 프로필)을 중앙 계정으로 쓴다(D-57). 등록 방법: `docs/SETUP-WINDOWS.md` 4-1. 중앙은 어느 계정에든 옮길 수 있게 만든다(D-58).
- 3단계가 끝난 Vercel 프로젝트(팀 슬러그와 프로젝트 이름을 안다)
- GitHub 저장소 관리자 권한

> **주의** AWS 콘솔과 본인 터미널 작업은 사람이 SSO·MFA로 한다. 에이전트에게 시키지 않는다.

> **주의 — 중앙 계정 운영 규칙** 엔진 실행 역할이 곧 고객이 신뢰하는 중앙 역할이다(PoC 결정).
> - 그래서 이 계정에는 다른 Lambda·워크로드를 두지 않는다.
> - `iam:PassRole`로 이 역할을 넘길 수 있는 주체를 배포 역할로 한정한다.
> - 개발 계정에서 먼저 확인한다: 중앙 역할 신뢰의 `aws:SourceAccount` 조건이 Lambda 실행에 문제를 일으키지 않는지(함수가 역할을 맡아 시작되는지).

### 4-1. [사람] AWS 준비: 버스·OIDC·배포 역할·한도 (1시간)

어디서: AWS 콘솔(중앙 계정, 서울). 5번만 Vercel 대시보드와 같이 본다.

- [ ] **버스 스택**

1. 언제: 아직 없으면. CloudFormation의 스택 목록에 `alarmops-central-bus`가 있으면 건너뛴다.
2. 값: `infra/aws/central-bus.yaml`을 스택 `alarmops-central-bus`로 올린다.
   - AWS 콘솔의 CloudFormation에서 새 스택을 만들고, 템플릿 파일로 저장소의 `infra/aws/central-bus.yaml`을 올린다.
   - 스택 이름: 정확히 `alarmops-central-bus`
   - 파라미터: `BusName`은 기본값 `alarmops-central` 그대로, `AllowedAccountIds`는 비워 둔다. 비어 있으면 아무 고객도 이벤트를 넣지 못한다.
   - 확인: 스택 상태가 생성 완료이고 출력에 `CentralBusArn`, `BusName`이 보인다.
   - 참고: `bus-allowlist` 워크플로가 이 스택을 갱신한다.

- [ ] **부트스트랩 스택 `alarmops-central-bootstrap`**(OIDC 공급자 두 개, SAM 아티팩트 버킷, 경계 정책, 배포 역할 두 개와 그 관리형 정책 4개를 한 번에)

3. 어디서: CloudFormation 콘솔(중앙 계정, 서울). 손으로 IAM 리소스를 만들지 않는다. 클릭 순서와 파라미터는 `infra/aws/deploy-role-policy.md` 5절이 정본이다. 요약은 다음과 같다.
   1. 스택 생성 → 템플릿 파일 업로드: `infra/aws/central-bootstrap.yaml`
   2. 스택 이름: 정확히 `alarmops-central-bootstrap`
   3. 파라미터
      - `GitHubOidcProviderArn`, `VercelOidcProviderArn`, `SamArtifactBucketName`: 이 계정에 이미 있으면(예: PoC 계정에서 손으로 만들어 둔 것) ARN이나 이름을 넣는다. 비워 두면 스택이 새로 만든다. 새 계정은 비워 둔다.
      - `VercelTeamSlug`: Vercel 공급자를 새로 만들 때 필수
      - 나머지는 기본값
   4. 마지막 화면의 **IAM 승인 체크**(`CAPABILITY_NAMED_IAM`)를 켜고 생성. 종료 방지를 켠다.
   5. 출력에서 `DeployCentralRoleArn`, `DeployBusRoleArn`, `VercelOidcProviderArn`, `SamArtifactBucketName`을 확인한다(4-2의 스크립트가 읽어 변수로 넣는다).
   - 확인: 상태 `CREATE_COMPLETE`.
   - 이미 손으로 만든 경계 정책·역할이 있으면 이름이 겹쳐 생성이 실패한다. 지우고 스택으로 만든다(`deploy-role-policy.md` 5-3). 공급자와 버킷은 지우지 않고 파라미터로 넘긴다.
   - 이 스택은 배포 역할이 고칠 수 없다(`deploy-role-policy.md` 5-5). 갱신은 사람이 한다.
   - 버스 스택(1~2번)은 이 스택에 합치지 않는다. `bus-allowlist`가 `UpdateStack`하기 때문이다.

   스택이 만드는 배포 역할의 요약:
   - 배포 역할 `AlarmOpsDeployCentral`: 신뢰 `sub` = `repo:<GITHUB_REPO_SUBJECT>:environment:central`(와일드카드 금지. `<GITHUB_REPO_SUBJECT>`는 GitHub가 보내는 불변 ID 형식 `owner@ID/repo@ID`, 이 저장소는 `hkjs96@75015048/alarmops@1451138684`), 최대 세션 1시간. 권한은 `infra/aws/README.md`의 "실행과 사람이 하는 일" 범위다.
     - CloudFormation: 스택 `alarmops-central`, 변환 `AWS::Serverless-2016-10-31`, `GetTemplate`
     - SAM 아티팩트 버킷: 객체 쓰기와 `s3:GetObject`
     - 이 스택이 만드는 리소스의 생성·변경: Lambda, SQS, Events, Logs, Secrets Manager(값 없이), CloudWatch 알람, API Gateway v2
     - `AlarmOpsCentral-*`와 `alarmops-central-*` 역할의 생성·변경. 만들 때마다 경계 정책을 붙여야 한다(`iam:PermissionsBoundary` 조건)
     - `iam:PassRole`: `AlarmOpsCentral-Engine`과 SAM 함수 역할에만, `iam:PassedToService=lambda.amazonaws.com` 조건으로
     - 버스 스택은 `DescribeStacks`만
   - **권한 경계 필수**: 경계 안에는 이 템플릿의 역할이 실제로 쓰는 서비스만 넣는다(sqs, secretsmanager 읽기, logs, `sts:AssumeRole`, `ses:SendEmail`). events와 lambda는 뺐다(`deploy-role-policy.md` 2절). `AssumeRemediatorCaller`는 상한일 뿐이고 실제 허용은 `RemediationEnabled`일 때만 만든다.
   - **신뢰 정책 변경의 우회 위험은 수용했다(D-57).** 보완책(CloudTrail 알림, plan 승인 전 본문 확인, `TrustChange` 정책 1시간 자동 만료)은 `deploy-role-policy.md` 3-2·4·4-1·4-2절에 있다. **CloudTrail 알림 규칙은 실고객 연결 전 필수다**(구현은 파일럿 전 이슈).
   - 버스 허용 목록 역할 `AlarmOpsDeployBus`: 신뢰 `sub` = `repo:<GITHUB_REPO_SUBJECT>:environment:central-bus`. `bus-allowlist` 전용이다. 중앙 배포 역할에는 버스 스택 `DescribeStacks`만 둔다.
   - 배포 권한은 인라인이 아니라 **고객 관리형 정책**이다(`AlarmOpsDeployCentral-Cfn`·`-Iam`·`-Services`, `AlarmOpsDeployBus`). ISMS-P 감사에서 버전 이력과 독립 검토를 위해서이고 정책 하나는 6,144자 한도라 3개로 나눴다. 기존 스택을 갱신하면 인라인 정책은 삭제되고 관리형 정책이 붙는다(`deploy-role-policy.md` 5절).
   - 정책 JSON(신뢰, 권한, 경계)의 정본은 `deploy-role-policy.md`이고, 템플릿이 같은 내용을 만든다(`infra/test/test_central_bootstrap.py`가 비교한다).

- [ ] **Vercel 쪽 설정(D-49)**

4. 순서대로 한다. AWS 쪽 공급자는 위 스택이 만들었다.
   1. 어디서: Vercel 프로젝트 Settings → Security → Secure backend access with OIDC federation
   2. 발급자 모드는 **Global**이나 **Team** 어느 쪽이든 된다. 템플릿이 공급자 ARN에서 조건 키 접두사를 계산한다. Team이면 사람이 IAM에서 URL `https://oidc.vercel.com/<팀 슬러그>`, 대상 `https://vercel.com/<팀 슬러그>`로 공급자를 만들고 그 ARN을 `VercelOidcProviderArn`으로 쓴다(부트스트랩 스택은 Global만 만든다).
   3. 스택 파라미터 `VercelTeamSlug`가 이 팀 슬러그와 같은지 확인한다(공급자 대상이 `https://vercel.com/<팀 슬러그>`다).
   4. 공급자 ARN은 스택 출력 `VercelOidcProviderArn`이다. 4-2의 스크립트가 변수 `VERCEL_OIDC_PROVIDER_ARN`에 넣는다.
      - ARN 모양(Global): `arn:aws:iam::<중앙 계정 ID>:oidc-provider/oidc.vercel.com`
      - ARN 모양(Team): `arn:aws:iam::<중앙 계정 ID>:oidc-provider/oidc.vercel.com/<팀 슬러그>`(슬러그는 소문자·숫자·하이픈)

- [ ] **Service Quotas**

5. AWS 콘솔의 Service Quotas에서 Lambda 동시 실행 한도를 찾아 올린다.
   - 값: Lambda 동시 실행 한도를 올린다.
   - 확인: 계정 한도 140 이상
   - 이유: 새 계정 10이면 예약 동시성 설정이 실패한다. 기본 예약 합계가 40이다.
   - 상향 요청은 AWS가 승인할 때까지 기다려야 할 수 있다. 승인 전에는 4-3을 실행하지 않는다.

### 4-2. [사람] GitHub 환경과 변수 (스크립트 한 번, 10분)

어디서: 본인 터미널(저장소 관리자 권한으로 `gh` 로그인, 본인이 연 SSO 세션). 환경은 CloudFormation으로 만들 수 없어서 스크립트로 한다.

> **참고 — GitHub 환경은 왜 여러 개인가** 배포 대상마다 환경을 따로 둔다. 환경은 세 가지 일을 한다. ① AWS·Vercel이 "이 이름의 환경에서 돈 작업"만 열쇠를 준다(OIDC 신뢰 `sub`). ② 배포 직전에 멈춰 사람 승인을 받는다. ③ 그 배포에만 쓰는 값·비밀을 담는다. 하나로 합치면 콘솔 배포를 승인한 작업이 AWS 열쇠까지 읽을 수 있어서 나눈다.
>
> | 환경 | 쓰는 워크플로 | 배포 대상 | 담는 것 | 만드는 곳 |
> |---|---|---|---|---|
> | `production` | `deploy-console` | 콘솔 → Vercel | Vercel 토큰·ID(비밀) | 3-2 |
> | `production-db` | `prod-db` | 운영 DB 마이그레이션 | DB 연결 주소(비밀) | `SETUP-PROD-DB.md` |
> | `central` | `deploy-central` | 엔진·수집 → AWS 중앙 계정 | 배포 역할 ARN, SAM 버킷, Vercel OIDC 공급자 ARN 등(변수) | 이 절 |
> | `central-bus` | `bus-allowlist` | 고객 허용 목록 → AWS 버스 | 버스 전용 역할 ARN(변수) | 이 절 |
>
> 값을 넣을 환경을 헷갈리지 않는다. 예: `VERCEL_OIDC_PROVIDER_ARN`은 AWS 중앙 배포가 쓰므로 `production`이 아니라 `central`에 넣는다.

- [ ] **스크립트 실행**

1. 먼저 아무것도 호출하지 않는 `--dry-run`으로 본다.
   ```bash
   infra/scripts/setup-github-environments.sh --repo hkjs96/alarmops --reviewer <본인 GitHub ID> --from-stack --dry-run
   ```
2. 이어서 실제로 실행한다. `--from-stack`이 `aws cloudformation describe-stacks --query`로 4-1 스택 출력을 읽는다. 나머지 변수는 `--var 환경:이름=값`으로 준다.
   ```bash
   infra/scripts/setup-github-environments.sh --repo hkjs96/alarmops --reviewer <본인 GitHub ID> --from-stack \
     --var central:VERCEL_TEAM_SLUG=<팀 슬러그> --var central:VERCEL_PROJECT_NAME=<Vercel 프로젝트 이름>
   ```
3. 스크립트가 하는 일
   - 환경 `central`, `central-bus`, `production`을 만든다. 필수 승인자는 본인 한 명이고, **Prevent self-review는 끈다**(승인자가 1인이다). 배포 브랜치는 사용자 지정 정책으로 `main`만 둔다.
   - 변수: `central`에 `CENTRAL_DEPLOY_ROLE_ARN`, `VERCEL_OIDC_PROVIDER_ARN`, `SAM_ARTIFACT_BUCKET`, `central-bus`에 `CENTRAL_BUS_DEPLOY_ROLE_ARN`(스택 출력에서). 두 ARN은 서로 다르다. `central` 환경에는 `CENTRAL_BUS_DEPLOY_ROLE_ARN`을 두지 않는다.
   - 이미 있는 환경과 변수는 덮어쓴다(여러 번 실행해도 된다).
4. 변수 표(환경 `central`)

   | 변수 | 필수 | 값 |
   |---|---|---|
   | `CENTRAL_DEPLOY_ROLE_ARN` | 필수 | 스택 출력 `DeployCentralRoleArn`(스크립트가 넣음) |
   | `VERCEL_OIDC_PROVIDER_ARN` | 필수 | 스택 출력 `VercelOidcProviderArn`(스크립트가 넣음) |
   | `VERCEL_TEAM_SLUG` | 필수 | Vercel 팀 슬러그(`--var`) |
   | `VERCEL_PROJECT_NAME` | 필수 | 3-1에서 만든 Vercel 프로젝트 이름(`--var`) |
   | `SAM_ARTIFACT_BUCKET` | 필수 | 스택 출력 `SamArtifactBucketName`(스크립트가 넣음) |
   | `ALARM_TOPIC_ARN` | 선택 | DLQ가 비어 있지 않을 때 알릴 SNS 주제 ARN(`--var`) |
   | `CENTRAL_BUS_NAME` | 선택 | 기본 `alarmops-central`. 버스 이름을 바꾸지 않았으면 넣지 않는다 |
   | `SES_IDENTITY_ARN`·`SES_FROM_ADDRESS` | 이메일을 쓸 때만 | 1-2에서 적어 둔 값(D-52). 둘을 같이 넣는다 |

5. 확인: `central` 환경의 Variables에 필수 다섯 개가 보이고 `central-bus`에 `CENTRAL_BUS_DEPLOY_ROLE_ARN`이 보인다. 하나라도 없으면 `plan`이 `Environment variable for … is not set in the central environment`로 멈춘다.

- [ ] **비밀 값**(스크립트가 하지 않는다)

6. `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`는 사람이 직접 `gh secret set <이름> --repo hkjs96/alarmops --env production`으로 넣는다(값은 프롬프트로 입력). 스크립트는 이름에 `TOKEN`·`SECRET`·`PASSWORD`·`PRIVATE`·`KEY`가 들어간 `--var`를 거부한다.

### 4-3. [사람] 배포 실행 (30분)

어디서: GitHub 저장소의 Actions

- [ ] **실행**

1. `main`에 병합하고 `ci`가 성공하면 `deploy-central`이 자동으로 시작한다(`infra/aws/`, `services/`, `packages/core/`, `package*.json`, 워크플로 파일, `bundle_manifest.py`가 바뀐 커밋만). 직접 하려면 Actions → `deploy-central` 실행, 브랜치는 `main`을 고른다. 바뀐 것이 없으면 변경 세트가 비어 `apply` 없이 성공으로 끝난다.
2. `build`와 `checks`가 끝나면 `plan` 작업 승인을 누른다(`central` 환경의 필수 승인자를 제거했으면 승인 없이 진행한다).
3. `plan`이 끝나면 요약의 **IAM 변경 표**를 읽는다.
   - 표 제목은 `IAM changes (read these first)`다.
   - 볼 것: 역할 이름이 모두 `AlarmOpsCentral-`로 시작하거나 이 스택의 함수 역할이다. 모르는 IAM 리소스가 있으면 승인하지 않고 허브에 묻는다.
4. `apply` 작업 승인을 누른다.
   - 확인: 완료 요약의 출력표. 제목은 `alarmops-central outputs`다.
5. 출력표를 그대로 열어 둔다. 4-4와 4-5에서 쓴다. 출력은 ARN·URL·계정 ID뿐이고 비밀이 아니다.

> **참고** 첫 실행은 사람이 끝까지 지켜본다. 검증 단계는 실제 AWS에서만 확인할 수 있다.

### 4-4. [사람] DB 비밀 값 넣기 (15분)

어디서: 본인 터미널 또는 AWS 콘솔(Secrets Manager)

- [ ] **DB 비밀 값 넣기**

엔진용과 수집용은 서로 다른 DB 사용자다(D-56). 먼저 두 사용자를 만들고(`db/sql/roles.sql`), 그 사용자의 주소를 4-3 출력의 `EngineDbSecretArn`, `IngestDbSecretArn` 비밀에 넣는다. 소유자 주소는 넣지 않는다.

> **참고** 화면별 순서는 `docs/SETUP-PROD-DB.md` 6~7단계

> **참고 (11/24 실제로 해 본 순서)** 비밀 값 한 줄은 이렇게 만든다.
> 1. Supabase 프로젝트 맨 위 **Connect** → **Session pooler** 주소를 메모장에 복사한다.
> 2. `postgres.` → `alarmops_engine.`(수집은 `alarmops_ingest.`), `[YOUR-PASSWORD]` → 그 사용자 비밀번호(대괄호까지 지움), 끝에 `?sslmode=require`.
> 3. 수집용은 포트를 `:5432` → `:6543`으로 바꾼다.
> 4. Secrets Manager(서울) → 비밀 → **비밀 값 검색** → **편집** → **일반 텍스트**에 임시 값을 지우고 붙인다. 메모장은 저장하지 않고 닫는다.

<!-- include: docs/SETUP-PROD-DB.md 6~7 -->

### 4-5. [사람] 출력값 연결 (10분)

어디서: Vercel 프로젝트의 환경변수 설정(Production) → GitHub Actions

- [ ] **출력값을 Vercel 환경변수(production)에**

1. 4-3의 출력표에서 값을 복사해 Vercel 환경변수(Production)에 넣는다.

   | Vercel 변수 | 출력표의 이름 |
   |---|---|
   | `ALARM_COMMANDS_QUEUE_URL` | `AlarmCommandsQueueUrl` |
   | `ALARM_COMMANDS_EXPECTED_ACCOUNT` | `CentralAccountId` |
   | `AWS_ROLE_ARN` | `VercelConsoleRoleArn` |
   | `CENTRAL_ROLE_ARN` | `CentralRoleArn` |
   | `CENTRAL_EVENT_BUS_ARN` | `CentralBusArn` |
   | `REMEDIATOR_CALLER_ROLE_ARN` | `RemediatorCallerRoleArn` (Remediator를 켜는 고객이 있을 때만) |

   모두 일반 변수로 넣는다. 비밀이 아니다. Vercel 추가 창의 Type에서 **Config**를 고른다(**Secret** 아님). 다섯 개는 한 창에서 Key·Value 칸을 늘려 한 번에 넣을 수 있다.

   > **주의** `AWS_ROLE_ARN`은 배포된 Vercel 런타임에만 넣는다. 회사 PC `.env`, CI, 에이전트 세션에는 넣지 않는다(`apps/console/README.md`).
2. 콘솔을 다시 배포한다. Actions → `deploy-console` 실행 → 승인(3-4). 새 변수는 새 배포부터 쓰인다.
3. 아래 값을 비밀번호 관리자나 메모에 적어 둔다. 비밀이 아니다. 7단계에서 고객에게 준다.

   고객 스택 파라미터:
   - `CentralRoleArn` = 출력 `CentralRoleArn`
   - `CentralEventBusArn` = 출력 `CentralBusArn`
   - (Remediator를 켜는 고객만) `RemediatorCallerRoleArn` = 출력 `RemediatorCallerRoleArn`

   웹훅 주소는 출력 `WebhookUrl`이다.

### 4-6. [사람] 권한 실측 (반나절, #38)

어디서: 시험용 AWS 계정(고객 역할을 하는 계정)과 중앙 계정

- [ ] **권한 실측**(#38)

스크립트는 `infra/scripts/rehearsal/`에 있다. 사람이 시험 계정(B·C)에서만 실행한다(중앙 계정은 제외). 에이전트는 실행하지 않는다. 자세한 순서는 그 폴더의 `README.md`를 본다.

1. 시험 계정을 콘솔에 등록한다(7-1, AlarmWriter 켬). 아직 허용 목록에는 넣지 않는다. 그리고 `accounts.local.json`을 만든다(저장소에 올리지 않는다).
2. `bash infra/scripts/rehearsal/preflight.sh --profile rehearsal-b` (읽기만 한다)
3. `REHEARSAL_EXTERNAL_ID=... bash infra/scripts/rehearsal/install.sh --profile rehearsal-b --confirm-account 12자리` (스택 `alarmops-customer`, `EnableAlarmWriter=true`). 끝나면 콘솔에서 연결 확인(7-4)이 OK인지 본다.
4. `bash infra/scripts/rehearsal/verify.sh --profile rehearsal-b --confirm-account 12자리 --run-id 이름`. 스크립트가 멈추면 안내대로 사람이 한다.
   - 허용 목록 추가 **전**에 먼저 돈다. 허용 목록에 없는 계정의 이벤트가 막히는지(`FailedInvocations`)를 본다. 중앙에서 처리되지 않았음은 사람이 콘솔에서 확인한다.
   - 그다음 사람이 `bus-allowlist`(`action=add`)로 시험 계정을 넣고 스크립트를 계속한다.
   - 태그를 붙이면 알람이 생긴다(`ManagedBy=AlarmOps`, 큐 차원). 반영까지 최대 15분(디바운스 10분 포함) 기다린다.
   - 태그를 떼면 알람은 남고 콘솔이 확인 필요(NEEDS_REVIEW)로 표시한다. 사람이 콘솔에서 STOP_MONITORING을 실행하면 그 알람만 사라진다.
   - `ManagedBy` 없는 알람 거부는 정책 시뮬레이션(실측 아님)으로 본다.
   - **1회 수동 실측(B 계정 리허설 때 한 번, 선택 아님)**: 시뮬레이션이 못 보는 CloudWatch의 실제 태그 조건 처리와 조직 SCP를 확인한다. 사람이 CLI로 한다(하네스에 넣지 않는다).
     1. `AlarmOps-AlarmWriter`의 권한 정책과 권한 경계를 콘솔(IAM → 역할)에서 그대로 확인한다.
     2. 같은 권한 정책과 같은 권한 경계를 붙인 임시 역할 `AlarmOpsRehearsal-WriterReplica`를 만든다. 신뢰 대상만 본인 SSO 역할로 둔다. 태그 `AlarmOpsRehearsal=true`.
     3. 그 역할로 `cloudwatch put-metric-alarm`을 두 번 부른다: `--tags Key=ManagedBy,Value=AlarmOps`를 붙이면 성공, 빼면 `AccessDenied`여야 한다. 알람 이름은 `AlarmOpsRehearsal-replica-test`.
     4. 만든 알람을 지우고 임시 역할을 지운다. 결과(성공/AccessDenied)만 허브에 알린다.
     5. 원본 정책과 다르게 만들면 의미가 없다. 확신이 없으면 하지 말고 허브에 묻는다.
5. `bash infra/scripts/rehearsal/cleanup.sh --profile rehearsal-b --confirm-account 12자리 --run-id 이름 [--stack]`. 그 뒤 사람이 콘솔 계정 비활성화와 `bus-allowlist remove`를 한다(OFFBOARDING 순서).
6. 결과를 허브에 알린다. 항목별로 "됐다/안 됐다/TIMEOUT/SKIP"과 오류 코드만 보낸다. 로그(`rehearsal-logs/`)는 올리지 않는다.

### 참고: 필요할 때만 하는 것

- [ ] **DLQ 재처리(break-glass)**

  > **참고** `alarm-commands` DLQ는 중앙 역할만 읽는다(`StartMessageMoveTask`도 막힌다).

  메시지를 되돌려야 하면:
  1. 운영 역할 ARN을 환경 변수 `DLQ_OPS_ROLE_ARN`에 넣고 `deploy-central`로 반영한다. 넣는 곳은 4-2와 같은 `central` 환경의 Variables다. 반영은 4-3과 같다(승인 두 번).
  2. 그 역할로 재처리한다.
  3. 끝나면 변수를 지우고 다시 반영한다.

- [ ] (선택, D-52) SES를 쓰면 `ses:Recipients` 조건을 추가해 수신자 범위를 좁히는 것을 검토한다. 지금은 From 주소와 신원만 고정한다.

### 막혔을 때 (4단계)

| 증상 | 원인과 할 일 |
|---|---|
| `deploy-central` 작업이 모두 건너뛰어짐 | `main`이 아닌 브랜치에서 실행했다 |
| `plan`: `Environment variable for … is not set in the central environment` | 4-2의 필수 변수가 없거나 저장소 변수로 넣었다. `central` 환경의 Variables에 넣는다 |
| `plan`: AWS 자격 증명 단계에서 실패 | 배포 역할의 신뢰 조건이 다르다. `sub`가 정확히 `repo:<GITHUB_REPO_SUBJECT>:environment:central`(불변 ID 형식)인지, 공급자의 대상이 `sts.amazonaws.com`인지 본다 |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | CloudTrail의 `AssumeRoleWithWebIdentity` 이벤트에서 `userIdentity.userName`의 실제 sub를 확인하고, 스택 `alarmops-central-bootstrap`의 파라미터 `GitHubRepo`를 그 값(`owner@ID/repo@ID`)으로 업데이트한다 |
| `plan`: `Check the central bus stack exists`에서 실패 | 버스 스택이 없거나 이름이 `alarmops-central-bus`가 아니다. 4-1의 1~2번 |
| `plan`: 파라미터 `VercelOidcProviderArn` 형식 오류 | ARN이 `…:oidc-provider/oidc.vercel.com` 또는 `…:oidc-provider/oidc.vercel.com/<팀 슬러그>`로 끝나야 한다. 4-1의 4번 |
| 콘솔 "The check could not be queued", CloudTrail `AssumeRoleWithWebIdentity` AccessDenied, `identityProvider`가 `…/oidc.vercel.com/<팀>` | 신뢰 정책이 다른 공급자를 가리킨다. `aws iam get-role --role-name AlarmOpsCentral-VercelConsole`의 `Federated`와 조건 키를 본다. GitHub `central` 환경 변수 `VERCEL_OIDC_PROVIDER_ARN`을 실제 공급자 ARN(Team이면 `…/oidc.vercel.com/<팀>`)으로 바꾸고 deploy-central을 Run workflow로 다시 돌린다. 신뢰 정책이 바뀌므로 먼저 `infra/aws/deploy-role-policy.md` 4장의 임시 권한(`AlarmOpsDeployCentral-TrustChange`)을 붙인다 |
| deploy-central `apply`가 `UPDATE_ROLLBACK_FAILED`, 알림 메일 `iam-denied` `UpdateAssumeRolePolicy` AccessDenied | 신뢰 정책 변경에 임시 권한이 없었다. 임시 권한을 붙이고 `aws cloudformation continue-update-rollback --stack-name alarmops-central`(리소스 건너뛰지 않음) → `UPDATE_ROLLBACK_COMPLETE` 확인 → Run workflow로 다시 배포 → 임시 권한 삭제 |
| `plan`: `SesFromAddress is required when SesIdentityArn is set` | `SES_FROM_ADDRESS`도 같이 넣는다 |
| `apply`: 예약 동시성 관련 실패 | Lambda 동시 실행 한도가 140 미만이다. 4-1의 5번 |
| `apply`: 코드 검증 단계에서 권한 거부 | 배포 역할에 `cloudformation:GetTemplate`이나 SAM 버킷 `s3:GetObject`가 없다. 4-1의 3번 |
| `apply`가 건너뛰어짐, 요약에 `no changes` | 바뀐 것이 없다. 정상이다 |
| Lambda가 시작을 거부 | 비밀의 연결 문자열에 `sslmode=require`가 없다. 4-4의 3번 |
| 콘솔에서 고객 해지 시 503 `COMMANDS_UNAVAILABLE` | Vercel에 `ALARM_COMMANDS_QUEUE_URL`이 없다. 4-5 |

### 배경 (읽지 않아도 된다)

#### [에이전트] 중앙 배포 묶음 템플릿 완료 (#47)

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

배포할 때는 워크플로가 직접 빌드한다. 사람이 미리 할 필요가 없다. 로컬에서 산출물을 확인하고 싶을 때만 저장소 루트에서 실행한다.

```bash
npm ci --ignore-scripts && npm run build:lambda -w @alarmops/ingest && npm run build:engine-lambda
```

- 수집 → `services/ingest/dist/{webhook,eventbridge,consumer}/index.mjs`
- 엔진 → `services/alarm-engine/build/`
- 자세한 내용은 `services/ingest/README.md`, `services/alarm-engine/README.md`의 Deploy.

> **참고** 엔진은 wheel을 받으므로 인터넷이 필요하다. 템플릿이 arm64라 기본이 aarch64 wheel이다.

#### 워크플로가 하는 확인

- `deploy-central.yml`의 `build` 작업이 위 빌드를 직접 한다. `plan`과 `apply`는 빌드하지 않고 `build`가 만든 것을 검증해 쓴다.
- `prisma generate`는 수집 번들이 쓰지 않아 불필요하다.
- 산출물 매니페스트 체크섬으로 `apply`가 `plan`이 올린 코드와 같은 것만 실행하는지 확인한다(`infra/aws/README.md`).

#### 남은 backend 몫

- 원격 조치의 두 단계 역할 맡기.

## 5단계 — 알림 발송 [에이전트, 1단계 결정 후]

끝나면: 인시던트가 열리면 정해진 순서대로 Slack·이메일(그리고 업체가 정해지면 문자·전화)이 실제로 나간다.

이 단계의 코드는 에이전트가 만든다. 사람이 할 일은 세 가지다: 정보를 주고(5-1), 키를 넣고(5-2), 한 번 시험한다(5-3).

에이전트 몫:

- [ ] 문자·전화 어댑터(#10): 멱등 키 전달, 오류 문구 가리기, 부분 장애 규칙. 업체 키는 서버 비밀로만
- [ ] Slack·이메일 어댑터 + DEGRADED 감시자 + 10시 요약 + 비상 열람 알림(#39)
- [ ] seed 번호 가드는 이미 있음(#26) — 실제 번호 등록 후 확인 링크로 검증

### 5-1. [사람] 정보 주기 (1단계가 끝났으면 5분)

1. 1단계의 1-2(SES)와 1-3(Slack)을 끝낸다.
2. 허브에 말한다: "Slack 워크스페이스·채널 정했다, SES 주소 인증했다. #39 시작해라."
3. 문자·전화는 1-1이 정해질 때까지 보류다(#10). Slack·이메일만 먼저 진행한다.
4. 기다린다. 허브가 #39 PR을 올리면 승인 요청이 온다. 그 PR에 "어떤 변수를 어디에 넣는지"가 적혀 있다.

### 5-2. [사람] 키 넣기 (PR이 머지된 뒤, 10분)

어디서: Vercel 프로젝트의 환경변수 설정(Production). PR이 Lambda 비밀이라고 하면 AWS 콘솔의 Secrets Manager.

1. 업체 키를 Vercel(또는 Lambda) 비밀로 입력한다.
   - 넣을 것: Slack 봇 토큰과 서명 비밀, 나중에 문자·전화 업체 키.
   - 변수 이름은 저장소에 아직 없다. #39(문자·전화는 #10) PR이 정한다. PR에 적힌 이름 그대로 넣는다.
   - 이메일(SES)은 키가 없다. 4-2의 `SES_IDENTITY_ARN`·`SES_FROM_ADDRESS`를 넣고 `deploy-central`을 다시 실행한다(4-3).
2. 콘솔을 다시 배포한다. Actions → `deploy-console` 실행 → 승인(3-4).

> **주의** 키는 Vercel·AWS 화면에 직접 넣는다. 허브·이슈·PR에 붙여 넣지 않는다.

### 5-3. [사람] 시험 한 번 (10분)

1. 본인 번호로 시험 호출 1건을 한다.
   - 시험하는 방법(어느 화면·버튼)은 #39 PR이 정한다. PR 설명에 없으면 허브에 물어본다.
2. 확인: 정한 Slack 채널에 메시지가 온다. 본인 메일함에 이메일이 온다. 문자·전화는 #10이 끝난 뒤에 온다.
3. 결과를 허브에 알린다: "Slack 왔다 / 이메일 왔다 / 안 왔다".

> **참고** seed의 가짜 번호로는 발송되지 않는다(#26). 본인의 실제 번호를 등록하고 확인 링크로 검증한 뒤 시험한다.

## 6단계 — 알람 자동 생성 [에이전트]

**끝났다. 사람이 할 일이 없다.**

- [x] 알람 엔진 리소스 수집기 29종(#48, #51 완료): `SYNC_ACCOUNT`가 리소스를 찾아 `Monitoring=on` 태그 대상에 알람을 만들고 맞춘다. 이게 있어야 "고객이 태그만 붙이면 알람이 생긴다"가 된다
- [x] CloudTrail 태그 변경 → 즉시 동기화 연결(#51 완료)

무엇이 되는가: 고객이 자기 AWS 리소스에 `Monitoring=on` 태그를 붙이면 엔진이 그 리소스의 CloudWatch 알람을 만든다. 태그를 떼면 알람은 남고 콘솔이 확인 필요(NEEDS_REVIEW)로 표시한다(D-16). 알람을 지우려면 사람이 콘솔에서 STOP_MONITORING을 실행한다.

언제 눈으로 볼 수 있나: 코드는 끝났지만 실제 계정에는 아직 배포되지 않았다. 4단계(중앙 계정 배포)와 7단계(고객 연결)가 끝나야 돈다. 동작은 7단계의 태그 시험(7-6의 1~3번)에서 확인한다. 권한이 실제로 맞는지는 4-6(#38)에서 먼저 본다.

## 7단계 — 파일럿 고객 연결 [사람]

끝나면: 파일럿 고객 계정의 알람이 울리면 콘솔에 인시던트가 열리고, 정해진 순서대로 호출이 가고, Ack·해결까지 콘솔에서 끝난다.

먼저 끝나 있어야 하는 것: 1-6(고객·계정 ID), 3단계, 4단계(4-5의 값 세 개), 5단계(적어도 Slack).

> **주의 (11/18)** 7-1·7-4·7-5에 필요한 API는 완료됐다(#68, #71). 화면(`/customers/new`, 연결 확인, 연락처 확인 링크)은 #63에서 만드는 중이다. 화면이 머지되기 전에는 이 단계를 시작하지 않는다.

> **주의** 연락처 확인 링크는 알림 채널(#39)이 생겨야 발송된다. 그 전에는 ADMIN이 수동 확인으로 처리한다.

### 7-1. 콘솔에 고객사·AWS 계정 등록 (10분)

어디서: 운영 콘솔 `https://<콘솔>/customers/new` (ADMIN으로 로그인)

1. 콘솔에서 고객사·AWS 계정 등록 → ExternalId 발급
2. 화면 순서는 명세 기준으로 다음과 같다.
   1. **Customer**: 고객사 이름, 로그인 도메인(포털)을 넣는다.
   2. **Organization**: 프로젝트와 서비스를 넣는다.
   3. **AWS account & roles**: 1-6에서 받은 12자리 계정 ID, Env, 리전(서울)을 넣는다. 역할을 고른다.
      - Reader, EventForwarder: 필수. 끌 수 없다.
      - AlarmWriter: 선택, 켬 권장. 꺼 두면 알람 생성·임계치 변경을 못 한다.
      - TagWriter: 선택. 콘솔에서 `Monitoring=on`을 붙이려면 켠다.
      - Remediator: 선택, 꺼짐(D-15). 파일럿에서는 끈 채로 둔다.
3. 확인: 화면에 ExternalId가 자동으로 발급돼 보인다. CloudFormation 실행 링크도 같이 나온다.
4. ExternalId와 연결 ID를 적어 둔다. 7-2와 7-3에서 쓴다.

> **주의** ExternalId는 고객 담당자에게만 준다. 이슈·PR에 적지 않는다.

- [ ] CloudTrail 알림 규칙 2개 동작 확인(`infra/aws/deploy-role-policy.md` 4-2). 첫 실고객 연결 전에 끝낸다.
  - 두 리전(us-east-1, 서울)의 스택이 `CREATE_COMPLETE`이고 스택 이름이 정확히 `alarmops-central-alerts`다. 부트스트랩의 `CentralStackName`·`BusStackName` 값과 다른지는 bootstrap Rules가 막는다(#115). Rules는 스택을 만들거나 업데이트할 때 **그때 올린 템플릿**으로 검사된다. 리소스 변경이 없으면 bootstrap 업데이트는 `The submitted information didn't contain changes`로 끝나는데 정상이다(11/24 확인). 대신 현재 파라미터가 기본값(`alarmops-central`, `alarmops-central-bus`)인지 콘솔의 파라미터 탭에서 확인하고, 앞으로 bootstrap을 업데이트할 때는 반드시 main의 최신 템플릿을 올린다.
  - 두 리전 모두 구독이 `Confirmed`다.
  - 시험 알림이 도착한다.
  - CloudTrail 관리 이벤트 추적이 있다(리전마다 관리 이벤트를 기록하는 추적).
  - 실측: 시험 알림 후 실제 배포 1회를 하고 각 리전에서 규칙 메일 수신 확인(eventName·eventID 포함).
  - 알림 소음 개선(직접 호출·거부 규칙 분리, 서울 배포 규칙 추가) 후에는 두 리전 스택을 새 템플릿으로 업데이트(사람). 업데이트 뒤 정상 배포 1회에 `AlarmOpsGuard-deploy` 메일 1통만 오는지 확인한다.

### 7-2. 허용 목록에 계정 추가 (10분)

> **주의 (D-57)** 실고객 계정을 허용 목록에 넣기 전에 확인한다: 고객 동의를 받았는가, 고객 스택은 읽기 전용(Reader·EventForwarder)인가. 리허설용 CT 계정은 그 계정 소유자의 확인을 받았는가.

어디서: GitHub 저장소의 Actions

고객이 스택을 만들기 **전에** 한다. 허용 전에 보낸 이벤트는 버스가 거절한다.

1. `bus-allowlist` 워크플로로 계정 추가(승인)
2. Actions → `bus-allowlist` 실행. 브랜치는 `main`. 입력 네 개를 넣는다.

   | 입력 | 값 |
   |---|---|
   | `action` | `add` |
   | `account_id` | 고객 AWS 계정 ID 12자리 |
   | `reference` | 7-1의 연결 ID. 실행 요약에 남기는 메모다 |
   | `confirm` | 계정 ID 12자리를 한 번 더 |

   > **주의** `action` 목록의 첫 값은 `remove`다. 반드시 `add`로 바꾼다.
3. `central-bus` 환경 승인을 누른다.
4. 확인: 작업이 초록색으로 끝나고 요약(`central bus allow list`)에 `action: add`, 계정, `accounts allowed now` 숫자가 보인다. 워크플로가 버스 정책에 계정이 들어갔는지 직접 확인하고, 없으면 실패한다.

### 7-3. 고객에게 스택 설치 요청 (고객 일정에 따름, 작업은 15분)

어디서: **고객의** AWS 계정(서울). 고객 담당자가 직접 한다. 우리는 고객 계정에 들어가지 않는다.

1. 고객에게 `infra/customer-stack/template.yaml` 설치 요청
   - 파라미터: 중앙 역할 ARN, ExternalId, 중앙 버스 ARN
2. 고객 담당자에게 보낼 것: 템플릿 파일(또는 7-1 화면의 CloudFormation 실행 링크)과 아래 파라미터 값.

   | 파라미터 | 값 | 어디서 나오나 |
   |---|---|---|
   | `CentralRoleArn` | 중앙 역할 ARN | 4-5에서 적어 둔 출력 `CentralRoleArn` |
   | `ExternalId` | 16자 이상 문자열 | 7-1에서 콘솔이 발급 |
   | `CentralEventBusArn` | 중앙 버스 ARN | 4-5에서 적어 둔 출력 `CentralBusArn` |
   | `EnableAlarmWriter` | `true` 권장(기본 `false`) | 7-1에서 고른 것과 같게 |
   | `EnableTagWriter` | 7-1에서 고른 것과 같게(기본 `false`) | |
   | `EnableRemediator` | `false` 그대로 | 파일럿에서는 켜지 않는다 |
   | `RemediatorCallerRoleArn` | 비워 둔다 | `EnableRemediator`가 `true`일 때만 필요 |

- 고객이 경계(`PermissionsBoundaryArn`)를 쓰면 연결 점검(Reader·이벤트 전달)을 돌려 AccessDenied가 없는지 확인한다.

3. 고객 담당자가 할 일:
   1. 자기 AWS 콘솔에서 리전을 **서울(ap-northeast-2)** 로 바꾼다.
   2. CloudFormation에서 새 스택을 만들고 템플릿 파일을 올린다. 스택 이름은 고객이 정한다.
   3. 위 파라미터를 넣는다.
   4. IAM 역할을 만든다는 확인란을 체크하고 스택을 만든다.
4. 확인(고객에게 물어본다): 스택 상태가 생성 완료다. 출력에 `ReaderRoleArn`, `EventForwarderRoleArn`이 보인다. AlarmWriter를 켰으면 `AlarmWriterRoleArn`도 보인다.

> **참고** 이 스택은 고객 계정에 역할(`AlarmOps-Reader` 등)과 EventBridge 규칙 2개(`AlarmOps-AlarmStateChange`, `AlarmOps-TagChange`)를 만든다. 역할별 권한은 `infra/customer-stack/README.md`에 있다. 고객이 물으면 그 문서를 보낸다.

### 7-4. 연결 확인 (5분)

어디서: 운영 콘솔, 7-1과 같은 화면의 3번째 단계

1. 콘솔 "연결 확인" → 역할별 OK
2. **Check connection**을 누른다.
3. 역할 행이 잠깐 `Checking…`으로 바뀐다. 기다린다.
4. 확인: 켠 역할이 모두 OK로 보인다.

### 7-5. 호출 순서·담당자 등록 (15분)

어디서: 운영 콘솔. 마법사의 **Call order** 단계, 나중에는 그 고객의 호출 순서 패널(Call order)

1. 호출 순서·담당자 등록, 연락처 확인 링크 발송
2. Responders에 사람을 넣는다. MSP 직원은 템플릿으로, 고객 쪽 사람은 이름과 역할(Pageable 또는 Notify only)로 넣는다.
3. 누구를 먼저 부를지 고른다(All at once / Customer rotation / Shared MSP rotation / Custom steps).
4. Timing을 고른다. Standard면 Slack 즉시 → 문자 2분 → 전화 7분 → 전원 전화 12분이다.
5. 확인: 미리보기 문장에 실제 이름과 순서가 나온다. 패널에 `UNREACHABLE`(아무도 호출되지 않음)이 보이지 않는다.
6. 연락처 확인 링크를 보낸다. 받은 사람이 링크를 눌러야 그 번호·주소가 검증된다.
   - 확인: 그 사람의 채널이 확인됨으로 바뀐다.

### 7-6. 시험: 태그 → 알람 → 인시던트 → 호출 → Ack → 해결 (30분)

어디서: 고객 계정(고객 담당자) + 운영 콘솔(본인)

먼저 태그 시험(6단계 확인)을 한다. AlarmWriter를 켰을 때만 한다.

1. 고객 담당자가 시험용 리소스 하나(예: EC2 인스턴스)에 태그 `Monitoring` = `on`을 붙인다.
2. 기다린다. 태그 변경은 CloudTrail 이벤트로 중앙에 온다. 걸리는 시간은 4-6(#38)에서 잰 값을 따른다.
3. 확인: 고객 계정의 CloudWatch 알람 목록에 태그 `ManagedBy` = `AlarmOps`가 붙은 새 알람이 생긴다.

다음으로 알람 시험을 한다.

4. 시험 알람 1건(임계값 낮춘 알람) → 인시던트 열림 → 전화 → Ack → 해결까지 확인
5. 고객 담당자가 고객 계정의 CloudWatch에서 알람 하나의 임계값을 지금 값보다 낮춰 바로 울리게 한다. 3번에서 생긴 알람을 써도 되고, 시험용 알람을 새로 만들어도 된다.
6. 순서대로 본다.

   | 언제 | 무엇이 보이나 |
   |---|---|
   | 알람이 ALARM이 된 뒤 1~2분 | 콘솔 Incidents에 새 인시던트가 열린다. 틱이 1분마다 돌기 때문에 바로는 아니다 |
   | 인시던트가 열린 직후 | 7-5에서 정한 첫 단계(Standard면 Slack)가 온다 |
   | 그 뒤 | 아무도 Ack 하지 않으면 다음 단계로 넘어간다(Standard면 2분에 문자, 7분에 전화) |

7. 전화를 받는 사람이 콘솔에서 그 인시던트를 **Acknowledge** 한다.
   - 확인: 다음 단계 호출이 더 오지 않는다. 인시던트 타임라인에 누가 언제 Ack 했는지 남는다.
8. 고객 담당자가 임계값을 원래대로 돌린다.
9. 콘솔에서 **Resolve…** 를 눌러 해결한다.
   - 확인: 인시던트가 Active 탭에서 사라진다.

> **참고** 문자·전화는 5단계의 #10이 끝나야 간다. 그 전에는 Slack·이메일까지만 확인한다.

### 7-7. iPhone 확인 (10분, #28)

어디서: 실제 iPhone의 Safari

1. 실제 iPhone Safari로 콘솔 확인(#28)
2. `https://<콘솔>/login`으로 로그인한다.
3. 볼 것:
   - Incidents 목록이 읽힌다.
   - 고객 트리가 옆에 붙지 않고 단계 시트로 열린다.
   - 인시던트 하나를 열어 Acknowledge 버튼을 손가락으로 누를 수 있다.
   - 호출 순서 패널에서 사람을 추가할 때 버튼이 손가락 밑에서 움직이지 않는다.
4. #28 이슈에 점검 목록이 있으면 그것도 따른다.
5. 이상한 곳은 화면을 캡처해 허브에 준다. 캡처에 실제 전화번호가 보이면 가린다.

### 막혔을 때 (7단계)

| 증상 | 원인과 할 일 |
|---|---|
| `/customers/new`가 빈 자리표시자 화면 | 아직 구현 전이다. 허브에 알린다(위 주의) |
| `bus-allowlist`: `The confirmation does not match the account id` | `confirm`에 넣은 값이 `account_id`와 다르다. 아무것도 바뀌지 않았다. 다시 실행한다 |
| `bus-allowlist`: 자격 증명 단계에서 실패 | `central-bus` 환경 변수 `CENTRAL_BUS_DEPLOY_ROLE_ARN`이 없거나, 역할 신뢰의 `sub`가 `environment:central-bus`가 아니다. 4-2 |
| `bus-allowlist`: `The stack has no BusName output` | 버스 스택이 옛 템플릿이다. 지금의 `infra/aws/central-bus.yaml`로 먼저 갱신한다 |
| 고객 스택 생성 실패: `ExternalId` | 16자 미만이거나 비어 있다. 7-1에서 발급된 값을 그대로 넣는다 |
| 고객 스택 생성 실패: `CentralEventBusArn` | 서울 리전 버스 ARN이 아니다. 출력 `CentralBusArn`을 그대로 넣는다 |
| 연결 확인에서 `Trust policy rejects our role — check ExternalId` | 고객이 넣은 `ExternalId`나 `CentralRoleArn`이 다르다. 고객이 스택 파라미터를 고친다 |
| 알람은 울렸는데 인시던트가 안 열림 | ① 7-2를 스택 설치 뒤에 했다: 허용 전 이벤트는 버려진다. 알람 상태를 한 번 더 바꾼다. ② 틱이 멈췄다: 3-5의 4번으로 확인한다 |
| 인시던트가 고객 이름 없이(미매핑) 열림 | 콘솔에 그 AWS 계정이 등록되지 않았다. 7-1 |
| 인시던트는 열렸는데 호출이 안 옴 | 5단계가 안 끝났거나, 그 고객의 호출 순서에 사람이 없다. 7-5 |
| 태그를 붙였는데 알람이 안 생김 | 고객 스택의 `EnableAlarmWriter`가 `false`다. 고객이 `true`로 스택을 갱신한다. 그래도 안 되면 4-6 결과를 허브와 본다 |

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
