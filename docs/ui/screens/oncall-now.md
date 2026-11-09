# On-call › Now

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall` (On-call 메뉴 첫 탭) |
| 목적 | 고객사 전체에서 지금 누가 당번이고, 지금 무언가 터지면 고객별로 누가 먼저 호출되는지 한 화면에 (D-30·D-31 개정) |
| 페르소나 | 하은(야간 당번, 모바일), 준호(P2-2) |
| 탭 | Now · Rotations · People · Templates · Maintenance |

## 구성
| 영역 | 내용 |
|---|---|
| 로테이션 카드 | 로테이션마다 지금 당번(실명, 고객 사람이면 고객 배지), "until Mon 9 09:00 · next Junho", 공용이면 "Used by N customers", 고객 로테이션이면 "Only <고객>" |
| Who gets paged for… | 서비스·리소스 입력 → 경로, 고객 Responders & paging 링크, 배지(순서 방식 · 시작 플랜, edited), 실명 문장. 프로젝트·서비스 덮어쓰기면 "Own steps on <노드>". 알림만 받는 고객 사람(Notify only) 별도 표시 |
| 고객별 표 | Customer · Ordering 배지 · Paged first(아바타+이름, 수단, 대상 종류) · Then(나머지 단계 요약) · Responders 수(고객 사람 수 포함) |
| 필터 | 고객 이름, 사람(Anyone/직원) — 그 사람이 Responders이거나 지금 호출되는 고객, 순서 방식 칩(All at once / Customer rotation / Shared MSP rotation / Custom steps, 수 포함) |

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
