# API 계약

상태: 4일차에 작성. 콘솔과 백엔드는 이 문서만 보고 따로 개발한다. 바꿀 때는 이 문서를 먼저 고친다.

## 경계
| 경로 | 호출자 | 받는 쪽 |
|---|---|---|
| 고객 EventBridge → 우리 이벤트 버스 | 고객 계정(EventForwarder) | `services/ingest` |
| `POST /ingest/{source}/{customerToken}` (웹훅) | 고객 Prometheus Alertmanager, Grafana | `services/ingest` (API Gateway) |
| SQS → 처리 함수 | `services/ingest` | Postgres 쓰기 |
| `POST /internal/tick` (1분) | pg_cron | 에스컬레이션·통지 |
| 콘솔 API (`/api/...`) | 콘솔 화면 | `apps/console` |
| Slack 인터랙티브, 확인 링크 `/ack/{signedToken}` | Slack, 알림톡·SMS·이메일 | `apps/console` |
| 알람 엔진 요청(생성·동기화) | 콘솔 설정 변경, 일일 동기화 | `services/alarm-engine` |

## 작성할 것
- 정규화된 알림 이벤트 스키마(소스 무관): source, customerId, fingerprint, severity, state, resource, metric, value, threshold, occurredAt, raw
- 인시던트·알림 조회와 Ack/Resolve/Escalate/Mute
- 온콜: 스케줄, 대체 근무, 에스컬레이션 정책 CRUD, "지금 당번" 조회
- 고객사·조직·계정·연동 소스 CRUD, 연결 상태 조회
- 임계치 조회(값과 출처)와 변경(미리보기 포함), 변경 기록 조회
- 오류 형식과 페이지네이션 규칙
