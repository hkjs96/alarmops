# 보안 검토 — feat/console-scope (1fa37ca) vs origin/main

- 대상: `/home/claude/wt-console`, `git diff origin/main...HEAD` (56개 파일, 콘솔 + design-system)
- 방법: 정적 검토(읽기 전용). 서버를 띄워 요청을 보내는 동적 확인과 테스트 실행은 하지 않았다.
- 결론: **[차단] 0건.** 콘솔 코드 자체에는 테넌트 존재를 드러내는 분기가 없다. 다만 격리는 전부 아직 계약에 없는 백엔드 동작(PROPOSED 4건)에 기대고 있어, R-1을 backend 이슈보다 먼저 처리해야 한다.
- 경로 표기는 `apps/console/src/` 기준(design-system은 전체 경로).

## 요약

| # | 등급 | 항목 |
|---|---|---|
| R-1 | 권고(백엔드 착수 전 필수) | `/scope-tree`, `outside`, `?customer/project/service`, `mine`의 테넌트 규칙이 `docs/API-CONTRACT.md`에 없음 |
| R-2 | 권고 | 포털/고객 사용자에게 unmapped 계정 정보가 나갈 수 있는 형태(mock이 그 동작을 기준으로 굳힘) |
| R-3 | 권고 | 단건 Acknowledge가 `If-Match` 버전 검사를 잃음 |
| R-4 | 권고 | 보안 응답 헤더 없음(기존 그대로) — 이번에 URL에 고객 slug가 들어가므로 우선순위 상승 |
| R-5 | 권고 | 404 이외 상태(403 등)가 오면 다른 화면이 나옴 — 존재 구분 가능 |
| R-6 | 권고 | `ID_RE`가 `.`/`..`를 통과시킴 + 정규식 중복 정의 |
| N-1~N-8 | 참고 | 아래 |

## 권고

### R-1 [권고] 새 조회 4건의 테넌트 규칙이 계약에 없다
- 위치: `lib/api/types.ts:28,141-154,160-166,300-307`, `lib/api/client.ts`(scopeTree), `app/layout.tsx:17`
- 내용: 콘솔은 받은 것을 그대로 그린다. 역할 검사(`me.role`)는 어디에도 없고, 트리 전체(고객·프로젝트·서비스의 id, slug, name, callHealth, openIncidents)가 로그인한 모든 화면의 RSC 페이로드로 브라우저에 내려간다. 즉 격리는 100% 백엔드 응답에 달려 있는데, 규칙이 `types.ts` 주석에만 있고 `docs/API-CONTRACT.md`에는 `scope-tree`·`outside`·`slug`·`mine`이 한 줄도 없다. 코드가 참조하는 `docs/ui/scope-variants.md`도 이 브랜치에 없다. CLAUDE.md의 "여러 폴더에 걸치면 API-CONTRACT를 먼저 고친다"에도 해당.
- 수정안: backend 이슈 발행 전에 계약 §2/§8에 아래를 명문화.
  1. `GET /scope-tree` — 서버가 구한 customerId 집합 안의 고객만. 프로젝트/서비스 범위(ContactScope PROJECT/SERVICE)인 사용자는 그 하위만. `openIncidents`·`callHealth`도 같은 범위로 계산. 범위 밖 노드는 개수 0이 아니라 아예 없음.
  2. `GET /incidents?customer=&project=&service=` — 모르는 slug와 범위 밖 slug는 **같은 404 `NOT_FOUND`, 같은 본문**. 403 금지. slug 해석은 호출자 범위 안에서만(범위 밖 고객을 먼저 찾고 나서 거부하는 순서 금지 — 응답 시간 차이).
  3. `outside` — 호출자 범위 안의 인시던트만 센다. 불변식 "목록 open + outside.open = 배지"는 범위 안에서만 성립.
  4. `mine=1` — 서버가 세션 사용자로 계산. 클라이언트가 보낸 사용자/연락처 id를 받지 않는다.
  5. `IncidentListResponse.counts`(배지, `layout.tsx:17`)도 범위 적용.
  6. `GET /incidents/{id}`가 돌려주는 `org.*.slug`는 범위 안일 때만(이미 §2의 404 규칙으로 보장되지만 리다이렉트가 slug를 URL에 싣기 때문에 명시).
- 이 6개에 대한 격리 테스트(다른 고객 slug / 없는 slug 응답 바이트 동일)를 backend PR 관문으로 건다.

### R-2 [권고] unmapped 계정 정보가 고객 사용자에게 나갈 수 있는 모양
- 위치: `lib/api/mock/mock-api.ts:49`(mine 뷰에 unmapped 포함), `:113`(mine일 때도 unmapped 배너 반환), `:114` + `lib/incidents.ts` `outsideCounts`(`outside.unmapped`), `app/incidents/IncidentsScreen.tsx:89-93`(AWS 계정 ID 12자리 표시), `IncidentsTable.tsx` `what()`
- 내용: unmapped 계정은 어느 고객의 것인지 모르는 상태다. MSP 직원에게는 맞지만, 포털 사용자(소연, Q-API-07 추천안 = 같은 `/api/v1` + 범위 강제)에게 "unmapped N건"과 계정 ID가 보이면 다른 고객의 계정 ID·알림 건수가 노출된다. mock은 사용자 1명이라 지금 새는 것은 없으나, mock 동작이 backend 구현의 기준이 된다.
- 수정안: 계약에 "unmapped 인시던트, `unmapped[]` 배너, `outside.unmapped`, `/c/-/incident/<id>`는 INTERNAL(MSP) 사용자에게만. 고객 사용자에게는 404/빈 배열/0" 추가. 콘솔은 그대로 두어도 된다.

### R-3 [권고] 단건 Acknowledge의 버전 검사 제거
- 위치: `app/incidents/IncidentsTable.tsx:62`(이전: `ackIncident(i.id, i.version)` → 현재: `executeBulk("ack", [i.id])`), 키보드 `A` `:95`
- 내용: 실행 취소 토큰을 얻으려고 bulk 경로로 바꾸면서 `If-Match`(낙관적 잠금)가 빠졌다. 오래된 목록에서 누른 Ack가 그 사이 재발화/에스컬레이션된 인시던트에 그대로 적용되고 호출이 멈춘다. 서버 액션의 `requireSession`·`assertIds`는 유지되어 인증·입력 검증 문제는 아니다.
- 수정안: `POST /incidents/{id}/ack`가 `undoToken`을 돌려주게 계약을 고치고 `ackIncident(id, version)`로 되돌리거나, bulk 본문에 `{id, version}` 쌍을 받게 한다. 계약 변경이므로 R-1과 함께.

### R-4 [권고] 응답 헤더 없음 (기존과 동일, 변경 없음)
- 위치: `apps/console/next.config.ts`(headers 없음), `middleware.ts`(헤더 설정 없음) — 이 브랜치에서 둘 다 미변경
- 내용: 클릭재킹 방어(`frame-ancestors`/`X-Frame-Options`), `Referrer-Policy`, `nosniff`가 원래 없다. 회귀는 아니지만 이번부터 고객·프로젝트·서비스 slug가 모든 화면의 경로/쿼리에 실리고(TopNav가 모든 메뉴 링크에 필터를 붙임), 한 번의 클릭으로 Ack가 되는 버튼이 목록에 항상 떠 있어 프레임 삽입의 가치가 커졌다. 외부 링크(runbook, Slack)는 `rel="noopener noreferrer"`라 현재 Referer 유출은 없다.
- 수정안: `next.config.ts` `headers()`에 `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`. 별도 이슈로(console).

### R-5 [권고] 404가 아닌 오류는 다른 화면이 된다
- 위치: `app/incidents/IncidentsScreen.tsx:46-47`(패널: 404만 notFound, 나머지는 throw → 500 화면), `:57-58`(목록: 404만 notFound, 나머지는 오류 카드에 `error.message`·requestId 표시), `app/incidents/[id]/page.tsx:17-18`
- 내용: 백엔드가 범위 밖에 403을 주면(계약 §2는 "범위 안 + 역할 부족 = 403"이라 구현 실수가 나기 쉬운 자리) 없는 주소(Not found)와 화면·HTTP 상태가 달라져 존재가 드러난다.
- 수정안: 조회 경로(getIncident / getTimeline / getNotifications / 범위 필터가 있는 listIncidents)에서는 403도 `notFound()`로 접는다. 쓰기 액션의 403은 그대로 둔다.

### R-6 [권고] `ID_RE`가 점만으로 된 id를 허용, 정의도 두 곳
- 위치: `lib/scope.ts:12`, `lib/validate.ts:3`(같은 정규식 두 번), `lib/api/client.ts:74-79`
- 내용: `encodeURIComponent("..")`는 `..` 그대로라 `fetch(base + "/incidents/../ack")`가 `/api/v1/ack`로 정규화된다. 페이지 경로로는 URL 파서가 먼저 접어서 닿기 어렵지만 서버 액션(`ackIncident`, `escalateIncident`, `executeBulk`)은 임의 문자열을 받는다. 호출자 본인 토큰으로 없는 엔드포인트를 치는 정도라 영향은 낮다(기존 결함, 이번에 `ID_RE`를 export해 재사용하면서 범위가 넓어짐).
- 수정안: `validate.ts`의 것 하나만 쓰고 `scope.ts`는 import. 정규식을 `/^(?!\.+$)[A-Za-z0-9._:-]{1,128}$/`로.

## 참고 (확인 결과 문제 없음 / 작은 것)

- **N-1 존재 노출(404 vs 200, 본문)**: 콘솔 쪽 분기 없음.
  - `/c/...` 형식 오류, 없는 id, 범위 밖 id(백엔드 404), 자기 범위와 다른 경로(`panelRouteMatches`, `IncidentsScreen.tsx:42`) 모두 `notFound()` → 같은 `NotFoundBody`, 주소의 이름을 본문에 쓰지 않음(`components/NotFoundBody.tsx`). 경로의 slug는 백엔드 조회에 쓰이지 않고 **볼 수 있는 인시던트 자신의 org와만** 비교하므로 slug 추측으로 다른 고객 존재를 알 수 없다.
  - 패널을 목록보다 먼저 확인하고, 필터 slug 404도 같은 `notFound()`.
  - `/incidents/<id>` 리다이렉트(`app/incidents/[id]/page.tsx`): `getIncident` 성공 후에만 slug가 든 경로를 만들고, 404면 리다이렉트 없이 Not found. 못 보는 id로 고객 slug가 URL에 실리는 경로 없음. 쿼리는 버린다.
  - `incidents/loading.tsx` 삭제로 스트리밍 전 404 상태 코드가 유지됨(좋은 방향).
  - 차이 하나: 인시던트 화면은 서버가 HTTP 404, 스텁 화면(`/call-order?customer=x` 등)은 셸이 클라이언트에서 Not found를 그려 HTTP 200(`ScopeShell.tsx:153`). "없는 slug"와 "범위 밖 slug" 둘 다 같은 200이라 존재 구분은 안 된다. 스텁이 실화면이 되면 서버에서 404로.
- **N-2 인증**: `middleware.ts` 미변경, matcher가 정적 자산 외 전부라 `/c/*`, `/call-order`, `/people`, `/maintenance` 포함. 미로그인 시 어떤 `/c/...`든 같은 `/login?next=` 리다이렉트. `getApi()`가 `requireSession()` 선행, 서버 액션 `run()`의 `requireSession` → 검증 → 호출 순서 유지(`app/incidents/actions.ts` 미변경). slug `^[a-z0-9][a-z0-9-]{0,63}$`, id 검증, `-`는 slug와 충돌 불가, 배열 쿼리는 첫 값만.
- **N-3 mock 가드**: `lib/mode.ts` 미변경. `lib/api/index.ts`의 변경은 `isMock()` 분기 안의 `MOCK_CUSTOMERS`뿐. dev-login도 미변경(mock 아닐 때 404).
- **N-4 오픈 리다이렉트**: `next` 처리 미변경(`/`로 시작, `//`·`/\` 거부). Copy link는 `window.location.origin` + 서버가 만든 경로(slug는 `isSlug` 통과분만, id는 `encodeURIComponent`) — 쿼리 미포함. 토스트 "Back to …"의 href(`ScopeShell.tsx:121-124`)와 `allHref`는 `usePathname()` + 현재 쿼리라 동일 출처. 방어적으로 `pathname.startsWith("//")`면 `/incidents`로 바꾸는 한 줄을 넣어도 좋다.
- **N-5 XSS**: 고객/프로젝트/서비스 이름은 트리·경로·필터 줄·토스트·다이얼로그·`title`/`aria-label` 모두 React 텍스트/속성으로만 출력. 새 `dangerouslySetInnerHTML` 없음(기존 테마 스크립트 상수만). sessionStorage에서 읽은 id는 `CSS.escape` 후 셀렉터에 사용. `IncidentDetailBody.tsx:110`의 `/call-order?customer=${slug}`는 API slug를 검증·인코딩 없이 붙임 — 상대 경로라 스킴 주입은 불가, `isSlug` 통과 시에만 링크를 만들면 깔끔.
- **N-6 sessionStorage**: `ao-scope-shell` = `{col, w}`(접힘, 너비), `ao-scope-tree` = 펼친 노드의 slug 키 맵 + 토글 2개, `ao-focus-row` = 인시던트 id 1개(읽자마자 삭제). 토큰·이름·검색어·인시던트 내용 없음. 같은 탭에서 사용자가 바뀌면 이전 사용자가 펼친 고객 slug가 남는다 → 로그아웃 구현 시 `ao-*` 키 삭제(현재 로그아웃 자체가 없음).
- **N-7 mock의 한계**: mock `getIncident`/`scopeTree`/`outsideCounts`는 범위 검사 없이 전체를 돌려준다(사용자 1명). e2e의 "범위 밖 = Not found"는 실제로는 "없는 slug"만 검증한다. 격리 검증은 backend 테스트 몫(R-1).
- **N-8 기타**: `incidentPanelPath`(`lib/scope.ts:73`)는 slug가 형식에 안 맞으면 세그먼트가 빠져 `/c//incident/…`가 될 수 있고, 고객 slug가 없으면 매핑된 인시던트가 `/c/-/…`로 나온다(보안 아님, 견고성 — `OrgRef.slug`를 필수로). `revalidatePath("/incidents","layout")`는 `/c/...`를 포함하지 않는다(표시 신선도). 비밀값·`.env`·자격증명 추가 없음, 스크린샷 출력 경로는 gitignore됨.

## 허브에 요청
- 머지 보류 요청 없음([차단] 없음).
- R-1·R-2·R-3·R-5는 계약 변경이 필요하므로 `docs/API-CONTRACT.md` 수정 이슈를 backend 배정 전에 연다. R-4·R-6·N-4·N-5는 console 후속 이슈.
