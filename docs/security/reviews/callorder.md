# 보안 검토 — Console Call order (feat/console-call-order, 7b636ae)

- 날짜: 2026-11-11
- 범위: `git diff origin/main...HEAD -- apps packages` (39개 파일, +4193/-31). 읽기 전용 검토.
- 방법: 코드 읽기 + 직접 띄운 빌드본(`next start -p 3120`, 목 API)에 curl·Playwright로 확인.
- 결론: **[차단] 0건 · [권고] 6건 · [참고] 7건.** 보안 관문은 통과. (머지 판정은 QA P1 때문에 별도 — `docs/qa/results.md` "Console Call order 점검" 참고)

## [차단]

없음.

## [권고]

1. **초안(draft)이 사용자별로 나뉘지 않고, 로그아웃 때 지워지지 않는다.**
   `lib/call-order/draft-store.ts`의 키는 `ao-draft:call-order:<customer>/<project>/<service>`뿐이고 사용자 id가 없다. 콘솔에 로그아웃 경로 자체가 아직 없어(`app/auth`에는 `dev-login`만 있음) 지우는 시점도 없다. 실제 확인: 초안 3개를 둔 채 같은 탭에서 `/auth/dev-login`으로 다시 로그인하면 "Draft for Mirae Pay / Daon Retail / Hanbit Logistics › Fulfilment › Orders API · Resume"가 그대로 보인다. 다른 사람이 같은 탭에서 로그인하면 볼 수 없는 고객·프로젝트·서비스 이름(`label`)과 contact·rotation id(`value.steps[].targetId`)를 보게 된다. sessionStorage(탭 한정)라 범위는 좁지만, 실제 로그인(Cognito)을 붙이기 전에 키에 사용자 id를 넣고 로그아웃·세션 만료 때 `ao-draft:*`, `ao-co-edit`, `ao-focus-row`를 지울 것.
   - 저장 내용 자체는 문제 없음: scope 슬러그, 라벨(경로 이름), baseVersion, style/plan/repeat, 단계의 atMin·targetType·targetId·channels뿐이다. 주소·전화번호·토큰은 없고 localStorage는 쓰지 않는다.

2. **Responders 변경(추가·역할 변경·제거)에 버전(If-Match)이 없다.**
   `addResponder` / `setResponderRole` / `removeResponder` 서버 액션과 `client.ts`의 POST/PATCH/DELETE `/customers/{id}/responders…`는 버전을 보내지 않는다. 단계 저장(`putPaging`, `putPagingOverride`, `deletePagingOverride`)은 If-Match / If-None-Match를 보낸다. 두 사람이 동시에 Responders를 고치면 마지막 요청이 조용히 이긴다. 누가 호출되는지를 바꾸는 변경이므로 계약(API-CONTRACT §8.3)에 버전 또는 멱등 조건을 정할 것.

3. **`addResponder`의 `contactId` 경로는 "이 고객에 넣어도 되는 contact인가"를 콘솔에서 확인할 수 없다.**
   액션은 `isId`만 검사하고 그대로 백엔드로 보낸다(콘솔이 확인할 방법은 없으므로 구조상 맞다). 따라서 백엔드가 "MSP 직원이거나 이 고객 소속 사람"인지 반드시 검사해야 한다. 목은 다른 고객 소속이면 `422 CROSS_CUSTOMER`, 없는 id면 `404`를 돌려주는데, 이 차이로 남의 테넌트 contact id가 존재하는지 알 수 있다. 실제 백엔드는 둘 다 같은 404로 답하도록 계약에 적을 것.

4. **서버 액션의 단계 검증이 화면 검증보다 느슨하다.**
   `assertPagingInput`은 타입·범위(atMin 0–1440, repeat 0–5, 단계 1–20, 채널 종류)만 본다. 화면이 막는 "분이 늘어나야 함", "1단계는 0분", "닿는 사람이 있어야 함"은 서버 액션에 없고, `channels` 배열의 길이·중복도 제한이 없다(`["SMS","SMS",…]` 수천 개 가능). 조작된 요청은 화면 규칙을 건너뛴다. 백엔드가 같은 규칙을 강제해야 하고, 액션에서도 채널 중복 제거·최대 3개, 순서 검사를 넣는 편이 안전하다.

5. **새 고객 사람 추가의 이메일·전화 형식을 서버 액션이 검사하지 않는다.**
   `assertAddResponder`는 길이만 본다(name ≤ 80, email ≤ 254, phone ≤ 32). 형식 검사는 목에만 있다. 이름에 제어 문자·줄바꿈도 통과한다. 이 값은 Slack·메일·SMS 본문에 들어갈 수 있으므로 액션에서 형식(이메일, E.164류 전화)과 이름의 제어 문자를 걸러낼 것.

6. **Responders 제거가 확인 없이 한 번에 실행되고 Undo는 마지막 한 건만 남는다 (QA P1과 같은 건, 가용성 관점).**
   권한·격리 문제는 아니지만 "아무도 호출되지 않는 고객"을 클릭 두 번으로 만들 수 있다(Daon Retail: Junho 제거 → 같은 자리에 Minjae의 Remove가 올라옴 → UNREACHABLE). 마지막 Pageable 한 명을 지우는 경우만이라도 확인을 받고, 서버에서 "남는 Responders 0명" 변경에 별도 확인 플래그를 요구하는 방안을 검토.

## [참고]

1. **requireSession 먼저** — 통과. 다섯 액션 모두 `run()` 안에서 `await requireSession()`이 입력 검증·API 호출보다 앞선다. 로그인 없는 POST(`Next-Action` 헤더 포함)는 미들웨어에서 307 → `/login?next=…`.
2. **slug → id 해석** — 통과. `assertScope`(슬러그 정규식 `^[a-z0-9][a-z0-9-]{0,63}$`, service는 project가 있어야 함) 뒤 `resolve()`가 `GET /scope-tree`(이 사용자가 볼 수 있는 것) 안에서만 customer → project → service를 찾는다. 프로젝트는 그 고객 아래에서, 서비스는 그 프로젝트 아래에서만 찾으므로 `/c/daon/core/payments-api`(다른 고객의 프로젝트) 같은 조합은 404다. 클라이언트가 id를 직접 보내는 경로는 없다(고객 id는 항상 서버에서 해석). URL 조립은 `encodeURIComponent`, id 패턴은 `.`/`..`을 거부한다. `scopeType`은 서버가 정한 `"PROJECT" | "SERVICE"` 값만 경로에 들어간다.
3. **If-Match** — 통과(단계 저장·own steps 제거). 고객 수준은 `If-Match: <version>` 필수(null이면 거부), own steps 생성은 `If-None-Match: *`, 수정·제거는 `If-Match`. 화면 확인: 두 탭에서 같은 고객을 고치면 두 번째 저장은 "Changed — reload… Nothing was saved"로 막히고 저장된 값은 첫 번째 것 그대로다. 오래된 초안을 Resume해 저장해도 같은 409로 막힌다. `If-None-Match: *`는 계약에 없는 PROPOSED이므로 계약에 반영 필요.
4. **대량 할당 없음** — 통과. `assertPagingInput` → `toInput()`이 `style, plan, sharedRotationId, repeatCount, steps[{atMin, targetType, targetId, channels}]`만 새 객체로 만든다. `assertAddResponder`도 `contactId, role` 또는 `name, email, phone, role`만 넘긴다(`extras` — APPROVER/PORTAL_USER — 는 버려지므로 화면으로 승인자 권한을 줄 수 없다). `setResponderRole`은 `{ role }`만 보낸다.
5. **마스킹** — 통과. 브라우저로 가는 HTML과 RSC 페이로드(`/call-order`, `/c/mirae|kumho/call-order`, `/c/hanbit/fulfilment/orders-api/call-order`)에 온전한 이메일·전화번호 0건, 필드는 `emailMasked`/`phoneMasked`뿐이다. 픽스처에도 원본 값이 없다. 새 사람을 추가하면 입력한 주소·번호는 상태에서 비워지고 목록에는 마스킹된 값만 돌아온다. Reveal은 이 화면에 없다. 단, `GET /staff`(MSP 직원 전체의 이름·직함·채널 상태)가 패널을 열 때마다 클라이언트 prop으로 내려간다 — MSP 사용자에게는 문제 없지만 고객 포털 사용자에게 이 화면을 열어줄 때는 막아야 한다.
6. **XSS** — 통과. 고객 사람 이름을 `<img src=x onerror=…>"'><script>…</script>`로 추가해 토스트, 사람 목록, 단계 선택 상자, "If something breaks now" 문장, 목록 행, 저장 확인 상자에서 확인: 전부 글자로 출력되고 스크립트 실행 0건, 주입된 요소 0개. 추가된 코드에 `dangerouslySetInnerHTML`·`innerHTML`·`eval`·`window.open`·새 외부 요청·새 환경 변수 없음. 초안의 `label`도 텍스트로만 출력되고, Resume 주소는 정규식을 통과한 `scope`로만 만든다(외부 주소로 유도 불가). `?customer=<img…>`는 Not found.
7. **이탈 가드·라우트·헤더** — 통과.
   - 가드는 같은 출처의 화면 이동(트리, Ctrl/⌘K, 행, 메뉴, 패널 닫기, 뒤로)만 묻는다. 편집 중 외부 링크를 누르면 묻지 않고 떠난다(가둘 수 없음). `beforeunload` 대화상자는 쓰지 않고, 새로고침·탭 닫기 때는 초안으로 남긴다. 뒤로가기는 한 걸음 앞으로 되돌린 뒤 묻는 방식인데 Cancel/Keep/Discard/Save 어느 쪽으로도 빠져나갈 수 있다.
   - 새 주소(`/call-order`, `/call-order/rotations`, `/call-order/templates`, `/c/<…>/call-order`)는 모두 미들웨어 기본 거부 대상: 세션 없으면 307 → `/login?next=…`.
   - Not found 동등성: 없는 고객·프로젝트·서비스, 다른 고객의 프로젝트 조합, 여분 세그먼트, 대문자, `-`, `<script>` 모두 같은 "Not found"(경로형 404). `?customer=nope`처럼 쿼리가 틀린 경우는 본문은 같은 Not found지만 상태 코드가 200이다(이전 화면과 같은 동작).
   - 응답 헤더(200·404·스텁 탭): CSP(`frame-ancestors 'none'`, `object-src 'none'`), X-Frame-Options DENY, Referrer-Policy, nosniff, Permissions-Policy, HSTS, `Cache-Control: private, no-store` 유지. `X-Powered-By: Next.js`와 `script-src 'unsafe-inline'`은 이전 검토와 같음(변화 없음).
   - `fail()`이 `ApiError.message`를 그대로 클라이언트에 준다(기존 인시던트 액션과 같은 방식). 백엔드 오류 문구에 내부 정보가 섞이지 않도록 백엔드 쪽에서 관리.
