# API 계약

상태: 초안 (4일차). 콘솔과 백엔드는 이 문서만 보고 따로 개발한다. 바꿀 때는 이 문서를 먼저 고친다. 데이터 형태는 `docs/DATA-MODEL.md`를 따른다.

## 1. 경계 한눈에

```
고객 계정 EventBridge ──(EventForwarder, D-07)──▶ 중앙 이벤트 버스 ─▶ ingest-normalizer λ ─┐
Prometheus Alertmanager / Grafana ──HTTPS──▶ API Gateway ─▶ webhook-receiver λ ──────────┤
                                                                                          ▼
                                                                   SQS alert-events (+DLQ)
                                                                                          ▼
                                                              alert-consumer λ ─▶ Postgres(Prisma)
pg_cron(1분) ──HTTP──▶ POST /api/internal/tick (Vercel) ─▶ 그룹·인시던트·에스컬레이션·아웃박스
콘솔 화면 ──▶ /api/v1/* (Next.js route handler) ─▶ Postgres
콘솔 ──SQS send──▶ SQS alarm-commands (+DLQ) ─▶ alarm-engine λ ─▶ 고객 계정(Reader/AlarmWriter/TagWriter/Remediator)
Slack ──▶ POST /api/slack/interactive        문자·음성 업체 ──▶ POST /api/callbacks/{provider}
```

| # | 경로 | 호출자 → 받는 쪽 | 인증 | 근거 |
|---|---|---|---|---|
| B1 | EventBridge `CloudWatch Alarm State Change`, CloudTrail 태그·변경 이벤트 | 고객 계정 → 중앙 버스 → `services/ingest` | 버스 리소스 정책(고객 계정 ID 허용 목록) + EventForwarder 역할 | D-07, D-09 |
| B2 | `POST /ingest/v1/{source}` (`source` = `prometheus`·`grafana`) | 고객 Alertmanager/Grafana → API Gateway → `services/ingest` | 고객사 연동 토큰(§4) | D-06, org-tenant R5 |
| B3 | SQS `alert-events` | ingest λ → `alert-consumer` λ | IAM | D-09 |
| B4 | `POST /api/internal/tick` | pg_cron → `apps/console` | `Authorization: Bearer <TICK_SECRET>` | D-10, D-11 |
| B5 | `/api/v1/*` | 콘솔 화면 → `apps/console` | 세션 쿠키(Google SSO) | D-09 원칙 1 |
| B6 | `POST /api/slack/interactive` | Slack → `apps/console` | Slack 서명 | notification R6-1 |
| B7 | `GET /a/{signedToken}` (확인 링크) | 이메일·문자 수신자 → `apps/console` | HMAC 서명 토큰 | 기존 계약 |
| B8 | `POST /api/callbacks/{provider}` | 문자·음성 업체 → `apps/console` | 업체 서명/비밀(업체 미정) | D-11, notification 새 구현 2 |
| B9 | SQS `alarm-commands` | 콘솔·틱 → `services/alarm-engine` | IAM(콘솔 쪽 자격증명 방식 미결 Q-API-03) | D-05, D-08 |
| B10 | 알람 엔진 ↔ Postgres | `services/alarm-engine` → DB | DB 역할(엔진 전용 사용자) | §7 |

"큐는 SQS 하나"(D-09 원칙 2)는 큐 기술이 SQS 하나라는 뜻으로 읽고 큐 2개(+각 DLQ)를 둔다. 해석이 틀리면 Q-API-01에서 바로잡는다.

## 2. 공통 규칙

| 항목 | 규칙 |
|---|---|
| 기본 경로 | 콘솔 API `/api/v1`. 내부·외부 콜백은 버전 없음 |
| 형식 | JSON, UTF-8, 필드 camelCase, 시각 ISO-8601 UTC(`Z`) |
| 페이지네이션 | 커서 방식 `?limit=50&cursor=<opaque>`(limit 최대 200). 응답 `{ items, nextCursor }`. 정렬은 서버에서 한 뒤 자른다(known-bugs 9-1, 9-2) |
| 필터 | `?customerId=&status=&severity=` 등. 빈 파라미터는 무시(9-6) |
| 범위 필터 (D-33) | 범위가 있는 모든 목록은 slug 파라미터 `?customer=&project=&service=`와 `mine=1`을 같은 뜻으로 받는다(§8.0). `project`는 `customer`가, `service`는 `project`가 있어야 한다(없으면 400 `VALIDATION_FAILED`). slug 형식 `^[a-z0-9][a-z0-9-]{0,63}$`. **모르는 slug와 범위 밖 slug는 같은 404 `NOT_FOUND`, 같은 본문**(403 금지). slug 해석은 호출자 범위 안에서만 한다(범위 밖 고객을 먼저 찾고 나서 거부하는 순서 금지 — 응답 시간 차이). 기존 `customerId`는 그대로 받는다. `mine=1`은 서버가 **세션 사용자**로 계산한다(클라이언트가 보낸 사용자·연락처 id를 받지 않는다). `customer`와 함께 오면 `customer`가 이긴다 |
| 조회 경로의 404 (D-33, security R-1·R-5) | **조회(GET) 경로에서 범위 밖은 언제나 404이고 403을 쓰지 않는다**: 단건(`/incidents/{id}`와 하위 `/timeline`·`/notifications`, `/resources/{id}`, `/contacts/{id}` 등), 범위 필터가 붙은 목록, `/scope-tree`. 없는 ID·없는 slug와 볼 수 없는 ID·slug는 **구별할 수 없어야 한다**: 같은 상태 코드 404, 같은 본문(`code: NOT_FOUND`, 같은 `message`, `details: {}`), 같은 헤더 집합, 리다이렉트·정규 경로 안내 없음. `requestId`만 다르다. 응답 시간으로도 구별되지 않게 범위 조건을 조회 쿼리 안에 넣는다(조회 후 비교 금지). 403은 **볼 수 있는 대상에 대한 쓰기**가 역할 부족일 때만 쓴다. MSP 직원·포털 사용자 모두에 적용되고, backend PR 관문 테스트로 고정한다: 같은 요청을 "다른 고객의 slug/ID"와 "없는 slug/ID"로 보내 본문이 `requestId`를 빼고 바이트 단위로 같아야 한다 |
| 미매핑 계정은 내부 전용 (security R-2) | 미매핑(unmapped) 계정 인시던트, 목록 응답의 `unmapped[]` 배너, `outside.unmapped`, 항목의 `awsAccountIds`, `/unmapped-accounts/*`는 **INTERNAL(MSP) 사용자에게만** 준다. 고객(포털) 사용자에게는 각각 404 / 빈 배열 / 0 / 빈 배열이다. 미매핑 계정은 어느 고객 것인지 모르는 상태라 다른 고객의 계정 ID·알림 건수가 될 수 있다 |
| ID in URL | 리소스 키처럼 `/`·`:`가 들어가는 값은 base64url(9-4) |
| 범위 | 모든 조회에 서버가 구한 customerId 집합(프로젝트·서비스 범위 사용자는 그 하위) 적용. 목록·수치(`counts`, `outside`, 트리의 `openIncidents`·`callHealth`)도 같은 범위로 계산한다. 범위 밖은 **404**(존재를 드러내지 않음, org-tenant R3-3, 위 "조회 경로의 404"). 범위 안 대상에 대한 쓰기가 역할 부족이면 403. MSP 직원의 범위는 전 고객이다(기본 보기 All customers, D-34) — `mine`은 권한이 아니라 필터다 |
| 낙관적 잠금 | 수정 요청은 `If-Match: <version>` 필수인 리소스: Incident, ManagedAlarm, PagingConfig, ResponderTemplate, ThresholdDefault. 불일치 409 `VERSION_CONFLICT` |
| 멱등 | 생성·상태 변경 POST는 `Idempotency-Key` 헤더 허용(24시간 보관). 같은 키 재요청은 첫 응답 재생 |
| 감사 | 쓰기 요청은 모두 AuditLog 1행 |

### 오류 형식
```json
{ "error": { "code": "VERSION_CONFLICT", "message": "Incident was updated by someone else.", "details": {}, "requestId": "req_..." } }
```

| HTTP | code 예 | 쓰임 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | 본문·쿼리 형식 오류. `details.fields[]` |
| 401 | `UNAUTHENTICATED` | 세션·토큰·서명 없음/불일치 |
| 403 | `FORBIDDEN`, `ROLE_REQUIRED`, `PORTAL_GRANT_REQUIRED`, `CAPABILITY_DISABLED` | 역할·포털 권한·고객 선택 기능(AlarmWriter 등) 꺼짐 |
| 404 | `NOT_FOUND` | 없음 또는 범위 밖 |
| 403 | `NOT_A_RESPONDER` | 연락처 열람: 그 고객의 Responder가 아님(D-35) |
| 409 | `VERSION_CONFLICT`, `ALREADY_EXISTS`, `INVALID_TRANSITION`, `TAG_WINS` | 경합, 중복 생성(4b5b079), 상태 전이 불가, 리소스 태그가 값 결정(D-08) |
| 413 | `PAYLOAD_TOO_LARGE` | 수집 본문 1MB 초과 |
| 422 | `ROLE_UPDATE_REQUIRED` | 고객 스택이 옛 버전 |
| 429 | `RATE_LIMITED` | |
| 503 | `NOT_CONFIGURED` | 필수 비밀 미설정(fail-closed, org-tenant 새 구현 1, oncall R4-8) |

메시지는 영어(D-01).

## 3. 정규화 알림 이벤트 (SQS `alert-events` 본문)

ingest λ가 소스별 페이로드를 아래 하나로 바꿔 넣는다. consumer는 이 스키마만 안다.

```json
{
  "schemaVersion": 1,
  "dedupKey": "2026-11-09T03:12:00Z#a1b2c3d4",
  "source": "CLOUDWATCH",
  "sourceId": null,
  "customerId": "cus_123",
  "customerResolvedBy": "ACCOUNT_MAP",
  "awsAccountId": "123456789012",
  "region": "ap-northeast-2",
  "fingerprint": "cloudwatch:123456789012:i-0abc#CPUUtilization",
  "fingerprintVersion": 1,
  "state": "FIRING",
  "previousState": "OK",
  "eventType": "STATE_CHANGE",
  "severity": "SEV_3",
  "severityRaw": "SEV-3",
  "resource": { "type": "EC2", "key": "i-0abc", "name": "web-1", "arn": "arn:aws:ec2:..." },
  "metric": { "key": "CPUUtilization", "namespace": "AWS/EC2", "value": 91.2, "threshold": 80, "comparison": ">" },
  "alarm": { "name": "[EC2] web-1 CPU (TagName: i-0abc)", "arn": "arn:aws:cloudwatch:...", "managed": true },
  "title": "web-1 CPU high",
  "reason": "Threshold Crossed: 1 datapoint [91.2] ...",
  "occurredAt": "2026-11-09T03:12:00Z",
  "receivedAt": "2026-11-09T03:12:02Z",
  "parseError": null,
  "raw": { }
}
```

| 필드 | 규칙 | 근거 |
|---|---|---|
| dedupKey | RawEvent UQ. SQS 재전달·EventBridge at-least-once 흡수 | fingerprint F-3, G-8 |
| customerId | **ingest가 신뢰 경로로만** 정한다: CloudWatch는 이벤트 봉투의 `account` → CloudAccount, 웹훅은 토큰 → IntegrationSource. 본문 값은 쓰지 않는다. 미매핑이면 null | backend 지침, org-tenant R5-5 차단 |
| customerResolvedBy | `ACCOUNT_MAP`, `SOURCE_TOKEN`, `UNMAPPED` | |
| fingerprint | DATA-MODEL Alert.fingerprint 규칙(임시, Q-DM-04) | |
| eventType | `STATE_CHANGE`만 판정 대상. 그 외 `CONFIG_CHANGE`는 이력만 | suppression S-2 |
| severity | CloudWatch 우리 알람: 설명 JSON → 레지스트리. 그 외: `sev-n` 패턴 → SeverityMapping 표(D-18) → 기본(Q-DM-08) | severity V-4 |
| raw | 64KB 상한, JSON 유지 | known-bugs 1-4 |

- 메시지 속성: `customerId`, `source`. 가시성 타임아웃 > consumer 처리 예산(known-bugs 6-9). DLQ maxReceiveCount 5, DLQ 1건 이상이면 경보(D-10, known-bugs 10-1).
- consumer 처리 순서: RawEvent INSERT(ON CONFLICT dedupKey → 종료) → Alert upsert(COALESCE) → 억제 판정(S-3: SEV-1 면제 → 점검 창(D-17) → flapping → dedup → auto-pause) → 결정 기록 → NOTIFY/DEFER면 그룹 배정(G-2, G-3). 판정은 `occurredAt` 기준(S-4). 실패는 fail-open(S-12).

### 3.1 소스 → 정규화 대응

| 소스 | 입력 | 지문 키(임시) | 상태 |
|---|---|---|---|
| CloudWatch | EventBridge `detail` | `{account}#{resource or alarmArn or alarmName}#{metricKey}` | ALARM→FIRING, OK→RESOLVED, INSUFFICIENT_DATA |
| Prometheus Alertmanager | webhook v4 `alerts[]` (배치 분리) | `alerts[].fingerprint` 필수, 없으면 `alertname`+정렬 라벨 해시 | firing/resolved |
| Grafana unified | `alerts[]` + `orgId` | 위와 같음, 접두 `grafana` | `paused`/`nodata` → INSUFFICIENT_DATA |

Grafana legacy, PagerDuty, generic은 PoC 범위 밖(fingerprint 제안 4).

## 4. 웹훅 수집 (B2)

| 항목 | 내용 |
|---|---|
| 요청 | `POST /ingest/v1/prometheus` 또는 `/grafana`, 본문은 공급자 원형 |
| 토큰 | `Authorization: Bearer in_<hex>` 우선, 헤더를 못 붙이는 공급자는 `?token=` 허용. SHA-256 후 `IntegrationSource.tokenHash`와 constant-time 비교 |
| 공용 토큰 | 없음. 토큰 없거나 불일치 401 + IngestRejection |
| 제한 | 1MB 초과 413. `source` 경로와 IntegrationSource.kind 불일치 400 |
| 응답 | `202 { "accepted": n, "rejected": m }` — SQS 적재까지만 동기 |
| 멱등 | dedupKey = hash(sourceId, fingerprint, startsAt, status) |

## 5. 1분 틱 (B4)

`POST /api/internal/tick` — pg_cron이 매분 호출. HTTP 호출 수단(pg_net 등 Supabase 확장 사용 여부)은 Q-API-02.

| 항목 | 내용 |
|---|---|
| 인증 | `Authorization: Bearer <TICK_SECRET>`, constant-time. 비밀 미설정 503 |
| 본문 | `{ "scheduledAt": "2026-11-09T03:13:00Z", "jobs": ["group","escalation","notify","reconcile"] }` (생략 시 전부) |
| 멱등 | `scheduledAt`(분 단위)별로 `TickHeartbeat` 선점. 같은 분 중복 호출은 `200 {"skipped":"duplicate"}`. 겹친 실행은 행 단위 낙관적 잠금으로 안전(oncall R4-5) |
| 처리 | ① group: `closeAt ≤ now`인 OPEN 그룹 Close → grace 5초 경과분 Collect/Finalize → 인시던트 병합(I-3, 6시간 상한) → INITIAL 잡 생성. stale 그룹 sweep(G-6) ② escalation: 아래 표 ③ notify: 아웃박스 드레인 최대 50건, Slack 다이제스트(R2) ④ reconcile: 5분마다 인시던트 정합성 점검(I-6) → alarm-commands에 `CHECK_ALARM_LIVENESS` 발행 |
| 응답 | `200 { "group": {...}, "escalation": {"checked":n,"escalated":n,"muted":n}, "notify": {"sent":n,"failed":n}, "durationMs": n }` |
| heartbeat | 작업별 `TickHeartbeat` 갱신. 3분 정체 경보(Q-DM-17) |
| 예산 | 응답 50초 이내. 남은 일은 다음 틱 |

group_wait 30초는 1분 틱 정밀도로는 지켜지지 않는다. 그룹 열 때 SQS `DelaySeconds = groupWaitSec`인 `GROUP_CLOSE` 메시지를 `alert-events`에 함께 넣어 consumer가 닫게 하고, 틱은 놓친 그룹의 안전망으로 둔다(제안, Q-API-04).

### 에스컬레이션 판정 (틱 ②)

| 조건 | 동작 | 근거 |
|---|---|---|
| Incident.status ≠ TRIGGERED | 건너뜀(ack가 멈춘다) | oncall R6-3 |
| 점검 창이 덮고 severity ≠ SEV-1 | 건너뜀, 단계 유지, `muted++` | D-17, R4-6 |
| `now − escalationBaseAt ≥ step.waitMin` | 선점(`WHERE version=?`) → IncidentEvent(기준 시각 포함 문구) → 채널별 NotificationJob | R4-2, R4-3, R4-5 |
| 마지막 단계 이후 `escalationRepeat < pagingConfig.repeatCount` | step=0, repeat+1, 처음부터 | D-20 (기본 1회) |
| 반복도 끝남 | `escalationDoneAt` 기록, 더 보내지 않음 | D-20 |
| ACKNOWLEDGED이고 `renotifyAfter` 경과 | RENOTIFY 잡(최초와 같은 채널 매칭) | R5-2, 71aa6e2 |

한 틱에 인시던트당 한 단계만 오른다(R4-4).

## 6. 알람 엔진 명령 (SQS `alarm-commands`, B9)

```json
{
  "schemaVersion": 1,
  "commandId": "cmd_01J...",
  "type": "APPLY_THRESHOLD",
  "customerId": "cus_123",
  "cloudAccountId": "acc_1",
  "requestedBy": { "type": "USER", "id": "usr_9" },
  "requestedAt": "2026-11-09T03:20:00Z",
  "payload": { }
}
```

| type | payload | 엔진 동작 | 필요한 역할 | 근거 |
|---|---|---|---|---|
| `SYNC_ACCOUNT` | `{ mode: "DAILY"|"TAG_RECONCILE"|"ON_DEMAND" }` | 발견 → 고아 정리 → 동기화, AlarmSyncRun 기록 | Reader (+AlarmWriter 있으면 쓰기) | alarm-sync §6 |
| `SYNC_RESOURCE` | `{ resourceId }` | 리소스 하나 동기화 | Reader, AlarmWriter | §5 |
| `APPLY_THRESHOLD` | `{ managedAlarmId, threshold?, evalM?, evalN?, off?, thresholdChangeId }` | 같은 이름 알람 제자리 `PutMetricAlarm`, 콘솔 값을 알람에 저장 | AlarmWriter | D-08 |
| `APPLY_CUSTOMER_DEFAULT` | `{ resourceType, metricKey }` | 영향 리소스 재해석·제자리 수정 | AlarmWriter | D-19 |
| `SET_SEVERITY` | `{ managedAlarmId, severity }` | 태그 + 설명 JSON 동시 갱신 | AlarmWriter | alarm-sync §3-2 |
| `SET_MONITORING_TAG` | `{ resourceId, value: "on" }` | `Monitoring=on` 태그 쓰기(그 키만) | TagWriter | D-07, D-16 |
| `STOP_MONITORING` | `{ resourceId, deleteAlarms: true }` | 사람이 확인 필요 리소스를 해제할 때만 알람 삭제 | AlarmWriter | D-16 |
| `CHECK_ALARM_LIVENESS` | `{ incidentId, fingerprints[] }` | DescribeAlarms로 deleted/not_firing/firing/unknown 분류 후 DB 반영 | Reader | grouping I-6 |
| `EXECUTE_REMEDIATION` | `{ remediationRequestId }` | 상태 APPROVED 재확인 후 실행 | Remediator | D-15 |
| `CHECK_CONNECTION` | `{}` | 역할별 AssumeRole(ExternalId) 점검 | 각 역할 | D-07, P4-1 |

- 멱등: `commandId` = 메시지 중복 제거 키. 엔진은 처리 전 `ThresholdChange.applyStatus`·`RemediationRequest.status`를 조건부로 선점한다. `APPLY_THRESHOLD`가 `PENDING`이 아니면 무시.
- 역할이 없거나 꺼져 있으면 실행하지 않고 결과를 `CAPABILITY_DISABLED`로 기록.
- 리소스 태그 `Threshold_*`가 있으면 콘솔 값을 적용하지 않고 `SKIPPED_TAG_WINS`(D-08, D-19).
- 엔진 테스트는 AWS 호출을 모두 목으로(backend 지침).

## 7. 알람 엔진 ↔ DB 계약 (B10)

| 테이블 | 엔진 | 콘솔 | 비고 |
|---|---|---|---|
| CloudAccount | 읽기, `*Status`·`lastCheckedAt` 쓰기 | CRUD | |
| Resource | 쓰기(upsert, 상태 전이) | 읽기 | 발견 실패 시 지우지 않음(4-9) |
| ManagedAlarm | 쓰기 | 읽기 | 버전 조건 |
| ThresholdDefault | 읽기 | 쓰기 | |
| ThresholdChange | `applyStatus`·`error`만 갱신 | INSERT | 추가만(그 외 컬럼 불변) |
| AlarmSyncRun | 쓰기 | 읽기 | |
| RemediationRequest | `EXECUTING→SUCCEEDED/FAILED` | 생성·승인 | |
| Alert / Incident | `CHECK_ALARM_LIVENESS` 결과로 해소(`resolvedVia=RECONCILE`), 지문 `episodeOpen=false` | 읽기·ack | I-6 3 |

엔진은 Prisma 클라이언트를 쓰지 않을 수 있다(Python 이식, D-05). 그 경우에도 위 표 밖의 테이블에 쓰지 않고, 스키마는 `prisma migrate`가 유일한 정본이다(D-09 원칙 6). 엔진 언어·DB 드라이버는 Q-API-05.

## 8. 콘솔 REST (B5)

역할 표기: V = VIEWER 이상, O = OPERATOR 이상, A = ADMIN, P(grant) = 고객사 담당자 + portalGrant. 역할 체계 자체는 미결(Q-DM-02)이라 이 열은 임시.

### 8.0 범위: 트리, 목록 필터, 필터 밖 수치 (D-33, D-34)

콘솔 셸(`docs/ui/screens/shell-scope.md`)이 쓰는 계약이다. 필드 이름은 콘솔 구현(`apps/console/src/lib/api/types.ts`의 `ScopeTreeResponse`·`OutsideCounts`·`IncidentListQuery`·`OrgRef`, `packages/design-system/src/scope/model.ts`)과 같다.

| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET `/scope-tree?onlyProblems=` | 왼쪽 트리·휴대폰 시트·`Ctrl/⌘K`의 데이터. 한 번에 전부(페이지네이션 없음). `onlyProblems=true`(선택)는 열린 인시던트가 있거나 `callHealth != OK`인 고객만 — 생략하면 전부 주고 콘솔이 거른다 | V, P |

```json
{ "customers": [
    { "id": "cus_…", "slug": "mirae", "name": "Mirae Pay", "mine": true,
      "openIncidents": 1, "callHealth": "OK",
      "projects": [
        { "id": "prj_…", "slug": "core", "name": "Core", "openIncidents": 1, "ownSteps": false,
          "services": [ { "id": "svc_…", "slug": "payments-api", "name": "Payments API", "openIncidents": 1, "ownSteps": false } ] },
        { "id": "prj_…", "slug": "data-platform", "name": "Data platform", "openIncidents": 0, "ownSteps": true, "services": [] } ] } ] }
```

| 필드 | 뜻 |
|---|---|
| `openIncidents` | 그 노드 아래 열린 인시던트 수(TRIGGERED, 아직 아무도 확인하지 않음 — 메뉴 배지와 같은 정의). 상위 = 하위 합 |
| `callHealth` | `OK \| AT_RISK \| UNREACHABLE`. 고객 단계만. `/customers/{id}/paging-health`의 `level`과 같은 계산(D-32) |
| `ownSteps` | 그 프로젝트·서비스에 호출 순서 덮어쓰기(PagingOverride)가 있음. 고객 노드에는 없다 |
| `mine` | 세션 사용자가 그 고객의 Responder(직접 또는 템플릿 경유). 서버가 계산 |
| `slug` | 부모 안에서 유일, `^[a-z0-9][a-z0-9-]{0,63}$` |

트리 표식은 3종뿐이라 필드도 이 셋이다. 임계치 검토 수(Needs review)는 넣지 않는다.

**테넌트 규칙 (security R-1).** 콘솔은 받은 트리를 그대로 그리고 모든 화면의 페이로드로 브라우저에 내려보낸다. 격리는 이 응답이 전부다.
1. 서버가 구한 customerId 집합 안의 고객만 준다. 프로젝트·서비스 범위(ContactScope PROJECT/SERVICE)인 사용자는 그 하위만.
2. `openIncidents`·`callHealth`도 같은 범위로 계산한다. **범위 밖 노드는 개수 0이 아니라 아예 없다.**
3. 포털(고객) 사용자: 자기 고객 하나. `callHealth`는 실제 값과 무관하게 `"OK"` 고정(MSP 내부 정보라 내보내지 않는다. 콘솔 타입에서 필수 필드라 빼지 않는다), `mine`은 `false`.
4. 미매핑 계정은 트리에 없다(고객이 아니다).
5. `ETag` / `If-None-Match` 지원(304). 콘솔은 30초마다, 그리고 Acknowledge·저장 뒤에 다시 부른다. ETag는 호출자 범위를 포함해 계산한다(다른 사용자의 트리와 같은 ETag 금지).
6. slug 예약어(`incidents` `incident` `monitoring` `call-order` `people` `maintenance` `thresholds` `alarms` `resources` `settings` `new` `-`)는 프로젝트·서비스·고객 생성 시 접미사를 붙여 피한다(DATA-MODEL에 `slug` 컬럼 추가 필요 — 미결 Q-API-09).

**목록의 범위 필터.** 아래 목록은 모두 `customer` · `project` · `service`(slug) · `mine=1`을 받는다(§2 "범위 필터"): `/incidents`, `/resources`, `/managed-alarms`, `/oncall/now`, `/contacts`, `/contacts/needs-action`, `/maintenance-windows`, `/threshold-changes`, `/remediation-requests`, `/rotations?scope=CUSTOMER`. 응답 항목의 `org.customer` · `org.project` · `org.service`(`OrgRef`)에는 `{ id, name, slug }`가 있다 — `slug`는 필수이고, 범위 안일 때만 나간다(단건이 404면 slug도 없다. 콘솔이 slug로 주소를 만들기 때문에 명시한다).

| 목록 | 범위 필터의 뜻 |
|---|---|
| `/incidents`, `/resources`, `/managed-alarms` | 그 노드에 속한 것(하위 포함). 미매핑 계정 인시던트는 INTERNAL 사용자에게, 범위 필터가 없을 때와 `mine=1`일 때만 |
| `/oncall/now` (Call order 목록) | 그 범위에 적용되는 호출 순서 행: 고객 행 + 범위 안에서 자기 단계를 가진 프로젝트·서비스 행 + 요청한 노드 자신의 행(물려받았으면 `inheritedFrom`) |
| `/contacts` (People) | **그 범위에서 호출되거나 알림 받는 사람 전부**(직원 포함). 항목마다 `reach: { paged?: {stepIndex, atMin, via: PERSON\|ROTATION\|ALL_RESPONDERS, from: {level,id,name}}, notified?: {scope:{level,id,name}} }`. `/oncall/paging-path`와 같은 해석 함수여야 한다(사람 목록 = 호출 문장) |
| `/maintenance-windows` | 범위가 그 노드와 겹치는 창(상위·하위 포함) |

**필터 밖 수치 (`outside`).** 범위 필터(`customer`/`project`/`service`)나 `mine`이 걸린 요청의 응답에 서버가 넣는다. 필터가 없으면 `outside: null`. 상태·심각도·검색 필터는 이 값을 바꾸지 않는다.

| 목록 | 필드 | 뜻 |
|---|---|---|
| GET `/incidents` | `outside: { open, unmapped, acknowledged }` | 범위 필터가 가린 건수. `open` = TRIGGERED(에스컬레이션 포함), `unmapped` = 그중 미매핑 계정 것(`open`에 포함), `acknowledged` = ACKNOWLEDGED. 불변식: 목록의 `counts.open` + `outside.open` = 필터 없는 요청의 `counts.open`(메뉴 배지) |
| GET `/resources`, `/managed-alarms` | `outside: { needsReview, inAlarm }` | Monitoring 칩 줄의 `Outside this view: 2 need review · 3 in alarm` |

- **`outside`는 호출자 범위 안의 인시던트만 센다.** 고객·포털 사용자에게 다른 테넌트의 건수가 섞이지 않는다. 불변식은 범위 안에서만 성립한다.
- `outside.unmapped`와 `unmapped[]`는 고객 사용자에게 0 / 빈 배열(§2 "미매핑 계정은 내부 전용").
- `counts`(배지 포함)도 범위를 적용한다.
- 따로 엔드포인트를 두지 않는다(목록과 한 트랜잭션에서 세야 불변식이 맞는다).

### 8.1 인시던트·알림
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET `/incidents` | 목록. 필터 status, severity, customerId, `customer`·`project`·`service`(slug), `mine`, assignee=me, unmapped, source, q. 응답 `{ items, nextCursor, counts, unmapped[], outside }`: `counts`(같은 필터 기준, 9-5), `unmapped[{awsAccountId, alertCount}]`(INTERNAL만), `outside`(§8.0). 범위 필터 없는 요청이 기본 보기다(D-34) | V |
| GET `/incidents/{id}` | 범위 밖·없음은 같은 404(하위 `/timeline`·`/notifications` 포함, §2). 미매핑 계정 인시던트는 INTERNAL만. 상세: 구성원 알림, 담당 스냅샷, 에스컬레이션 진행, 억제 이유, RCA 자리(D-14) | V |
| GET `/incidents/{id}/timeline` | IncidentEvent 커서 | V |
| GET `/incidents/{id}/notifications` | NotificationLog(P3-2) | V |
| POST `/incidents/{id}/ack` | TRIGGERED→ACKNOWLEDGED. **`If-Match: <version>` 필수**(없으면 400, 불일치 409 `VERSION_CONFLICT` — 오래된 목록에서 누른 Ack가 그 사이 재발화·에스컬레이션된 인시던트에 적용되지 않게, security R-3). 응답 `{ incident, undoToken }` — 목록 행·카드·패널의 Acknowledge는 이 엔드포인트를 쓴다. `undoToken`은 `/incidents/bulk/undo`에 그대로 쓴다(5분, Ack한 본인, 그 사이 다른 전이가 없을 때. 에스컬레이션은 멈췄던 단계부터 이어진다) | O |
| POST `/incidents/{id}/resolve` | `{ kind?, note? }` → Resolution | O |
| POST `/incidents/{id}/escalate` | 즉시 다음 단계 | O |
| POST `/incidents/bulk` | `{ action: "ack"|"resolve", items: [{ id, version }], preview: true }` → 대상 목록 → `preview:false`로 실행, 응답 `{ done[], conflicts[{id, code}], undoToken }`. **항목마다 `version` 필수**: 버전이 다른 항목은 건너뛰고 `conflicts`에 `VERSION_CONFLICT`로 돌려준다(나머지는 실행). 버전 없는 `ids[]`만 보내는 형식은 받지 않는다(R-3). 범위 밖 id는 `conflicts`에 `NOT_FOUND` | O |
| POST `/incidents/bulk/undo` | `{ undoToken }` (5분) → `{ restored[] }`. 단건 Ack의 `undoToken`도 받는다 | O |
| GET `/alerts/{id}` | 알림(지문) 상세, RawEvent 이력, 억제 판정 이력 | V |
| POST `/alerts/{id}/ack` | 알림 단위 ack — **Ack 단위 미결(Q-DM-05)**, 결정 전까지 404 비활성 | O |

### 8.2 노이즈
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET/POST `/maintenance-windows` | 목록/생성. 목록은 범위 필터(§8.0). 생성 본문에 범위 `{customerId, projectId?, serviceId?}`(ID) 필수(미리 채우지 않는다, D-33 ⑦). 30일 상한, 과거 구간 400. SEV-1 예외 문구 고정 표시(D-17) | O, P(silences) |
| POST `/maintenance-windows/preview` | 생성과 같은 본문 → `{ services[{id,name}], openIncidents: {muted, sev1KeepsPaging}, existing[{id, scope, window}] }`. 생성 패널의 `Applies to` · `Mutes` · `Already here` | O, P(silences) |
| POST `/maintenance-windows/{id}/revoke` | | O, P(silences) |
| GET/PUT `/settings/suppression` | SuppressionPolicy, 범위 검증 400 | A |
| GET/PUT `/settings/severity-mapping` | 표 하나(D-18) | A |

### 8.3 온콜
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET/POST `/schedules`, PATCH/DELETE `/schedules/{id}` | 시프트 포함 | A |
| GET/POST `/schedules/{id}/overrides`, DELETE `.../{oid}` | 대체·교환 요청. 본문 `{ kind: "COVER"\|"SWAP", start, end, fromUserId, toUserId, swapStart?, swapEnd?, reason }`(부분 시간 허용). 생성 시 `status: PENDING` — 수락 전 순서 불변. GET은 `?since=`로 최근 목록(사유 포함). DELETE는 요청자 취소(PENDING만) | O |
| POST `/schedules/{id}/overrides/{oid}/accept` | 대상자만. PENDING→ACCEPTED, 반영. 이미 처리됨 409 `OVERRIDE_NOT_PENDING` | O(대상자) |
| POST `/schedules/{id}/overrides/{oid}/decline` | 대상자만. 본문 `{ note? }`. PENDING→DECLINED, 요청자에게 알림. 48시간 또는 시작 시각 경과 시 EXPIRED | O(대상자) |
| POST `/schedules/{id}/overrides/{oid}/remind` | 요청자만. Slack 재전송(10분 1회 제한) | O |
| GET `/oncall/now?customerId=&customer=&project=&service=&mine=&contactId=&style=` | 로테이션별 지금 당번 + 고객별 첫 호출 대상·단계 요약 — 알림 해석과 같은 함수(Leave·Override 적용) | V |
| GET `/oncall/paging-path?q=` 또는 `?resourceId=` / `?serviceId=` | "Who gets paged for…". 응답 `{ path: [{level:"RESOURCE"\|"SERVICE"\|"PROJECT"\|"CUSTOMER", id, name}], customer: {id,name}, inheritedFrom: {level, id, name}, style, plan, edited, pagingConfigId, version, steps: [{atMin, targetType:"PERSON"\|"ROTATION"\|"ALL_RESPONDERS", targetId?, nowIds[], names[], channels}], repeatCount, stopAtMin, sentence, customerNotified: [{contactId, name, scope:{level,id,name}}] }`(Notify only 고객 사람). `q`는 이름 접두 검색, 여러 건이면 `candidates[]` 반환. `/oncall/now`와 같은 해석 함수 | V |
| GET/PUT `/customers/{id}/paging` | D-30 개정. `{ style: ALL_AT_ONCE\|CUSTOMER_ROTATION\|SHARED_ROTATION\|CUSTOM, plan: STANDARD\|URGENT\|QUIET, sharedRotationId?, steps[{atMin, targetType: PERSON\|ROTATION\|ALL_RESPONDERS, targetId?, channels[]}], repeatCount }` (If-Match). `plan`만 바꾸면 서버가 템플릿으로 단계 재생성(`edited=false`). 응답에 `sentence`(실명 미리보기) | A |
| PUT/DELETE `/customers/{id}/paging-overrides/{scopeType}/{scopeId}` | PROJECT·SERVICE 덮어쓰기. 해석 service › project › customer | A |
| GET `/customers/{id}/paging-health` | D-32. `{ level: OK\|AT_RISK\|UNREACHABLE, problems[{ code: NO_PAGEABLE_RESPONDER\|NO_VERIFIED_PHONE\|STEP_UNVERIFIED_ONLY\|ROTATION_GAP, stepIndex?, contactIds[], rotationId?, from?, to?, message }] }`. 서버가 Responders·단계·채널 검증·교대표(앞으로 14일)로 계산. 저장하지 않음 | A |
| GET `/customers?pagingHealth=UNREACHABLE,AT_RISK` | 고객사 목록 필터. 목록 항목마다 `pagingHealth.level`과 `problems` 개수 포함. 정렬 기본: UNREACHABLE → AT_RISK → OK | A |
| GET `/oncall/now?onlyProblems=true` | Call order 목록. ~~고객사 10곳 초과 시 콘솔이 기본으로 켬~~ → 트리의 `Only with problems`(`/scope-tree`)가 대신하고 기본은 꺼짐 | A |
| GET/POST `/customers/{id}/responders`, PATCH/DELETE `/customers/{id}/responders/{contactId}` | `{contactId, role: PAGEABLE\|NOTIFY_ONLY}` 또는 새 고객 사람 `{name,email,phone,role,extras:[APPROVER,PORTAL_USER],scope, insertStep?:{afterIndex, atMin, channels}}`. 다른 고객 Contact는 422 `CROSS_CUSTOMER` | A |
| GET/POST `/rotations?scope=&customerId=`, PATCH/DELETE `/rotations/{id}`, GET `/rotations/{id}/shifts?from=&to=`, GET `/rotations/{id}/usage` | Rotation(scope MSP\|CUSTOMER). usage = 참조 고객·단계 | A |
| POST `/rotations/{id}/overrides`, POST `/overrides/{id}/accept\|decline` | COVER/SWAP, 상대 수락 후 반영(D-28) | O |
| GET/POST `/responder-templates`, PATCH `/responder-templates/{id}`, POST `/responder-templates/{id}/preview` | 템플릿 변경 시 영향 고객 미리보기, PATCH는 `previewHash` 필수 | A |
| GET `/staff?q=`, GET `/staff/{id}/coverage` | People: `{customerCount, onShift[], nextShift, customers[{id, via[]}]}` | V |
| POST `/staff/{id}/leave/preview`, POST `/staff/{id}/leave`, DELETE `/leaves/{id}` | `{from, to, replacementId}` → `{customers[{id,effects[]}], rotations[{id,shifts[]}], totals, previewHash}`. 적용은 같은 본문 + previewHash, 다르면 409 `PREVIEW_STALE`. BulkChange + AuditLog 기록 | A |
| POST `/staff/{id}/customers/preview`, POST `/staff/{id}/customers` | 직원을 여러 고객 Responders에 추가 `{customerIds[]}` | A |
| GET `/bulk-changes?contactId=&kind=` | 일괄 변경 감사 | V |
| GET `/contacts/needs-action?kind=&customerId=&channel=&q=` | 직원·고객 통합 Needs action 목록(한 정의: 확인 안 된 채널이 하나라도 있는 사람). 응답 `{ people[], counts:{people, staff, customer, linkable, notSet} }` | A |
| GET/POST `/routing-rules`, PATCH/DELETE `/{id}` | | A |

### 8.4 조직·계정·연동
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET/POST `/customers`, GET/PATCH/DELETE `/customers/{id}` | | A (GET V) |
| GET/POST `/customers/{id}/projects`, `/projects/{id}/services` (+PATCH/DELETE) | 이름 유일 409 | A |
| GET/POST `/customers/{id}/accounts`, PATCH/DELETE `/accounts/{id}` | 12자리 검증, ExternalId 발급, 역할 ARN, 선택 기능 토글 | A |
| POST `/accounts/{id}/check` | `CHECK_CONNECTION` 발행 → `202 { commandId }` | A |
| GET `/accounts/{id}/status` | 역할별 상태·첫/마지막 수신(P4-1) | V |
| POST `/unmapped-accounts/{awsAccountId}/map` | `{ customerId, serviceId? }` 미매핑 복구(P2-3). INTERNAL 전용(고객 사용자는 404) | A |
| GET/POST `/assignments`, DELETE `/assignments/{id}`, PUT `/assignments/order` | | A |
| GET/POST `/contacts`, PATCH/DELETE `/contacts/{id}` | `kind: INTERNAL\|CUSTOMER`(D-29). GET 쿼리 `kind`, `customerId`, `customer`·`project`·`service`(slug), `mine`(§8.0: 범위를 주면 그 범위에서 호출·알림 받는 사람), `needsAction=true`(미확인·만료·미설정), `q`. **목록·단건 응답의 전화·이메일은 항상 가린 값**(`phoneMasked: "010-••••-4821"`, `emailMasked: "y•••@mirae.example"`)이고 `canReveal: boolean`이 붙는다. 전체 값은 `/contacts/{id}/reveal`로만. 응답 항목에 `customerCount`(INTERNAL) 또는 `responderRole`·`scopes[]`(CUSTOMER), 채널별 `{status, via, at, expiresAt}`. CUSTOMER를 다른 고객이나 MSP 로테이션에 넣으면 422 `CROSS_CUSTOMER`, NOTIFY_ONLY를 단계·로테이션에 넣으면 422 `NOT_PAGEABLE` | A, P(contacts, 자기 고객 CUSTOMER만) |
| POST `/contacts/{id}/reveal` | **연락처 전체 값 열람(D-35).** 본문 `{ channel: "PHONE"\|"EMAIL"\|"SLACK", reason? }` → `{ channel, value, revealedAt, auditId }`. `Cache-Control: no-store`. 허용: CUSTOMER 연락처는 **그 고객의 Responder인 MSP 직원**(직접 또는 템플릿 경유)과 그 고객의 포털 사용자(P contacts), INTERNAL 연락처는 같은 고객의 Responder인 직원. ADMIN 역할만으로는 안 된다. 아니면 403 `NOT_A_RESPONDER`(볼 수 있는 연락처에 대한 쓰기성 동작이라 403. 연락처가 범위 밖이면 없는 ID와 같은 404). **호출마다 AuditLog 1행**(`action: CONTACT_REVEAL`, 누가·누구의·어떤 채널·`customerId`·시각, 값 자체는 기록하지 않음). 감사 기록에 실패하면 값을 주지 않는다(500). 1인당 분당 30회 초과 429. GET이 아닌 이유: 프리페치·캐시·로그에 값이 남지 않게 | O(그 고객의 Responder), P(contacts) |
| (삭제) `/customers/{id}/people` | Responders & paging 탭으로 통합(`/customers/{id}/responders`, ContactScope는 아래) | |
| POST `/contacts/{id}/scopes`, DELETE `/contacts/{id}/scopes/{sid}` | `{ scopeType: CUSTOMER\|PROJECT\|SERVICE, scopeId, role: NOTIFY\|APPROVER\|PORTAL_USER }`. 중복 409 | A, P(contacts) |
| POST `/contacts/verify-bulk` | `{ contactIds[] }` 또는 `{ kind?, customerId?, filter: "needsAction" }` → `{ sent, notSet[] }`. 미설정(NOT_SET) 채널은 링크 대상 아님 → `notSet`으로 반환해 "Ask to add" | A |
| POST `/contacts/{id}/verify` | `{ channel, method: "link"|"manual", note? }` | A, P(contacts) |
| GET `/verify/{token}` | 1회용 확인 링크(세션 불필요, 토큰 해시 대조) | 토큰 |
| GET/POST `/customers/{id}/integrations`, PATCH/DELETE `/integrations/{id}` | Prometheus/Grafana. 생성 응답에만 평문 토큰 1회 | A |
| POST `/integrations/{id}/rotate-token` | 이전 토큰 즉시 무효(R5-1) | A |
| GET/POST `/notification-channels`, PATCH/DELETE `/{id}`, POST `/{id}/test` | 중복 409 | A, P(channels) |
| GET/PATCH `/users`, `/users/{id}` | 가입 승인, 역할 | A |
| GET `/me` | 세션 사용자, 역할, 범위 고객사 | 세션 |

### 8.5 리소스·임계치 (D-08, D-16, D-19)
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET `/resources?customerId=&customer=&project=&service=&type=&monitoringState=&coverage=missing` | 커버리지 빈틈(P4-2). `NEEDS_REVIEW` 필터(D-16) | V |
| GET `/resources/{id}` | 태그 사본, 알람, 값과 출처, 드리프트, 변경 이력 | V |
| POST `/resources/{id}/monitoring` | `{ action: "tag_on" | "stop" | "keep" }` — tag_on은 TagWriter 필요(403 `CAPABILITY_DISABLED`), stop은 확인 필요 해제 | O |
| GET `/resources/{id}/thresholds` | 지표별 `{ value, source: CODE|MSP|CUSTOMER|CONSOLE|TAG, layers: [...] , editable, lockedReason }` | V |
| POST `/thresholds/preview` | `{ targets[], change }` → 영향 리소스·출처별 결과, 태그가 이기는 대상 표시 | O |
| POST `/thresholds/apply` | preview와 같은 본문 + `previewId` → ThresholdChange 행 + `APPLY_THRESHOLD` 명령, `202 { changeIds[] }` | O |
| GET/PUT `/threshold-defaults?level=MSP|CUSTOMER&customerId=` | 기본값 편집(D-19) | A |
| GET `/threshold-changes?resourceId=&customerId=` | 변경 기록 | V |
| POST `/managed-alarms/{id}/drift` | `{ action: "restore" | "accept" }` 밖에서 바뀐 값(P4-5) | O |
| PUT `/managed-alarms/{id}/severity` | `SET_SEVERITY` | O |

### 8.6 자동 조치 (D-15)
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET/PUT `/customers/{id}/remediation-policy` | `enabled` 기본 false, `mode` 기본 NOTIFY_ONLY | A |
| GET `/remediation-requests?customerId=` | 목록 | V |

콘솔에서는 승인하지 않는다. 승인은 Slack에서만(D-15, §9).

### 8.7 운영
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET `/health` | DB, heartbeat 나이, DLQ 길이(가능하면) | 공개(값 최소화) |
| GET `/audit-logs` | | A |

### 8.8 초안과 Undo (D-33)

| 항목 | 결정 |
|---|---|
| 저장 안 한 편집의 초안 | **PoC에서는 클라이언트에만 둔다**(브라우저 `sessionStorage`, 키 = 화면 종류 + 범위 경로, 탭 단위). 서버에 초안 엔드포인트·테이블은 없다. 이유: 3~5인 팀, 기기 간 이어 쓰기 요구 없음, 서버 초안은 범위별 권한·만료·충돌 규칙이 따라온다. 잃는 것: 탭을 닫거나 다른 기기에서는 초안이 없다 |
| 초안과 버전 | 초안에 편집을 시작한 때의 `version`을 같이 둔다. 저장은 평소처럼 `If-Match`. 그 사이 남이 바꿨으면 409 `VERSION_CONFLICT` → 콘솔이 "Someone else changed this" + 지금 값과 내 값을 나란히 보여 준다. 초안을 말없이 덮어쓰지 않는다 |
| 민감 값 | 초안에 연락처 전체 값(reveal 결과)을 넣지 않는다 |
| 서비스 하나짜리 저장의 `Undo` | 서버 버전 기록 없이 한다: 콘솔이 저장 직전 값을 들고 있다가 `Undo`를 누르면 **같은 엔드포인트에 이전 값을 다시 저장**한다(`If-Match` = 방금 저장이 돌려준 `version`). 그 사이 값이 또 바뀌었으면 409 → "Could not undo — changed again by …". 감사 기록은 저장 1행 + 되돌림 1행. 새로 만든 것(자기 단계, 점검 창)의 Undo는 DELETE / revoke |
| 확인창을 거친 저장 | Undo 없음(서비스 둘 이상에 닿는 변경을 한 번에 되돌리는 계약은 PoC 이후) |
| 서버 초안이 필요한 곳 | 고객 온보딩 마법사의 단계별 저장만(기존 미결, `customer-onboarding.md`) |

콘솔 엔드포인트 수: 위 표 기준 메서드·경로 조합 약 103개.

## 9. Slack 인터랙티브 (B6)

| 항목 | 내용 |
|---|---|
| 인증 | `X-Slack-Signature`/`X-Slack-Request-Timestamp`, 5분 창. 비밀 없으면 503 |
| 사람 판정 | Slack user ID → Contact(active) → 연결된 User(ACTIVE) → 역할 ≥ OPERATOR → 인시던트가 범위 안. 하나라도 실패하면 ephemeral 거절, 변경 없음. 고객사 담당자는 거절 |
| 응답 | 3초 안에 `response_url`로 메시지 교체 후 비동기 처리(R6-3) |
| 멱등 | 상태 조건 갱신. 이미 처리됐으면 "already acknowledged/resolved" ephemeral |

| action_id | 동작 | 근거 |
|---|---|---|
| `ao_ack` | 인시던트 ack | R4-2 |
| `ao_resolve` | 해소 → 스레드에 분류 버튼 | R7-2 |
| `ao_mute_1h` | ALERT 범위 1시간 점검 창(SEV-1은 D-17에 따라 계속 울림 안내) | R6-4, D-17 |
| `ao_kind:<restart|config|auto|other>` | Resolution.kind만 갱신 | R6-5 |
| `ao_remed_approve:<requestId>` | `PENDING_APPROVAL→APPROVED`(version 조건) → `EXECUTE_REMEDIATION` 발행. 정책 승인 역할 미달이면 거절 | D-15 |
| `ao_remed_reject:<requestId>` | → REJECTED | D-15 |
| `ao_open` | URL 버튼(서버 처리 없음) | |

## 10. 확인 링크·업체 콜백 (B7, B8)

| 경로 | 규칙 |
|---|---|
| `GET /a/{token}` | 토큰 = base64url(`incidentId.contactId.action.exp`) + HMAC. 열면 확인 화면, POST로 실행(링크 미리보기 봇의 GET이 ack하지 않도록). 만료 24시간 |
| `POST /api/callbacks/{provider}` | 문자·음성 업체 전송 결과(NotificationLog 갱신), 음성 키패드 `1` = ack(actor = 통화 대상 Contact). 업체 서명 방식은 업체 선정 후(Q-API-06) |

## 11. 엔드포인트 수 요약

| 구분 | 수 |
|---|---|
| 수집(EventBridge 규칙 1, 웹훅 2) | 3 |
| SQS 큐(alert-events, alarm-commands; DLQ 제외) | 2 |
| 내부 틱 | 1 |
| 콘솔 REST(§8) | 약 103 (11/10: `/scope-tree`, `/contacts/{id}/reveal`, `/maintenance-windows/preview` 추가) |
| Slack 인터랙티브 | 1 (action 7종) |
| 확인 링크·업체 콜백·채널 확인 링크 | 3 |

## 12. 미결 (API)

| ID | 질문 | 현재 처리 |
|---|---|---|
| Q-API-01 | "큐는 SQS 하나"가 큐 1개인가, SQS 기술 하나인가 | 큐 2개 + DLQ |
| Q-API-02 | pg_cron이 HTTP를 부르는 수단(pg_net은 Supabase 확장 → 이전 시 대체 필요) | 미정 |
| Q-API-03 | Vercel 콘솔이 SQS에 보낼 AWS 자격증명(Vercel OIDC → IAM 역할 vs 접근 키) | 미정, security 검토 |
| Q-API-04 | group_wait 30초를 SQS 지연 메시지로 지킬지, 1분 단위로 올릴지 | 지연 메시지 제안 |
| Q-API-05 | 알람 엔진 언어(Python 이식)와 DB 접근 방식(Prisma 외 드라이버 허용 범위) | 표 밖 쓰기 금지 |
| Q-API-06 | 국내 문자·음성 업체 선정과 콜백 서명 방식 | 솔라피 후보 |
| Q-API-07 | 고객 포털(소연) API를 같은 `/api/v1`에 역할로 나눌지, `/api/portal/v1`로 분리할지 | 같은 경로 + 범위 강제 |
| Q-API-08 | Ack 단위 결정 전 `POST /alerts/{id}/ack` 노출 여부 | 비활성 |
| Q-API-09 | Customer·Project·Service `slug` 컬럼과 예약어 처리(접미사 제안), 이름 변경 시 옛 주소 처리(404 vs 리다이렉트 — 포털은 리다이렉트 금지) | 미정, backend |
| Q-API-10 | 프로젝트·서비스 단계의 `callHealth`를 계산해 트리에 줄지(지금은 고객 단계만) | 고객 단계만 |
| Q-API-11 | `Undo`를 "이전 값 다시 저장"으로 할 때 알람 엔진 명령(`APPLY_THRESHOLD`)이 이미 나간 임계치 변경의 처리(두 번째 명령으로 덮어씀 vs 첫 명령 취소) | 두 번째 명령 |
| Q-API-13 | 콘솔 주소 형식이 문서(`?filter=<c>/<p>/<s>`, `/c/…/incidents/<id>`, 미매핑 `/incidents/<id>`)와 콘솔 브랜치 구현(`?customer=&project=&service=`, `/c/…/incident/<id>`, 미매핑 `/c/-/incident/<id>`)이 다르다. API에는 영향 없음(API는 slug 파라미터) | 미정, 사용자 결정 |
| Q-API-12 | 연락처 열람 규칙의 예외(그 고객에 Responder가 한 명도 없을 때 ADMIN 비상 열람 + 사유 필수) | 예외 없음, security 검토 |
| (DATA-MODEL Q-DM-01~19) | | DATA-MODEL §9 |
