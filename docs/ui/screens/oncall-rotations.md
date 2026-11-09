# On-call › Rotations

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/rotations?r=` |
| 목적 | **공용 MSP 로테이션**(예: MSP night desk, Data desk)을 관리. 여러 고객의 단계가 "on shift in <로테이션>"으로 참조한다 (D-31 개정) |
| 페르소나 | 하은(교대·대체), 준호 |

## 구성
| 영역 | 내용 |
|---|---|
| 로테이션 선택 | 공용 로테이션 세그먼트 + "New shared rotation" |
| 순서 | 1 = 지금 당번(until …), 2 = 다음 교대. 순서 하나만(D-28 유지) |
| 다음 시프트 | 일 단위(09:00 → 09:00) 8행 또는 주 단위 4행. 휴가 대체는 "for Junho (leave)", 수락된 부분 대체·대기 요청 표시, 행마다 Swap |
| Used by | 이 로테이션을 단계에서 참조하는 고객(단계 번호 또는 "project or service override"). 멤버·순서 변경은 이 고객 모두에 적용됨을 안내 |
| Customer rotations | 고객 전용 로테이션 표(이름, 고객, 멤버 — 고객 사람 배지, 지금 당번). 편집은 고객 상세 Responders & paging |
| Cover or swap | 상대 수락 후 반영(D-28 유지). 여러 날·모든 고객은 People › Leave & replace로 안내 |

## API
GET/POST `/rotations?scope=MSP|CUSTOMER&customerId=`, PATCH `/rotations/{id}` (members[] 순서, cadence, handover), GET `/rotations/{id}/shifts?from=&to=`, GET `/rotations/{id}/usage` → 참조 고객·단계, POST `/rotations/{id}/overrides` (COVER/SWAP, PENDING→ACCEPTED).
