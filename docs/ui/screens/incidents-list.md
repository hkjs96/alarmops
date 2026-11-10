# Incidents list

| 항목 | 내용 |
|---|---|
| 경로 | `/incidents` (로그인 기본), 필터 `?customer=<slug>&project=<slug>&service=<slug>` 또는 `?mine=1` |
| 목적 | 지금 울리는 인시던트 수, 가장 심각한 것, 담당자를 스크롤 없이 파악 |
| 페르소나 | 하은 P1-1(한눈 파악), P1-3(내 것만), 준호 P2-3(미매핑 배너) |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 기본 보기 | **All customers**(D-34). `My customers`는 트리 묶음 머리·시트 1단계의 필터 |
| 트리 필터 | 적용. 고객·프로젝트·서비스로 좁힌다. 미매핑 계정 인시던트는 필터가 없을 때와 `My customers`일 때만 보인다 |
| 메뉴 배지 | 전 고객의 열린 인시던트 수 하나. 필터와 무관 |
| `Outside this view` | 필터가 걸리면 필터 줄에 `Outside this view: 4 open (1 from an unmapped account) · 2 acknowledged`. 목록의 open + 밖의 open = 배지. 누르면 필터를 지우고 알림에 `Back to <필터>` |
| 행 | 모든 행에 `고객(굵게) › 프로젝트 › 서비스`. 행에서 바로 `Acknowledge`(알림에 전체 경로 + `Undo`) |
| 패널 | 행을 누르면 인시던트 패널(`/c/<customer>/<project>/<service>/incident/<id>`, 미매핑 `/c/-/incident/<id>`). 읽기 + Acknowledge. 편집 칸 없음 |
| 열 우선순위 | Sev, Status, 경로, Incident, `Acknowledge`는 끝까지. Paged → Age 순으로 숨김, 690px 미만 카드 |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | 제목 "Incidents", 일괄 Ack/Resolve(선택 시만). 고객 선택기는 없다(트리) |
| 배너 | 미매핑 계정 알림이 있을 때 "3 alerts from unmapped accounts — Map account" |
| 스탯 타일 | Triggered · Escalated · Acknowledged · Resolved 24h · Muted. 현재 필터 기준(9-5) |
| 화면 안 필터 | 상태 칩, Severity, Assignee(`me`), Source, 검색. Customer 필터는 없다(트리가 대신한다) |
| 표 | Sev · Status · `고객 › 프로젝트 › 서비스` · Title · Alerts(n) · Assignee(1순위 + 다음) · Escalation(step n/m, 다음 단계까지 남은 시간) · Age |
| On call now (목록 옆 카드) | On call now · by schedule: 열린 인시던트가 걸린 스케줄(서비스 › 프로젝트 › 고객사 › MSP 기본 상속 결과)마다 현재 당번 1명과 열린 건수. 순번(1·2·3)은 표시하지 않음(스케줄마다 다름). 미매핑은 "No owner". 고객사·서비스를 필터하면 그 범위의 에스컬레이션 체인 전체를 표시. 그리고 Escalation pending |

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
| 목록·수치 | GET `/api/v1/incidents?status=&severity=&customer=&project=&service=&mine=1&assignee=me&unmapped=` (`counts`, `unmapped[]`, `outside{open,unmapped,acknowledged}` 포함) |
| 행 Ack | POST `/incidents/{id}/ack` (If-Match 필수, 응답 `undoToken` → 알림의 `Undo`는 POST `/incidents/bulk/undo`) |
| 일괄 Ack/Resolve | POST `/incidents/bulk` `items[{id, version}]` preview → 실행, `undoToken` 5분 → POST `/incidents/bulk/undo` |
| 지금 담당 | GET `/oncall/now?customerId=` |
| 미매핑 복구 | POST `/unmapped-accounts/{awsAccountId}/map` |

## 휴대폰 폭
타일 2열, 표 → 카드 리스트(Sev·경로·제목·담당·Acknowledge 44px 이상). 범위는 필터 줄 한 줄을 눌러 여는 단계 시트로 고른다. "On call now"는 목록 아래.

## 미결
- 정렬 기본값: 심각도 우선 vs 최신 우선 (제안: Triggered 먼저, 그 안에서 심각도 → 나이)
- 일괄 Ack를 OPERATOR 모두에게 열지 (Q-DM-02 역할 체계에 종속)
