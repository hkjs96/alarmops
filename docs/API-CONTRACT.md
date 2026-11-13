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
| 멱등 | 생성·상태 변경 POST·PUT·DELETE는 `Idempotency-Key` 헤더 허용(24시간 보관). 같은 키 재요청은 첫 응답 재생. 키는 **사용자 + 현재 범위·역할 + 메서드 + 경로 + `If-Match` + 본문 해시**에 묶인다: 같은 키를 다른 요청에 쓰면 422 `IDEMPOTENCY_KEY_REUSED`(실행하지 않음), 역할·범위가 바뀐 뒤에는 재생하지 않고 새로 판정한다. 성공(2xx) 응답만 저장한다. `preview: true` 요청(읽기 전용)은 저장하지 않는다. 사용자당 살아 있는 키는 최대 200개이고 넘으면 가장 오래된 것부터 버린다(버려진 키의 재요청은 새 요청으로 실행되며 `If-Match`·버전이 중복 적용을 막는다). **재생 응답에는 `undoToken`이 없다**(SQL 보안 검토 R-7): 토큰은 첫 응답으로만 나가고 멱등 저장소에는 본문에서 뺀 채 저장한다. 첫 응답을 잃은 클라이언트는 재생으로 Undo할 수 없다(첫 토큰은 5분 동안 그대로 유효). **연락처 값이 든 응답을 내는 라우트(연락처 공개 D-35, 연락처 목록·내보내기)는 `replayable: false`로 등록한다** — 재요청은 재생되지 않고 다시 실행·감사된다. 만료된 키는 틱이 전 사용자 대상으로 지운다 |
| 입력 문자 | 경로·질의·헤더·본문 어디든 NUL(`\u0000`)이 있으면 400 `VALIDATION_FAILED`. 경로의 id 자리는 제어 문자가 없고 200자 이하여야 한다(아니면 400). 커서는 `{ t: ISO 시각(toISOString 형식, 0000년 제외 — Postgres에 0년이 없다, issue #10 P-2), id: 위 규칙의 id }`만 받는다(아니면 400 `cursor`). 이 판정은 요청 문자만 보고 저장소를 부르기 전에 끝나므로 500이 되지 않고, 대상이 있는지와 무관하게 같은 응답이다(SQL 보안 검토 R-5). 형식이 맞는 id의 "없음/남의 것"은 지금처럼 404 |
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
| 403 | `NOT_A_RESPONDER` | 연락처 열람: 그 고객의 Responder가 아니고 ADMIN도 아님(D-35) |
| 422 | `EMERGENCY_REASON_REQUIRED` | 연락처 비상 열람: Responder가 아닌 ADMIN이 `reason` 없이(또는 공백만) 호출(D-35) |
| 409 | `VERSION_CONFLICT`, `ALREADY_EXISTS`, `INVALID_TRANSITION`, `TAG_WINS` | 경합, 중복 생성(4b5b079), 상태 전이 불가, 리소스 태그가 값 결정(D-08) |
| 409 | `WOULD_BE_UNREACHABLE`, `IN_USE`, `FROM_TEMPLATE` | Responders 쓰기: 고객이 UNREACHABLE이 됨(`?confirmUnreachable=true`로 확인 후 실행) / 단계가 그 사람을 지정함 / 템플릿에서 온 직원(§8.3 Responders) |
| 413 | `PAYLOAD_TOO_LARGE` | 수집 본문 1MB 초과 |
| 422 | `ROLE_UPDATE_REQUIRED` | 고객 스택이 옛 버전 |
| 409 | `MUTED_BY_MAINTENANCE` | 수동 Escalate: 점검 창이 덮고 SEV-1이 아님. `details.mutedUntil`(D-17) |
| 422 | `SEND_CAP_EXCEEDED` | 호출 순서 저장: 인시던트 1건이 한 바퀴 60건 또는 1시간 120건을 넘김. `details { perCycle, perHour, limits }`(D-38) |
| 422 | `RESPONDER_LIMIT_EXCEEDED` | 호출 순서 저장: `ALL_RESPONDERS` 단계인데 Pageable Responder가 20명 초과. `details { field, responders, limit }`. Responder를 늘리는 쓰기(§8.3 Responders POST·PATCH)도 같은 규칙(`sendCapViolation`)으로 거부한다(11/12). 이 API 밖에서 늘어난 사람은 엔진이 열릴 때 줄인다(아래 한도표, D-38) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | 같은 `Idempotency-Key`를 다른 요청(메서드·경로·`If-Match`·본문)에 사용 |
| 422 | `CROSS_CUSTOMER`, `NOT_PAGEABLE` | 단계 대상이 다른 고객의 사람·로테이션 / Notify-only 사람 |
| 429 | `RATE_LIMITED` | **응답 헤더 `Retry-After: <초>`**와 같은 값의 `details.retryAfterSec`. 현재 쓰임: 수동 Escalate(인시던트당 60초에 1회) |
| 503 | `NOT_CONFIGURED` | 필수 비밀 미설정(fail-closed, org-tenant 새 구현 1, oncall R4-8) |

메시지는 영어(D-01).

### 한도 (D-38, 값은 `packages/core/src/limits.ts`)

| 대상 | 값 | 넘으면 |
|---|---|---|
| 호출 순서: 단계 수 / `atMin` / `repeatCount` | 12 / 0~1440분, 단계마다 앞 단계보다 커야 함 / 0~5 | 400 `VALIDATION_FAILED` |
| 인시던트 1건의 발송: 한 바퀴 / 1시간(반복 포함) | 60건 / 120건 | 저장 시 422 `SEND_CAP_EXCEEDED`. 저장 뒤 Responder가 늘어 넘게 되면 엔진이 인시던트를 열 때 한도까지 줄인다. 순서: ① 여러 명 단계의 **채널**(이메일 → Slack DM. SMS·음성·Slack 채널 글은 빼지 않음) → ② 가장 큰 단계의 **사람**(Responder 순서의 끝부터, 근무 중인 사람 제외) → ③ 더 줄일 수 없으면 **단계 통째**(마지막 `ALL_RESPONDERS` 단계부터. `PERSON`·`ROTATION` 단계는 `ALL_RESPONDERS` 단계가 하나도 안 남았을 때만 뒤에서부터) → ④ 1시간 한도는 반복 횟수. 타임라인 `Send limit applied…`에 빠진 채널, 단계별로 빠진 사람, **통째로 빠진 단계와 그 단계의 사람**, **어느 단계에서도 호출되지 않게 된 사람**(`Not paged in ANY step: …`, 근무자는 `(on shift)` 표시)이 이름으로 남는다. 이벤트 `data`에는 `dropped`·`droppedChannels`·`droppedSteps`·`unreached` 전체가 들어간다(내부 전용) |
| `ALL_RESPONDERS` 한 단계가 닿는 사람 | 20명 | 저장 시 422 `RESPONDER_LIMIT_EXCEEDED`. 엔진은 20명만 호출: **지금 근무 중인 사람 먼저, 그다음 Responder 순서**(`order`, 같으면 contactId. `order`가 유한한 숫자가 아니면 — `NaN`·`null`·문자열 — "없음"으로 보고 맨 뒤). **근무 중인 사람이 20명을 넘으면 근무자도 Responder 순서의 끝부터 빠진다**("근무자는 항상 남는다"가 아니라 "20명까지 먼저 남긴다"). 빠진 사람은 타임라인에 이름으로 남고, 근무자면 `(on shift)`가 붙는다 |
| Ack 뒤 재알림 | 12회 | 더 보내지 않음 |
| 수동 Escalate | 인시던트당 60초에 1회 | 429 `RATE_LIMITED` + `Retry-After` |
| 일괄 처리 항목 | 200 | 400 |
| Undo 토큰 | 5분, 누른 사람만, 1회 | 404 |
| `Idempotency-Key` | 24시간, 사용자당 200개 | 오래된 것부터 버림 |
| 틱 아웃박스 | 업체 종류(Slack·SMS·음성·이메일)마다 틱당 50건, 동시 5건(그 틱에 업체가 한 번도 응답하지 않은 동안은 **서로 다른 수신자** 5명까지, 아래 "업체 무응답"), 호출 타임아웃 10초 | 남은 잡은 다음 틱(원래 만기 유지) |
| 틱 응답 시간 | 예산 45초 + 호출 타임아웃 10초 + 결과 기록 1초, **60초 이하** | 더 큰 예산·타임아웃 설정은 60초에 맞게 줄여서 쓴다. 저장소 호출이 돌아오지 않아도 60초 이하다(보안 4차 N-33): 단계 밖의 네 호출 `claimTick`·`loadPolicy`·`outboxBacklog`·`writeHeartbeat`은 각각 최대 5초(`STORE_CALL_TIMEOUT_MS`, 틱 끝에 가까우면 더 짧게) 기다린다. `claimTick` 무응답 → 그 틱은 아무것도 하지 않고 오류 1건으로 끝난다(하트비트 없음 → 정체로 잡힘). `loadPolicy` 무응답 → 그룹·자동 해소·에스컬레이션 단계는 건너뛰고(하트비트 `ERROR`) **아웃박스는 보낸다**. `outboxBacklog` 무응답 → notify 하트비트 `ERROR`. `writeHeartbeat` 무응답 → 오류 1건, 행이 갱신되지 않아 정체로 잡힘. 앞 단계가 예산을 넘겨 아웃박스가 늦게 시작하면 남은 시간의 절반까지만 새 호출을 시작하고 타임아웃도 그만큼 줄인다(2초 미만이 남으면 보내지 않는다 → `DEGRADED`). SQL 어댑터는 `statement_timeout`을 5초 아래로 둔다(`packages/store-sql`: 트랜잭션마다 `SET LOCAL statement_timeout = 4500`, `lock_timeout = 3000`, 연결 기본값도 같다. 실제 Postgres에서 4.5초 취소·3초 잠금 포기를 테스트한다). 실행기는 `now`를 넘기지 않거나 실제 시계를 넘긴다(보안 5차 N-40: 멈춘 시계로는 시간 제한이 줄지 않는다) |
| 발송 재시도 | 5회(30초·1·2·5·10분) | `FAILED` + NotificationLog `GAVE_UP` |
| 업체 오류 문구 | 마스킹 전에 300자로 자르고, 저장은 **가린 발췌 120자**(`STORE_PROVIDER_TEXT=false`, 기본). `true`면 가린 300자 | 잘림. D-39(임시) |

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

**고객 상태별 수집 (D-43, 구현됨 — 이슈 #19).** 웹훅(B2)과 EventBridge(B1) 모두 같다. 인시던트는 수집이 아니라 틱 ①이 만든다: `SUSPENDED`는 평소처럼 큐에 넣고 틱이 `pagingSuppressed`로 열며 잡을 만들지 않는다. `TERMINATED`는 큐에 넣지 않고 `OffboardResidual`만 올린다(웹훅 `202 {accepted, rejected}`의 `accepted`는 정규화된 건수). 상태는 캐시하지 않고 매 호출 읽는다. 토큰·계정 검사는 상태와 무관하게 먼저 한다.

| `Customer.status` | 수집 | 인시던트 | 호출 |
|---|---|---|---|
| `ACTIVE` | 평소대로 | 만든다 | 한다 |
| `SUSPENDED` | 받는다(202) | 만든다. `Incident.pagingSuppressed = 'CUSTOMER_SUSPENDED'` | 안 한다(MSP 포함). 업무 시간 요약에 집계 |
| `TERMINATED` | 받는다(202, 공급자가 재시도하지 않도록) | 만들지 않는다. `OffboardResidual`에 계정·소스별 마지막 수신 시각·건수만 남긴다 | 안 한다. 업무 시간에 "정리 필요" 알림(MSP) |

## 5. 1분 틱 (B4)

`POST /api/internal/tick` — 콘솔 앱 안의 라우트(`apps/console/src/app/api/internal/tick/route.ts`, Node 런타임, 세션 없음). D-23: pg_cron + pg_net이 매분 호출한다. 실행기는 실제 시계를 쓰고(N-40) 저장소는 `packages/store-sql`(DB `now()` 기준, R-2). 업체 발송기는 아직 없어 잡은 `NOT_CONFIGURED`로 아웃박스에 남는다.

```sql
-- Supabase (D-23). 비밀은 Vault에 두고 SQL에 평문으로 쓰지 않는다. 호출 타임아웃은 60초 이상(§5 "예산").
select cron.schedule('alarmops-tick', '* * * * *', $$
  select net.http_post(
    url     := 'https://<console-host>/api/internal/tick',
    headers := jsonb_build_object('content-type', 'application/json',
                 'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'tick_secret')),
    body    := jsonb_build_object('scheduledAt', to_char(date_trunc('minute', now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:00"Z"')),
    timeout_milliseconds := 60000);
$$);
```
AWS 이전 때는 이 호출 1곳을 EventBridge Scheduler로 바꾼다(D-23).

| 항목 | 내용 |
|---|---|
| 인증 | `Authorization: Bearer <TICK_SECRET>`, constant-time(양쪽 SHA-256 비교라 길이도 드러나지 않음). 비밀 미설정·32자 미만 503 `NOT_CONFIGURED`(fail-closed), 틀림·없음 401. 미들웨어의 세션 검사 대상이 아니다(공개 경로, 이 비밀이 유일한 자격) |
| 본문 | `{ "scheduledAt": "2026-11-09T03:13:00Z", "jobs": ["group","escalation","notify","reconcile"] }` (생략 시 전부) |
| 멱등 | `scheduledAt`(분 단위)별로 `TickClaim` 선점. 같은 분 중복 호출은 `200 {"skipped":"duplicate"}`. 겹친 실행은 행 단위 낙관적 잠금으로 안전(oncall R4-5) |
| 시계 (SQL 보안 검토 R-2) | 틱은 먼저 저장소 시각(DB `now()`)을 묻는다. 실행기 시계가 **30초 넘게** 다르면 아무것도 하지 않고 `200 {"skipped":"clock-skew","clockSkewMs":n}`(실행기 − 저장소)을 돌려주며, 요청된 작업의 하트비트를 `ERROR` + `lastFinishedAt = null`(→ `/health`에서 stale)로 남긴다. 저장소도 `claimTick`에서 같은 판정을 한 번 더 한다. 30초 안이면 그룹 닫기·수집, 에스컬레이션 만기, 점검 창 판정, 타임라인·로그 시각은 모두 **저장소 시각**(실행기 시계 + 측정한 차이)으로 한다. 저장소는 호출자가 준 시각을 그대로 믿지 않는다: 새 페이지·Undo로 되살린 페이지의 만기는 `LEAST(받은 시각, now())`, 점검 보류(`releaseJob`)는 `now() + 10분`까지, 만기 목록은 `now()`를 넘겨 보지 않고, 하트비트 시각도 `now()`를 넘지 않는다. 그래서 시계가 빠른 실행기·API 서버는 페이지를 이르게 보내지도, 미래로 미뤄 두지도 못한다 |
| 처리 | ① group: `closeAt ≤ now`인 OPEN 그룹 Close → grace 5초 경과분 Collect/Finalize → 인시던트 병합(I-3, 6시간 상한) → INITIAL 잡 생성. stale 그룹 sweep(G-6) ② escalation: 아래 표 ③ notify: 아웃박스 드레인 — 아래 "아웃박스 드레인", Slack 다이제스트(R2) ④ reconcile: 5분마다 인시던트 정합성 점검(I-6) → alarm-commands에 `CHECK_ALARM_LIVENESS` 발행 |
| 응답 | `200 { "group": {...}, "escalation": {"checked":n,"escalated":n,"muted":n,"suppressed":n}, "notify": {"sent":n,"failed":n,"retried":n,"skipped":n,"deferred":n,"released":n,"timeouts":n,"unanswered":["SMS"],"dueUnattempted":n,"dueSev1Unattempted":n,"probeCursor":{"SMS":"<customerId>"}}, "truncated": bool, "durationMs": n }` |
| heartbeat | 작업별 `TickHeartbeat` 갱신. 3분 정체 경보(Q-DM-17). 상태는 `OK` / `ERROR` / `DEGRADED`. **notify는 오류가 없어도, 만기가 된 SEV-1 호출이 한 번도 시도되지 않은 채 남아 있으면 `DEGRADED`**다(예산 소진, 업체 무응답). `notify.unanswered`는 그 틱에 타임아웃만 있고 응답이 한 번도 없던 레인이다(표시용 — 레인은 닫히지 않는다). 상태 점검은 `stale` 또는 `degraded`면 정상으로 보고하지 않는다 |
| 예산 | **응답은 작업 예산(45초) + 호출 타임아웃(10초) + 결과 기록 1초 이내, 최대 60초.** 예산이 지나면 새 호출을 시작하지 않고, 이미 시작한 호출은 타임아웃까지만 기다린다. 예산·타임아웃을 더 크게 줘도 합이 60초를 넘지 않게 줄인다. notify가 그 시간 안에 끝나지 않으면(저장소 호출이 돌아오지 않음) 기다리지 않고 `ERROR`로 응답하며 선점된 잡은 임대(60초)가 끝나면 돌아온다. 호출자(pg_cron·Lambda) 타임아웃은 60초 이상으로 둔다. 남은 일은 다음 틱. 앞 단계(group·reconcile·escalation)는 notify 몫(10초, 예산의 1/4 이하)을 남기고 멈춘다. 앞 단계 하나가 돌아오지 않으면 그 시점에 두고 notify로 넘어가며(`ERROR` 기록), notify는 시작 시점부터 자기 몫을 항상 받는다 |

group_wait 30초는 1분 틱 정밀도로는 지켜지지 않는다. 그룹 열 때 SQS `DelaySeconds = groupWaitSec`인 `GROUP_CLOSE` 메시지를 `alert-events`에 함께 넣어 consumer가 닫게 하고, 틱은 놓친 그룹의 안전망으로 둔다(제안, Q-API-04).

### 에스컬레이션 판정 (틱 ②)

| 조건 | 동작 | 근거 |
|---|---|---|
| Incident.status ≠ TRIGGERED | 건너뜀(ack가 멈춘다) | oncall R6-3 |
| 고객 `status ≠ ACTIVE` 또는 `pagingSuppressed` 있음 | 건너뜀, 잡을 만들지 않음(`suppressed++`). 아웃박스 드레인(③)도 발송 직전 같은 조건을 다시 보고 잡을 `SKIPPED`로, `lastError = SKIPPED_CUSTOMER_INACTIVE`로 닫는다. 정지 중 고객의 열린 인시던트는 틱이 한 번 보고 `pagingSuppressed`를 달아 더 보지 않는다(`nextEscalationAt = null`). `ACTIVE`로 돌아온 뒤 같은 축에 새 발화가 오면 조용한 인시던트에 합치지 않고 새 인시던트를 열어(조용한 쪽은 병합 대상에서 내림) 평소대로 호출한다. `ACTIVE`로 돌아와도 정지 중 인시던트는 호출하지 않는다 | D-43 |
| 점검 창이 덮고 severity ≠ SEV-1 | 건너뜀, 단계 유지, `muted++` | D-17, R4-6 |
| `now − escalationBaseAt ≥ step.waitMin` | 선점(`WHERE version=?`) → IncidentEvent(기준 시각 포함 문구) → 채널별 NotificationJob | R4-2, R4-3, R4-5 |
| 마지막 단계 이후 `escalationRepeat < pagingConfig.repeatCount` | step=0, repeat+1, 처음부터 | D-20 (기본 1회) |
| 반복도 끝남 | `escalationDoneAt` 기록, 더 보내지 않음 | D-20 |
| ACKNOWLEDGED이고 `renotifyAfter` 경과 | RENOTIFY 잡(최초와 같은 채널 매칭) | R5-2, 71aa6e2 |

한 틱에 인시던트당 한 단계만 오른다(R4-4).

**단계 시각 규칙.** `atMin`은 화면에 보이는 **누적 분**(인시던트가 열린 뒤 몇 분)이다. 엔진이 기다리는 시간은 **직전 호출로부터의 차이**다: `wait(i) = atMin(i) − atMin(i−1)`(첫 단계는 `atMin(0)`), 기준 시각은 `escalationBaseAt`(직전 호출). 틱이 제때 돌면 두 값은 같은 시각이 된다. 틱이 늦거나 점검 창이 끝난 직후에는 한 단계만 보내고 기준을 지금으로 다시 잡으므로, 이후 단계는 누적 분보다 늦어질 수 있어도 몰아서 나가지 않는다. 반복은 마지막 간격(단계가 하나면 5분) 뒤에 시작한다. 타임라인 문구에는 기준 시각이 들어간다(R4-3).

### 아웃박스 드레인 (틱 ③)

| 항목 | 규칙 |
|---|---|
| 레인 | 업체 종류마다 한 줄: 음성 / SMS / Slack(채널·DM) / 이메일. 레인은 동시에 돌고 서로 기다리지 않는다. 레인마다 틱당 50건 선점, 동시 호출 5건 |
| 선점 순서 | 고객별 라운드 로빈. 고객 안에서는 SEV-1 → **한 번도 시도하지 않은 잡** → 원래 만기(`dueAt`) → 생성 순. 선점 수의 20%는 SEV-1이 아닌 가장 오래된 잡 몫으로 남긴다(SEV-1 고객이 배치보다 많아도 낮은 등급이 굶지 않게). **동시 선점**(SQL 보안 검토 B-1): 같은 레인의 선점은 한 번에 하나씩 한다 — 선점 트랜잭션 첫 문장이 레인별 `pg_advisory_xact_lock`이다(트랜잭션 범위, 수 ms, `lock_timeout` 3초가 상한, 다른 레인은 기다리지 않는다). 겹쳐 들어온 실행기는 앞 실행기가 집고 남은 것 중에서 고르므로, 같은 잡을 두 번 집지 않을 뿐 아니라 **만기 잡이 있는데 빈 선점을 받지도 않는다**(전에는 모두 같은 상위 N건을 고르고 하나만 잠금을 얻었다). 실제 Postgres 측정: 실행기 8 × 한도 50, 400건 → 1라운드(8 × 50), 2 × 25·4 × 25 / 120건, 8 × 10 / 400건, 80고객 × 5건도 최소 라운드, 중복 0, 빈 선점 0(`packages/store-sql/test/review-sql.test.ts`) |
| 업체 무응답 (차단기 없음) | **레인을 닫는 차단기는 두지 않는다**(보안 3차 R-17). 업체 상태는 틱 사이에 저장하지 않는다. 대신 **한 틱 안에서만** 보내는 순서를 바꾼다(보안 4차 R-22). ① **벌점**: 호출이 타임아웃되면 그 잡의 **고객**과 **수신자**(사람, 고객 Slack 채널, MSP 기본 채널)에 그 틱 동안 표시를 한다. 다음 틱에는 표시가 없다. ② **업체가 이 틱에 한 번이라도 응답한 뒤**(성공이든 거절이든): 동시 5건. 표시 없는 잡 → 고객만 표시된 잡(같은 고객의 다른 수신자) → 수신자가 표시된 잡 순서이고, 같은 등급 안에서는 지금 호출 중이 아닌 수신자 먼저, 그다음 선점 순서(공정 순서). 즉 타임아웃된 고객은 다른 고객이 다 나간 뒤에, 타임아웃된 번호는 같은 고객의 다른 번호 뒤에 선다. ③ **아직 응답이 없는 동안**: **서로 다른 수신자**에게 동시 5건까지. 타임아웃 표시가 없고 호출 중도 아닌 고객 먼저(고객마다 1건), 그다음 호출 중인 고객의 다른 수신자, 그다음 표시된 고객의 다른 수신자. 표시된 수신자만 남으면 한 번에 1건씩. ④ 잡별 재시도 간격(30초·1·2·5·10분)이 있어 같은 잡을 연속으로 다시 보내지 않는다. 틱 중간에 업체가 살아나면 그 틱에 바로 ②로 넘어간다. **죽은 업체에 쓰는 시도**: 동시에 5건을 넘지 않고 틱당 최대 25건(5건 × 10초마다 5회)이다. 수신자가 적으면 "수신자 수 + 약 4건"(고객 2곳·번호 2개: 6건). 3차까지는 틱당 5건이었다. **측정값**(실제 `runTick` + `MemoryTickStore`, 가짜 업체, 타임아웃 10초·예산 45초): 응답 없는 고객 H곳이 앞에 있을 때 정상 고객의 호출은 **같은 틱** 안에 `⌊H÷5⌋ × 10초` 뒤에 나간다 — H = 4·5·8·12·24, 고객당 대기 호출 1~20건, 다섯 레인 모두(24곳 × 20건: 40초). 같은 고객의 20개 번호 중 앞 k개가 무응답이면 정상 번호는 `⌊k÷5⌋ × 10초` 뒤(k = 12: 20초). **탐침 커서(보안 5차 R-24, SQL 보안 검토 R-1에서 다시 만듦)**: 아직 응답이 없는 동안에는 고객을 **고객 id 순서(원형)**로 탐침한다. 한 틱이 응답 없이 끝나면 그 틱이 마지막으로 탐침한 고객 id를 레인별로 notify 하트비트(`lastStats.probeCursor`)에 남기고, 다음 틱은 **그 다음 고객부터** 시작한다. 선점도 같은 커서로 돌린다(`claimDueJobs({ rotateAfter })`: 어떤 잡을 집을지만 커서 뒤 고객 우선으로 정하고, 돌려주는 순서는 공정 순서 그대로) — 만기 고객이 선점 수(50)보다 많아도 창이 커서를 따라 움직인다. 커서가 없으면(직전 틱에 업체가 응답했거나 첫 틱) 공정 순서의 첫 고객부터 시작한다. 업체가 응답한 뒤의 순서(②)는 그대로다. 이전 규칙 `(분 번호 × 보폭) mod 고객 수`는 한 틱이 보폭만큼 탐침한다고 가정해서, 저장소가 느려 탐침 수가 줄면 시작 위치가 멈추거나 위치를 건너뛰었다(고객 20·49·50곳에서 일부 위치 미도달) — 지금은 "지난 틱이 멈춘 곳"에서 이어 가므로 보폭·gcd·분 번호와 무관하다. **보장**: 레인의 만기 고객 n곳, 한 틱에 탐침하는 고객 P곳일 때 정상 고객의 호출은 최악 **`⌈n ÷ P⌉ − 1`틱** 밀린다. P는 틱이 실제로 해내는 수다: 저장소가 빠르면 25, 저장소 호출 1건이 0.4초·1초면 20, 2.5초면 15. **측정값**(실제 `runTick` + `MemoryTickStore`, n = 1…60곳 × 정상 고객을 **모든 위치**에 × 저장소 지연 4가지, 나머지 n − 1곳은 무응답 × 20건; `packages/core/test/r24-rotation.test.ts`가 매번 전부 돌린다 — 미도달 0, 중복 0, 틱 ≤ 60초) — 최악 지연(틱): **저장소 빠름(P = 25)** n 1–25: 0, 26–50: 1, 51–60: 2 / **호출당 0.4초·1초(P = 20)** 1–20: 0, 21–40: 1, 41–50: 2, 51–60: 2 / **호출당 2.5초(P = 15)** 1–15: 0, 16–30: 1, 31–45: 2, 46–50: 3, 51–60: 3. n ≤ 50에서는 측정값이 `⌈n ÷ P⌉ − 1`과 정확히 같다. **50곳 초과**(선점 한도): 커서가 있는 틱은 선점 창도 커서를 따라가므로 계속 전진한다. 다만 커서가 없는 첫 틱의 선점은 공정 순서의 앞 50곳이어서 그 틱에 창 밖이던 고객은 한 바퀴 안에 닿는다 — 보장은 `⌈n ÷ P⌉`틱(측정은 51–60곳에서 2~3틱). 60곳 초과는 재지 않았다. **남은 한계**: ① 커서는 하트비트에 실린 참고 상태다. notify 하트비트 쓰기나 틱 시작의 읽기가 실패하면 그 레인은 다시 공정 순서의 처음부터 시작한다(하트비트가 계속 안 써지면 `/health`가 stale로 알린다). ② 한 레인을 두 실행기가 겹쳐 돌리면 둘 다 커서를 옮긴다(나중에 쓴 쪽이 남는다). ③ 예산이 끝나면 보내지 못한 선점은 **그 즉시** 병렬로 되돌린다(전에는 진행 중인 호출이 다 돌아온 뒤였다). 저장소가 되돌리기조차 다음 틱 전에 끝내지 못할 만큼 느리면(호출당 약 10초 이상) 임대(60초)로 돌아오는 잡은 다음 틱 선점에 빠지고, 그 고객은 한 바퀴 뒤에 닿는다. ④ **일부만 무응답인 레인**(매 틱 누군가는 응답)에서는 커서를 쓰지 않는다 — 응답 뒤의 순서(②, 벌점 + 공정 순서)가 적용되고, 정상 고객 앞에 무응답 고객이 24곳을 넘게 서 있으면 그 고객들의 대기 잡이 재시도 간격으로 빠질 때까지 밀릴 수 있다(R-22 범위, 이번에 바꾸지 않음). ⑤ MSP 기본 채널처럼 수신자를 공유하는 고객은 그 수신자가 호출 중이면 그 틱에 건너뛴다. 정상 고객의 호출이 **같은 틱**에 나가는 조건은 전과 같다: 앞에 선 무응답 고객 24곳 이하 + 저장소가 빠를 때(느리면 19곳, 2.5초면 14곳). 밀리는 틱 동안 notify 하트비트는 `DEGRADED`다. 그 밖의 측정: `packages/core/test/security-review-5.lanes.test.ts`(25·30·40·49곳 × 20건, 시작 분을 바꿔 가며 25·40곳, 저장소 지연 0.4초·1초 × 19·24·40곳), 같은 시나리오를 SQL 저장소로 돌린 `packages/store-sql/test/contract.lanes.test.ts`(6 × 5, 5 × 20, 12 × 20, 24 × 20, 25·40 × 20, 실행기 3개 동시). **부분 장애가 길면 포기가 생긴다**(N-38): 타임아웃이 60%인 채 30분이면 360건 중 22~33건이 5회 실패로 `GAVE_UP`이 된다(7b85c90은 같은 조건에서 1~4건만 포기하고 150~180건을 60분 넘게 쥐고 있었다). **검증 방법**: `packages/core/test/security-review-4.lanes.test.ts`(현재 엔진, 위 수치)와 `security-review-4.baseline.test.ts`(현재 엔진 대 **실제 7b85c90 core** — `git archive 7b85c90 packages/core/src`로 꺼내 `test/fixtures/baseline-7b85c90/`에 둔 것, 다시 구현한 것이 아님). 두 엔진 모두 자기 `runTick`·`MemoryTickStore`를 같은 가짜 업체·가짜 타이머로 돌린다. 확인하는 규칙: 정상 고객의 SEV-1은 1틱을 넘겨 늦지 않는다(저장소가 빠를 때 H ≤ 49, 같은 틱은 H ≤ 24) / 검토자 시나리오 전체(한 고객 무응답, 무작위 타임아웃 20·40·60% × 시드 5, 깜빡임 3/1·5/1·30초/30초·1/1·10/2, H곳 × 깊이 × 추가 유입, k개 번호, 레인 간)에서 7b85c90보다 1틱 넘게 나빠지지 않는다(전달 지연을 순위별로 비교) / 같은 멱등 키가 두 번 성공하지 않는다 / 틱 ≤ 60초. 3차까지 이 줄이 인용하던 "기준선"은 7b85c90을 손으로 다시 쓴 시뮬레이터(`lane-sim.ts`)였고 실제 7b85c90과 결과가 달랐다. 그 파일과 그것에 기댄 테스트는 지웠다. 한계: 업체와 틱의 시계는 가짜다. 저장소는 메모리와 SQL(PGlite, `TEST_DATABASE_URL`이 있으면 실제 Postgres) 둘 다로 같은 계약 테스트를 돌린다(`packages/core/test/contract`). 실제 업체와 실제 네트워크 지연으로는 재지 않았다 |
| 반환 | 예산 때문에 보내지 못한 잡은 `QUEUED`로 돌아가고 **만기를 다시 찍지 않는다**. 되돌리기는 예산이 끝나는 즉시, 병렬로 한다(진행 중인 호출을 기다리지 않는다) |
| 시각 | 만기·임대·재시도 시각은 **DB 시각(`now()`)**으로 계산한다. 실행기 시계는 틱 예산에만 쓴다(위 "시계" 줄: 30초 넘게 다르면 틱을 하지 않고, 그 안이면 저장되는 시각도 DB 시각으로 맞춘다) |
| Slack 채널 여러 개 | 한 잡의 채널들은 동시에 보내고 잡 전체가 타임아웃 10초 하나를 쓴다. 하나라도 성공하면 `SENT` |
| 발송 직전 재확인 | 인시던트 상태(Ack·Resolve면 `SKIPPED`), 수신자의 고객 일치, 활성 여부, 주소, SMS·음성은 확인된 번호(D-37). 조회가 실패해도 시도 1회로 세고 5회면 `GAVE_UP` |
| 점검 창 | 호출이 대기 중에 점검 창에 들어가면(SEV-1 제외) **버리지 않고 창이 끝날 때까지 미룬다**(시도 횟수 불변, 창 취소를 알아채도록 5분마다 재확인, 타임라인 1줄). 창이 끝난 뒤 인시던트가 아직 TRIGGERED면 보내고, Ack·Resolve됐으면 `SKIPPED` |

**발송 포트 요건 (업체 어댑터).** ① 업체 호출에 잡의 `idempotencyKey`를 넘기고 **업체(또는 어댑터)가 그 키로 중복 발송을 막아야 한다**. 타임아웃된 호출은 실제로 전달됐을 수 있고, 재시도와 임대를 넘겨받은 다른 실행기가 같은 키로 다시 호출한다. 업체가 키를 지원하지 않으면 어댑터가 `키 → providerMessageId`를 저장해 같은 답을 돌려준다. ② 어댑터 자체 타임아웃은 10초 미만. ③ 동시 5건 호출을 견딘다(한 틱의 첫 호출은 1건씩 온다). ④ 전달 실패는 예외가 아니라 `{ ok:false, retryable, code? }`로 돌려준다. 오류 문구는 저장 전에 300자로 자르고 번호·주소·비밀값을 가린다.

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
| `OFFBOARD_ACCOUNT` | `{ offboardingId }` (+ 최상위 `cloudAccountId` 필수) | **구현됨.** 고객이 `TERMINATED`가 아니면 `REFUSED`. 계정 리전 + us-east-1에서 목록(ARN 계정·리전, `ManagedBy=AlarmOps` 태그) → 삭제 직전 배치마다 다시 읽어 확인 → `DeleteAlarms`. 결과는 `CustomerOffboarding.steps.ALARMS_DELETED`에 계정별로 합쳐 기록(전부 OK=DONE, 하나라도 `CAPABILITY_DISABLED`·`FAILED`=MANUAL, 사람이 DONE으로 표시한 것은 덮지 않음). 실패는 기록 후 재시도. 해지 고객의 계정만 건드린다. 해지 고객 계정의 `ManagedBy=AlarmOps` 알람만 삭제(다른 알람은 건드리지 않음). 삭제 전 계정·리전·태그를 다시 확인. 결과는 계정별 `deleted`·`failed`·`CAPABILITY_DISABLED` | AlarmWriter | D-43 |

- 멱등: `commandId` = 메시지 중복 제거 키. 엔진은 처리 전 `ThresholdChange.applyStatus`·`RemediationRequest.status`를 조건부로 선점한다. `APPLY_THRESHOLD`가 `PENDING`이 아니면 무시.
- 역할이 없거나 꺼져 있으면 실행하지 않고 결과를 `CAPABILITY_DISABLED`로 기록.
- 리소스 태그 `Threshold_*`가 있으면 콘솔 값을 적용하지 않고 `SKIPPED_TAG_WINS`(D-08, D-19).
- 엔진 테스트는 AWS 호출을 모두 목으로(backend 지침).

## 7. 알람 엔진 ↔ DB 계약 (B10)

| 테이블 | 엔진 | 콘솔 | 비고 |
|---|---|---|---|
| CloudAccount | 읽기, `*Status`·`lastCheckedAt` 쓰기 | CRUD | |
| CustomerOffboarding | `steps.ALARMS_DELETED`·`completedAt`만 쓰기(행 잠금) | 생성·읽기 | D-43 |
| Resource | 쓰기(upsert, 상태 전이) | 읽기 | 발견 실패 시 지우지 않음(4-9) |
| ManagedAlarm | 쓰기 | 읽기 | 버전 조건 |
| ThresholdDefault | 읽기 | 쓰기 | |
| ThresholdChange | `applyStatus`·`error`만 갱신 | INSERT | 추가만(그 외 컬럼 불변) |
| AlarmSyncRun | 쓰기 | 읽기 | |
| RemediationRequest | `EXECUTING→SUCCEEDED/FAILED` | 생성·승인 | |
| Alert / Incident | `CHECK_ALARM_LIVENESS` 결과로 해소(`resolvedVia=RECONCILE`), 지문 `episodeOpen=false` | 읽기·ack | I-6 3 |

엔진은 Prisma 클라이언트를 쓰지 않을 수 있다(Python 이식, D-05). 그 경우에도 위 표 밖의 테이블에 쓰지 않고, 스키마는 `prisma migrate`가 유일한 정본이다(D-09 원칙 6). 엔진 언어·DB 드라이버는 Q-API-05.

## 8. 콘솔 REST (B5)

역할 표기: V = VIEWER 이상, O = OPERATOR 이상, A = ADMIN, P(grant) = 고객사 담당자 + portalGrant. 역할 체계 자체는 미결(Q-DM-02)이라 이 열은 임시. **I** = MSP 직원(INTERNAL) 전용: 포털 사용자에게는 그 경로가 없다(파라미터를 보기 전에 같은 404, `/oncall/paging-path`와 같음).

**호출 경로 화면의 역할 (D-41, 확정).** Responders(`/customers/{id}/responders`), `/customers/{id}/paging-health`, `/rotations`, `/staff`, `/oncall/now`:
| 호출자 | 읽기(GET) | 쓰기(POST·PATCH·DELETE) |
|---|---|---|
| MSP VIEWER | 200 | 403 `ROLE_REQUIRED`(`details.role: "ADMIN"`), 바뀌는 것 없음 |
| MSP OPERATOR | 200 | 403 `ROLE_REQUIRED`, 바뀌는 것 없음 |
| MSP ADMIN | 200 | 규칙대로 실행 |
| 포털 사용자(저장된 역할과 무관, ADMIN이어도) | 같은 404 | 같은 404 |

지금 쓰기가 있는 것은 Responders뿐이다. `/rotations`·`/staff`에 쓰기 경로가 생기면 같은 규칙(ADMIN)이다. 계약 테스트 `packages/api/test/contract/peopleContract.ts`의 "roles on Responders…(D-41)"가 메모리·SQL 저장소 둘 다에서 역할마다 고정한다.

**배포 (D-09).** 콘솔 REST는 콘솔 앱 안에 있다: `apps/console/src/app/api/v1/[...path]/route.ts`(Node 런타임)가 `packages/api`의 `createApi`를 `packages/store-sql`(node-postgres, `DATABASE_URL`, 트랜잭션 풀러면 `DATABASE_POOLER=transaction` — db/README.md "Connecting")에 붙여 그대로 돌린다. 다른 서비스로 나가는 호출은 없다.
- **AuthContext는 서버가 세션에서 만든다.** 세션 쿠키(서명 검증) → `User.id` → `ACTIVE`인 사용자만 → `customerId`가 있으면 포털(그 고객 하나, PORTAL_USER 범위가 프로젝트·서비스면 그 하위로 좁힘), 없으면 MSP 직원(전 고객, D-34), 역할은 `User.role`. 요청 본문·헤더의 사용자·역할·고객 값은 읽지 않는다. 모르는·비활성 사용자는 401. **포털 사용자는 그 고객의 `Customer.status`가 `ACTIVE`일 때만 세션이 있다(D-42)**: `SUSPENDED`·`TERMINATED` 고객의 포털 사용자는 `sessionPrincipal` → null → 401(요청마다 확인하므로 상태를 바꾸면 다음 요청부터). MSP 직원은 고객 상태와 무관하고, 그런 고객의 데이터도 계속 본다. 고객 상태를 바꾸는 API·콘솔 화면은 아직 없다(DB에서만, D-42).
- 쓰기(POST/PUT/PATCH/DELETE)는 콘솔과 같은 Origin에서만(`sameOriginPost`, 아니면 403 `FORBIDDEN`). API로 넘기는 헤더는 `If-Match`·`If-None-Match`·`Idempotency-Key`뿐(쿠키는 넘기지 않음).
- 콘솔의 서버 컴포넌트·서버 액션은 같은 핸들러를 프로세스 안에서 부른다(같은 요청·응답 모양, 네트워크 없음).
- `DATABASE_URL`이 없으면 503 `NOT_CONFIGURED`(localhost 대체 없음). 목 모드(`MOCK_API=1`, 운영 금지)에서는 `/api/v1`이 404다.

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
6. slug 예약어(`incidents` `incident` `monitoring` `call-order` `people` `maintenance` `thresholds` `alarms` `resources` `settings` `new` `-`)는 프로젝트·서비스·고객 생성 시 접미사를 붙여 피한다(컬럼과 규칙: DATA-MODEL §1 Customer · Project / Service. 이름 변경 시 옛 주소 처리만 미결 Q-API-09).

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
| GET `/incidents/{id}/notifications` | NotificationLog(P3-2). 항목 `{ id, at, channel, status, targetSummary, escalationStep, reason, attempt }` + 내부 사용자에게만 `providerMessageId`, `warnings`, `error`. **`reason`**(모든 사용자): 실패 이유 코드 `TIMEOUT \| INVALID_DESTINATION \| RATE_LIMITED \| PROVIDER_REJECTED \| PROVIDER_ERROR \| NOT_CONFIGURED \| GAVE_UP` 또는 `null`. `error`(가린 업체 문구)는 기본(`STORE_PROVIDER_TEXT=false`, D-39 임시)에서 **내부 ADMIN에게만** 값이 있고(가린 발췌, 120자 이하) 내부 OPERATOR·VIEWER에게는 `null`이다. `STORE_PROVIDER_TEXT=true`면 내부 OPERATOR·ADMIN이 가린 300자를 본다. 포털 응답에는 어느 쪽이든 키가 없다. 가리기(마스킹)는 패턴 방식이라 완전하지 않다(중립 키 아래의 비밀값, 문장 속 값 등은 통과) — 그래서 기본이 "코드 + 짧은 발췌, 읽는 사람 최소"다 | V |
| POST `/incidents/{id}/ack` | TRIGGERED→ACKNOWLEDGED. **`If-Match: <version>` 필수**(없으면 400, 불일치 409 `VERSION_CONFLICT` — 오래된 목록에서 누른 Ack가 그 사이 재발화·에스컬레이션된 인시던트에 적용되지 않게, security R-3). 응답 `{ incident, undoToken }` — 목록 행·카드·패널의 Acknowledge는 이 엔드포인트를 쓴다. `undoToken`은 `/incidents/bulk/undo`에 그대로 쓴다(5분, Ack한 본인, 그 사이 다른 전이가 없을 때. 에스컬레이션은 멈췄던 단계부터 이어진다) | O |
| POST `/incidents/{id}/resolve` | `{ kind?, note? }` → Resolution. **`If-Match` 필수**(ack와 같음: 없으면 400, 불일치 409) | O |
| POST `/incidents/{id}/escalate` | 즉시 다음 단계. **`If-Match` 필수.** 인시던트당 60초에 1회(429 `RATE_LIMITED` + `Retry-After`). 점검 창이 덮으면 409 `MUTED_BY_MAINTENANCE`(SEV-1 제외). 일괄 처리에는 없다 | O |
| POST `/incidents/bulk` | `{ action: "ack"|"resolve", items: [{ id, version }], preview: true }` → 대상 목록 → `preview:false`로 실행, 응답 `{ done[], conflicts[{id, code}], undoToken }`. **항목마다 `version` 필수**: 버전이 다른 항목은 건너뛰고 `conflicts`에 `VERSION_CONFLICT`로 돌려준다(나머지는 실행). 버전 없는 `ids[]`만 보내는 형식은 받지 않는다(R-3). 범위 밖 id는 `conflicts`에 `NOT_FOUND` | O |
| POST `/incidents/bulk/undo` | `{ undoToken }` (5분) → `{ restored[], skipped[{id, code}] }`. 단건 Ack의 `undoToken`도 받는다. **Undo 규칙:** 누른 사람만, 1회, 그 뒤로 아무도 건드리지 않은 항목만(버전이 같아야 함, 아니면 `skipped`에 `VERSION_CONFLICT`). 모르는·쓴·만료된·남의 토큰은 같은 404. Ack를 되돌리면 호출은 멈췄던 단계에서 이어지고, Ack 때문에 취소됐던 **현재 단계의** 대기 중 호출만 되살아난다(이미 나간 호출은 다시 보내지 않고, 이전 단계·다른 사유의 건너뜀은 그대로, 다음 단계 시각은 옮기지 않음). Resolve를 되돌린 인시던트는 병합 대상으로 돌아가지 않는다 | O |
| GET `/alerts/{id}` | 알림(지문) 상세, RawEvent 이력, 억제 판정 이력 | V |

**목록·상세 항목의 확정 필드 (11/12, 콘솔 `types.ts`의 PROPOSED 정리).** `key`(표시 키 `INC-yyyymmdd-HHMM-XXXX`, UTC), `escalated`(TRIGGERED이고 한 단계 이상 나감), `escalation { state: PAGING\|MUTED\|STOPPED_ACKED\|STOPPED_RESOLVED\|STOPPED_EXHAUSTED\|NEVER_ESCALATING\|UNREACHABLE, step, firedSteps, totalSteps, repeat, repeatCount, nextAt, nextLabel, doneAt, baseAt, stoppedAt, renotifyAt, mutedByMaintenance }`, 상세의 `paged[{label, at, done}]`. `assignmentSnapshot.planLabel`은 문장으로만 준다(구조화된 style·plan·edited는 없다 — 콘솔이 문장을 해석). `counts.meta`(타일 보조 줄)는 **선택이고 아직 보내지 않는다**(콘솔은 "—"/0).

**포털(고객) 사용자 응답 모양 (D-36).** 인시던트 목록·상세·타임라인·통지 기록은 같은 경로를 쓰되 내부 식별자가 없다. `assignee` / `acknowledgedBy` / `resolvedBy`: `{ name }`만(`contactId`·`via` 없음). `assignmentSnapshot`: `{ capturedAt, planLabel, level, repeatCount, steps[{ index, atMin, targetType, resolved[{ name }], channels, label? }] }`(`pagingConfigId`·`targetId` 없음). 타임라인 항목: `actorId: null`, `message`는 구조화 데이터로 다시 만든 문장. 통지 기록: `providerMessageId`·`error`·`warnings` 없음, 채널은 `Slack channel`. **MSP 직원 이름은 `MSP on-call`**로 나가고(플래그 `PORTAL_SHOWS_STAFF_NAMES=true`일 때만 실명), 그 고객 자신의 사람은 실명이다. `awsAccountIds`는 빈 배열.

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
| GET `/oncall/now?customerId=&customer=&project=&service=&mine=&onlyProblems=` | Call order 목록(구현됨). 응답 `{ rotations: RotationSummary[], rows: CallOrderRow[] }`. `rows[]`: 고객 행(항상 `own: true`) + 범위 안에서 자기 단계를 가진 프로젝트·서비스 행 + 요청한 노드 자신의 행(물려받았으면 `own: false`, `inheritedFrom {level,id,name}`). 행 `{ key: "<customer>/<project>/<service>" slug, org: OrgChain, level, own, inheritedFrom, style, plan, edited, steps: PagingPathStep[](아래 paging-path와 같은 모양), repeatCount, responderCount(Pageable), health: {level, problems: n, first?} \| null(고객 행만) }`. 정렬: UNREACHABLE → AT_RISK → OK, 같으면 이름. `onlyProblems=true`: health가 OK가 아니거나 열린 인시던트가 있는 고객만. 범위가 프로젝트·서비스로 좁혀진 직원은 그 하위 행만. `rotations[]`는 아래 `/rotations` 항목 모양. 알림 해석과 같은 함수(Leave·Override 적용). `contactId`·`style` 파라미터는 아직 없다 | V, I |
| GET `/oncall/paging-path?q=` 또는 `?resourceId=` / `?serviceId=` / `?projectId=` / `?customerId=` / slug `?customer=[&project=[&service=]]`(콘솔 패널) | **INTERNAL 전용**: 포털 사용자에게는 이 경로가 없다(파라미터를 보기 전에 404). "Who gets paged for…". 응답 `{ path: [{level:"RESOURCE"\|"SERVICE"\|"PROJECT"\|"CUSTOMER", id, name}], customer: {id,name}, inheritedFrom: {level, id, name}, style, plan, edited, pagingConfigId, version, steps: [{atMin, targetType:"PERSON"\|"ROTATION"\|"ALL_RESPONDERS", targetId?, nowIds[], names[], channels}], repeatCount, stopAtMin, sentence, customerNotified: [{contactId, name, scope:{level,id,name}}] }`(Notify only 고객 사람). 추가 필드: `own`(요청한 단계 자신이 단계를 가짐), `sharedRotationId`(SHARED_ROTATION), 단계마다 `targetName`(로테이션·사람 이름)·`targetIsCustomerPerson`, 아무에게도 닿지 않으면 `warning: "NOBODY_REACHABLE"`, 설정이 없으면 `warning: "NO_CALL_ORDER"`·`inheritedFrom: null`. `updatedByName`·`updatedAt`은 선택(아직 보내지 않음). `q`는 이름 접두 검색, 여러 건이면 `candidates[]` 반환. `/oncall/now`와 같은 해석 함수 | V |
| GET/PUT `/customers/{id}/paging` | D-30 개정. `{ style: ALL_AT_ONCE\|CUSTOMER_ROTATION\|SHARED_ROTATION\|CUSTOM, plan: STANDARD\|URGENT\|QUIET, sharedRotationId?, steps[{atMin, targetType: PERSON\|ROTATION\|ALL_RESPONDERS, targetId?, channels[]}], repeatCount }` (If-Match). `plan`만 바꾸면 서버가 템플릿으로 단계 재생성(`edited=false`). 응답에 `sentence`(실명 미리보기)와 `sendCap { perCycle, perHour, limits, exceeded }`(지금 Responder 기준으로 매번 다시 계산, `exceeded`는 `null` 또는 지금 저장하면 받을 오류 코드). **아직 저장한 단계가 없으면 GET은 `version: 0`, `steps: []`, ETag `"0"`을 주고, 첫 PUT은 `If-Match: 0`으로 보내 201을 받는다**(이후 PUT은 200). 삭제 후 다시 만들어도 버전은 이어진다. 한도는 §2 "한도" | A |
| PUT/DELETE `/customers/{id}/paging-overrides/{scopeType}/{scopeId}` | PROJECT·SERVICE 덮어쓰기. 해석 service › project › customer | A |
| GET `/customers/{id}/paging-health` | D-32. `{ level: OK\|AT_RISK\|UNREACHABLE, problems[{ code: NO_PAGEABLE_RESPONDER\|NO_VERIFIED_PHONE\|STEP_UNVERIFIED_ONLY\|ROTATION_GAP\|SEND_CAP_EXCEEDED, stepIndex?, contactIds[], rotationId?, from?, to?, message, skipped? }] }`. 서버가 Responders·단계·채널 검증·교대표(앞으로 14일)로 계산(core `pagingHealth`, 트리의 `callHealth`와 같은 함수). 저장하지 않음. Call order 화면이 모든 직원에게 보여 주므로 읽기는 V(11/12, 이전 A). 고객 전체 범위의 직원만(좁혀진 직원은 404) | V, I |
| GET `/customers?pagingHealth=UNREACHABLE,AT_RISK` | 고객사 목록 필터. 목록 항목마다 `pagingHealth.level`과 `problems` 개수 포함. 정렬 기본: UNREACHABLE → AT_RISK → OK | A |
| GET `/oncall/now?onlyProblems=true` | Call order 목록. ~~고객사 10곳 초과 시 콘솔이 기본으로 켬~~ → 트리의 `Only with problems`(`/scope-tree`)가 대신하고 기본은 꺼짐 | V, I (D-41, 이전 A) |
| GET `/customers/{id}/responders` | 아래 "Responders" 참조 | V, I |
| POST `/customers/{id}/responders`, PATCH/DELETE `/customers/{id}/responders/{contactId}` | 아래 "Responders" 참조. `If-Match: <목록 version>` 필수 | A, I |
| GET/POST `/rotations?scope=&customerId=`, PATCH/DELETE `/rotations/{id}`, GET `/rotations/{id}/shifts?from=&to=`, GET `/rotations/{id}/usage` | Rotation(scope MSP\|CUSTOMER). usage = 참조 고객·단계 | 읽기 V, I · 쓰기 A, I (D-41) |
| POST `/rotations/{id}/overrides`, POST `/overrides/{id}/accept\|decline` | COVER/SWAP, 상대 수락 후 반영(D-28) | O |
| GET/POST `/responder-templates`, PATCH `/responder-templates/{id}`, POST `/responder-templates/{id}/preview` | 템플릿 변경 시 영향 고객 미리보기, PATCH는 `previewHash` 필수 | A |
| GET `/rotations?scope=MSP\|CUSTOMER&customerId=` (구현된 읽기) | `RotationSummary[]`: `{ id, scope, customerId?, name, onShift: { contactId, name, until, channels } \| null, next: 다음 당번 이름 \| null }`. MSP 로테이션 + 범위 안 고객의 로테이션. `customerId`가 있으면 MSP 것 + 그 고객 것(범위 밖·없는 고객은 404). `channels`는 아래 채널 상태 | V, I |
| GET `/staff?q=` (구현됨) | 활성 MSP 직원 Contact `[{ contactId, name, channels }]`, 이름 순, `q`는 이름 부분 일치. 연락처 값은 없다 | V, I |
| GET `/staff/{id}/coverage` | People: `{customerCount, onShift[], nextShift, customers[{id, via[]}]}` | V |
| POST `/staff/{id}/leave/preview`, POST `/staff/{id}/leave`, DELETE `/leaves/{id}` | `{from, to, replacementId}` → `{customers[{id,effects[]}], rotations[{id,shifts[]}], totals, previewHash}`. 적용은 같은 본문 + previewHash, 다르면 409 `PREVIEW_STALE`. BulkChange + AuditLog 기록 | A |
| POST `/staff/{id}/customers/preview`, POST `/staff/{id}/customers` | 직원을 여러 고객 Responders에 추가 `{customerIds[]}` | A |
| GET `/bulk-changes?contactId=&kind=` | 일괄 변경 감사 | V |
| GET `/contacts/needs-action?kind=&customerId=&channel=&q=` | 직원·고객 통합 Needs action 목록(한 정의: 확인 안 된 채널이 하나라도 있는 사람). 응답 `{ people[], counts:{people, staff, customer, linkable, notSet} }` | A |
| GET/POST `/routing-rules`, PATCH/DELETE `/{id}` | | A |

#### Responders (D-32, D-35, security review 권고 2·3·6, 11/12 구현)

`GET /customers/{id}/responders` →
```json
{ "staff":  [{ "contactId": "ct_…", "source": "DIRECT|TEMPLATE", "templateId": "…", "templateName": "…", "name": "Haeun Kim",
               "channels": { "SLACK": "VERIFIED", "EMAIL": "VERIFIED", "SMS": "UNVERIFIED", "VOICE": "UNVERIFIED" },
               "emailMasked": "h•••@msp.example", "phoneMasked": "010-••••-1234" }],
  "people": [{ "contactId": "ct_…", "role": "PAGEABLE|NOTIFY_ONLY", "extras": ["APPROVER","PORTAL_USER"], "scope": { "level": "CUSTOMER|PROJECT|SERVICE", "id": "…", "name": "…" },
               "name": "Yuna Seo", "channels": { … }, "emailMasked": "…", "phoneMasked": "…" }],
  "templateId": null, "version": 3, "slackChannel": "VERIFIED|NOT_SET" }
```
- 순서는 `Responder.order`, 같으면 contactId. `staff` = INTERNAL Contact, `people` = 그 고객의 Contact. `scope`는 그 사람의 NOTIFY ContactScope(없으면 첫 ContactScope, 그것도 없으면 고객). `extras`는 APPROVER·PORTAL_USER ContactScope.
- **채널 상태**(`channels`): `SLACK`·`EMAIL`·`SMS`·`VOICE`마다 `VERIFIED`(값 + 유효한 확인 시각) / `UNVERIFIED`(값만) / `NOT_SET`. SMS·VOICE는 전화 하나를 본다. 콘솔 타입에는 `EXPIRED`·`LINK_SENT`도 있으나 API는 아직 보내지 않는다.
- **연락처 값은 나가지 않는다**(D-35): `emailMasked`(첫 글자 + `•••@도메인`), `phoneMasked`(앞 3자리 + `-••••-` + 끝 4자리). 전체 값은 `/contacts/{id}/reveal`만.
- **`version`**: 목록의 낙관적 잠금 버전. Responders 쓰기(아래)마다 1씩 오르고 되돌아가지 않는다. 저장: 그 고객의 `AuditLog`(`targetType = 'Responders'`) 행 수 — 쓰기와 같은 트랜잭션에서 고객 행을 `FOR UPDATE`로 잠그고 다시 센다(스키마 변경 없음). 이 API 밖의 변경(템플릿 동기화, 시드)은 버전을 올리지 않는다. 응답 `ETag: "<version>"`.

쓰기 — 모두 ADMIN(D-41: VIEWER·OPERATOR 직원은 403 `ROLE_REQUIRED`, 포털 사용자는 404), `If-Match: <version>` 필수(없으면 400, 다르면 409 `VERSION_CONFLICT` + `details.currentVersion`), 응답 `{ contactId, version }`(POST 201, 그 밖 200). 검사 순서: 범위(고객 전체 범위가 아니면·없으면 404) → 대상이 이 목록에 있는가(PATCH/DELETE, 없으면 404) → 역할(403) → If-Match → 아래 규칙.

| 요청 | 본문 | 규칙 |
|---|---|---|
| POST | `{ contactId, role? }` | 활성 MSP 직원(항상 PAGEABLE) 또는 **이 고객의** 사람(기본 NOTIFY_ONLY). 다른 고객의 사람·없는 id·비활성은 **같은 404**(이전 계약의 422 `CROSS_CUSTOMER` 대신 — 다른 테넌트 id가 실재함을 알리지 않는다, 권고 3). 이미 있으면 409 `ALREADY_EXISTS` |
| POST | `{ name, email?, phone?, role, extras?: ["APPROVER"\|"PORTAL_USER"] }` | 새 고객 사람(Contact CUSTOMER + Responder + extras는 고객 단계 ContactScope). 이름 1~80자, 이메일·전화 중 하나 필수, 형식 400. 새 값은 미확인 상태(확인 링크는 아직 보내지 않음). `insertStep`은 아직 없다 |
| PATCH `/{contactId}` | `{ role }` | 고객 사람만(직원은 404). NOTIFY_ONLY로 바꾸려는데 어떤 단계가 그 사람을 PERSON으로 지정하면 409 `IN_USE` |
| DELETE `/{contactId}` | — | 템플릿에서 온 직원은 409 `FROM_TEMPLATE`(템플릿에서 바꾼다). 단계가 지정한 사람은 409 `IN_USE` |

- **409 `WOULD_BE_UNREACHABLE`** (권고 6): PATCH·DELETE 결과 고객의 paging-health가 UNREACHABLE이 되면(전에는 아니었는데) 실행하지 않는다. `?confirmUnreachable=true`(사용자가 경고를 본 뒤)이면 실행한다. `details.level`.
- **D-38**: 목록을 늘리는 쓰기(POST, PATCH→PAGEABLE)가 이 고객의 어느 호출 순서를 한도 밖으로 밀면 422 `RESPONDER_LIMIT_EXCEEDED`(`details {field, responders, limit}`) / `SEND_CAP_EXCEEDED` — 호출 순서 저장과 같은 `sendCapViolation`. 이미 넘어 있던 것은 막지 않는다(paging-health가 보여 준다).
- 감사: 쓰기마다 AuditLog 1행 `responders.add|create|role|remove`, `before/after`는 버전·역할만(이메일·전화 없음).

### 8.4 조직·계정·연동
| 메서드 경로 | 설명 | 권한 |
|---|---|---|
| GET/POST `/customers`, GET/PATCH/DELETE `/customers/{id}` | | A (GET V) |
| PATCH `/customers/{id}/status` | **D-43, 구현 전(이슈 #19의 남은 항목: 저장소 포트·핸들러 미구현).** `{ status: ACTIVE\|SUSPENDED\|TERMINATED, reason, confirmName? }` (If-Match). `TERMINATED`로 갈 때는 `confirmName`이 고객사 이름과 같아야 한다(아니면 400). `TERMINATED`에서 다른 상태로는 409 `CUSTOMER_TERMINATED`. `TERMINATED`가 되면 서버가 `CustomerOffboarding`을 만들고 계정마다 `OFFBOARD_ACCOUNT`를 발행 → `200 { status, offboardingId? }`. 감사 기록 남김. 일반 PATCH `/customers/{id}`로는 상태를 바꿀 수 없다 | A |
| GET `/customers/{id}/offboarding` | D-43 체크리스트: `{ steps[{ key: PAGING_STOPPED\|ALARMS_DELETED\|CUSTOMER_STACK_REMOVED\|ACCOUNTS_DISABLED\|BUS_ALLOWLIST_REMOVED, state: DONE\|PENDING\|MANUAL, detail? }], residual: { lastEventAt?, count } }`. `CUSTOMER_STACK_REMOVED`는 사람이 표시(고객 계정이라 우리가 지울 수 없다). PATCH로 MANUAL·PENDING 항목 완료 표시 | A |
| GET/POST `/customers/{id}/projects`, `/projects/{id}/services` (+PATCH/DELETE) | 이름 유일 409 | A |
| GET/POST `/customers/{id}/accounts`, PATCH/DELETE `/accounts/{id}` | 12자리 검증, ExternalId 발급, 역할 ARN, 선택 기능 토글 | A |
| POST `/accounts/{id}/check` | `CHECK_CONNECTION` 발행 → `202 { commandId }` | A |
| GET `/accounts/{id}/status` | 역할별 상태·첫/마지막 수신(P4-1) | V |
| POST `/unmapped-accounts/{awsAccountId}/map` | `{ customerId, serviceId? }` 미매핑 복구(P2-3). INTERNAL 전용(고객 사용자는 404) | A |
| GET/POST `/assignments`, DELETE `/assignments/{id}`, PUT `/assignments/order` | | A |
| GET/POST `/contacts`, PATCH/DELETE `/contacts/{id}` | `kind: INTERNAL\|CUSTOMER`(D-29). GET 쿼리 `kind`, `customerId`, `customer`·`project`·`service`(slug), `mine`(§8.0: 범위를 주면 그 범위에서 호출·알림 받는 사람), `needsAction=true`(미확인·만료·미설정), `q`. **목록·단건 응답의 전화·이메일은 항상 가린 값**(`phoneMasked: "010-••••-4821"`, `emailMasked: "y•••@mirae.example"`)이고 `canReveal: boolean`과 `revealRequiresReason: boolean`이 붙는다(Responder면 `true`/`false`, Responder가 아닌 ADMIN이면 `true`/`true`, 그 밖은 `false`/`false` — D-35). 전체 값은 `/contacts/{id}/reveal`로만. 응답 항목에 `customerCount`(INTERNAL) 또는 `responderRole`·`scopes[]`(CUSTOMER), 채널별 `{status, via, at, expiresAt}`. CUSTOMER를 다른 고객이나 MSP 로테이션에 넣으면 422 `CROSS_CUSTOMER`, NOTIFY_ONLY를 단계·로테이션에 넣으면 422 `NOT_PAGEABLE` | A, P(contacts, 자기 고객 CUSTOMER만) |
| POST `/contacts/{id}/reveal` | **연락처 전체 값 열람(D-35).** 본문 `{ channel: "PHONE"\|"EMAIL"\|"SLACK", reason? }` → `{ channel, value, mode: "NORMAL"\|"EMERGENCY", revealedAt, auditId }`(`auditId` = ContactRevealLog.id). `Cache-Control: no-store`. **일반(NORMAL):** CUSTOMER 연락처는 그 고객의 Responder인 MSP 직원(직접 또는 템플릿 경유)과 그 고객의 포털 사용자(P contacts), INTERNAL 연락처는 같은 고객의 Responder인 직원. `reason`은 선택이고 주면 기록한다. **비상(EMERGENCY):** 호출자가 그 고객의 Responder가 아닌 **ADMIN(MSP)** 이면 `reason`이 필수다(앞뒤 공백을 뺀 뒤 1~500자, 직접 입력한 글). 없으면 422 `EMERGENCY_REASON_REQUIRED`이고 값은 주지 않는다. 서버가 호출자를 보고 mode를 정한다(클라이언트가 고르지 않는다. Responder인 ADMIN은 NORMAL). 비상은 CUSTOMER 연락처에만 있다. **그 밖:** Responder도 ADMIN도 아니면 403 `NOT_A_RESPONDER`(볼 수 있는 연락처에 대한 쓰기성 동작이라 403). **연락처가 범위 밖이면 없는 ID와 같은 404(§2) — 이 판정이 먼저다**: 범위 밖 호출자에게 403·422를 주지 않는다. **호출마다 ContactRevealLog 1행**(누가 · 누구의 연락처 · 고객 · 채널 · mode · 사유 · 시각, 값 자체는 기록하지 않음) + AuditLog 1행(`action: contact.reveal`). 기록에 실패하면 값을 주지 않는다(500). **비상 열람 뒤:** 같은 트랜잭션에서 그 고객의 주 Responder에게 가는 알림 1건을 아웃박스(NotificationJob)에 넣는다(내용: 누가 · 누구의 연락처 · 사유 · 시각. 연락처 값은 넣지 않는다). 주 Responder가 없으면 다른 ADMIN 전원에게(Q-API-14). 1인당 분당 30회 초과 429, 비상은 1인당 시간당 10회. GET이 아닌 이유: 프리페치·캐시·로그에 값이 남지 않게 | O(그 고객의 Responder), A(비상, 사유 필수), P(contacts) |
| GET `/contact-reveals?mode=&customer=&actorUserId=&contactId=&from=&to=` | **열람 기록 목록(D-35 검토 보기).** ContactRevealLog 커서 목록, 최신순. 항목 `{ id, at, mode, actor:{id,name}, contact:{id,name}, org.customer, channel, reason, notified:[{contactId,name}] }` — 연락처 값은 없다. `mode=EMERGENCY`가 Settings › Audit log의 `Emergency reveals`. ADMIN은 전 고객, 그 밖의 직원은 자기가 Responder인 고객의 기록만(범위 밖 `customer`는 404) | A, O(자기 고객) |
| (삭제) `/customers/{id}/people` | Responders & paging 탭으로 통합(`/customers/{id}/responders`, ContactScope는 아래) | |
| POST `/contacts/{id}/scopes`, DELETE `/contacts/{id}/scopes/{sid}` | `{ scopeType: CUSTOMER\|PROJECT\|SERVICE, scopeId, role: NOTIFY\|APPROVER\|PORTAL_USER }`. 중복 409 | A, P(contacts) |
| POST `/contacts/verify-bulk` | `{ contactIds[] }` 또는 `{ kind?, customerId?, filter: "needsAction" }` → `{ sent, notSet[] }`. 미설정(NOT_SET) 채널은 링크 대상 아님 → `notSet`으로 반환해 "Ask to add" | A |
| POST `/contacts/{id}/verify` | `{ channel, method: "link"|"manual", note? }` | A, P(contacts) |
| GET `/verify/{token}` | 1회용 확인 링크(세션 불필요, 토큰 해시 대조) | 토큰 |
| GET/POST `/customers/{id}/integrations`, PATCH/DELETE `/integrations/{id}` | Prometheus/Grafana. 생성 응답에만 평문 토큰 1회 | A |
| POST `/integrations/{id}/rotate-token` | 이전 토큰 즉시 무효(R5-1) | A |
| GET/POST `/notification-channels`, PATCH/DELETE `/{id}`, POST `/{id}/test` | 중복 409 | A, P(channels) |
| GET/PATCH `/users`, `/users/{id}` | 가입 승인, 역할 | A |
| GET `/me` | 세션 사용자 `{ id, name, email, role, kind: INTERNAL\|CUSTOMER }`. `role`은 실제로 적용되는 역할(포털 사용자는 VIEWER, 유효한 역할이 없는 직원도 VIEWER로 표시하되 쓰기는 거부). 범위 고객 목록은 `/scope-tree`가 준다 | 세션 |

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
| 콘솔 REST(§8) | 약 103 (11/10: `/scope-tree`, `/contacts/{id}/reveal`, `/maintenance-windows/preview`, `/contact-reveals` 추가) |
| Slack 인터랙티브 | 1 (action 7종) |
| 확인 링크·업체 콜백·채널 확인 링크 | 3 |

## 12. 미결 (API)

| ID | 질문 | 현재 처리 |
|---|---|---|
| Q-API-01 | "큐는 SQS 하나"가 큐 1개인가, SQS 기술 하나인가 | 큐 2개 + DLQ |
| Q-API-02 | pg_cron이 HTTP를 부르는 수단(pg_net은 Supabase 확장 → 이전 시 대체 필요) | D-23: pg_net(§5 SQL). 이전 때 EventBridge Scheduler |
| Q-API-03 | Vercel 콘솔이 SQS에 보낼 AWS 자격증명(Vercel OIDC → IAM 역할 vs 접근 키) | 미정, security 검토 |
| Q-API-04 | group_wait 30초를 SQS 지연 메시지로 지킬지, 1분 단위로 올릴지 | 지연 메시지 제안 |
| Q-API-05 | 알람 엔진 언어(Python 이식)와 DB 접근 방식(Prisma 외 드라이버 허용 범위) | 표 밖 쓰기 금지 |
| Q-API-06 | 국내 문자·음성 업체 선정과 콜백 서명 방식 | 솔라피 후보 |
| Q-API-07 | 고객 포털(소연) API를 같은 `/api/v1`에 역할로 나눌지, `/api/portal/v1`로 분리할지 | 같은 경로 + 범위 강제 |
| Q-API-08 | Ack 단위 결정 전 `POST /alerts/{id}/ack` 노출 여부 | 비활성 |
| Q-API-09 | slug 이름 변경 시 옛 주소 처리(404 vs 리다이렉트 — 포털은 리다이렉트 금지). ~~`slug` 컬럼과 예약어 처리~~는 정해짐(DATA-MODEL §1, 11/10) | 미정, backend. 현재: slug는 만든 뒤 바꾸지 않음 |
| Q-API-10 | 프로젝트·서비스 단계의 `callHealth`를 계산해 트리에 줄지(지금은 고객 단계만) | 고객 단계만 |
| Q-API-11 | `Undo`를 "이전 값 다시 저장"으로 할 때 알람 엔진 명령(`APPLY_THRESHOLD`)이 이미 나간 임계치 변경의 처리(두 번째 명령으로 덮어씀 vs 첫 명령 취소) | 두 번째 명령 |
| ~~Q-API-13~~ | ~~콘솔 주소 형식(문서 vs 콘솔 브랜치 구현)~~ **닫힘(11/10, 사용자 결정): 콘솔 구현 형식으로 확정** — 목록 `?customer=&project=&service=` · `?mine=1`, 패널 `/c/<customer>/<project>/<service>/incident/<id>`, 미매핑 `/c/-/incident/<id>`. 기준 `docs/ui/screens/shell-scope.md` §7 | 닫힘 |
| ~~Q-API-12~~ | ~~연락처 열람 규칙의 예외~~ **닫힘(11/10, 사용자 결정, D-35): ADMIN 비상 열람 + 사유 필수, 모든 열람 기록, 비상 열람은 검토 목록 + 주 Responder 알림** — §8 `/contacts/{id}/reveal`, `/contact-reveals` | 닫힘 |
| Q-API-14 | D-35의 "주 Responder"(비상 열람 알림 대상)를 무엇으로 정하나: 고객 호출 순서 1단계의 첫 대상 vs 고객마다 지정하는 컬럼. 비상 `reason` 최소 길이, 비상 호출 한도 | 호출 순서 1단계 첫 대상(없으면 다른 ADMIN 전원), 1자 이상, 시간당 10회. security 검토 |
| (DATA-MODEL Q-DM-01~19) | | DATA-MODEL §9 |
