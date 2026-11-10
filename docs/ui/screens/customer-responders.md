# Call order 패널 — 단계와 Responders (구 Customer › Responders & paging)

| 항목 | 내용 |
|---|---|
| 경로 | `/c/<customer>[/<project>[/<service>]]/call-order` (Call order 목록의 행에서 여는 패널). ~~`/customers/{id}/responders` 고객 상세 탭~~은 없어졌다(D-26 개정) |
| 목적 | 한 범위(고객, 또는 자기 단계를 가진 프로젝트·서비스)의 호출 순서를 읽고, 필요하면 고친다. Responders(MSP 직원 + 고객 사람)는 참고 카드, 사람 관리는 People (D-30·D-31, D-33) |
| 페르소나 | 준호(P2-1, P2-3), 하은 |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 머리 띠 | `Call order · <customer\|project\|service> level` + 전체 경로 + `Copy link`. 편집 중에는 `Call order · editing at <단계> level` |
| **읽기 화면 (처음 열리는 화면)** | ① "If something breaks now" 실명 문장 ② `Paged (n)` · `Also notified (m)` 이름, "Open them in People →" ③ Steps: 번호 · 분 · 대상 · 수단, 마지막 "then repeat once" ④ `Comes from <경로> · own steps · used by N services · edited by …` 또는 `Inherited from <상위 경로>` + "Open the call order of <상위> →" ⑤ "Where steps come from" 트리, Responders 카드. 입력 칸·Save·넓히기·삭제 없음 |
| 읽기 화면의 버튼 | 자기 단계가 있으면 `Edit call order for <전체 경로>`(키 `E`), 물려받았으면 `Create own steps for <전체 경로>…` |
| 편집 화면 | 아래 "구성"의 편집기. "Level you are editing"(지금 단계만), 입력하는 대로 바뀌는 문장(옛 값 취소선), 순서가 뒤집히면 저장 막힘, `Cancel`, `Save for <전체 경로>` / `Save own steps for <전체 경로>` |
| 넓히기 | `Edit project X instead…` / `Edit the whole customer instead…` → 설명 창(대상 서비스 목록, 기본 `Stay`). 읽는 중에는 넓은 단계를 그냥 열 수 있다 |
| 저장 | 서비스 하나에만 닿으면 바로 적용: `Saved for <전체 경로> · step 2 5 → 4 min · 1 service` + `Undo`. 서비스 둘 이상이거나 넓힌 단계면 확인창(전 → 후, 대상 서비스, 안 바뀌는 것) |
| 자기 단계 제거 | 편집 화면에서만, 저장 버튼과 떨어진 줄 `Remove own steps of <경로>…` + 확인 |
| 가드 | 저장 안 한 편집에서 나가면 Save / Keep draft / Discard. 초안은 그 범위에만 속한다 |
| 포털 | 읽기 화면만. "Managed by your MSP." |

## 구성 (편집 화면과 참고 카드)
아래 편집기는 `Edit`를 누른 뒤에만 나온다. Project & service overrides 영역은 패널의 "Where steps come from" 트리와 Call order 목록의 `Own steps` 행이 대신한다. Responders와 Add customer person은 People 화면에서 한다(패널에는 읽기용 Responders 카드).
| 영역 | 내용 |
|---|---|
| Paging steps | **Who is paged first**: All at once / Customer rotation / Shared MSP rotation(로테이션 선택) / Custom steps. **Timing · start from a plan**: Standard/Urgent/Quiet — 고르면 단계를 템플릿에서 다시 만듦(편집 내용 버림 경고). 단계 편집기: At(분) · Who(로테이션 당번 / Everyone in Responders (n) / 사람 — 고객 사람은 "(customer)") · How(Slack/SMS/Call) · ✕, + Add step, Repeat. **If something breaks now** 실명 문장 미리보기. 덮어쓰기 예외 안내 |
| Rotation | 고객 로테이션이면 순서(MSP·고객 배지), 지금 당번, 4주 띠(휴가 대체 표시). 공용이면 링크 + "also used by N other customers". 없으면 이유 |
| Project & service overrides | 노드별 자기 단계 문장, "Use customer steps". 해석 순서 service › project › customer |
| Responders | MSP staff: 템플릿 이름(멤버) · Change · + Add staff, 행마다 출처(from Infra core / added directly), 지정 단계, 문제 채널. <고객> people: 역할 배지(Pageable / Notify only / Auto-fix approver / Portal), "step 2"·"in rotation" 배지, Notified for 범위, 채널 칩, 역할 선택(Pageable ↔ Notify only) |
| Add customer person (서랍) | 이름, 이메일·전화, Role(Pageable (calls, SMS) / Notify only) + Auto-fix approver·Portal 체크, Notified for 범위, **Call them at**: "Not in a named step" 또는 "New step k+1, after step k" + 분(앞뒤 단계 사이 기본값) → 미리보기 문장에 새 이름. 저장 후 확인 링크 |

역할 정의: **Pageable** = 전화·문자 가능, 단계·로테이션에 지정 가능, "everyone"에 포함. **Notify only** = 상태 메일만(범위 안 인시던트). Approver·Portal은 둘 중 어디에나 추가.

## API
GET `/customers/{id}/responders` → `{ staff[{contactId,source:TEMPLATE|DIRECT,templateId}], people[{contactId,role,extras[],scope}], templateId }`; POST/DELETE `/customers/{id}/responders`; PATCH `/customers/{id}/responders/{contactId}` (role); GET/PUT `/customers/{id}/paging` (`style, plan, sharedRotationId?, steps[], repeatCount`, If-Match); PUT/DELETE `/customers/{id}/paging-overrides/{scopeType}/{scopeId}`.

## 390px
패널은 전체 화면. 읽기 화면은 문장 → 이름 → 단계 → 출처 순서, `Edit` 버튼은 아래 고정(44px 이상). 단계 행은 번호 + (분 / 대상 / 수단) 세로. Responders 카드는 단계 아래.

## v4 점검 반영 (2026-11-09)
- 상단 빨간 배너: 호출 건강도 문제와 설명.
- 사람 추가 "Call them at": 'Only as part of everyone' 또는 'Own call, inserted after step N · old step N+1 becomes N+2'. All at once 등 Custom이 아닌 고객이면 Custom steps 전환 경고 + Before/After 문장. Pageable이면 everyone에 이미 포함됨을 안내.
- 용어: "everyone in Responders (N)"로 통일.
