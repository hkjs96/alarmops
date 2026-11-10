# Call order (구 On-call › Now)

| 항목 | 내용 |
|---|---|
| 경로 | `/call-order` (Call order 메뉴 첫 탭), 필터 `?customer=&project=&service=` · `?mine=1`. 탭 `/call-order/rotations`, `/call-order/templates` |
| 목적 | 고객사 전체에서 지금 누가 당번이고, 지금 무언가 터지면 고객별로 누가 먼저 호출되는지 한 화면에 (D-30·D-31 개정) |
| 페르소나 | 하은(야간 당번, 모바일), 준호(P2-2) |
| 탭 | Call order · Rotations · Templates (People·Maintenance는 메뉴, D-26 개정) |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 트리 필터 | 적용. 기본 All customers. `Only with problems`(트리)가 구 "Only customers with problems" 필터를 대신한다: 열린 인시던트 또는 호출 문제가 있는 고객 |
| 행 | 행을 누르면 그 범위의 호출 순서 패널(`customer-responders.md`). 목록에는 편집 칸이 없다 |
| 휴대폰 | 카드는 호출되는 사람 이름이 먼저(`Junho, Minjae, Soyeon` / everyone in Responders (3), all at once). 패널을 열지 않아도 "누가 호출되나"가 답해진다 |
| 열 우선순위 | 경로, Paged first, Steps는 끝까지. Then → Reach 열(고객 이름 옆 표식으로) 순으로 숨김, 500px 미만 카드 |

## 구성
| 영역 | 내용 |
|---|---|
| 로테이션 카드 | 로테이션마다 지금 당번(실명, 고객 사람이면 고객 배지), "until Mon 9 09:00 · next Junho", 공용이면 "Used by N customers", 고객 로테이션이면 "Only <고객>" |
| Who gets paged for… | 트리에서 서비스까지 고르면 그 범위의 행이 답이다(이름 검색은 트리 "Find by name…"·`Ctrl/⌘K`). 리소스 이름 입력 → 경로, 호출 순서 패널 링크, 배지(순서 방식 · 시작 플랜, edited), 실명 문장. 프로젝트·서비스 덮어쓰기면 "Own steps on <노드>". 알림만 받는 고객 사람(Notify only) 별도 표시 |
| 호출 순서 표 | `고객 › 프로젝트 › 서비스`(+ Reach 표식 `UNREACHABLE`/`AT RISK`) · Paged first(이름 먼저, 수단, 대상 종류) · Then(나머지 단계 요약) · Steps(`Customer steps` / `Own steps`). 고객마다 한 행 + 자기 단계를 가진 프로젝트·서비스마다 한 행 + 필터로 고른 범위의 행 |
| 화면 안 필터 | 사람(Anyone/직원) — 그 사람이 Responders이거나 지금 호출되는 고객, 순서 방식 칩(All at once / Customer rotation / Shared MSP rotation / Custom steps, 수 포함) |

## API
GET `/oncall/now?customerId=&contactId=&style=` → `{ rotations[{id,scope,name,onShift:{contactId,name,until},next}], customers[{id,name,style,plan,edited,firstStep:{targetType,ids[]},steps[],responderCount}] }`. GET `/oncall/paging-path?q=`.

## 상태
- 빈: "No customers match."
- 390px: 카드 3개 세로, 표는 라벨:값 카드.

## v4 점검 반영 (2026-11-09)
- 고객별 표 "Then"은 단계마다 한 줄(`N min` + 문장)로 세로 배치. 390px 카드에서 읽힘.
- 고객 단위 호출 건강도(D에서 계산, 서버는 `/oncall/now`·`/customers` 응답의 `pagingHealth[]`): No pageable responder / No verified phone on any step / Step targets unverified only / Rotation gap(다음 2주 당번이 Notify only 고객 사람). 고객 행에 빨간 배지.
- 필터 "Only customers with problems (N)": 고객 10곳 초과면 기본 켜짐.
- 로테이션 카드에 교대 시간 명시("24 h shifts, 09:00 → 09:00 next day"), 복수형 정리.
