# On-call schedule editor

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/schedules/{id}` (목록 `/oncall/schedules`) |
| 목적 | 팀 기본 순서, 요일·시각 시프트, 대체 근무를 편집하고 "지금 누가"와 그 근거를 확인 |
| 페르소나 | 준호 P2-2(순서), P2-4(상속 확인) |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | 스케줄 이름, 팀, 고객사(내부면 Internal), Save |
| Now 카드 | 지금 순서 1·2·3 + 해석 근거("Override by Junho until 09:00", "Shift Mon–Fri 09–18") |
| 주간 그리드 | 7일 × 24시간, 시프트 막대(사람별 색 아닌 이니셜 + 잉크 농도), 대체 근무는 빗금 |
| 팀 기본 순서 | 순번 마크 + ↑↓, 멤버 추가 |
| 대체 근무 | 목록 + "Add override"(누구, 기간, 이유) |

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | 시프트 없음 → "Team default order applies at all times" |
| 오류 | 겹침은 저장 허용 + 경고("Later start wins", R2-3) |

## 동작 → API
| 동작 | API |
|---|---|
| 스케줄 | GET/PATCH `/schedules/{id}` |
| 대체 근무 | GET/POST `/schedules/{id}/overrides`, DELETE `.../{oid}` |
| 팀 순서 | PATCH `/teams/{id}` |
| 지금 담당 | GET `/oncall/now?customerId=&serviceId=` |

## 미결
- 주 단위 순환 교대(Q-DM-14) — 그리드에 "Rotation" 자리만
- 시프트가 자정을 넘는 경우 입력 방식
