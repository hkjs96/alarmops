# Incidents list

| 항목 | 내용 |
|---|---|
| 경로 | `/incidents` (로그인 기본) |
| 목적 | 지금 울리는 인시던트 수, 가장 심각한 것, 담당자를 스크롤 없이 파악 |
| 페르소나 | 하은 P1-1(한눈 파악), P1-3(내 것만), 준호 P2-3(미매핑 배너) |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | 제목 "Incidents", 일괄 Ack/Resolve(선택 시만), 고객 선택기(전역) |
| 배너 | 미매핑 계정 알림이 있을 때 "3 alerts from unmapped accounts — Map account" |
| 스탯 타일 | Triggered · Escalated · Acknowledged · Resolved 24h · Muted. 현재 필터 기준(9-5) |
| 필터 줄 | 상태 칩, Severity, Customer, Assignee(`me`), Source, 검색 |
| 표 | Sev · Status · Title / org chain · Alerts(n) · Assignee(1순위 + 다음) · Escalation(step n/m, 다음 단계까지 남은 시간) · Age |
| 우측 패널 | On call now · by schedule: 열린 인시던트가 걸린 스케줄(서비스 › 프로젝트 › 고객사 › MSP 기본 상속 결과)마다 현재 당번 1명과 열린 건수. 순번(1·2·3)은 표시하지 않음(스케줄마다 다름). 미매핑은 "No owner". 고객사·서비스를 필터하면 그 범위의 에스컬레이션 체인 전체를 표시. 그리고 Escalation pending |

## 컴포넌트
SevMark, StatusBadge, StatTile, FilterChip, IncidentRow(Triggered는 좌측 3px 빨강), AvatarStack, OrgChain(`›`), BulkBar

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | "No open incidents." + 마지막 해소 시각, 필터가 있으면 "Clear filters" |
| 로딩 | 표 8행 스켈레톤, 타일 수치 `—` |
| 오류 | 표 자리 오류 카드 + Retry, requestId 표시. 타일은 숨김(틀린 수치 금지) |

## 동작 → API
| 동작 | API |
|---|---|
| 목록·수치 | GET `/api/v1/incidents?status=&severity=&customerId=&assignee=me&unmapped=` (`counts` 포함) |
| 행 Ack | POST `/incidents/{id}/ack` (If-Match) |
| 일괄 Ack/Resolve | POST `/incidents/bulk` preview → 실행, `undoToken` 5분 → POST `/incidents/bulk/undo` |
| 지금 담당 | GET `/oncall/now?customerId=` |
| 미매핑 복구 | POST `/unmapped-accounts/{awsAccountId}/map` |

## 휴대폰 폭
타일 2열, 표 → 카드 리스트(Sev·제목·담당·Ack 버튼). 우측 패널은 목록 아래.

## 미결
- 정렬 기본값: 심각도 우선 vs 최신 우선 (제안: Triggered 먼저, 그 안에서 심각도 → 나이)
- 일괄 Ack를 OPERATOR 모두에게 열지 (Q-DM-02 역할 체계에 종속)
