# 보안 검토 — feat/d43-inactive-customers (D-43, 이슈 #19)

- 대상: 커밋 `5bad34f`(마이그레이션 0004, 수집·틱·`OFFBOARD_ACCOUNT`) 및 이를 고친 후속 커밋.
- 범위: 상태 API(`PATCH /customers/{id}/status`, `/offboarding`)는 이 변경에 **포함되지 않았다**. 그 부분은 구현할 때 따로 검토한다.
- 테스트: 코어·ingest·store-sql·엔진 테스트와 타입·린트 통과(후속 커밋 메시지 참고).

## 결론

- **[차단] 0건.**
- 아래 [권고] 5건과 [참고] 1건을 후속 커밋에서 반영했다.

## 항목

| # | 구분 | 내용 | 상태 |
|---|---|---|---|
| 1 | 권고 | EventBridge 핫패스의 `customerStatus` 조회가 느리거나 실패하면 ACTIVE 이벤트까지 실패해 재시도·DLQ로 가고 호출이 유실될 수 있다 | **반영** — 조회 실패는 TERMINATED 아님으로 보고 큐에 넣는다. `customer_status_lookup_failed` 경고 로그와 `IngestStatusLookupFailed` 지표를 남긴다. 실제 관문은 틱과 발송 직전 재확인이다. 테스트로 고정 |
| 2 | 권고 | TERMINATED 이벤트마다 같은 행에 SELECT + UPSERT가 반복된다 | **반영(부분)** — TERMINATED만 인스턴스별 45초 캐시한다(해지는 되돌리지 않으므로 오래된 "예"가 틀릴 수 없다). ACTIVE·SUSPENDED는 매번 읽는다. UPSERT는 이벤트마다 그대로 둔다(묶기는 **보류**: 건수가 적고 단순함을 우선) |
| 3 | 권고 | 틱 안에서 `statusOf`를 캐시해 발송 직전 재확인이 그룹 단계에서 읽은 값을 쓸 수 있다 | **반영** — `sendOne`은 캐시를 쓰지 않고 잡마다 `repo.customerStatus`를 새로 읽는다(잡 50건당 PK 조회) |
| 4 | 권고 | `OFFBOARD_ACCOUNT`가 REFUSED면 흔적 없이 단계가 PENDING으로 남는다 | **반영** — 해지 행이 그 고객 것일 때만 `record_offboard_result`로 `REFUSED`와 사유를 `ALARMS_DELETED.detail`에 남기고 MANUAL로 한다. 테스트로 고정 |
| 5 | 권고 | OFFBOARD에서 `KeyError`까지 "없음"으로 삼켜 내부 버그가 조용히 버려진다 | **반영** — 해지 행 없음(`TargetNotFound`)만 poison. 그 밖의 `KeyError`·`LookupError`는 재시도·DLQ로 간다. 테스트로 고정 |
| 6 | 참고 | 해지 고객의 조용한 인시던트도 `CUSTOMER_SUSPENDED`로 표시됨 | **반영** — `PagingSuppressedReason`에 `CUSTOMER_TERMINATED`를 추가(미병합 마이그레이션 0004 안에서). 틱이 열 때·발견할 때 상태에 맞는 값과 타임라인 문구를 쓴다 |

## 남은 위험

- 엔진의 Postgres 쓰기(`record_offboard_result`)는 로컬에 Postgres가 없어 실행해 보지 못했다. `ALARM_ENGINE_TEST_PG_URL`로 pg 테스트를 CI에서 돌려야 한다.
- 정지 중에 마킹된 인시던트는 `ACTIVE` 복귀 뒤에도 호출하지 않는다(의도). 정지·복귀가 틱 두 번 사이에 끝나면 마킹되지 않아 호출이 이어진다.
- 수동 "Escalate now"는 정지 고객에게도 잡을 만든다(발송 직전에 `SKIPPED_CUSTOMER_INACTIVE`로 닫힘).
