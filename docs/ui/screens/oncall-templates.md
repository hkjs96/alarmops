# Call order › Templates (Responder templates)

| 항목 | 내용 |
|---|---|
| 경로 | `/call-order/templates` |
| 목적 | 자주 쓰는 MSP 직원 묶음(예: "Infra core: Haeun, Junho, Minjae")을 저장하고 여러 고객에 적용. 고객 사람은 템플릿에 넣지 않고 고객마다 추가 (D-31 개정) |
| 페르소나 | 준호 |
| 구현 | 11/27 (이슈 #28 템플릿 부분). `/oncall/templates`는 `/call-order/templates`로 리다이렉트 |


## 셸·범위 (D-33, `shell-scope.md`)
- 트리 필터: 적용하지 않는다(템플릿은 MSP 것). Customers 열이 사용 고객을 보여 준다.
- 읽기 먼저: 상세는 멤버와 사용 고객을 읽기 전용으로 보여 주고 `Edit template`을 눌러야 멤버 칩이 편집된다.
- 여러 고객에 닿는 변경: 영향 미리보기 → `Save template for N customers` → 확인창 1회 → 감사 기록.
- 새 셸 시안은 아직 없다(`mockups/index.html`의 화면 내용이 기준).

## 구성
| 영역 | 내용 |
|---|---|
| 목록 | Template · MSP staff · Customers(사용 고객 수) · Last edited. 휴대폰(390px)에서는 행이 카드로 바뀐다. 이름 버튼 `Open template <이름>`으로 상세를 연다 |
| 상세(읽기) | 멤버 칩, `Used by N customers` 목록, `Edit template`(ADMIN만). 그 외 역할은 `Changing a template needs the Admin role. You are signed in as Operator.` 문장과 읽기 전용 상세 |
| 상세(편집) | 이름 입력, 멤버 칩(✕ `Remove <이름> from this template`), `+ Add staff…` 선택 + `Add`. 바꾸면 250ms 뒤 영향 미리보기 |
| 영향 미리보기 | `This change affects 7 customers`, `N will join, M will leave`, 고객별 효과 줄(아래 문구 표), 막힌 고객은 `✕ Blocked` |
| 새 템플릿 | `New template`(ADMIN) → 이름 + 멤버 → `Create template`. 쓰는 고객이 없어 미리보기 없음 |
| 저장 | `Save template for N customers`(고객이 0이면 `Save template`) → 확인창(같은 제목 + `?`, 대상 고객과 효과 목록) → 저장 → `Saved “<이름>” for N customers · M changed. People added directly were not touched.` + `Undo`. `Discard`는 편집을 버린다 |

효과 줄 문구(고정, 표시 기호는 색이 아닌 글자):
| kind | 문구 |
|---|---|
| JOINS | `+ Dohyun Kang joins Responders` |
| LEAVES | `− Junho Park leaves Responders` |
| STAYS_DIRECT | `= Junho Park stays (added directly)` |
| ALREADY_DIRECT | `= Junho Park is already in Responders (added directly) — no change` |
| STEP_NAMES | `! **step 2 still names Junho Park** — fix in the customer` (막지 않는다) |

Save는 다음 중 하나면 꺼지고 이유가 버튼 아래에 나온다: 역할이 ADMIN이 아님 · 바뀐 것 없음 · 이름 없음/멤버 없음 · 미리보기 확인 중 · 막힌 고객이 있음(`Blocked: see the customers marked below.`).

막힘(`blocking`) 문구: `Can’t save: this would break N customers` + 고객별 이유 + `Change the people, or fix those customers’ call orders first. There is no way around this.`
- UNREACHABLE: `<고객>: nobody could be called after this change.`
- RESPONDER_LIMIT_EXCEEDED: `<고객>: a step that calls everyone in Responders would reach more than 20 people.`
- SEND_CAP_EXCEEDED: `<고객>: a call order would send more notifications per incident than the limit allows.`

오류(저장이 안 된 경우, 모두 "Nothing was changed."로 끝나고 할 일을 말한다): WOULD_BE_UNREACHABLE · RESPONDER_LIMIT_EXCEEDED · SEND_CAP_EXCEEDED(`Not saved. After this change …`), PREVIEW_STALE(`Review the new preview, then save again.`, 미리보기를 다시 한다), VERSION_CONFLICT(`Reload` 버튼), ALREADY_EXISTS(`Choose a different name.`), BUSY(서버 `Retry-After` 뒤 한 번 자동 재시도, 또 BUSY면 `Try again in a moment.`).

되돌리기: 저장 직후 `Undo`는 이전 이름·멤버로 같은 미리보기 → 저장을 거친다(막히면 `Not undone. …`).

템플릿은 고객 Responders의 출처일 뿐 페이징 순서를 갖지 않는다. 순서는 고객 단계 또는 로테이션.

## API
GET/POST `/responder-templates`, PATCH `/responder-templates/{id}` (`name?`, `members[]`, `previewHash`, `If-Match`), POST `/responder-templates/{id}/preview` → `{customers[{id,name,effects[]}], totals, previewHash}`. 정의는 API-CONTRACT §8.3 "Responder 템플릿".

고객에 연결·해제: `POST·PUT /customers/{id}/responders/template[/preview]`(D-64). 화면은 `customer-responders.md`의 "Responders 카드의 Template 칸".
