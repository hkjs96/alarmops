# 알람 생성·동기화·드리프트·재생성 규칙

상태: 초안

- 출처: AAM `aws-alert-manager` 커밋 `4eafce9`, 읽기 전용 추출. 경로는 저장소 루트 기준.
- 관련 결정: D-05(재설계 없이 이식), D-07(역할 분리·ExternalId), D-08(태그 읽기 전용, 콘솔 값은 알람에 저장).
- **(추정)** = 코드로 직접 확인하지 못한 판단.

## 1. 알람 이름과 메타데이터

1. 이름 형식: `[{타입}] {label} {표시지표} {방향} {임계치}{단위} (TagName: {short_id})`. label은 `Name` 태그, 없으면 리소스 ID. 임계치는 정수면 소수점 없이. 255자 초과 시 label → 지표명 순으로 `...` 축약, `(TagName: …)`는 축약하지 않는다.
   - 근거: `backend/common/alarm_naming.py:92-168`, `docs/ALARM-RULES.md` §6.
2. ALB/NLB/TG는 이름에 short ID(`{name}/{hash}`), 설명 메타데이터에는 Full ARN.
   - 근거: `alarm_naming.py:43`(`_shorten_elb_resource_id`), `docs/ALARM-RULES.md` §6.
3. **이름에 임계치가 들어가므로 임계치 변경 = 알람 삭제 후 재생성**(이름이 바뀜). 상태·이력이 초기화된다.
   - 근거: `_recreate_alarm_by_name` `backend/common/alarm_builder.py:555-627`.
4. `AlarmDescription` = `{사람용 접두어} | {"metric_key","resource_id","resource_type","severity"}` JSON. 1024자 제한은 **접두어를 잘라** 맞춘다(JSON이 깨지면 관리 대상에서 빠짐).
   - 근거: `_build_alarm_description` `alarm_naming.py:169-199`.
5. **우리 알람 판정은 메타데이터로만**. 메타데이터 없으면 이름이 우리 형식이어도 우리 것이 아니다. 예외: 알람을 바꾸지 않는 알림 라우팅만 이름 폴백 허용(`allow_name_fallback=True`).
   - 근거: `backend/common/alarm_identity.py:80-115`, 커밋 `f376969`(2026-10-19: 고객 알람 32개가 공백 하나 차이로 우리 형식과 비슷했음).
6. 레거시 이름 `{resource_id}-{metric}-{env}`는 삭제 호환용으로만 남음.
   - 근거: `alarm_naming.py:38-40`.

## 2. 알람 태그 (ManagedBy, Severity)

1. 생성 직후 `tag_resource`로 `Severity={SEV}`, `ManagedBy=AlarmManager`를 단다. 실패해도 생성은 성공 처리(경고 로그).
   - 근거: `_tag_alarm_with_severity` `alarm_builder.py:95-129`.
2. ARN은 조립(STS 계정 ID 캐시)해서 쓰되, 실패하면 **알람을 만든 그 클라이언트로** 실제 ARN을 조회해 재시도. 고객 계정 알람에 중앙 계정 ID ARN이 조립돼 ManagedBy 없이 남는 버그 수정.
   - 근거: 같은 함수 docstring, 커밋 `1a1080b`(2026-09-23, AP-18).
3. 재생성 경로도 반드시 다시 태그한다.
   - 근거: `alarm_builder.py:736-739`, 커밋 `bc4d1ab`(2026-06-08).
4. 고객 계정 역할의 `DeleteAlarms`는 `aws:ResourceTag/ManagedBy=AlarmManager` 조건 — 우리 태그 없는 알람은 못 지운다. 중앙 계정에는 이 가드가 없다.
   - 근거: `infrastructure/customer-onboarding/template.yaml:88-99`, 커밋 `a9217be`(2026-09-22).
5. 알람 액션 SNS는 알람과 **같은 리전** 토픽일 때만 넣고, 아니면 비운다(CloudWatch가 타 리전 SNS 거부). 고객 계정 알람은 EventBridge 포워딩으로 중앙에 온다.
   - 근거: `_same_region_topic` `alarm_builder.py:53-62`(2026-10-12).

## 3. Severity 정본과 수동 등급 우선

1. 관리(목록·필터·수정)의 정본은 **알람 Severity 태그**. 알림 파이프라인은 이벤트에 태그가 실리지 않으므로 **설명 JSON의 severity**를 읽는다. 두 값은 항상 같아야 한다.
   - 근거: `docs/ALARM-RULES.md` §13-4, 커밋 `acd5844`, `0537f59`(2026-09-08).
2. 태그를 바꾸는 모든 경로(커스텀 알람 생성, 등급 변경 PUT)는 `set_description_severity()`로 설명도 바꾼다.
   - 근거: `alarm_naming.py:202-236`, 리뷰 F1.
3. 설명 severity가 `SEV-1`~`SEV-5` 밖이면 무시(`is_valid_severity`). 설명은 PutMetricAlarm 권한이 있으면 누구나 고칠 수 있으므로 신뢰하지 않는다.
   - 근거: `backend/common/alarm_registry.py:336-338`, `alarm_identity.py:44-46`.
4. **재생성 시 수동 등급 보존(F8)**: 지우기 전에 Severity 태그를 읽어, 레지스트리 기본값과 다를 때만 `{metric_key: severity}`로 보존하고 새 알람의 태그·설명에 쓴다. 전체 재생성(`create_alarms_for_resource`), 이름별 재생성, 동적 드리프트 재생성 세 경로 모두.
   - 근거: `_severity_overrides` `alarm_builder.py:165-186`, `alarm_builder.py:587-589`, `backend/common/alarm_manager.py:210-215`, `backend/common/alarm_sync.py:357`. 커밋 `6f76ffe`(2026-09-08, 사용자 결정 "수동 등급이 기본값을 이긴다").
5. 레지스트리 기본값이 나중에 바뀌어도 기존 알람은 생성 시점 등급 유지(설명에 박힘). SEV-1 억제 면제가 이 값에 걸린다.

## 4. 생성 (`create_alarms_for_resource`)

`backend/common/alarm_manager.py:182-245`
1. 글로벌 타입은 us-east-1 클라이언트.
2. 기존 알람이 있으면 수동 등급을 읽어 둔 뒤 **리소스 알람 전부 삭제** 후 다시 만든다.
3. 정의별: 디스크(`dynamic_dimensions`)는 경로별 생성(CWAgent 지표 없으면 건너뜀), 나머지는 `off`면 건너뛰고 표준 생성.
4. 이어서 동적 알람(`Threshold_*` 비하드코딩 지표) 생성 — period 300, notBreaching, 등급 정책 M/N(추정: `alarm_builder.py:335-420`).
5. `DatapointsToAlarm`은 정의에 값이 있을 때만 넘긴다. 이 함수와 동기화 비교 필드(`_CONFIG_FIELDS`)는 같은 필드를 다뤄야 한다 — 어긋나면 무한 재생성.
   - 근거: `_optional_alarm_params` `alarm_builder.py:70-82`.

## 5. 동기화 (`sync_alarms_for_resource`)와 드리프트

`backend/common/alarm_manager.py:259-330`, `backend/common/alarm_sync.py`
1. 기존 알람 조회는 daily에선 인메모리 `AlarmIndex`, 아니면 리소스 prefix 검색(풀스캔 금지, AP-4). 글로벌 타입은 인덱스 대신 라이브 조회. 쓰기는 항상 라이브 API.
2. 기존 알람이 없으면 → 전체 생성. 정의가 없는데 알람이 있으면 → 전부 삭제.
3. 표준 지표(`_sync_standard_alarms` `alarm_sync.py:224-266`):
   - `off`면 건너뜀(삭제는 6항).
   - 알람 없음 → `created`(단건 생성).
   - 임계치 차이 > 0.001(CloudWatch 단위 비교) → `updated`(이름별 재생성).
   - 설정 드리프트 → `updated`. 비교 필드: `Statistic, Period, EvaluationPeriods, ComparisonOperator, TreatMissingData(기본 notBreaching), DatapointsToAlarm`. 정의에 없는 필드(None)는 비교 안 함. Namespace/MetricName/Dimensions는 정체성이라 비교 안 함.
     - 근거: `_CONFIG_FIELDS` `alarm_sync.py:56-63`, `_config_drift` `:66-81`.
   - 맞으면 `ok`. 단 설명에 severity가 없으면(옛 형식) `refreshed`.
4. **설명 갱신(F3)**: `refreshed` 알람은 재생성 없이 제자리 `put_metric_alarm`으로 설명만 고친다(기존 필드 복사, 상태 유지, 태그 미변경). 값은 Severity 태그 우선, 없으면 레지스트리. 두 번째 호출은 no-op.
   - 근거: `_refresh_alarm_description` `alarm_sync.py:110-148`, 커밋 `0537f59`.
5. 디스크(`_sync_disk_alarms` `alarm_sync.py:151-221`): 디스크 알람이 없고 **CWAgent 디스크 지표도 없으면 변경 없음**. 지표가 있는데 경로 알람이 빠졌으면 전체 재생성. 경로별 임계치·설정 드리프트는 이름별 재생성. 디스크 지표 조회는 **넘겨받은 고객 계정 클라이언트**로.
   - 근거: 커밋 `fc36fb5`, `d933d13`(2026-09-23: 매 동기화마다 EC2 알람 전체 삭제·재생성되던 버그).
6. `off` 처리(`_sync_off_hardcoded` `alarm_sync.py:269-303`): `Threshold_{키}=off`이고 알람이 있으면 삭제, 결과 목록에서 제거 후 `deleted`.
7. 동적(`_sync_dynamic_alarms` `alarm_sync.py:306-376`): 태그엔 있고 알람 없음 → 생성. 알람엔 있고 태그 없음 → 삭제. 임계치 또는 EvaluationPeriods/DatapointsToAlarm(미설정이면 EP와 같다고 봄) 드리프트 → 수동 등급 보존 후 삭제·재생성.
8. 적용(`_apply_sync_changes` `alarm_sync.py:379-402`): 디스크 생성 필요 또는 기존 알람 0개 → 전체 재생성. 그 외 `updated`는 이름별 재생성, `created`는 단건 생성.
9. 이름별 재생성은 **삭제 전에 정의를 확보**한다(정의 못 찾으면 삭제하지 않고 건너뜀 — 알람 영구 소실 방지). 디스크는 기존 Dimensions 재사용.
   - 근거: `alarm_builder.py:592-606`.

## 6. 언제 동기화가 도는가

1. **Daily run**(`backend/daily_monitor/lambda_handler.py`): 계정·리전 순회 → 고아 정리 → 수집기 나열(Monitoring=on) → 리소스별 알람 sync + 메트릭 점검(임계치 초과 시 자체 알림, 방향은 표시명의 `<`로 판정 `:1278-1286`). 고객사 기본값은 계정 세션 전환 전에 읽어 둔다(`:360-375`).
2. **시간별 태그 정합 런** `mode=tag_reconcile`: daily에서 메트릭·알림·런 히스토리를 뺀 것(인벤토리 동기화 → 고아 정리 → 나열 → sync).
   - 근거: `lambda_handler.py:523-619`, `docs/specs/monitoring-tag-contract/design.md` D2. 배포 후 동기화도 이 모드(커밋 `06b6bc6`).
3. **고아 정리**(`_cleanup_orphan_alarms` `lambda_handler.py:1193-1246`): 모든 MetricAlarm 중 메타데이터로 우리 것인 알람을 타입별로 묶어, 수집기 `resolve_alive_ids`로 없는 리소스면 삭제, 있으면 태그를 Full ID로 읽어 `Monitoring=on`이 아니면 삭제. **태그를 못 읽으면 지우지 않는다**(`:1249-1257`). 100개씩 `delete_alarms`.
   - 근거: 커밋 `10e6444`(2026-05-21, 태그 제거 시 알람 삭제), `69c8b64`(ACM Full ID로 태그 읽기), `f376969`(고객 알람 보호).
4. **CloudTrail 즉시 반영**(`backend/remediation_handler/lambda_handler.py`) — EC2·RDS·ALB·SQS 4타입만 TAG_CHANGE(나머지는 시간별 정합 런):
   - CREATE: 태그 조회 후 `Monitoring=on`이면 생성(`:1038-1068`).
   - DELETE: 태그 확인 없이 알람 삭제 시도 + 감시 대상이었으면 lifecycle 알림. RDS/Aurora 타입 판정 실패 시 양쪽 prefix 삭제(KI-008) (`:964-1035`).
   - TAG_CHANGE: Monitoring 추가 `on` → 생성, 다른 값/제거 → 삭제 + `MONITORING_REMOVED` 알림. Threshold만 바뀌면 감시 중일 때 sync. 제거 이벤트는 명시 목록(`DeleteTags, RemoveTagsFromResource, RemoveTags, UntagQueue, UntagResource`), 나머지는 추가로 본다(`:1088-1204`).
   - **MODIFY: `Monitoring=on` 리소스에 대해 Auto-Remediation — EC2/RDS/Aurora/DocDB `stop`, ALB/NLB `delete_load_balancer`** (`:777-953`). 기본 Lambda 세션(`boto3.client`)으로 실행(추정: 중앙 계정 리소스만 대상).
   - 이 경로들은 고객사 기본값을 적용하지 않는다(`customer_thresholds` 미사용) → 다음 정합 런에서 임계치가 바뀌어 재생성될 수 있다(추정, 잠재 버그).

## 7. 2026-11-02~11-04 임계치·M/N 변경

1. `30ac2b6`(11-02): 고객 역할 태깅 조건을 `Monitoring`만 → `Monitoring` + `Threshold_*`(StringLike)로 넓히고 Untag 액션도 같은 조건으로 허용. 기존 고객은 스택 업데이트 필요.
   - 근거: `infrastructure/customer-onboarding/template.yaml:158-230`.
2. `60d2138`(11-03): 콘솔 단건·벌크 임계치/M/N 편집. 값은 고객 리소스 태그 `Threshold_{지표}=값|off`, `Threshold_{지표}_Eval=M/N`. 값을 지우면 태그 삭제 → 고객 기본값으로 복귀. 쓰기는 고객 계정 역할 세션, 쓴 뒤 즉시 sync. 역할이 옛 버전이면 403 `ROLE_UPDATE_REQUIRED`. 벌크는 값→영향 미리보기→3개씩 적용·실패 재시도.
   - 근거: `backend/api_handler/routes/resource_thresholds.py:51-92, 130-177, 224-260`, `docs/specs/bulk-alarm-config/design.md`.
3. `e9c6f6a`, `ab00be1`(11-04): 고객 기본값 변경이 닿는 리소스와 값 출처(resource/customer/system) 미리보기(`customer_thresholds.source_of`).

## 과거 수정 사례

| 날짜 | 커밋 | 내용 |
|---|---|---|
| 2026-05-21 | `10e6444` | Monitoring 태그 제거 시에도 알람 삭제(리소스 삭제 때만 지우던 것) |
| 2026-06-08 | `bc4d1ab` | 임계치 변경 재생성 시 ManagedBy 태그 누락 |
| 2026-08-25 | `7143c72` | 알람 정체성 결함, EC2 페이지네이션, 등급 |
| 2026-09-08 | `0537f59` | **F3** 동기화가 설명 드리프트를 안 봐 옛 알람에 severity가 영영 없던 문제 → 제자리 설명 갱신. **F9** 등급 변경 라우트가 ARN을 마지막 콜론으로 잘라(`(TagName: …)`의 콜론) TagResource가 조용히 실패 → `:alarm:` 구분자로 자름. 단위 테스트가 mock ARN만 봐서 통과했었음 |
| 2026-09-08 | `6f76ffe` | **F8** 재생성 경로가 수동 Severity를 기본값으로 되돌림 → 지우기 전 보존 |
| 2026-09-22 | `a9217be` | 고객 역할은 ManagedBy 태그 알람만 삭제 |
| 2026-09-23 | `1a1080b` | 교차 계정 알람이 ManagedBy 없이 생성(잘못 조립한 ARN) |
| 2026-09-23 | `fc36fb5`, `d933d13` | 디스크 지표 없는 EC2가 동기화마다 전체 재생성 / 중앙 계정에서 디스크 지표를 찾던 원인 |
| 2026-09-23 | `358aff4` | 토글이 리소스의 실제 태그로 알람 생성 |
| 2026-10-12 | `7df32c7`, `715a5b2` | 벌크·워커가 Lambda 리전이 아닌 리소스 리전에 알람 생성/삭제. 서울 리소스가 us-east-1로 표시돼 재생성 실패 |
| 2026-10-19 | `f376969` | 메타데이터 없는 알람은 우리 것 아님(고객 알람 오인 삭제 방지) |
| 2026-10-26 | `a791edc` | 고객 기본값이 실제 알람에 반영 |
| 2026-11-03 | `60d2138` | 이전 인라인 저장이 중앙 자격증명으로 알람만 쓰고 EC2만 태깅 → 시간별 정합 런이 되돌림 |

## 새 구현에서 바꿀 점

### D-05 (그대로 이식)
1. 이름 형식, 메타데이터 JSON, 메타데이터 기반 소유 판정, `_CONFIG_FIELDS` ↔ 생성 파라미터 일치, 삭제 전 정의 확보, 수동 등급 보존, 디스크 지표 없음 = 변경 없음, 태그 못 읽으면 삭제 안 함 — 위 과거 사례마다 회귀 테스트를 옮긴다.

### D-07 (역할 분리, ExternalId)
2. 현재 고객 역할은 **하나**(`MonitoringRole`)에 읽기·알람 쓰기·태그 쓰기가 모두 있고, 신뢰 정책이 `arn:aws:iam::{Central}:root` 전체이며 **ExternalId 없음**(`template.yaml:56-67`, 중앙 assume_role이 ExternalId를 안 넘긴다고 주석). → Reader / EventForwarder(기존 `AlertForwardRole` 대응) / AlarmWriter(선택)로 분리, ExternalId 필수, 특정 중앙 역할 ARN만 신뢰.
3. **TagWriter 없음**: 현재 태그 쓰기 statement(`tag:TagResources/UntagResources`, 서비스별 태깅 19개, 조건 없는 `s3:PutBucketTagging`·`route53:ChangeTagsForResource`, `template.yaml:158-230`)를 전부 제거. 그 결과 **콘솔 Monitoring 토글이 태그를 쓸 수 없다** → 감시 의도 저장 위치를 새로 정해야 함(결정 필요: 고객이 IaC로 태그 / 중앙 DB 의도 + 우리 알람). monitoring-tag-contract의 "태그가 의도" 원칙과 충돌.
4. AlarmWriter 권한: `PutMetricAlarm`, `TagResource`(알람), `DeleteAlarms`(ManagedBy 조건 유지). AlarmWriter가 없는 고객은 알람 생성·동기화·고아 정리를 건너뛰고 읽기만(모드 표시 필요).
5. Auto-Remediation(MODIFY 시 EC2/RDS stop, ELB 삭제)은 쓰기 권한이 큰 동작이라 역할 목록에 없다 → 이식 대상에서 제외하거나 별도 결정(추정: PoC 범위 밖).
6. 중앙 계정 알람에는 ManagedBy 삭제 가드가 없으므로, 소유 판정(메타데이터)이 유일한 방어선 — 유지.

### D-08 (태그 읽기 전용, 콘솔 값은 알람에 저장)
7. 현재 `resource_thresholds.py`의 `_write_tags`(`:224-233`)가 고객 리소스에 `Threshold_*`·`_Eval`를 쓰고 지운다 → 제거. 콘솔 값은 **우리 알람**에 저장(알람 태그 예: `Override_Threshold`, `Override_Eval`, 또는 설명 JSON 필드 — 형식 결정 필요. 설명은 누구나 고칠 수 있어 신뢰 문제, 태그는 알람당 50개 제한).
8. 임계치 변경은 이름이 바뀌어 재생성되므로, 재생성 전에 콘솔 값을 읽어 새 알람에 다시 쓴다(`_severity_overrides`와 같은 패턴을 일반화). 리소스 전체 재생성 경로(`create_alarms_for_resource`)도 포함. 알람이 삭제되면 값이 유실 → 중앙 DB 변경 기록에서 복구할 수 있게(추정: D-08의 "중앙 DB는 변경 기록" 의도).
9. 동기화 드리프트 기준이 "태그 > 콘솔(알람) > 고객 기본값 > 기본값"으로 해석한 기대값이 되도록 해석기 교체. 리소스 태그가 생기면 콘솔 값보다 우선하므로 콘솔에 "태그가 이김" 표시 필요.
10. `30ac2b6`의 `Threshold_*` 태깅 권한 확장은 되돌린다(D-07의 TagWriter 없음과 동일).
11. CloudTrail 경로(remediation_handler)도 같은 해석기를 써서 고객 기본값·콘솔 값이 빠지지 않게(현재 누락, 6절 4 추정 버그).
