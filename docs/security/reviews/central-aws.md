# 보안 검토 기록: feat/central-aws (중앙 AWS 배포 묶음, #47)

대상: 커밋 `d7ffe22`와 이를 고친 후속 커밋. 항목별 반영/보류.

| 항목 | 내용 | 처리 | 근거 |
|---|---|---|---|
| 차단 | `ci.yml`이 YAML로 파싱되지 않음(infra 작업에서 cfn-lint 실행 줄과 "Template structure tests" 단계가 한 줄로 붙음) | 반영 | 단계를 둘로 나눔. `infra/test`에 `.github/workflows/*.yml` 전부가 파싱되고 `jobs`를 갖는지 보는 테스트(`Workflows`) 추가. 검증: 모든 워크플로 파일에 `yaml.safe_load` 통과 |
| 권고 1 | 중앙 역할 `AssumeRole`에 ExternalId 없이 맡을 수 있음 | 반영 | 중앙 역할의 `AssumeCustomerRoles`와 RemediatorCaller 역할의 `AlarmOps-Remediator` 맡기에 `Null sts:ExternalId = "false"` 조건. 값 검사는 고객 쪽. 테스트 `test_external_id_required_on_every_assume_of_a_customer_role` |
| 권고 2 | D-15 기본 false를 IAM이 강제하지 않음 | 반영 | 중앙 역할의 `AssumeRemediatorCaller` 문과 엔진 환경 변수 `REMEDIATOR_CALLER_ROLE_ARN`을 `RemediationEnabled`(`RemediationExecution == "true"`) 조건 안으로. README에 "Remediator Deny는 가드레일, 승인은 코드가 강제"를 명시. 테스트 `test_remediation_switch_is_enforced_by_iam_and_env` |
| 권고 3 | 중앙 역할과 엔진 실행 역할 합침 | 반영(문서), PoC 동안 유지 | GO-LIVE 4단계에 중앙 계정에는 다른 Lambda를 두지 않고 `iam:PassRole` 대상을 배포 역할로 한정, 개발 계정에서 Lambda 신뢰의 `aws:SourceAccount` 동작 확인을 적었다. 분리(두 단계 맡기)는 backend 변경이 필요해 보류 |
| 권고 4 | `TagEventRule` 패턴이 넓음 | 반영 | `detail.eventSource` 접미사 `.amazonaws.com`, `detail.eventName`은 엔진 `events.py`의 `TAG_EVENTS` 12개(고객 `TagChangeRule`과 같은 목록), `detail.errorCode` 없음. 서비스별 `eventSource` 목록은 빠뜨리면 이벤트가 조용히 사라지므로 열거하지 않고 접미사로 두었다(이름 목록이 실질 제한). 테스트 `test_tag_rule_matches_only_engine_tag_apis_and_successful_calls` |
| 권고 5 | `CommandsDlq`·`AlertEventsDlq`에 큐 정책 없음 | 반영 | 두 DLQ에 `DenyInsecureTransport`. `alarm-commands` DLQ는 수신·삭제·가시성 변경을 중앙 역할과 선택 파라미터 `DlqOpsRoleArn`만(`ArnNotEquals` Deny). SQS의 DLQ 이동(redrive)은 서비스가 하므로 영향 없음. 테스트 `test_dlq_policies` |
| 권고 6 | 수집 EventBridge 규칙의 SAM 자동 DLQ | 반영 | SAM `EventBridgeRule` 이벤트를 명시적 규칙 `IngestAlarmEventsRule` + `AWS::Lambda::Permission`(SourceArn=규칙)으로 바꾸고, SSE 큐 `IngestEventsRuleDlq`에 그 규칙 ARN 하나만 허용하는 정책 + TLS Deny + DLQ 알람. 테스트 `test_ingest_rule_has_own_sse_dlq_with_one_rule_policy` |
| 권고 7 | `alert-events` 큐 정책이 TLS Deny뿐 | 반영 | 송신은 웹훅·EventBridge·소비자 함수 역할(`!GetAtt <Fn>Role.Arn`)만, 수신·삭제는 소비자 역할만, 그 밖은 `ArnNotEquals` Deny. SAM이 소비자에 붙이는 SQS 이벤트 소스 권한(SQSPollerPolicy)은 큐 이름 한정. `cfn-lint`와 `sam validate --lint`가 `<Fn>Role` 참조를 해석함. 테스트 `test_alert_events_policy_producers_and_consumer_only` |
| 권고 8 | 배포가 바로 실행되어 IAM 변경을 사람이 보지 못함 | 반영 | `deploy-central.yml`을 `plan`(`sam deploy --no-execute-changeset`, IAM 변경을 요약 맨 위에 출력) → `apply`(`execute-change-set`을 변경 세트 ID로) 두 작업으로 나누고 둘 다 `central` 환경 승인과 `main` 조건. 배포 역할은 `AlarmOpsCentral-*` 이름 범위 + `PassRole` 조건 + 권한 경계가 필수라고 README·GO-LIVE에 적었다(정책 자체는 사람이 만든다). 테스트 `test_two_phase_plan_then_approved_apply` |
| 권고 9 | `uses:` 커밋 SHA 고정 | 보류(TODO 유지), 일부 반영 | 저장소·잠금 파일 어디에도 실제 SHA가 없어 지어내지 않는다. `actions/checkout`에 `persist-credentials: false` 추가(테스트 `test_checkout_does_not_persist_credentials`) |
| 권고 10 | 배포 변수가 저장소 수준 | 반영 | 워크플로·README·GO-LIVE가 `central` **환경** 변수를 쓰도록 안내(환경 규칙을 통과한 작업만 읽음). 필수 변수 누락이면 `plan`이 바로 실패한다. 선택 변수 `DLQ_OPS_ROLE_ARN`, `REMEDIATION_EXECUTION` 추가 |
| 참고 | DLQ 재처리 break-glass, Lambda 계정 동시성(예약 합계 40), `ses:Recipients` | 반영(문서) | GO-LIVE 4단계: `DLQ_OPS_ROLE_ARN`을 넣고 반영 → 재처리 → 제거. 한도 140 이상 확인. `ses:Recipients` 조건은 검토 항목으로 기록 |

## 남은 위험

- 중앙 역할 = 엔진 실행 역할 합침(PoC). 엔진 코드가 침해되면 고객 신뢰 신원과 DB 비밀·큐를 함께 쥔다.
- 배포 역할 정책·권한 경계는 사람이 만든다. 저장소는 요구 사항만 적었고 검증하지 못한다.
- `uses:` SHA 미고정(TODO 유지).
- 고객이 허용 목록 계정에서 `aws.*` 이벤트로 위장해 큐에 넣을 수 있는 것은 이제 12개 태그 API 이름의 성공 호출 모양뿐이고, 엔진이 최상위 `account`와 허용 계정 여부를 다시 확인한다.
- Remediation 두 단계 맡기는 backend 구현 전까지 동작하지 않는다(기본 꺼짐이라 안전한 쪽).
