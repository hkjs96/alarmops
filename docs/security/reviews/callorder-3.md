# AlarmOps Console — Call order 보안 재검토 3 (2026-11-11)

대상: `feat/console-call-order` `28e60b0`, `git diff d9e91b9..HEAD -- apps packages` (24개 파일, +922 −62). 읽기 전용 검토 + 직접 띄운 빌드본(`next start -p 3142`, 목 모드)에 요청을 보내 확인. 제품 코드는 고치지 않았다.

## 결론

**[차단] 0건.** [권고] 4건. 재검토 2의 권고 중 2(서버 액션 역할 검사), 3(`X-Forwarded-Host` 신뢰), 4(404 뒤 Reload 안내)는 반영됐고, 권고 1(편집 중 로그아웃 실패)은 QA P2-A와 함께 해결됐다.

## 항목별

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | 로그아웃 폼을 `document.body`에 붙여 제출 (`lib/sign-out.ts`) | 통과 | 폼은 `method=post`, `action="/auth/sign-out"` 고정 문자열, 입력 필드 없음. 사용자 입력이 action에 들어가지 않는다. CSP `form-action 'self'` 유지 |
| 2 | `/auth/sign-out` 출처 검사 (`lib/auth/origin.ts`) | 통과 | 실측: GET 405 · `Origin: https://evil.example` 403 · `Origin: null` 403 · 다른 포트 403 · `Sec-Fetch-Site: cross-site`(Origin 없음) 403 · `Sec-Fetch-Site: same-site` 403 · 403 뒤 세션 유지(`/call-order` 200). 같은 출처 303 + `Set-Cookie: ao_session=; Path=/; Max-Age=0; HttpOnly; SameSite=lax` |
| 3 | 열린 리다이렉트 | 통과 | `Location`은 상수 `/login?signedOut=1`. `?next=https://evil.example&redirect=//evil.example`와 본문 `next=`를 보내도 그대로. `/login`·`/auth/dev-login`의 `next`는 `safeNextPath`(`//evil.example`, `https://…` → `/incidents`) |
| 4 | `TRUSTED_PROXY` | 통과 | 미설정: `Origin: evil` + `X-Forwarded-Host: evil` → 403 (재검토 2의 우회 재현 안 됨). `TRUSTED_PROXY=1`로 재기동: XFH=console·Origin=evil 403, XFH 없음·Origin=Host 303, XFH 없음·Origin=evil 403, XFH `console, evil`은 첫 값 사용. XFH=evil·Origin=evil은 303 — 프록시가 클라이언트 값을 덮어쓴다는 전제이며 README에 조건이 적혀 있다 |
| 5 | 서버 액션의 `requireRole` | 통과 | `"use server"` 파일 2개, 내보낸 액션 11개 전부 `run()` 경유: `requireSession()` → `requireRole()` → 입력 검증 → API. **빠진 액션 없음.** `call-order/actions.ts`(ADMIN): `saveCallOrder`, `removeOwnSteps`, `addResponder`, `setResponderRole`, `removeResponder`. `incidents/actions.ts`(OPERATOR): `ackIncident`, `resolveIncident`, `escalateIncident`, `previewBulk`, `executeBulk`, `undoBulk`. 입력(`assert*`)은 모두 `fn` 안에서 읽으므로 역할 검사 뒤다 |
| 6 | 역할 재전송 실측 | 통과 | 관리자의 `removeResponder(["daon","ct_junho",1,false])` 요청을 operator·viewer 쿠키로 다시 보냄 → `ROLE_REQUIRED`. 고객을 없는 값으로, 사람을 없는 값으로 바꿔도 같은 `ROLE_REQUIRED`(존재 여부가 새지 않음). operator의 `ackIncident`를 viewer로, 없는 id로 → `ROLE_REQUIRED`. 세션 없이 → 307 `/login`. 서버 상태 변화 없음. 관리자 쿠키 + `Origin: https://evil.example` → Next가 500으로 거부 |
| 7 | `/me` 실패 → 거부 | 통과 | `requireRole`은 `getApi().me()` 예외를 삼키지 않고 `run()`의 catch → `fail()`(`UNKNOWN`, 내부 메시지 미노출). `roleAtLeast`는 모르는 역할을 −1로 본다. 단위 테스트 "if GET /me cannot be read, nothing is let through" |
| 8 | 로그아웃 뒤 남는 것 | 통과 | 인증 페이지·RSC 응답·`/login` 모두 `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`. 브라우저 실측: 로그아웃 뒤 뒤로가기 3번·앞으로 → 매번 `/login?next=…`, 고객·사람 이름 없음, 이전 문서 복원 없음(bfcache 미사용). 로그아웃은 문서 이동(폼 POST)이라 클라이언트 라우터 캐시도 사라진다. `sessionStorage`의 `ao-…` 키 0개, `localStorage`에는 테마뿐. 루트 레이아웃 `force-dynamic`, `unstable_cache`·서비스 워커 없음 |
| 9 | 초안의 사용자 분리 | 통과 | 관리자 초안 → 같은 탭 `?as=operator`·`?as=viewer`: 키 0, 화면에 초안 값 없음, 뒤로가기로도 안 보임. 관리자 id 키를 operator 세션에 직접 심어도 표시 안 됨 |
| 10 | 보안 헤더 | 통과 | 200·303·307 응답 모두 CSP(`frame-ancestors 'none'`, `form-action 'self'`, `object-src 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy`, `nosniff`, `Permissions-Policy`, HSTS. 미들웨어 공개 경로 변화 없음(`/login`, `/auth/dev-login`, `/auth/sign-out`) |

## [권고]

1. **세션이 사라진 뒤의 서버 액션이 화면에서 멈춘다 (QA P2-D).** 쿠키가 없으면 액션 POST가 미들웨어에서 `/login`으로 307이 되고, 클라이언트는 "An unexpected response was received from the server."를 던지지만 잡는 곳이 없어 "Saving…" / "Removing…" / "Acknowledging…"가 계속 보인다. 서버에는 적용되지 않으므로 권한 문제는 아니다. 다만 만료된 탭에 고객·담당자 정보가 계속 보이고 사용자는 로그아웃된 줄 모른다. 액션 호출을 한 곳에서 감싸 401/리다이렉트를 "다시 로그인"으로 바꾸고, 미들웨어는 `Next-Action` 요청에 307 대신 401을 주는 것을 권한다. main의 Incidents도 같으므로 별도 이슈.
2. **출처 비교가 호스트만 본다.** `Origin: https://localhost:3142`가 `http` 서버에서 303으로 통과했다(스킴 무시). 반대 방향(같은 호스트의 `http://` 페이지가 `https://` 콘솔의 로그아웃을 부름)이 가능하려면 망 중간자가 필요하고 영향은 로그아웃뿐이며 운영은 HSTS가 있다. SSO 연결 때 스킴까지 비교하거나 `Sec-Fetch-Site`가 없을 때만 Origin에 기대도록.
3. **로그아웃이 토큰을 서버에서 무효화하지는 않는다.** 세션은 서명 쿠키(8시간)라 로그아웃 전에 복사된 쿠키는 만료까지 유효하다(실측: 로그아웃 뒤 예전 쿠키로 `/call-order` 200). 주석대로 SSO 전의 자리표시자이므로 이번 PR 범위 밖 — SSO 연결 이슈에 "로그아웃 시 서버 측 세션 폐기"를 넣을 것. 운영 쿠키에 `Secure`가 붙는지도 그때 확인(`dev-login`은 https일 때만 붙인다).
4. **다른 탭에서 로그아웃하면 이 탭의 `sessionStorage` 초안은 남는다.** 탭마다 저장소가 따로라 로그아웃한 탭만 지워진다. 같은 사용자가 다시 로그인하면 이어 쓸 수 있고, 다른 사용자가 로그인하면 읽기 전에 지워진다(실측). 공용 PC를 전제로 하면 `BroadcastChannel`로 다른 탭에도 로그아웃을 알려 지우고 `/login`으로 보내는 것을 권한다(권고 1과 함께 풀린다).

## 참고

- `TRUSTED_PROXY=1`에서 XFH의 첫 값을 쓴다. 값을 덧붙이는 프록시 사슬이면 첫 값이 클라이언트 것이다. ALB·CloudFront는 `Host`를 보존하므로 설정이 필요 없다 — infra에서 켜지 않는 것을 기본으로.
- 목 API 기준 검토다. 역할·If-Match·고객 격리의 실제 강제는 백엔드 PR에서 확인해야 한다.
