# 보안 검토 기록: feat/infra-d43 (고객 연결 스택, 중앙 버스, 배포 점검)

항목별 반영/보류.

| 항목 | 내용 | 처리 | 근거 |
|---|---|---|---|
| 차단 1 | AlarmWriter 템플릿과 엔진 불일치 (엔진은 태그 없이 생성 후 `TagResource`로 `ManagedBy`) | 반영(템플릿). **엔진 변경 필요(backend)** | 생성은 `PutMetricAlarm` 한 번에 `Tags`로 `ManagedBy=AlarmOps`(`aws:RequestTag`)만 허용. 갱신·`TagResource`·`UntagResource`·`DeleteAlarms`는 `aws:ResourceTag/ManagedBy=AlarmOps`일 때만. `TagResource`/`UntagResource`는 `aws:TagKeys`에 `ManagedBy`가 있으면 Deny. 기존 알람에 `ManagedBy`를 붙이는 권한 삭제. 엔진이 해야 할 일은 `infra/customer-stack/README.md` 마지막 절 |
| 차단 1 (Resource 좁히기) | `alarm:AlarmOps-*`로 제한 | 보류 | 엔진 알람 이름은 `[{resourceType}] ...`로 시작해 고정 접두사가 없다(`naming.alarm_name`). `alarm:*` 유지, 소유는 태그로 판정 |
| 차단 1 (미확인) | 태그를 실어 만드는 `PutMetricAlarm`이 `cloudwatch:TagResource`도 요구하는지 | 보류(개발 계정 실측 필요) | 요구하면 생성이 거부된다. 그때의 대안은 태그 없는 고객 알람에 `ManagedBy`를 붙일 수 있는 구멍이라 사용자 결정이 필요하다 |
| 차단 2 | `ParameterValue=$NEXT`가 쉼표에서 깨짐 | 반영 | `bus-allowlist.mjs`가 `PARAMS_FILE`에 JSON을 쓰고 워크플로가 `--parameters file://`로 전달. 계정 3개 테스트 추가 |
| 권고 2 | TagWriter 값 제한, Remediator 호출자 분리 | 반영 | `aws:RequestTag/Monitoring=on` 추가. `RemediatorCallerRoleArn` 파라미터(활성 시 필수, Rules로 강제). README에 TagWriter+Remediator 동시 사용 주의와 ELB 삭제 방지 안내 |
| 권고 3 | Reader에서 Lambda 목록 제거 | 반영 | `lambda:ListFunctions`·`ListTags` 삭제. 발견은 `tag:GetResources`/`cloudwatch:ListMetrics`. 태그 없는 Lambda는 발견되지 않는 한계 |
| 권고 4 | 버스 정책에 source/detail-type 조건, ingest 규칙 | 반영(정책, 문서). ingest 테스트는 별도 이슈 | `events:source` `aws.*`, `events:detail-type` 두 값. 최상위 `account`만 신뢰 |
| 권고 5 | `if: github.ref == refs/heads/main`, OIDC sub, SHA 고정 | 일부 반영 | `if`와 sub 문서화 반영. SHA 고정은 보류: 저장소에 복사할 실제 SHA가 없어 TODO 표시(지어내지 않음) |
| 권고 6 | 버스 이름 하드코딩 | 반영 | 스택 출력 `BusName`에서 읽음 |
| 권고 7 | env 점검 파서 | 반영 | `KEY = v`, `KEY: v`, `export` 허용. `CONSOLE_ORIGIN`의 빈 `?`·`#` 거부. 테스트 추가 |
| 참고 | pg 테스트 단계 `pipefail`, cfn-lint 버전 | 반영 | `set -o pipefail`, `cfn-lint==1.60.1` |
| 추가 | 알람 명령 큐 | 반영 | `infra/aws/alarm-commands-queue.yaml`: 표준 큐, SSE, DLQ+알람, 송신/수신 역할 분리, `aws:SecureTransport` Deny |

## 남은 위험
- 엔진이 위 규칙에 맞게 바뀌기 전에는 AlarmWriter 템플릿으로 알람을 만들 수 없다(기존 방식은 태그 없는 생성이라 거부됨).
- IAM만으로는 같은 이름의 고객 알람 덮어쓰기와 `DeleteAlarms`의 태그 조건 지원 여부를 보장하지 못한다(후자는 AWS 문서로 확인 안 됨). 엔진의 사전 확인이 방어선.
- EventForwarder 역할은 ExternalId 대신 `aws:SourceAccount`/`aws:SourceArn`으로 고정(D-07 문자 그대로가 아님, 사용자 확인 대기).
