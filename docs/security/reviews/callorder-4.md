# AlarmOps console — Call order 보안 재검토 4 (읽기 전용)

- 대상: `feat/console-call-order` @ `57ac28c`, `git diff 28e60b0..HEAD -- apps packages` (20개 파일, +1454/−171; 제품 코드는 middleware, `/auth/session`, `lib/session-ended.ts`, `components/SessionEnded.tsx`, `lib/auth/origin.ts`, sign-out 라우트 등)
- 방법: 코드 읽기 + 빌드본(`next start -p 3162`, 목 모드)에 curl·Playwright. 제품 코드는 고치지 않음.
- 결과: **[차단] 0건, [권고] 3건**

## 1. 미들웨어 (`src/middleware.ts`)

| 요청 (세션 없음) | 응답 |
|---|---|
| `GET /incidents` | 307 `/login?next=%2Fincidents` |
| `GET /incidents` + `next-action` 헤더 | 307 (메서드도 봄) |
| `POST /incidents` (헤더 없음) | 307 |
| `POST /incidents` + `next-action` | 401, `text/plain`, 본문 `SESSION_ENDED`, `Cache-Control: no-store`, CSP·XFO·nosniff·Referrer-Policy·Permissions-Policy·HSTS 포함 |
| `PUT`·`DELETE` + `next-action` | 307 |
| `POST /api/x`, `/c/mirae/call-order`, `/settings/users` + `next-action` | 401 (같은 본문, 경로의 존재 여부를 드러내지 않음) |
| 변조 쿠키로 `GET /incidents` | 307 |
| `x-middleware-subrequest` 우회 시도 | 307 (우회 안 됨) |
| 유효 세션 + 가짜 `next-action` | 404 (Next가 처리) |

- 401 분기는 세션 검증이 실패한 뒤에만 있고, 요청을 통과시키지 않고 끝낸다. 인증되지 않은 요청이 액션 코드에 닿는 경로는 생기지 않았다.
- `PUBLIC`에 추가된 것은 `/^\/auth\/session$/` 하나. `/auth/session/x`, `/auth/sessions`는 307.

## 2. `GET /auth/session`

- 쿠키 없음·변조·쓰레기 값 → 401, 유효 → 204. 네 경우 모두 본문 0바이트, `Cache-Control: no-store`, Set-Cookie 없음, `Access-Control-Allow-*` 없음. 이름·역할·만료 시각 등은 나가지 않는다.
- 쿼리(`?as=admin&next=//evil.example`)는 읽지 않음(401). POST·PUT 405, HEAD·OPTIONS 204(Next 기본 처리, 정보 없음).
- 상태를 바꾸지 않으므로 CSRF 대상이 아니다. 쿠키가 `SameSite=Lax`·HttpOnly라 다른 사이트에서 보낸 하위 요청에는 쿠키가 실리지 않고(항상 401), CORS 허용이 없어 응답도 읽을 수 없다 → 자기 쿠키에 대한 답 외의 로그인 오라클로 쓸 수 없다.
- `mockMode()`가 던지면(운영에서 목 모드) `mock=false`로 계속 진행해 운영 비밀값으로 검증한다 — 실패해도 열리는 쪽이 아니다.

## 3. `callAction` 적용 범위

- 서버 액션: `app/incidents/actions.ts`, `app/call-order/actions.ts`의 11개(`ackIncident`, `escalateIncident`, `resolveIncident`, `previewBulk`, `executeBulk`, `undoBulk`, `saveCallOrder`, `removeOwnSteps`, `addResponder`, `removeResponder`, `setResponderRole`).
- 호출 15곳 모두 `callAction(() => …)` 줄 안. 맨 호출 0건(grep). `lib/session-ended.test.tsx`의 "every server action goes through callAction"이 같은 검사를 한다.
- `callAction`은 클라이언트 쪽 표시일 뿐이다. 권한은 여전히 미들웨어(세션)와 액션 안의 `requireRole`이 정한다(이전 검토에서 확인, 이번 diff에서 바뀌지 않음). 세션 종료가 한 번 확인되면 그 탭은 더 보내지 않는다.

## 4. Origin 비교 (`lib/auth/origin.ts`, sign-out)

| 설정 | 요청 | 결과 |
|---|---|---|
| 미설정 | `Origin: http://localhost:3162` | 303 `/login?signedOut=1` |
| 미설정 | `https://localhost:3162` (스킴 다름) / 다른 포트 / `null` / `Sec-Fetch-Site: cross-site` / XFH 위조 | 403 |
| 미설정 | `Origin: https://localhost:3162` + `X-Forwarded-Proto: https` (또는 `https, http`) | 303 — [권고 1] |
| `CONSOLE_ORIGIN=https://console.example` | 그 Origin | 303 |
| 〃 | localhost / `:8443` / `http://console.example` / `console.example.evil.com` / XFH·XFP 위조 / same-site | 403 |
| 〃 | Origin 없음 | 303 (브라우저가 아닌 클라이언트 — 피해자 쿠키 없음), `Sec-Fetch-Site: cross-site`가 있으면 403 |

- 이전 권고 2(호스트만 비교)는 해결: 스킴·호스트·포트 전체를 비교한다.
- 리다이렉트 대상은 고정(`/login?signedOut=1`)이라 열린 리다이렉트 없음.

## 5. Sign in 링크의 `next`

- `signInHref`는 `location.pathname + search + hash`를 `safeNextPath`에 통과시킨다. 조작한 주소(`?next=https://evil.example`, `#//evil.example`, `//evil.example/x`, `/%5Cevil.example`, `..%2f..%2f%2fevil.example`, CRLF)에서 링크는 `/login` 또는 콘솔 안 경로뿐이고, 로그인 뒤 항상 콘솔 출처에 머문다.
- `/auth/dev-login?next=`에 `//evil.example`, `/\evil.example`, `https://evil.example`, `/%5Cevil.example`, `/%2F%2Fevil.example`, 탭 문자, `/login?next=//evil.example`를 직접 넣어도 모두 `/incidents`로 간다.

## 6. 다른 탭 알림 (BroadcastChannel `ao-auth`, localStorage `ao-signed-out`)

- 메시지에는 `{type:"signed-out"}`뿐, localStorage 값은 시각뿐 — 사용자 정보 없음.
- 받는 쪽은 `type`만 보고 자기 탭의 저장소를 지우고 상자를 띄운다. 채널은 같은 출처·같은 브라우저 프로필에만 닿는다. 위조하면 자기 탭들이 "로그아웃됨"으로 보이고 자기 초안이 지워질 뿐(쿠키·서버는 그대로)이고, 다른 사람의 브라우저에는 닿지 않음을 별도 컨텍스트로 확인했다. 같은 출처에서 스크립트를 실행할 수 있는 공격자(XSS)는 이보다 큰 일을 이미 할 수 있으므로 새 권한 상승은 아니다.

## 7. 헤더

`/login`, `/auth/session`, 미들웨어의 401 모두 CSP(`form-action 'self'`, `frame-ancestors 'none'`), X-Frame-Options DENY, Referrer-Policy, nosniff, Permissions-Policy, HSTS 유지. 인증 페이지는 `no-store`.

## 권고

1. **[권고]** `CONSOLE_ORIGIN`이 없으면 요청의 스킴을 `X-Forwarded-Proto`에서 읽으므로, 헤더를 직접 넣을 수 있는 클라이언트는 `https://` Origin을 통과시킬 수 있다. 브라우저의 폼 전송으로는 이 헤더를 넣을 수 없고 대상도 로그아웃뿐이라 영향은 작다. 운영 배포에서는 `CONSOLE_ORIGIN`을 필수 환경값으로 두고 없으면 기동을 막기를 권함(infra 이슈).
2. **[권고]** (유지) 세션은 서명 쿠키라 로그아웃이 서버에서 토큰을 무효화하지 않는다. SSO 연결 때 서버 쪽 세션 폐기 또는 짧은 수명 + 갱신으로.
3. **[권고]** `/auth/session`은 공개 경로이고 요청 수 제한이 없다. 나가는 정보는 없지만 HMAC 검증을 무제한 호출할 수 있으므로 운영 프록시(ALB/WAF)에서 제한을 권함.

## 한계

목 모드 기준. 실제 프록시(ALB) 뒤에서의 `X-Forwarded-*` 동작과 `TRUSTED_PROXY=1` 조합은 이번에 다시 돌리지 않았다(이전 검토에서 확인, 해당 분기 코드는 유지). 8시간 만료는 쿠키 삭제로 대신했다.
