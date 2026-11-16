# 보안 검토 — feat/engine-collectors (이슈 #48, 수집기 29종·SYNC_ACCOUNT·CloudTrail 태그 이벤트)

- 대상: 커밋 `c4d57e4`(수집기·이벤트 처리)와 이를 고친 후속 커밋.
- 테스트: 엔진 pytest(Postgres 16 유무 모두)·ruff·mypy 통과.

## 결론

- **[차단] 0건.**
- 아래 항목 중 엔진 코드·README로 닫을 수 있는 것은 후속 커밋에서 **반영**했다. 인프라(CloudFormation·버스 규칙)가 필요한 것은 **보류 → infra**.

## 항목

| # | 내용 | 상태 |
|---|---|---|
| 1 | 이벤트로 계정을 찾을 때 `disabled` 계정·연결 정리(`connectionPurgedAt`)된 계정도 동기화 대상이 됨 | **반영** — `find_active_account_by_aws_id`가 고객 ACTIVE + `disabled = false` + `connectionPurgedAt IS NULL`을 요구한다(Postgres·메모리 저장소 모두). 테스트: pg(`test_find_active_account_requires_enabled_and_not_purged`), 메모리(`test_disabled_or_purged_accounts_get_no_event_sync`) |
| 3 | 이벤트 폭주: 태그 이벤트마다 계정 전체 `TAG_RECONCILE`가 돌 수 있음, 같은 리소스 이벤트 반복 | **반영** — (a) 계정에 최근 N분(기본 10, `TAG_EVENT_RECONCILE_DEBOUNCE_MINUTES`) 안에 시작한 AlarmSyncRun이 있으면 건너뜀(DB 조회라 Lambda 인스턴스 간에도 유효). (b) 같은 리소스 이벤트는 행의 `lastSeenAt` 기준 60초(`TAG_EVENT_RESOURCE_DEDUPE_SECONDS`) 안이면 버림(새 테이블·마이그레이션 없음, 건너뛴 변경은 시간별 TAG_RECONCILE가 메운다). (c) `detail.errorCode`가 있는 이벤트(실패한 호출)는 무시. (d) `source`가 `aws.`로 시작하지 않으면 무시. 테스트 4건 |
| 4 | 깊게 중첩된 JSON이 `RecursionError`로 핸들러를 죽이거나 SQS 재시도·DLQ 루프를 만듦 | **반영** — `json.loads`를 쓰는 두 곳(`parse`, 봉투 판별)이 `(ValueError, RecursionError)`를 poison으로 버린다. 이벤트 `_walk`는 반복형이며 깊이 12·노드 5000으로 제한. 테스트: 10만 단 중첩 본문, 5000단 중첩 요청 |
| 5 | 무한·반복 페이지 토큰으로 수집이 끝나지 않거나, 잘린 목록이 "리소스 없음"으로 읽힘 | **반영** — 모든 목록 호출(`pages`, CloudFront·Route53 마커 루프)이 최대 1000페이지와 반복 토큰 검출을 갖고, 넘으면 `PaginationError`를 **발생**시킨다(자르고 반환하지 않음). 그 타입은 오류로 기록되고 기존 행·알람은 건드리지 않는다. 테스트 3건 |
| 6 | MQ 수집이 `DescribeBroker`를 호출(사용자 목록 포함 응답) | **반영** — `mq:ListBrokers` 요약(`BrokerState`, `DeploymentMode`)만 쓴다. README의 Reader 요청에서 `mq:DescribeBroker` 제거, `mq:ListBrokers`로 교체 |
| 7 | README Reader 요청이 넓음(`apigateway:GET` 전체, 쓰이지 않는 삭제 감지용 권한) | **반영(README)** — apigateway는 `arn:${Partition}:apigateway:*::/restapis`·`/apis` 정확히 두 Resource로 좁히고 `/apikeys*`, `/usageplans/*/keys*`, `/restapis/*/*`는 명시적 Deny로 요청. `sagemaker:DescribeEndpoint`는 `endpoint/*`, `directconnect:DescribeConnections` 유지. 코드가 호출하지 않는 acm·backup·wafv2·efs 권한 요청은 삭제 |
| 8 | `typeErrors`에 오류 전문(ARN·계정 ID 포함 가능)이 AlarmSyncRun.counts로 저장됨 | **반영** — 저장은 AWS 오류 코드(또는 예외 클래스 이름)만. 전문은 서버 로그에만 남긴다. 테스트로 고정 |
| 9 | Reader 역할에 `apigateway:GET`(좁힘)·`mq:ListBrokers`·`sagemaker:DescribeEndpoint`·`directconnect:DescribeConnections` 추가 | **보류 → infra** — `infra/customer-stack/template.yaml`은 이 변경 범위 밖. README의 요청 표가 기준 |
| 10 | 중앙 버스 규칙이 TagChangeRule 이벤트를 `alarm-commands` 큐로 전달해야 함(큐 정책에서 EventBridge 허용, 봉투 최상위 `account`는 버스가 채움) | **보류 → infra** |

## 남은 위험

- 리소스별 중복 제거는 행의 `lastSeenAt`을 쓴다. 60초 안에 `Monitoring`을 제거했다가 다시 붙이면 두 번째 이벤트가 버려져 다음 시간별 TAG_RECONCILE까지 상태가 어긋날 수 있다(알람은 건드리지 않는 쪽이라 안전한 방향).
- 삭제 감지(`alive`)가 불가능한 타입(ACM·Backup·WAF·EFS·Lambda·APIGW·MQ·DX·SageMaker)은 삭제된 리소스의 알람이 남는다.
