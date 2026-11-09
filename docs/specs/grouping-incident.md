상태: 초안

# 그룹·인시던트 명세

출처: AAM(4eafce9) `backend/common/alert_group.py`, `backend/common/alert_state.py`, `backend/alert_ingestor/lambda_handler.py`, `backend/alert_group_worker/lambda_handler.py`, `backend/alert_router/lambda_handler.py`, `backend/common/incident.py`, `backend/common/alarm_liveness.py`, `infrastructure/backend/template.yaml`, `docs/specs/alert-pipeline/review-personas-2026-09-08.md`(F4·F5·F8) / AH(49c83dc) `src/server/alerts.ts`.

## 규칙 — 그룹

### G-1. 그룹 키 = `{customer_id or account_id}#{severity}`
고객사 매핑이 없는 계정은 계정 ID로 대신한다. 그러지 않으면 미등록 계정 알람이 전부 `#SEV-x` 한 그룹으로 뭉쳐 서로의 발송을 흡수한다(F5). 상태 키는 `grp#{그룹 키}`.
- 근거: AAM `backend/common/alert_state.py:60-66`, review-personas F5(`:14, 94, 140`)

### G-2. 그룹에 넣는 이벤트
상태 전이이면서 판정이 NOTIFY 또는 DEFER인 것만. 억제된 이벤트는 그룹을 열지 않는다(폭풍의 억제 이벤트 수만큼 실행이 생기는 것 방지).
- 근거: `backend/common/alert_group.py:61-66`, `docs/specs/alert-pipeline/plan-state-grouping.md:118`

### G-3. 구성원 자격은 적재 시점의 `group_id`로 정한다(시간 창 아님)
열린 `grp#`가 있으면 그 `group_id`를 이력 항목에 적기만 한다. 없거나 닫혔거나 stale이면 조건부 put으로 열고 Step Functions 실행을 시작한다. 실행은 그룹당 하나. 늦은 이벤트가 어느 창에도 없거나 두 창에 들어가는 빈틈이 없다.
- 근거: `backend/common/alert_group.py:4-10`, `backend/alert_ingestor/lambda_handler.py:252-306`

### G-4. 그룹 ID = 실행 이름 = `g-{sha1(그룹 키)[:16]}-{opened_at 숫자 14자}`
결정적이라 연 쪽이 StartExecution 전에 죽어도 다음 이벤트가 같은 이름으로 재시작하고, `ExecutionAlreadyExists`는 멱등 처리한다. 실행 ARN이 없는 열린 그룹을 본 이벤트가 실행을 시작한다. 같은 초에 닫혔다 다시 열려 이름이 겹치면 1초 뒤 스탬프로 연다.
- 근거: `backend/common/alert_group.py:12-13, 69-80`, `backend/alert_ingestor/lambda_handler.py:238-249, 276-291`

### G-5. 타이머: GroupWait → Close → Grace(5초) → Collect → [PauseWait] → Finalize → Deliver
- `group_wait_sec` 기본 30초(Alertmanager 기본과 같음), 범위 0~300. 그룹 생성 시점 값이 실행 입력에 실린다.
- Close를 조회보다 **먼저** 한다. 닫힌 뒤 도착한 이벤트는 새 그룹을, 닫히기 전 도착한 이벤트는 Grace 5초 안에 적재를 마친다.
- Close는 `status=open`이고 `group_id`가 같을 때만 닫는다(새 그룹을 덮지 않음). 조건 충돌 시 한 번 재읽기.
- PauseWait은 구성원 중 DEFER가 있고 등급별 유예 > 0일 때만(suppression.md S-10).
- 각 Task 재시도 3회(5초, 배수 2). 실행 `TimeoutSeconds` 7200.
- 근거: `backend/common/alert_suppression.py:101-102`, `backend/common/alert_config.py:285`, `backend/alert_group_worker/lambda_handler.py:274-281, 405-431`, `infrastructure/backend/template.yaml:1067-1130`, review-personas `:133`

### G-6. stale 그룹 처리(F4), 두 겹
1. 인제스터: 열린 그룹이 `opened_at + group_wait_sec + 300초`를 넘기면 실행이 죽은 것으로 보고 새 그룹을 연다(`stale_group=true` 기록). `opened_at`을 못 읽으면 stale로 보지 않는다.
2. 실행이 FAILED/TIMED_OUT/ABORTED로 끝나면 EventBridge → 워커 `sweep`: 열려 있으면 닫고, 유예 없이 finalize(이미 `final_action`이 있는 구성원은 건너뜀, 사유에 `swept:<status>`), 구성원이 하나라도 있으면 라우터로 비동기 전달. 라우터의 그룹별 발송 선점(claim) 덕분에 중복 발송은 없다.
- 근거: `backend/common/alert_group.py:31-55`, `backend/alert_ingestor/lambda_handler.py:266-274`, `backend/alert_group_worker/lambda_handler.py:335-356, 465-541`, commit `27f20dd`, review-personas F4(`:13, 28-35, 133-138`)
- 주의 (추정: 결함): stale 기한에 auto-pause 시간이 들어 있지 않다. 리뷰 처방은 "대기 + grace + 최대 pause + 여유"였으나(`review-personas:33-34`) 코드는 `wait + 300`만 본다. 유예가 약 270초를 넘으면 PauseWait 중인 정상 그룹이 stale로 보여 같은 축에 새 그룹이 열린다. 그 그룹들이 겹쳐도 인시던트 쓰기는 버전 조건으로 보호된다(I-7).

### G-7. finalize 결과 기록
구성원마다 이력에 `final_action`/`final_reason`/`finalized_at`/`group_id`를 쓴다. DEFER 구성원이 유예 뒤에도 울리면 notify + `fp#`에 `last_notified_at`·`episode_notified` 기록(dedup 창 일관성).
- 근거: `backend/alert_group_worker/lambda_handler.py:443-507`

### G-8. 이력 적재는 한 번만
EventBridge는 at-least-once이므로 `event_key` 부재 조건으로 put한다. 조건 실패는 "이미 처리됨"(오류 아님, 재시도 유발 안 함). 덮어쓰면 워커의 `final_action`이 지워진다.
- 근거: `backend/alert_ingestor/lambda_handler.py:374-387`

### G-9. 대표 알람
묶음 제목은 가장 심각한 구성원(`SEV-1`=1 … `SEV-5`=5, 그 밖 9)이다.
- 근거: `backend/alert_router/lambda_handler.py:81-82, 296-299`

### G-10. AH의 묶음
AH에는 인시던트 그룹이 없다. 서비스가 식별되면 Slack 발송을 묶음 창(기본 60초)만큼 미뤄 `service:{serviceId}` 키로 다이제스트한다. 상세는 notification.md 범위.
- 근거: AH `src/server/alerts.ts:220-226`

## 규칙 — 인시던트

### I-1. 상태: triggered → acknowledged → resolved
- 근거: AAM `backend/common/incident.py:23-25`

### I-2. 인시던트 축 = 그룹 키 그대로
포인터 `inc#{그룹 키}`가 열린 인시던트를 가리킨다. 미매핑 계정이 `inc##SEV-x`로 뭉치지 않는다(M3). 옛 행은 `customer_id#severity`로 축을 복원한다. ID는 `inc-{sha1(축)[:12]}-{triggered 숫자 14자}`.
- 근거: `backend/common/incident.py:38-62`, commit `277af15`

### I-3. 병합(열기·합치기)
발화 구성원이 있을 때:
- 포인터가 없거나, 가리키는 인시던트가 resolved이거나, **`triggered_at`에서 6시간이 지났으면** 새 인시던트를 연다(같은 초 ID 충돌 시 +1초). 그렇지 않으면 기존에 합친다.
- 6시간이 지난 옛 인시던트는 열린 채 남고, 원인이 풀리면 점검(I-6)이 닫는다. 포인터는 새 인시던트로 넘어간다.
- 새 인시던트는 포인터를 조건부로 먼저 건다. 남이 먼저 걸었으면 다시 읽어 그쪽에 합친다(둘을 만들지 않음).
- 근거: `backend/alert_router/lambda_handler.py:76-78, 147-153, 190-202, 212-216`, commit `e04d4f6`

### I-4. 구성원·카운트
구성원은 `series_id` 집합(최대 200, 넘치면 추가 안 함). 같은 지문이 여러 번 울려도 구성원은 한 번만 늘고 `event_count`만 누적한다. `series_id`가 빈 이벤트는 무시한다. 계정·리소스 타입은 집합(`account_ids`, `resource_types`)으로 남겨 채널 조건 매칭에 쓴다(하나라도 맞으면 그 채널).
- 타임라인 최대 100개, 넘치면 오래된 것부터 버리되 첫 항목(triggered)은 고정.
- 근거: `backend/common/incident.py:29-32, 106-160`, commits `71aa6e2`, `517b3d3`

### I-5. 확인(ack)·해소
- ack는 triggered일 때만 적용. 첫 확인자와 `mtta_sec`가 남는다.
- resolve는 이미 resolved면 무시(MTTR 밀림 방지). `mttr_sec` 기록.
- 해소 조건: 구성원이 있고, 어느 구성원의 `fp#.episode_open`도 열려 있지 않음. 구성원이 없으면 해소하지 않는다. 방금 발화를 합친 경우엔 해소 판정을 하지 않는다.
- 해소 이벤트만 왔고 열린 인시던트가 없으면 아무것도 안 한다. resolved를 가리킨 포인터는 정리만 한다.
- 근거: `backend/common/incident.py:163-202`, `backend/alert_router/lambda_handler.py:203-209, 218-228`

### I-6. 5분 점검 틱(정합성·자가 치유)
열린 인시던트마다 순서대로:
1. 모든 구성원 지문이 OK면 조건부로 닫는다("정합성 점검: 원인 알람이 모두 해소됨"). commit `27f20dd`(M1).
2. 아니면 CloudWatch에 직접 묻는다(**삭제된 알람 처리**). 열린 구성원 각각의 에피소드 시작 후 15분 유예가 지났어야 하고, 모든 열린 구성원이 확실히 `deleted`(계정의 모든 확인 리전 + us-east-1에 없음) 또는 `not_firing`(존재하지만 ALARM 아님)일 때만 닫는다. 하나라도 `firing`·`unknown`(권한·네트워크·미등록 계정·읽기 실패)·유예 중이면 열어 둔다. 메트릭 키 대조로 못 찾았는데 같은 리소스에 ALARM인 알람이 있으면 `unknown`.
3. 닫을 때 해당 지문의 `episode_open=false`로 바꾸고 버전을 올린다. 그래야 다음 발화가 dedup에 눌리지 않고 알린다.
4. 그 뒤 ack된 채 `renotify_after_sec`(기본 3600) 지난 인시던트를 재알림한다(주기당 한 번, `renotified_at` 기준, 읽은 버전일 때만 선점).
- 한 인시던트의 오류가 틱 전체를 막지 않는다.
- 근거: `backend/alert_router/lambda_handler.py:431-543, 545-638`, `backend/common/alarm_liveness.py`(분류 `classify`, `all_quiet`), `backend/common/incident.py:205-223`, commit `e04d4f6`

### I-7. 모든 쓰기는 낙관적 잠금
병합·해소·ack·재알림 표시 모두 버전 조건으로 쓰고, 충돌 시 다시 읽어 재적용(3회). 계속 충돌하면 발송을 막지 않기 위해 인시던트 기록을 포기한다(그룹은 기록 없이 발송).
- 근거: `backend/alert_router/lambda_handler.py:156-232`, `backend/common/incident_store.py`, commit `277af15`(H2)

### I-8. 보관
해소된 인시던트 TTL 90일. 빈 값 필드는 저장하지 않는다(미매핑 인시던트는 고객사 인덱스에 안 잡힘, 의도).
- 근거: `backend/common/incident.py:34-35, 83-103, 228-231`

### I-9. AH의 "인시던트" = 알람 행 하나
AH는 지문당 `Alert` 한 행이다. 재발화(비FIRING→FIRING)는 새 사건으로 보고 count++, 에스컬레이션 1단계부터 다시, 담당 스냅샷 갱신, 24시간 안 재발이면 지난 해결 기록에 재발 표시. RESOLVED면 해결 기록(`via: auto`)과 Slack 메시지 상태 동기화(이번 발화 메시지만).
- 근거: AH `src/server/alerts.ts:299-318, 339-363, 380-391`, commit `4deb94f`

## 과거 수정 사례
- `e04d4f6` fix(incidents): **ALARM 상태에서 삭제된 알람은 OK를 보내지 않아** 인시던트가 영원히 열렸다(HOME WEBFIL 디스크, 10-06부터). 고객사#등급 병합이라 2주간 HOME SEV-3가 전부 거기에 붙었다. → CloudWatch 확인으로 닫기(15분 유예, 보수적 판정), 지문 해제, 6시간 넘은 인시던트에 병합 금지.
- `27f20dd` fix(alert-pipeline): sweep된 그룹이 라우터에 안 가서 조용히 유실(H1). 열린 인시던트 자가 치유(M1), Deliver 재시도 약 10분(M2).
- `277af15` fix(incidents): 무조건 PutItem이라 ack가 되돌아가거나 구성원이 사라져 울리는 중에 해소됐다(H2). 축 = 그룹 키(M3).
- `517b3d3` fix(alert-pipeline): 타임라인 상한이 첫 항목을 지우던 문제(L5).
- `71aa6e2` fix(alerts): 재알림이 계정·리소스 타입 채널 조건을 무시(M4).
- review-personas F4(09-08): 실행 실패 그룹이 최대 1일 열려 같은 축 알림을 전부 흡수. → G-6. F5: 미등록 계정 `#SEV-x` 뭉침 → G-1. F8은 severity.md 참고.
- AH `fd67c37` fix(ingest): 동시 생성 경합, FIRING 전이 원자화. `4deb94f` fix(slack): 상태 변경이 지난 발화 메시지까지 갱신하던 버그.

## 새 구현에서 바꿀 점
1. 인시던트 중심 UI(D-04)이므로 AAM의 인시던트 모델(I-1~I-8)을 기준으로 하고, AH의 알람 행은 인시던트의 구성원(알림)으로 둔다. Ack 단위(인시던트/알림)는 미결정(DECISIONS "아직 정하지 않은 것"). 제안: 인시던트 단위 ack + AH식 ack 고착.
2. Step Functions 타이머 대신 SQS + Postgres + 1분 틱(D-09, D-10). 그룹 상태·포인터·버전은 Postgres 행과 조건부 UPDATE(`WHERE version = ?`)로 옮긴다. 결정적 그룹 ID·조건부 열기·Close→Grace→Collect 순서는 유지.
3. stale 기한은 `group_wait + grace + 최대 auto_pause + 여유`로 고친다(G-6 주의).
4. 삭제 알람 점검(I-6 2번)은 고객 Reader 역할(D-07)로 DescribeAlarms. 판정 불확실 시 열어 두는 보수 원칙 유지. Prometheus/Grafana 소스(D-06)는 "삭제" 판정 방법이 없으므로 (추정) 일정 시간 재전송이 없으면 stale 표시만 하고 자동 해소는 하지 않는 방안을 검토.
5. 6시간 병합 상한은 설정값으로 둔다. 그룹 키에 서비스(AH 조직 모델)를 넣을지 검토(org-tenant.md, 제안).
6. 회귀 테스트: 삭제 알람 인시던트 자동 종료, 6시간 경과 후 새 인시던트, 동시 ack/병합 충돌, sweep 후 발송.
