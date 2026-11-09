상태: 초안

# 지문(Fingerprint)·중복 판정 명세

출처: AAM(4eafce9) `backend/common/alert_event.py`, `backend/common/alert_suppression.py`, `backend/common/alarm_identity.py`, `backend/alert_ingestor/lambda_handler.py` / AH(49c83dc) `src/lib/normalize.ts`, `src/lib/providers/{cloudwatch,prometheus,grafana,pagerduty,generic,shared,index}.ts`, `src/server/alerts.ts`, `prisma/schema.prisma`.

## 규칙 — AAM (CloudWatch, EventBridge 경로)

### F-1. 지문 = `series_id` = `{account_id}#{resource}#{metric_key}`
- `resource` = 해석된 `resource_id`, 없으면 알람 ARN, 그것도 없으면 알람 이름.
- MetricHistoryTable과 같은 키 규약이라 알람 이력과 메트릭 이력을 조인할 수 있다.
- 알람 이름을 쓰지 않는 이유: 임계치가 바뀌면 이름이 바뀌어 dedup이 초기화된다.
- 근거: `backend/common/alert_event.py:10-14, 82-91`, `backend/common/alert_suppression.py:151-157`

### F-2. 리소스·메트릭 해석
알람 설명(`configuration.description`) JSON 메타데이터 우선, 없으면 이름 형식 폴백(`allow_name_fallback=True`, 알람을 바꾸지 않는 해석이라 허용). `metric_key`는 메타데이터, 없으면 `configuration.metrics[].metricStat.metric.name`. 미관리 알람도 버리지 않고 `parse_error="unmanaged alarm format"`으로 적재한다.
- 근거: `backend/common/alert_event.py:122-182`, `backend/common/alarm_identity.py:85-115`, commit `f376969`

### F-3. 이벤트 키와 재전달
`event_key = {occurred_at}#{event_id[:8]}`. 이력 put은 `event_key` 부재 조건 → 같은 이벤트 재전달은 중복으로 기록만 하고 덮지 않는다. 상태 반영은 집합 기반이라 같은 이벤트 두 번 = 한 번.
- 근거: `backend/common/alert_event.py:93-96`, `backend/alert_ingestor/lambda_handler.py:374-387`, `docs/specs/alert-pipeline/review-personas-2026-09-08.md:20-22`

### F-4. 지문별 상태 `fp#{series_id}`
`last_notified_at`, `episode_open`, `episode_started_at`, `episode_notified`, `recent_episodes`, `quarantined_until`, `version`. TTL 30일(한 달 조용하면 첫 발화로 다룸). 판정 → 조건부 쓰기 → 충돌 시 재판정(최대 3회)이 이중 발송을 막는 유일한 지점.
- 근거: `backend/common/alert_state.py:15-21, 46-47`, `backend/alert_ingestor/lambda_handler.py:20-26, 204-235`

## 규칙 — AH (웹훅 경로)

### F-5. 공급자 선택
명시 경로(`/api/webhooks/<name>`)면 그 공급자, `alarm`이면 자동 감지 순서 cloudwatch → pagerduty → grafana → prometheus → generic. 아무것도 아니면 빈 결과.
- 근거: AH `src/lib/providers/index.ts:10-64`

### F-6. 공급자별 지문
| 소스 | 지문 | 근거 |
|---|---|---|
| CloudWatch(SNS 본문: `AlarmName` + `NewStateValue`) | `cw:{AlarmArn}`, 없으면 `cw:{AlarmName}` | `providers/cloudwatch.ts:5-12, 53` |
| Prometheus Alertmanager(`version:"4"` 또는 `groupKey`, `orgId` 없음) | 알림의 `fingerprint`가 있으면 `prometheus:{fingerprint}`, 없으면 `prometheus:{alertname 또는 title}:{instance 또는 job 또는 ""}` | `providers/prometheus.ts:10-35`, `providers/shared.ts:9-34` |
| Grafana unified(`alerts[]` + `orgId`/`version:"1"`/`dashboardURL`) | Prometheus와 같은 규칙, 접두 `grafana:` | `providers/grafana.ts:6-33, 61-71`, `shared.ts:29-34` |
| Grafana legacy(`evalMatches`/`ruleName`/`ruleId`) | `grafana:{ruleId 또는 ruleName}` | `providers/grafana.ts:35-54` |
| PagerDuty v3/v1·v2 | `pagerduty:{incident id 또는 title}` | `providers/pagerduty.ts:27-50` |
| generic(`title` 또는 `name`) | `{source 또는 "generic"}:{title}:{resource 또는 ""}` | `providers/generic.ts:7-21` |
- 소스 접두사로 공급자 간 충돌을 막는다. `alertname`도 `summary`도 없는 라벨 알림은 버린다.

### F-7. 중복 판정 = 지문 유일 행
`Alert.fingerprint @unique`. 새 지문이면 행 생성, 알려진 지문이면 필드 갱신 + 이벤트 추가. 생성 경합 패자(P2002)는 갱신 경로로. FIRING 전이는 상태 조건 updateMany로 정확히 한 번. 빈약한 후속 페이로드(OK 재전송 등)는 이미 아는 필드를 지우지 않는다.
- 근거: AH `prisma/schema.prisma:29`, `src/server/alerts.ts:239-289, 299-326`, commit `fd67c37`

### F-8. 상태 매핑
- CloudWatch: ALARM→FIRING, OK→RESOLVED, INSUFFICIENT_DATA→INSUFFICIENT_DATA, 그 외→FIRING.
- firing/alerting/active→FIRING, resolved/ok→RESOLVED, no_data/nodata/paused→INSUFFICIENT_DATA, 그 외→FIRING.
- generic: 열거값 그대로, ALARM/TRIGGERED/OPEN→FIRING, OK/CLEARED/CLOSED→RESOLVED, ACK/ACKED→ACKNOWLEDGED, 그 외→FIRING.
- PagerDuty: acknowledge 포함→ACKNOWLEDGED, resolve 포함→RESOLVED, 나머지→FIRING.
- 근거: AH `src/lib/normalize.ts:38-95`, `providers/pagerduty.ts:10-17`, commit `ec8caf4`(Grafana paused)

## 충돌(두 저장소가 다른 점)
1. **CloudWatch 지문 축이 다르다.** AAM은 `계정#리소스#메트릭`(이름 변경에 안정), AH는 알람 ARN(ARN에 이름이 들어 있어 임계치 변경으로 이름이 바뀌면 새 지문). 같은 알람이 두 시스템에서 다른 키를 갖는다.
2. **같은 리소스·메트릭의 알람 둘**(예: 사용자 정의 + 엔진 기본)은 AAM에선 한 지문으로 합쳐지고 AH에선 둘이다 (추정: AAM 쪽은 의도된 병합).
3. **수신 경로가 다르다.** AAM은 EventBridge `CloudWatch Alarm State Change`(account/region/time이 봉투에 있음), AH는 SNS 알림 본문. 필드 이름과 시각 출처가 다르다.
4. Prometheus/Grafana의 폴백 지문(`alertname:instance`)은 라벨이 더 있는 경우(예: 같은 instance의 다른 `device`) 서로 다른 시계열을 하나로 합친다. 네이티브 `fingerprint`(전체 라벨 해시)가 있으면 문제없다 (추정: Alertmanager v4와 Grafana unified는 항상 보낸다).
5. AH generic은 `title`이 지문에 들어가 제목 표기가 바뀌면 새 알람이 된다.
6. 시간 창: AAM dedup은 지문 + 15분 창(suppression.md S-8), AH는 지문 행 + 상태 전이 + 10분 스로틀.

## 제안 규칙 (미결정 — 1주차 "지문 규칙(소스별)" 결정 대상)
D-06(비CloudWatch 예시는 Prometheus/Grafana), D-09(모든 알림은 AWS 수집 + SQS 경유) 기준:
1. 형식 `{source}:{tenant}:{소스별 키}`. `tenant`는 AWS 계정 ID 또는 고객사 연동 ID(공급자 간·고객 간 충돌 방지).
2. CloudWatch: AAM `series_id` 규칙(F-1)을 따른다. EventBridge 경로가 정본(D-09: AWS 수집). 미관리 알람은 ARN 폴백(F-1) 유지.
3. Prometheus/Grafana unified: 네이티브 `fingerprint` 필수 사용. 없을 때만 `alertname` + 정렬된 전체 라벨(`severity` 등 변하는 라벨 제외 목록을 둠)의 해시. AH의 `alertname:instance` 폴백은 쓰지 않는다.
4. Grafana legacy·PagerDuty·generic은 PoC 범위 밖으로 두되, generic은 보낸 쪽이 `dedup_key`를 주면 그것을 쓰고 없으면 `title:resource`.
5. 지문은 정규화 단계에서 한 번 계산해 저장하고, 규칙이 바뀌면 버전 필드(`fingerprint_v`)를 둔다 (제안).
6. 재전달 멱등(F-3)과 지문별 조건부 상태 갱신(F-4)은 Postgres 유일 제약 + 버전 조건으로 옮긴다(D-09 원칙 6).

## 과거 수정 사례
- `20ebad9` fix(alert-pipeline) B2: 미관리 알람의 `resource_id`가 비어 모든 미관리 알람이 `{account}##` 한 지문으로 뭉쳤고, dedup 조회가 남의 알람 이벤트를 돌려줬다 → ARN/이름 폴백.
- `f376969` fix(alarms): 이름 형식만으로 "우리 알람"이라 판정하던 것 제거(고객 알람 32개가 공백 하나 차이). 알림 해석만 이름 폴백 허용.
- `ed4e005` fix(alert-pipeline): `dynamodb:Query` 권한 누락으로 dedup이 조용히 꺼져 있었다.
- review-personas P1(재전달 멱등) 문제 없음 확인(`review-personas-2026-09-08.md:20-22`), 이력 한 번 쓰기는 `acd5844`(feat).
- AH `fd67c37` fix(ingest): 빈약한 갱신이 필드를 지움, 생성 경합 500, FIRING 전이 중복.
- AH `ec8caf4`(feat): Grafana `paused`를 FIRING이 아닌 INSUFFICIENT_DATA로.

## 새 구현에서 바꿀 점
- 위 "제안 규칙"을 1주차에 확정한다(D-06, D-09). 확정 전까지 CloudWatch는 AAM 규칙, Prometheus/Grafana는 네이티브 fingerprint.
- AH의 SNS 본문 CloudWatch 파서는 쓰지 않는다(D-09: EventBridge + SQS 한 경로) (추정: 고객 쪽 SNS 구독이 남아 있으면 이행 기간에만 유지).
- 회귀 테스트: 임계치 변경(이름 변경) 후에도 같은 지문, 미관리 알람끼리 다른 지문, 같은 이벤트 재전달 시 상태 불변, Prometheus 배치 안 다중 알림 분리.
