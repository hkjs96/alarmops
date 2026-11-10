# Call order › Templates (Responder templates)

| 항목 | 내용 |
|---|---|
| 경로 | `/call-order/templates` |
| 목적 | 자주 쓰는 MSP 직원 묶음(예: "Infra core: Haeun, Junho, Minjae")을 저장하고 여러 고객에 적용. 고객 사람은 템플릿에 넣지 않고 고객마다 추가 (D-31 개정) |
| 페르소나 | 준호 |


## 셸·범위 (D-33, `shell-scope.md`)
- 트리 필터: 적용하지 않는다(템플릿은 MSP 것). Customers 열이 사용 고객을 보여 준다.
- 읽기 먼저: 상세는 멤버와 사용 고객을 읽기 전용으로 보여 주고 `Edit template`을 눌러야 멤버 칩이 편집된다.
- 여러 고객에 닿는 변경: 영향 미리보기 → `Save template for N customers` → 확인창 1회 → 감사 기록.
- 새 셸 시안은 아직 없다(`mockups/index.html`의 화면 내용이 기준).

## 구성
| 영역 | 내용 |
|---|---|
| 목록 | Template · MSP staff · Customers(사용 고객 수) · Last edited |
| 상세 | 멤버 칩(✕ 제거, "+ Add staff…"). 변경하면 즉시 영향 미리보기: "This change affects 7 customers" + 고객별 "+ Dohyun joins Responders" / "− Junho leaves Responders" / "Junho stays (added directly)" / "**step 2 still names Junho** — fix in the customer" |
| 저장 | "Save template for N customers" → 감사 기록(People › audit). Discard |

템플릿은 고객 Responders의 출처일 뿐 페이징 순서를 갖지 않는다. 순서는 고객 단계 또는 로테이션.

## API
GET/POST `/responder-templates`, PATCH `/responder-templates/{id}` (`members[]`, `previewHash`), POST `/responder-templates/{id}/preview` → `{customers[{id,effects[]}]}`.
