# AlarmOps 콘솔 범위 틀 — 보안 재검토 (2차)

- 대상: `feat/console-scope`, `git diff 1fa37ca..HEAD` (커밋 `cdc5a1c`), 읽기 전용 검토. 2026-11-10.
- 방법: diff 열람 + 직접 띄운 서버(`next dev`, `next build && next start -p 3118`)에 `curl -I`와 Playwright로 확인. 단위 테스트(console 62, design-system 83)와 `tsc --noEmit` 통과 확인.
- 결론: **[차단] 0건, [권고] 4건.** 1차의 R-3·R-4·R-5·R-6은 반영 확인. 남은 것은 계약 문서 불일치(S-1), CSP `'unsafe-inline'`(S-2), 기존 dev-login의 열린 리다이렉트(S-3), undo 계약(S-4).

## 1차 권고 확인

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| R-3 | 단건 Ack의 버전 검사 | 반영 | `ackIncident(id, version)` → `assertId`·`assertVersion` → `POST /incidents/{id}/ack` + `If-Match`(`client.ts`). 행·카드·패널 모두 이 한 경로. bulk는 `items: [{id, version}]`, `assertBulkItems`가 1~200건·각 id/version 검사. 409는 행에 "Changed since you loaded this list · not acknowledged · Reload", 패널에 "Someone else updated this incident. Nothing was changed" — 화면에서 두 세션으로 재현해 Ack되지 않음을 확인. bulk 실행은 버전이 다른 건을 `conflicts`로 건너뜀(mock) |
| R-4 | 응답 헤더 | 반영 | 빌드본 `curl -I`: `/login` 200, `/incidents` 307, `/_next/static/x.js` 404, `/auth/dev-login` 307, `/favicon.ico` 404 전부에 `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`. 운영 CSP: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. dev에서만 `'unsafe-eval'`과 `ws: wss:` 추가 (S-2 참고) |
| R-5 | 읽기 경로 403 → Not found | 반영 | `isHidden`(404 또는 403)이 `/incidents/[id]` 리다이렉트, 패널 조회, 목록 조회(`IncidentsScreen` 2곳)에 쓰임. `e.status === 404` 직접 비교는 남아 있지 않음. 화면에서 없는 고객·남의 id·경로 불일치가 모두 같은 본문 |
| R-6 | 단일 검증기, 점만으로 된 id 거부 | 반영 | 정규식 정의는 `lib/validate.ts`의 `ID_RE`(`^(?!\.+$)…`)·`SLUG_RE` 두 개뿐(grep 확인), `scope.ts`·mock은 여기서 가져다 씀. `/c/…/incident/..`, `%2e%2e`, `/incidents/....`, `?customer=..&project=.` 모두 Not found |

## 추가 확인 (문제 없음)

- **Ctrl/⌘K 검색**: `ScopeSearch`/`searchScopes`는 레이아웃이 이미 받은 `scopeTree().customers`만 클라이언트에서 거른다. 새 조회·새 서버 액션 없음 → 범위 트리에 없는 이름은 나올 수 없다. 입력값은 React 텍스트로만 출력(`<img onerror>` 입력 시 요소 생성 0 확인).
- **XSS**: 새 `dangerouslySetInnerHTML`은 `shellInitScript` 하나, 상수 3개만 들어가는 고정 문자열. `sessionStorage` 값은 `JSON.parse` 후 boolean/숫자로만 쓰고 폭은 200~360으로 자름. 토스트 문구(고객·인시던트 이름)는 텍스트 노드.
- **리다이렉트**: 새로 생긴 이동은 `router.push(listPath + scopeQuery(...))`뿐이고 slug는 `isSlug` 통과분. 외부 URL로 가는 새 경로 없음.
- **미들웨어**: 변경 없음. 기본 거부 유지 — 로그아웃 상태에서 `/people`, `/settings`, `/c/…`, `/api/anything`, `/_next/data/x` 모두 `/login?next=…`로 307.
- **서버 액션**: 전부 `run()`에서 `requireSession()` → 입력 검사 → API 순서 유지. `revalidatePath("/", "layout")`로 넓어졌으나 권한과 무관.
- **sessionStorage `ao-scope-shell`**: `{col, w}`만 저장, 이름·id 없음.

## 권고

### S-1 [권고 — backend 착수 전 필수] 코드 주석은 "API-CONTRACT §8.0/§8.1"을 가리키는데 이 브랜치의 계약 문서에는 없다
- `types.ts`·`client.ts`의 PROPOSED 표시가 "API-CONTRACT §8.0"으로 바뀌었지만 `docs/API-CONTRACT.md`는 이 diff에서 바뀌지 않았다. 현재 문서: `/incidents/bulk`는 `ids[]`, 단건 ack는 `undoToken` 반환 없음, `/scope-tree`·`outside`·slug 필터·`mine` 항목 없음. 해당 내용은 `origin/docs/scope-context` 브랜치에만 있다.
- 위험: 1차 R-1(테넌트 규칙이 계약에 없음)이 문서상 그대로 열려 있고, 격리(범위 밖 slug → 404, unmapped는 INTERNAL만, `mine`은 세션에서 계산)가 아직 mock 가정이다. backend가 main의 계약을 보고 구현하면 `ids[]`로 만들어 R-3이 다시 사라진다.
- 수정안: `docs/scope-context`를 먼저(또는 같이) 머지하고, 이 PR 설명에 의존 관계를 적는다. CLAUDE.md "여러 폴더에 걸치면 API-CONTRACT를 먼저 고친다"와도 맞춘다.

### S-2 [권고] CSP `script-src 'unsafe-inline'`
- 운영 CSP에도 `'unsafe-inline'`이 있어 인라인 스크립트 주입은 CSP로 막히지 않는다(외부 스크립트 출처, `object`, `base`, `form-action`, 프레임은 막힘). `next.config.ts` 주석대로 nonce 방식(미들웨어에서 요청별 발급)이 다음 단계. 파일럿 실운영 전 이슈로 등록 권장.
- 함께: `Strict-Transport-Security`, `Permissions-Policy` 없음. HSTS는 ALB/CloudFront에서 줄 수 있으므로 infra 이슈로.

### S-3 [권고 — 기존 코드, mock 전용] `/auth/dev-login?next=`의 열린 리다이렉트
- 이 diff에서 바뀐 파일은 아님(스캐폴드 #5). `next=/%09/evil.example`(또는 `%0A`) → `Location: http://evil.example/`. `startsWith("//")` 검사는 통과하지만 URL 파서가 탭·개행을 지워 `//evil.example`이 된다. `/login?next=/%09/evil.example`의 dev 로그인 링크로도 이어진다.
- 영향: mock 모드에서만 열리는 경로라 운영 영향 없음. 다만 같은 검사를 SSO 콜백의 `next`에 재사용하면 운영 취약점이 된다.
- 수정안: `new URL(next, origin)`을 만든 뒤 `url.origin === origin`인지 확인하는 함수 하나로 통일하고 SSO 콜백도 그것만 쓰게 한다.

### S-4 [권고 — 계약] Undo의 권한·경합 규칙
- 단건 Ack의 Undo가 `POST /incidents/bulk/undo { undoToken }`을 쓴다. mock은 스냅샷을 그대로 덮어쓴다(그 사이 다른 사람이 Resolve·Escalate했어도 되돌림). 계약에 "토큰은 발급받은 사용자만, 5분, 대상이 토큰 발급 뒤 바뀌었으면 409"를 명시할 것. `escalate`는 여전히 `If-Match` 없음(1차와 동일).

## 참고 (QA에서 넘어온 안전 문제, 보안 차단 아님)

- QA P1-A: 데스크톱에서 Ack 후 다음 행으로 마우스를 옮기면 다른 고객의 인시던트가 Ack된다. 원인은 `IncidentsTable.tsx`의 고정 행 `onPointerLeave → release()`가 즉시 재정렬을 일으키는 것. `If-Match`는 버전이 같으므로 이 실수를 막지 못한다. 상세는 `docs/qa/results.md` "Console 범위 틀 재점검".

## 판정

보안 관문: **[차단] 없음 — 통과.** S-1은 backend 이슈 배정 전에 처리, S-2·S-3·S-4는 후속 이슈.
