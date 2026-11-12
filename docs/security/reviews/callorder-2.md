# 보안 재검토 — Console Call order (feat/console-call-order, d9e91b9)

- 날짜: 2026-11-11
- 범위: `git diff 7b636ae..HEAD -- apps packages` (57개 파일, +2947/-629). 읽기 전용 검토, 제품 코드는 고치지 않음.
- 방법: 코드 읽기 + 직접 띄운 빌드본(`E2E_ALLOW_MOCK=1 MOCK_API=1 next start -p 3121`)에 Playwright·HTTP 요청으로 확인. 서버 액션은 관리자 세션에서 실제 요청을 잡아 다른 역할·무세션·다른 출처로 다시 보냄.
- 결론: **[차단] 0건 · [권고] 4건 · [참고] 8건.** 이전 검토의 권고 1(초안 사용자별 분리·로그아웃), 2(Responders If-Match), 4·5(서버 액션 검증)는 반영됨. 다만 권고 1번(아래)은 로그아웃이 실제로 되지 않는 경로라 QA 쪽에서 P2로 올렸고 머지 전 수정을 권한다 — `docs/qa/results.md` "Console Call order 재점검" 참고.

## [차단]

없음.

## [권고]

1. **편집 중 로그아웃을 누르면 로그아웃되지 않는다 (QA P2-A와 같은 건).**
   `components/AccountMenu.tsx`: Sign out → `shell.requestLeave(() => { clearUserStorage(); form.current?.submit(); })`. 저장 안 된 편집이 있으면 이탈 가드가 뜨는데, 가드의 버튼을 누르는 순간 계정 메뉴의 "밖을 누르면 닫힘"(`pointerdown` 캡처)이 먼저 실행되어 메뉴와 함께 `<form>`이 화면에서 사라진다. 그 뒤 콜백이 실행될 때 `form.current`는 `null`이라 POST가 나가지 않는다.
   - 실제 확인(1440·390): Iruda Edu 편집 중 → 계정 → Sign out → 가드에서 "Keep draft and sign out" / "Discard changes" / "Save for Iruda Edu" 어느 것을 골라도 주소는 그대로, `ao_session` 쿠키 유지, `GET /call-order` 200. sessionStorage의 `ao-…`는 지워짐(초안도 사라짐).
   - 영향: 버튼 문구는 "…and sign out"인데 세션이 8시간 유효한 채로 남는다. 화면이 콘솔에 그대로 남아 있어 눈에는 보이지만, 공용 PC에서 자리를 뜨는 경우를 생각하면 로그아웃은 반드시 되어야 한다. 편집 중이 아닐 때의 로그아웃은 정상(쿠키 삭제, 초안 삭제, 뒤로가기도 `/login`).
   - 방향: 폼을 메뉴가 닫혀도 남는 자리에 두거나, 콜백에서 `fetch('/auth/sign-out', {method:'POST'})` 후 이동. e2e는 가드의 Cancel만 본다 — 나머지 세 버튼에 대한 테스트 추가.

2. **역할 검사는 콘솔 서버 액션에 없고 백엔드에만 의존한다 (명시).**
   `app/call-order/actions.ts`, `app/incidents/actions.ts`의 `run()`은 `requireSession()`만 확인한다. 화면은 `GET /me`의 역할로 버튼을 끄고 이유를 보여 줄 뿐이다(`hasRole`, `roleReason`). 실제 거부는 API가 한다.
   - 실제 확인: 관리자의 `setResponderRole` / `removeResponder` / `addResponder` 요청을 operator·viewer 세션으로 그대로 다시 보내면 세 액션 모두 `ROLE_REQUIRED`("This action needs the ADMIN role."), 상태 변화 없음. 단, 이것은 **목 API**가 거부한 것이다(`paging-mock.ts`의 `need("ADMIN")`, `mock-api.ts`의 `need("OPERATOR")`).
   - 구조상 틀린 것은 아니다(권한의 원천은 API). 하지만 실제 백엔드가 Call order·Responders 쓰기 7개와 인시던트 쓰기 6개에 같은 역할 검사를 하는지는 이 PR로는 확인되지 않는다. 백엔드 PR의 관문에 "역할별 403 테스트"를 넣을 것. 콘솔 액션에서도 `api.me()`로 한 번 더 막는 것은 선택 사항(방어 겹치기).
   - 참고: 목은 "대상이 있는가"를 역할보다 먼저 본다(없는 contact면 operator에게도 `NOT_FOUND`). 권한 없는 사용자가 id 존재 여부를 구분할 수 있으므로 실제 API는 역할을 먼저 볼 것.

3. **`/auth/sign-out`의 출처 검사가 `X-Forwarded-Host`를 그대로 믿는다.**
   `Origin: https://evil.example` + `X-Forwarded-Host: evil.example`이면 303으로 통과한다(실제 확인). 브라우저의 교차 출처 폼은 이 헤더를 붙일 수 없으므로 지금 악용 경로는 없고, 영향도 "로그아웃 당함"뿐이다. 다만 앞단 프록시가 클라이언트가 보낸 `X-Forwarded-Host`를 덮어쓰지 않는 구성이면 검사가 무의미해지므로, 배포 구성이 정해지면 신뢰할 호스트를 환경 변수로 고정하거나 프록시가 헤더를 덮어쓰는지 확인할 것. `Origin`도 `Sec-Fetch-Site`도 없는 POST는 통과한다(오래된 브라우저·비브라우저 클라이언트 — 피해자 쿠키가 없으므로 문제 없음).

4. **Responders 변경이 `NOT_FOUND`로 실패하면 "Changed — reload"가 뜨지 않는다.**
   두 탭에서 같은 사람을 제거하면 늦은 쪽은 409가 아니라 404("Not found. It may have been removed…")를 받고, 지워진 사람이 목록에 그대로 남으며 버튼도 켜져 있다. 다음 변경은 409로 막히므로 잘못 적용되는 것은 없다. 404도 "목록이 바뀜"으로 다루면 깔끔하다.

## [참고]

1. **로그아웃 경로** — 통과(편집 중이 아닐 때). `GET`·`HEAD` → 405(링크·이미지로 로그아웃시킬 수 없음). `POST` + 다른 출처 `Origin` → 403, `Origin: null` → 403, 다른 포트 → 403, `Origin` 없이 `Sec-Fetch-Site: cross-site`/`same-site` → 403. 거부된 뒤 세션 유지. 같은 출처 `POST` → 303 `/login?signedOut=1`, `Set-Cookie: ao_session=; Path=/; Max-Age=0; HttpOnly; SameSite=lax`. 이후 `/call-order`는 307 → `/login`. 미들웨어의 PUBLIC에 `/auth/sign-out`이 추가된 것은 "만료된 세션으로도 쿠키를 지울 수 있어야 함" 때문이며 정확히 그 경로 하나만 열렸다(`^\/auth\/sign-out$`). 쿠키의 `Secure`는 https일 때만 붙는다(기존 dev-login과 같은 방식).
2. **초안 키와 삭제** — 통과. 키는 `ao-draft:call-order:<encodeURIComponent(user id)>/<scope>`, 본문에도 `user`가 들어가고 `parseDraft`가 키의 사용자·scope와 본문이 다르면 버린다. 실제 확인: 관리자가 초안 2개를 둔 탭에서 로그아웃 없이 operator로 로그인 → 초안 줄 0개, `ao-draft…` 키 0개(`claimStorageFor`가 다른 사용자의 `ao-…`를 읽기 전에 지움), 패널에도 초안 없음. 다시 관리자로 돌아와도 초안은 돌아오지 않음. sessionStorage에 다른 사용자 id로 된 키를 직접 심어도 목록에 나오지 않음. 로그아웃 뒤 `ao-…` 키 0개, 뒤로가기는 `/login?next=…`. 저장 내용은 이전과 같이 id·분·채널 종류뿐.
3. **Responders If-Match** — 통과. 세 쓰기 모두 `If-Match: <version>`(화면이 본 목록 버전)을 보내고, `assertVersion`으로 검증한다. 실제 확인: A가 Junho를 제거한 뒤 낡은 B가 Minjae를 제거 → "Changed — reload… Your last change was not applied", 서버 상태 변화 없음, B의 모든 버튼 비활성, Reload 뒤 정상. `confirmUnreachable`은 `=== true`일 때만 쿼리에 붙는다. PROPOSED이므로 `docs/API-CONTRACT.md`에 반영되어 있는지 백엔드 쪽과 맞출 것.
4. **서버 액션 검증 = 화면 검증** — 통과. `assertPagingInput`에 단계 1–12, 분 0–1440 정수, 1단계 0분, 분 증가, 반복 0–5, 채널 1–5개·중복 없음·알려진 종류만이 들어갔고, `assertReachable`이 저장 직전에 고객의 현재 Responders·로테이션으로 화면과 같은 `validateConfig`(대상 존재, Notify only 호출 금지, 발송 한도, 닿는 사람 있음)를 돌린다. `assertAddResponder`는 이메일·전화 형식과 이름의 제어 문자·방향 전환 문자를 거부한다. 화면: + Add step은 12에서 비활성(강제로 눌러도 12 유지).
5. **`?as=`** — 통과. `/auth/dev-login`은 `mockMode()`가 참일 때만 동작하고 아니면 404. `mockMode`는 `MOCK_API=1`이 아니면 false, `VERCEL_ENV=production`이거나 `NODE_ENV=production`인데 `E2E_ALLOW_MOCK=1`이 없거나 Vercel이면 예외(→ 404, `lib/api/index.ts`는 모듈 로드 때 실패). `as`는 `Object.hasOwn(DEV_USERS, as)`로만 고른다: `operator`→usr-minjae, `viewer`→usr-sora, `root`·`ADMIN`·`__proto__`·`constructor`→기본 사용자. 역할은 쿠키가 아니라 API의 사용자에 붙어 있어 쿠키를 고쳐 역할을 올릴 수 없다(서명도 검증됨). 로그인 화면의 operator/viewer 링크도 목 모드에서만 나온다.
6. **0.6초 같은 자리 가드** — 통과. `installSameSpotGuard`는 `markSpot`이 불린 지점(Acknowledge, Remove…, Add, 확인 상자의 두 버튼)에서 600ms·24px 안의 **포인터** 클릭만 삼킨다. 키보드(Enter/Space, `detail === 0`)는 막지 않는다. 삼켜지는 쪽은 항상 "아무 일도 안 일어남"이라 Cancel·Keep·Undo·Sign out이 삼켜져도 상태는 바뀌지 않고 한 번 더 누르면 된다. 실제 확인: Remove… 자리에서 80ms·0.7·1.5·3초에 다시 눌러도 확인 상자만 떠 있고(기본 포커스 "Keep …"), 확인 버튼 더블클릭은 한 건만 제거. 확인 상자의 Cancel/Keep은 Remove… 버튼과 떨어져 있어(1440: 481–858 × 530 vs 1329 × 747, 390: y 500–596 vs 422) 첫 누름이 삼켜지지 않았다. 전역 상태는 모듈 변수 하나(`last`)이며 사용자 간 공유되는 서버 상태가 아니다.
7. **서버 액션의 CSRF·무세션** — 통과. 다른 출처 `Origin`으로 보낸 서버 액션은 Next가 500으로 거부(상태 변화 없음), 세션 없는 요청은 미들웨어에서 307 → `/login?next=…`.
8. **헤더·미들웨어** — 회귀 없음. `/login` 200, `/incidents` 307, `/auth/sign-out` 405, `/auth/dev-login` 307 모두 CSP(`frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`, 빌드본에 `unsafe-eval` 없음), X-Frame-Options DENY, Referrer-Policy, nosniff, Permissions-Policy, HSTS. `next.config.ts`는 이 범위에서 바뀌지 않았다. `X-Powered-By: Next.js`와 `script-src 'unsafe-inline'`은 이전과 같음. `fail()`은 이제 `details`에서 정해진 키와 원시 값만 브라우저로 넘기고(`safeDetails`), `CROSS_CUSTOMER`는 `NOT_FOUND`로 바꿔 답한다(이전 권고 3 반영). 추가된 코드에 `dangerouslySetInnerHTML`·`eval`·새 외부 요청·localStorage 사용 없음.

## 한계

목 API 기준이다. 역할(권고 2)·If-Match·검증의 실제 강제는 백엔드에서 다시 확인해야 한다. 프록시 뒤 배포 구성(권고 3)은 아직 없어 보지 못했다.
