상태: 초안

# 억제(Suppression) 명세

출처: AAM(aws-alert-manager, 4eafce9) `backend/common/alert_suppression.py`, `backend/common/alert_config.py`, `backend/common/alert_state.py`, `backend/alert_ingestor/lambda_handler.py`, `backend/alert_group_worker/lambda_handler.py`, `docs/specs/alert-pipeline/*` / AH(alert-hub, 49c83dc) `src/lib/refire-throttle.ts`, `src/lib/silence.ts`, `src/lib/silence-window.ts`, `src/server/alerts.ts`, `src/app/api/cron/escalate/route.ts`.
경로 표기는 저장소 루트 기준이다. AAM 경로의 `backend/`는 아래에서 생략하지 않는다.

## 규칙

### S-1. 판정 결과는 세 가지다
NOTIFY(지금 보냄), SUPPRESS(안 보냄, 사유 기록), DEFER(유예 뒤 재평가 = auto-pause).
- 근거: AAM `backend/common/alert_suppression.py:7-10, 35-37`

### S-2. 판정 전 선별: 상태 전이만 대상이다
1. `event_type != state_change`(알람 생성/수정/삭제)면 SUPPRESS/`not_actionable`. 이력에는 남는다.
2. 해소 전이(`previous_state == ALARM` 이고 `state ∈ {OK, INSUFFICIENT_DATA}`)는 **이 발화를 이미 알렸으면** NOTIFY/`cleared`, 아니면 SUPPRESS/`cleared`. 유예 중 스스로 풀린 알람이 여기서 조용히 끝난다.
3. 그 밖에 `state != ALARM`이면 SUPPRESS/`not_actionable`(예: OK→INSUFFICIENT_DATA).
- "이미 알렸는가"는 `episode_open && episode_notified`다. 닫힌 에피소드에 중복 해소가 와도 다시 알리지 않는다.
- 근거: AAM `backend/common/alert_suppression.py:181-193`, `backend/common/alert_event.py:112-119`, `backend/common/alert_state.py:126-127`

### S-3. 발화(ALARM) 판정 순서. 순서가 곧 정책이다
| 순서 | 단계 | 결과 | 근거 |
|---|---|---|---|
| 1 | 면제: `severity ∈ exempt_severities`(기본 `("SEV-1",)`) | 즉시 NOTIFY. 이후 단계는 모두 건너뛴다 | `alert_suppression.py:90, 195-197` |
| 2 | 정비창(silence)이 덮음 | SUPPRESS/`silence` | `:199-202` |
| 3 | flapping 격리 중 | SUPPRESS/`flapping` | `:204-206` |
| 4 | 중복: 같은 지문의 마지막 알림 이후 `0 ≤ 경과 < repeat_interval_sec` | SUPPRESS/`dedup` | `:208-212` |
| 5 | auto-pause: 등급별 유예 `> 0` | DEFER/`auto_pause`, `defer_seconds` = 유예값 | `:214-217` |
| 6 | 나머지 | NOTIFY | `:219` |
- 결과: **SEV-1은 정비창도 뚫는다.** 정비창 중에도 SEV-1은 알린다. 1번이 2번보다 앞서기 때문이다(코드상 사실. 의도인지는 문서에 명시 없음 (추정: 의도)).
- 면제 등급 목록은 DB 정책으로 바꿀 수 있다(`exempt_severities`, 빈 문자열 제거·정렬). 근거: `backend/common/alert_config.py:357-359, 490-494`
- 억제는 알람(M-of-N)이 아니라 알림 쪽에 둔다(설정 한 줄로 조정 가능, 두 층은 겹치지 않고 쌓임). 근거: `alert_suppression.py:19-20`

### S-4. 판정 기준 시각은 이벤트 발생 시각이다
`now = alert.occurred_dt or 벽시계`. 재시도로 늦게 처리돼도 중복·정비창 판정이 같고, 과거 이벤트를 재현할 수 있다. 다만 그룹 열기와 stale 판정은 벽시계(`wall`)를 쓴다.
- 근거: AAM `backend/alert_ingestor/lambda_handler.py:325-328`, `backend/common/alert_event.py:98-110`

### S-5. 정비창(silence) — AAM
- 매칭: `starts_at ≤ now < ends_at`(끝 시각 미포함), `customer_id`(빈 값 = 모든 고객사), `resource_type`(빈 값 = 모든 타입). 다른 축(계정·리소스·알람·등급)은 없다.
  - 근거: `backend/common/alert_suppression.py:58-75`
- 저장: `AlertPolicyTable`(`config_type="silence"`, `config_id="{YYYYmmddTHHMMSS}-{uuid8}"`), `ttl = ends_at + 7일`(감사 흔적 뒤 자동 삭제).
  - 근거: `backend/common/alert_config.py:237-239, 275-277, 410-429`
- API 검증: `ends_at` 필수, `ends_at > starts_at`, 길이 최대 30일, 이미 끝난 구간은 거절(400), `starts_at` 생략 시 지금, `reason` 200자 절단.
  - 근거: `backend/common/alert_config.py:498-517`
- 로더는 시각이 없거나 뒤집힌 항목을 버린다(적용 안 함, 경고 로그). 근거: `:392-407`
- 설정 로드 실패 시 정비창은 비어 있다 → 억제가 덜 될 뿐 더 되지는 않는다. 근거: `:531-551`, `backend/alert_ingestor/lambda_handler.py:164-171`

### S-6. 정비창(silence/mute) — AH
- 범위는 정확히 하나: 알람 단위(`alertId`) 또는 조직 단위(고객사/프로젝트/서비스). 조직 범위는 하위로 상속(알람이 속한 서비스·프로젝트·고객사 id 중 하나라도 걸리면 뮤트).
- 상태: `revokedAt` 있으면 revoked, `now < startsAt` scheduled, `now ≥ endsAt` ended, 그 외 active. 여러 개가 걸리면 가장 늦게 끝나는 것을 표시용으로 고른다.
- 효과: **통지와 자동 에스컬레이션만** 멈춘다. 수집·상태 전이·화면 표시·count는 계속된다. 등급 면제는 없다(SEV-1도 뮤트된다).
- 기간 프리셋: `1h`, `4h`, `tomorrow9`(다음 09:00Z), `today23`(다음 23:00Z), `custom`(UTC로 해석, 끝 > 시작). 상한 없음.
- 근거: AH `src/lib/silence.ts:4-10, 34-66`, `src/lib/silence-window.ts:1-46`, `src/server/alerts.ts:180-196`, `src/app/api/cron/escalate/route.ts:82`

### S-7. flapping 격리
- 상태 `fp#{지문}.recent_episodes`: 창(`flapping_window_days`, 기본 1일) 안의 ALARM 진입 시각 목록. **현재 발화도 포함**해 센다("N번째"가 N-1로 세어지지 않도록). 정렬·중복 제거, 상한 30개.
  - 근거: AAM `backend/common/alert_state.py:48-49, 100-111`
- 판정: 격리 중(`now < quarantined_until`)이면 flapping. 아니면 `count / window_days ≥ flapping_per_day`(기본 3) → 기본값에서 "오늘 세 번째 발화부터 격리".
  - 근거: `backend/common/alert_state.py:114-122`, `backend/common/alert_suppression.py:94-99, 222-230`
- 격리 시작: 판정 사유가 `flapping`일 때만, 그리고 이미 격리 중이 아닐 때만 `quarantined_until = now + flapping_quarantine_sec`(기본 3600초). 격리 중에도 에피소드는 기록되므로 만료 시 아직 잦으면 다시 격리된다.
  - 근거: `backend/common/alert_state.py:150-155`, `backend/common/alert_suppression.py:98-99`
- 결과: SEV-1은 1단계에서 빠지므로 격리되지 않는다. 정비창에 걸린 발화도 사유가 `silence`이므로 격리 타이머를 시작하지 않는다(코드상 사실).
- 판정식은 실측 스크립트 `scripts/analyze_alarm_history.py`와 같다. 근거: `alert_suppression.py:222-227`

### S-8. 중복(dedup) = 해소 후 재발화 병합 창
- 기본 `repeat_interval_sec = 900`(15분). Alertmanager의 4시간을 쓰지 않은 이유: CloudWatch는 **전이만** 보내므로 dedup이 실제로 막는 것은 "해소 뒤 재발화"뿐이고, 4시간이면 진짜 재발을 놓친다.
  - 근거: AAM `backend/common/alert_suppression.py:47-55`
- 기준: `last_notified_at`(NOTIFY로 판정된 발화의 `occurred_at`). DEFER로 유예된 발화는 그룹 워커가 유예 뒤에도 울리면 그때 `last_notified_at`을 찍는다.
  - 근거: `backend/common/alert_state.py:147-149`, `backend/alert_group_worker/lambda_handler.py:443-453`
- 경과가 음수(시계 역전)면 dedup하지 않는다(`0 ≤ elapsed`). 근거: `alert_suppression.py:210-211`
- AH 대응물: 재발화 스로틀. 마지막 FIRING 팬아웃 후 `REFIRE_THROTTLE_MINUTES`(기본 10분, 0이면 끔, 음수·비숫자면 기본값) 안의 재발화는 팬아웃을 건너뛴다. count·이벤트·스냅샷은 갱신된다. 에스컬레이션 사다리에는 적용되지 않는다(최초 팬아웃에만).
  - 근거: AH `src/lib/refire-throttle.ts:1-28`, `src/server/alerts.ts:198-218`
- AH에서 순서는 **뮤트 → 스로틀 → 발송**. 근거: `src/server/alerts.ts:185-226`

### S-9. AH의 ack 고착(sticky ack)
FIRING 재수신은 저장 상태가 FIRING도 ACKNOWLEDGED도 아닐 때만 전이(count++, 통지, 에스컬레이션 1단계부터 재시작)로 친다. Prometheus/Grafana가 주기적으로 같은 발화를 재전송해도 ack가 풀리거나 재페이징되지 않는다. INSUFFICIENT_DATA도 ack를 풀지 못한다. RESOLVED(또는 공급자 측 ACK)만 어느 상태에서든 적용된다.
- 근거: AH `src/server/alerts.ts:299-346`

### S-10. auto-pause(유예)
- 등급별 유예 초 `auto_pause_sec: {severity: sec}`. **기본은 비어 있다** → 유예하지 않는다. 값은 Phase 0 실측("N분 유예 시 억제율")으로 정한다. 범위 0~3600초(로더 클램프, API 400).
  - 근거: AAM `backend/common/alert_suppression.py:82-84, 108-109`, `backend/common/alert_config.py:289, 336-344, 463-477`
- DEFER는 적재 시점에 억제로 세지 않는다(`suppressed = action ∉ {NOTIFY, DEFER}`). 근거: `backend/alert_ingestor/lambda_handler.py:343-346`
- 그룹 수집 단계에서 구성원 중 DEFER가 있으면 그룹 등급의 유예만큼 기다린다. finalize에서 해당 에피소드가 아직 열려 있고 `episode_started_at ≤ occurred_at`이면 NOTIFY/`auto_pause_expired`, 아니면 SUPPRESS/`auto_pause`(auto-pause의 이득).
  - 근거: `backend/alert_group_worker/lambda_handler.py:425-440, 480-486`
- sweep(실행 실패) 경로는 유예 없이 finalize한다(fail-open). 근거: `:282-285, 510-525`

### S-11. 정책 출처·우선순위·상한
- 우선순위 **DB > 환경변수 > 코드 기본값**. DB 항목에 있는 필드만 덮는다(부분 저장). 캐시 60초.
  - 근거: AAM `backend/common/alert_config.py:241-242, 271-273, 322-360, 569-580`
- 환경변수: `ALERT_AUTO_PAUSE_SEC`(JSON), `ALERT_REPEAT_INTERVAL_SEC`, `ALERT_FLAPPING_QUARANTINE_SEC`, `ALERT_FLAPPING_WINDOW_DAYS`, `ALERT_GROUP_WAIT_SEC`, `ALERT_RENOTIFY_AFTER_SEC`. 형식 오류는 로그만 남기고 기본값.
  - 근거: `backend/common/alert_suppression.py:111-137`
- 범위: `repeat_interval_sec` 0~86400, `flapping_quarantine_sec` 0~86400, `flapping_per_day` 1~1000, `flapping_window_days` 1/24~30, `group_wait_sec` 0~300, `renotify_after_sec` 0~86400. 로더는 클램프, API는 400.
  - 근거: `backend/common/alert_config.py:279-292, 301-305, 478-489`
- 주의(코드 결함 (추정)): `policy_from_item`·`load`·`policy_to_item`은 `renotify_after_sec`를 다시 조립하지 않아 DB 값이 런타임 정책에 반영되지 않고 환경변수/기본값(3600)이 유지된다. 근거: `alert_config.py:326-335, 554-565, 363-376`

### S-12. 실패 시 fail-open
상태 조회·갱신·그룹 처리·설정 로드가 실패하면 첫 발화처럼 판정하거나 NOTIFY로 빠진다(알림 유실보다 중복이 낫다). 같은 지문 조건 충돌이 3회 연속이면 NOTIFY/`state_contention`. 실패는 ERROR 로그 + `PERF_METRIC state_ok=false`로 남긴다.
- 근거: AAM `backend/alert_ingestor/lambda_handler.py:28-30, 85-87, 174-235`
- AH도 스로틀 판정 실패 시 그대로 발송한다. 근거: AH `src/server/alerts.ts:216-218`

### S-13. 억제 사유 값
`silence`, `flapping`, `dedup`, `auto_pause`, `cleared`, `not_actionable`, (인제스터) `state_contention`, (워커) `auto_pause_expired`, sweep 시 `;swept:<status>` 접미. 이력에 그대로 남아 리포트 집계 축이 된다.
- 근거: AAM `backend/common/alert_suppression.py:39-45`, `backend/alert_ingestor/lambda_handler.py:87`, `backend/alert_group_worker/lambda_handler.py:317, 489-490`

### S-14. Shadow 모드
AAM 인제스터는 판정을 기록만 하고 막지 않는다(발송자 도입 전 억제율 측정). 실제 발송은 그룹 워커 finalize 뒤 라우터가 한다.
- 근거: AAM `backend/alert_ingestor/lambda_handler.py:16-18`, `backend/alert_group_worker/lambda_handler.py:287-288`

## 과거 수정 사례
- `ed4e005` fix(alert-pipeline): 인제스터에 `dynamodb:Query` 권한 누락 → dedup이 조용히 꺼져 있었다. fail-open이 IAM 결함을 숨긴 사례. 배포 뒤 `AccessDenied` grep을 규칙으로 둠(`lambda_handler.py:28-30`).
- `20ebad9` fix(alert-pipeline) review 1.6: 미관리 알람이 `{account}##` 한 지문으로 뭉쳐 남의 알람을 dedup하던 문제(B2), 계정→고객사 캐시 5분 TTL·실패 시 이전 매핑 유지(Q2), raw 64KB 제한(Q3), 실측 스크립트 창을 CloudWatch 보존 14일로 제한해 flapping 비율 과소 계산 수정(B3), 인제스터 예약 동시성 50(폭풍 대비).
- `27f20dd` fix(alert-pipeline): sweep된 그룹이 라우터로 가지 않아 이력엔 notify인데 발송은 안 됐다(H1). 열린 인시던트 자가 치유(M1).
- review-personas F4(`docs/specs/alert-pipeline/review-personas-2026-09-08.md:13, 28-35, 133-138`): 실행이 죽은 그룹에 하루치 알림이 흡수되던 문제 → sweep + stale 그룹 재오픈. 상세는 grouping-incident.md.
- AH `fd67c37` fix(ingest): 같은 지문 동시 생성 경합, FIRING 전이를 상태 조건 updateMany로 원자화(통지가 정확히 한 번).
- AH `ab268ec`(feat, 수정 아님): 점검 창·뮤트 도입. `107aee8`(feat): 재발화 스로틀 도입.

## 새 구현에서 바꿀 점
1. 판정 순서(S-3)는 그대로 가져가되 순수 함수 + 사유 기록 구조를 유지한다(D-03: 규칙만 이식).
2. **두 저장소의 차이를 하나로 정해야 한다** (제안, 1주차 미결정 "기본 심각도·사일런스 규칙"):
   - SEV-1이 정비창을 뚫는가: AAM은 뚫고 AH는 못 뚫는다. 제안: 기본은 AAM처럼 뚫고, 정비창 생성 시 "SEV-1 포함" 선택지를 둔다.
   - 재발 병합 창: AAM 15분, AH 10분. 제안: 15분 하나로 통일하고 DB 정책으로 조정.
   - 정비창 범위: AAM(고객사·리소스 타입), AH(알람·고객사·프로젝트·서비스 상속). 제안: AH 범위 + 리소스 타입·계정 축 추가, AAM의 30일 상한·과거 구간 거절은 유지.
   - ack 고착(S-9)은 Prometheus/Grafana 재전송 때문에 필수(D-06).
3. 정책 저장은 Postgres 한 경로(D-09 원칙 6, Prisma). 환경변수는 초기값만. 캐시 60초 유지.
4. S-11의 `renotify_after_sec` DB 미반영 결함을 재현 테스트로 막는다.
5. auto-pause 기본 비활성 유지. 1분 틱(D-10)과 SQS(D-09)로 구현하므로 Step Functions 대기 대신 지연 메시지/틱 재평가로 바꾼다 (추정: 설계 미정).
6. fail-open 원칙 유지 + 권한 누락 감지(헬스체크·DLQ 알림, D-10).
