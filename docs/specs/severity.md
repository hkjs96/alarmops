상태: 초안

# 심각도(Severity) 명세

출처: AAM(4eafce9) `docs/ALARM-RULES.md` §10-5·§13, `backend/common/alarm_registry.py`, `backend/common/alarm_identity.py`, `backend/common/alert_event.py`, `backend/alert_ingestor/lambda_handler.py`, `docs/specs/alert-pipeline/review-personas-2026-09-08.md` / AH(49c83dc) `src/lib/normalize.ts`, `src/lib/providers/*`, `src/components/badges.tsx`, `src/server/alerts.ts`, `src/lib/routing.ts`.

## 규칙

### V-1. 등급 정의 SEV-1~5 (숫자가 낮을수록 심각)
| 등급 | 이름 | 의미 | 확인 목표 | 채널 |
|---|---|---|---|---|
| SEV-1 | Critical | 고객 서비스 전면 중단, SLA 위반 위험 | 5분 | 전화 + Slack + 에스컬레이션 |
| SEV-2 | High | 핵심 기능 심각 저하·부분 중단 | 15분 | Slack + 에스컬레이션 |
| SEV-3 | Medium | 일부 기능 제한·단일 리소스 장애, 우회 가능 | 30분 | Slack |
| SEV-4 | Low | 성능 저하, 고객 직접 영향 없음 | 4시간 | Slack(저우선) |
| SEV-5 | Info | 추세 관찰 | 다음 업무 시간 | 로그만 |
SEV-1·2는 Major Incident. 유효 값은 `SEV-1`~`SEV-5`뿐(`is_valid_severity`).
- 근거: AAM `docs/ALARM-RULES.md:341-357`, `backend/common/alarm_registry.py:336-338`
- 채널 열은 문서 정의이며 AAM 라우터가 그대로 강제하는지는 확인하지 않았다 (추정: 채널 조건으로 구현).

### V-2. 메트릭별 기본 등급(레지스트리)
`_DEFAULT_SEVERITY` dict. 예: SEV-1 StatusCheckFailed·StatusCheckFailed_Application·HealthyHostCount·TunnelState·ConnectionState·HealthCheckStatus·ActiveControllerCount·ClusterStatusRed / SEV-2 ELB5XX·HTTPCode_ELB_5XX_Count·CLB5XX·Errors·UnHealthyHostCount·Api5XXError·DatabaseMemoryUsagePercentage 등 / SEV-3 CPU·Memory·Disk·Free*·ReplicaLag·DaysToExpiry 등 / SEV-4 지연·4XX·BurstCreditBalance / SEV-5 연결·요청 수·바이트.
- `Disk_*`, `disk_used_percent_*` 접두는 SEV-3. **미정의 메트릭은 SEV-5.**
- 근거: `backend/common/alarm_registry.py:250-330, 341-349`, `docs/ALARM-RULES.md:361-372`
- 문서와 코드 차이: 문서 표(§13-2)보다 코드가 항목이 많다. `ClusterStatusRed`는 문서에 SEV-1인데 코드 누락으로 SEV-5로 떨어졌다가 추가됨(`alarm_registry.py:265-267`). 코드가 정본이다.

### V-3. 등급의 저장 위치(AAM 알람)
- 정본(알람 관리): CloudWatch 알람 태그 `Severity`.
- 알림 파이프라인: 알람 설명 JSON 메타데이터의 `severity`. EventBridge 알람 이벤트에는 태그가 실리지 않기 때문이다. 생성 시 태그와 같은 규칙으로 채우므로 같은 값이고, 이후 레지스트리가 바뀌어도 기존 알람은 생성 시점 등급을 유지한다(SEV-1 면제가 이 값에 걸림).
- 태그를 바꾸는 경로(커스텀 생성 POST, 등급 변경 PUT)는 설명도 같이 바꾼다. 설명에 등급이 없는 옛 알람은 일일 동기화가 재생성 없이 제자리에서 채운다(태그 우선, 없으면 레지스트리).
- 재생성 경로(이름별·전체·동적 드리프트)는 지우기 전에 Severity 태그를 읽어 새 알람에 그대로 쓴다: **수동 등급이 레지스트리 기본값을 이긴다**(F8, 사용자 결정 2026-09-08).
- 근거: `docs/ALARM-RULES.md:388-420`, review-personas `:17, 118-131`, commits `0537f59`, `acd5844`(feat)

### V-4. 알림 이벤트의 등급 결정 순서(AAM 인제스터)
1. 알람 설명 메타데이터 `severity`가 SEV-1~5면 그 값. 범위 밖(예: `"urgent"`)이면 무시.
2. 없으면 `get_severity(metric_key)`(레지스트리, 미정의 SEV-5).
3. `metric_key`도 없으면 빈 문자열 → 그룹 키가 `{고객사}#`가 되고 면제·유예 매칭이 안 된다 (추정: 미관리 알람 일부가 해당).
- 알람 **이름**과 **태그**에서는 읽지 않는다.
- 근거: `backend/common/alarm_identity.py:44-46, 96-113`, `backend/common/alert_event.py:160-177`, `backend/alert_ingestor/lambda_handler.py:320-323`

### V-5. 등급이 쓰이는 곳(AAM)
- 억제 면제(SEV-1), 등급별 auto-pause, 그룹·인시던트 축, 대표 알람 선택. (suppression.md, grouping-incident.md)
- 알람 평가 M-of-N: SEV-1 1/1(즉시, 변경 불가), SEV-2·3 3중 2, SEV-4·5 5중 3. 미매핑은 SEV-5 정책.
- 근거: `backend/common/alarm_registry.py:34-93`, `docs/ALARM-RULES.md:277-300`

### V-6. AH의 등급 추출
- 자유 텍스트 정규식 `/sev[\s-]?(\d)/i` → `SEV-{n}`. `SEV1`, `SEV-1`, `sev 1` 모두 인식. 숫자 범위 검사 없음(`SEV-0`, `SEV-9`도 나온다). 못 찾으면 `UNKNOWN`.
- 소스별:
  - CloudWatch: 알람 이름, 그다음 설명에서 추출. (AAM 알람은 설명 JSON의 `"severity": "SEV-3"`에서 잡힌다 (추정: 이름엔 등급이 없음).)
  - Prometheus/Grafana unified: 라벨 `severity`가 있으면 **대문자로 그대로**(`critical`→`CRITICAL`, 매핑 없음). 없으면 alertname → description → summary에서 추출.
  - Grafana legacy: `tags.severity` 대문자, 없으면 ruleName → message.
  - PagerDuty: `priority.summary` 대문자(예: `P1`), 없으면 `urgency` 대문자(`HIGH`/`LOW`), 없으면 `UNKNOWN`.
  - generic: `severity` 필드 대문자, 없으면 title → description → reason.
- 갱신 시 새 값이 `UNKNOWN`이면 저장된 등급을 유지한다.
- 근거: AH `src/lib/normalize.ts:25-36`, `providers/cloudwatch.ts:57`, `providers/shared.ts:130-133`(파일 내 `:35-38`), `providers/grafana.ts:41`, `providers/pagerduty.ts:19-25`, `providers/generic.ts:23-26`, `src/server/alerts.ts:50-57`, commit `fd67c37`
- 결과: AH 저장 등급은 SEV-n, CRITICAL/HIGH/WARNING 등 원문, P1, UNKNOWN이 섞인다. 배지는 SEV-0~5와 CRITICAL·HIGH·ERROR·WARNING·LOW·INFO·UNKNOWN에 색을 주고 나머지는 UNKNOWN 색(`src/components/badges.tsx:30-52`). 라우팅 규칙은 쉼표 목록 정확 일치(대소문자 무시)(`src/lib/routing.ts:3, 38`).

## 충돌
1. AAM은 SEV-1~5만 유효, AH는 임의 문자열 + SEV-0.
2. AAM은 메타데이터 > 레지스트리, AH는 이름·설명 텍스트 정규식.
3. Prometheus/Grafana `severity` 라벨(critical/warning/info 관례)을 AH는 매핑하지 않아 SEV 체계 규칙(SEV-1 면제 등)과 연결되지 않는다.
4. 기본값: AAM 미정의 메트릭 SEV-5, AH UNKNOWN.

## 과거 수정 사례
- `0537f59` fix(alarms): Severity 태그와 설명 불일치(F1·F2·F3·F9). 설명 등급 범위 밖 무시·API 400, 일일 동기화 제자리 보충. `_alarm_arn_for_name`이 마지막 콜론에서 잘라 등급 태그 갱신이 조용히 ResourceNotFound로 실패하던 버그.
- review-personas F8: 재생성이 수동 등급을 레지스트리 기본값으로 되돌림 → 수동 등급 우선(`review-personas-2026-09-08.md:17, 129-132`).
- `7143c72` fix: Phase 0 hotfixes — severity 포함(상세 확인 안 함 (추정)).
- `ClusterStatusRed` 누락으로 SEV-5 폴백(`alarm_registry.py:265-267`, 커밋 미확인).
- AH `fd67c37` fix(ingest): 빈약한 갱신이 등급을 UNKNOWN으로 덮던 문제.

## 새 구현에서 바꿀 점
1. 내부 등급은 SEV-1~5 하나로 정규화하고 원문은 `severity_raw`로 보존한다(제안, 1주차 "기본 심각도" 미결정).
2. 소스별 매핑 제안(D-06):
   - CloudWatch: AAM V-4 그대로(D-05: 알람 엔진 이식). 고객 자체 알람은 태그를 이벤트에서 못 읽으므로 레지스트리 → 없으면 고객 기본값 → SEV-3 (제안).
   - Prometheus/Grafana: `severity` 라벨 매핑 `critical`→SEV-1? 또는 SEV-2, `error|high`→SEV-2, `warning`→SEV-3, `info`→SEV-5, `sev[-]?n`은 그대로. critical의 대응 등급은 사용자 결정 필요(SEV-1 면제가 걸리므로).
   - 매핑 없으면 고객사 기본 등급(설정) → 없으면 SEV-3 (제안. AAM의 SEV-5 폴백은 알람 엔진 레지스트리에만 유지).
3. 등급 우선순위는 D-08 정신과 맞춘다: 리소스/알람 쪽 값(CloudWatch 설명 메타데이터·Prometheus 라벨) > 콘솔에서 정한 매핑 > 고객 기본값 > 시스템 기본값 (제안).
4. 수동 등급 우선(F8)과 태그·설명 동기화(V-3)는 알람 엔진 이식 시 그대로 유지(D-05). AlarmWriter 역할(D-07) 없이 고객 알람에는 쓰지 않는다.
5. 콘솔은 영어(D-01): 표시명 Critical/High/Medium/Low/Info.
