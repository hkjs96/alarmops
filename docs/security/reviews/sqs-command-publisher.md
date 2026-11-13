# 보안 검토 — feat/sqs-command-publisher (SQS 명령 발행기, 이슈 #21)

- 대상: 커밋 `17eedc7`(`SqsCommandPublisher`, `commandPublisherFromEnv`, 계약 픽스처) 및 이를 고친 후속 커밋.
- 범위: `packages/api/src/sqsCommandPublisher.ts`, `@aws-sdk/client-sqs` 의존성, API-CONTRACT §6.
- 테스트: api·store-sql·core 테스트, 타입 검사, alarm-engine pytest·ruff·mypy 통과(후속 커밋 기준). AWS 호출은 모두 목.

## 결론

- [차단] 0건.
- [권고] 6건 중 5건 반영, 1건(큐 정책·IAM)은 infra로 넘김.

## 항목

| # | 구분 | 내용 | 상태 |
|---|---|---|---|
| 1 | 권고 | `client-sqs`가 `^3.1168.0`이고 잠금 파일에 두 버전(루트 3.693.0, `packages/api` 3.1168.0)이 있었다 | **반영** — `services/ingest`가 쓰는 `3.693.0`으로 정확히 고정해 한 벌로 합쳤다(`npm ls`에 deduped). 잠금 파일은 `npm install`로 다시 만들고 `npm ci`로 확인 |
| 2 | 권고 | 큐 URL의 계정 번호를 모양(12자리)만 검사했다 | **반영** — `ALARM_COMMANDS_QUEUE_URL`이 있으면 `ALARM_COMMANDS_EXPECTED_ACCOUNT`(12자리) 필수, URL 계정과 다르면 기동 시 예외. API-CONTRACT §6에 적었다. 테스트로 고정 |
| 3 | 권고 | `commandId`·`customerId` 문자 검사가 FIFO에서만 있었다 | **반영** — 표준·FIFO 모두 SQS ID 문자 규칙(1~128자)으로 검사 |
| 4 | 권고 | `type`을 런타임에서 확인하지 않았고 `JSON.stringify(cmd)`가 객체의 모든 속성을 내보냈다 | **반영** — 발행 가능 type 허용 목록(`OFFBOARD_ACCOUNT`)으로 거부, 본문은 허용 키만 직렬화. 추가 속성이 큐에 가지 않음을 테스트로 고정 |
| 5 | 권고 | 오류 클래스 이름(`causeName`)이 응답으로 새어 나갈 수 있다 | **반영** — `causeName`은 서버 로그용으로만 두고(주석), 호출자는 계정 ID 목록만 응답에 싣는다. `PATCH /customers/{id}/status` 응답 본문에 `AccessDenied`·큐 URL·`SEND_FAILED`가 없음을 테스트로 고정 |
| 6 | 권고 | 큐 정책(발행 주체 제한)·IAM 최소 권한 | **보류(infra)** — 콘솔 역할에 해당 큐 `sqs:SendMessage`만, 큐 정책으로 그 역할만 허용. `infra/` 이슈에서 처리 |

## 남은 위험

- 커밋과 발행이 원자적이지 않다(d43 검토와 같음). 복구는 같은 `TERMINATED` 요청 재전송이다.
- 표준/FIFO 확정(Q-API-15)과 콘솔 자격증명 방식(Q-API-03)은 미결이다.
- 실제 SQS 호출은 시험하지 않았다. dev 프로필에서 첫 발행을 확인해야 한다.
