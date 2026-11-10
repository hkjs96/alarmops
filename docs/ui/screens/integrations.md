# Integrations

| 항목 | 내용 |
|---|---|
| 경로 | Customers 고객 상세 `Integrations` 탭(`/customers/{id}/integrations`), 전체 목록 `/settings/integrations` |
| 목적 | CloudWatch(AWS 계정 + 역할 5개), Prometheus Alertmanager, Grafana 연동 상태와 첫/마지막 수신 |
| 페르소나 | 민재 P4-1(연결 확인), 준호 |


## 셸·범위 (D-33, `shell-scope.md`)
- 트리 필터를 쓰지 않는다. 고객 상세 탭은 그 고객 하나, Settings › Integrations는 전 고객 목록(읽기)이다.
- 읽기 먼저: 상태·토큰 접두는 읽기 전용. 변경 동작(Add, Rotate token, Check)은 버튼마다 고객 이름이 있는 확인(`Rotate token for Mirae Pay · Prometheus`).
- 연동은 고객 하나에만 닿는다. 전 고객에 닿는 연동 설정은 없다.
- 새 셸 시안은 아직 없다.

## 레이아웃
| 영역 | 내용 |
|---|---|
| 소스 카드 3개 | CloudWatch · Prometheus · Grafana — 상태, 마지막 수신, 24h 이벤트 수, 거절 수 |
| CloudWatch 계정 표 | Account(12자리) · Env · Reader · EventForwarder · AlarmWriter · TagWriter · Remediator(각 ✓ OK / ✕ Denied / – Not enabled / ? Unknown) · First event · Check |
| 웹훅 소스 | 이름, kind, endpoint URL(복사), 토큰 접두 `in_3f9a…`, Rotate token, Last received |
| 토큰 1회 표시 | 생성·회전 직후 모달에만 평문, "You won't see this again" |
| 설정 예시 | Alertmanager `webhook_configs` / Grafana contact point 스니펫 |

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | 소스 없음 → "Add Prometheus" / "Add Grafana" |
| 대기 | 계정 연결 후 이벤트 없음 → "Waiting for first event" |
| 오류 | 422 ROLE_UPDATE_REQUIRED → "Stack v1.2 is outdated — update CloudFormation stack". 거절 → IngestRejection 최근 5건 |

## 동작 → API
| 동작 | API |
|---|---|
| 웹훅 목록 / 생성 | GET/POST `/customers/{id}/integrations` |
| 수정 / 삭제 | PATCH/DELETE `/integrations/{id}` |
| 토큰 회전 | POST `/integrations/{id}/rotate-token` |
| 계정 | GET/POST `/customers/{id}/accounts`, PATCH `/accounts/{id}` |
| 연결 점검 / 상태 | POST `/accounts/{id}/check` → GET `/accounts/{id}/status` |

## 미결
- 고객사 횡단 연동 목록 엔드포인트 없음(Settings › Integrations용)
- IngestRejection 조회 엔드포인트 없음
