# 온콜 · 에스컬레이션 동작 명세

상태: 초안

- 출처: alert-hub(AH) 기준 커밋 49c83dc, aws-alert-manager(AAM) 기준 커밋 4eafce9. 두 저장소는 읽기만 했고 실행하지 않았다.
- 표기: `AH path:줄` / `AAM path:줄`. 코드로 확인하지 못하고 미루어 짐작한 내용은 **(추정)**으로 표시한다.
- 관련 결정: D-10(1분 에스컬레이션 틱 + heartbeat), D-11(온콜 자체 구축 Postgres + pg_cron, Slack + 국내 문자·음성 + 이메일).

## 1. 담당 해석 (누가 받는가)

**R1-1. 조직 트리: 고객사 › 프로젝트 › 서비스 › AWS 계정.** 담당 배정(`Assignment`) 하나는 네 단계 중 정확히 한 곳에 붙는다. 사람(contactId)이나 팀(teamId) 중 하나를 가리키고, 그 단계 안에서의 순번(`order`, 0이 1순위)을 가진다. 담당 라벨(OWNER/DEPUTY 같은 것)은 없고 순번만 있다.
근거: `AH prisma/schema.prisma:522-570`, `AH src/lib/org/resolve.ts:6-9`. 라벨을 없앤 커밋은 2b4cbd4.

**R1-2. 가장 구체적인 단계 하나만 쓴다.** 계정 → 서비스 → 프로젝트 → 고객사 순으로 내려가며, 배정이 하나라도 있는 첫 단계의 목록을 **통째로** 쓴다. 여러 단계를 합치지 않는다. 서비스 단계에 목록이 있으면 고객사 단계 목록은 뒤에 붙지 않는다. "서비스를 맡은 팀이 상위의 에스컬레이션 꼬리를 모르게 물려받지 않게" 하려는 것이다.
근거: `AH src/lib/org/resolve.ts:46-69`, 단계 순서는 `:14-19`.

**R1-3. 상속은 위에서 아래로만 흐른다.** 편집 화면에 "이 단계는 비어 있고 실제로는 이 순서가 적용됩니다"를 보여 줄 때는 상위 단계만 본다. 하위 단계(프로젝트에서 본 서비스·계정)의 목록은 상속분으로 보이지 않는다. 체인 전체에 배정이 하나도 없으면 결과는 `level=null`(담당자 미지정)이다.
근거: `AH src/lib/org/resolve.ts:71-98`, `AH src/server/org.ts:269`(getEffectiveInheritance). 고친 커밋은 1b27f2f.

**R1-4. 팀은 자기 순번 자리에서 멤버 순서대로 펼친다.** 예를 들어 [최민서, DB팀(김도윤 → 이서연)]은 최민서 → 김도윤 → 이서연이 된다. 팀 안의 순서는 소수 순번(`order + i/1000`)으로 지킨다. 같은 사람이 직접 배정과 팀 경유로 겹치면 처음 나온 자리만 남긴다. 멤버가 없는 팀은 무시한다.
근거: `AH src/lib/org/resolve.ts:118-141`, 중복 제거는 `:64-65`.

**R1-5. 비활성 인원은 순서에서 빠진다.** 퇴사나 휴직으로 `active=false`가 된 사람은 직접 배정이든 팀 경유든 해석에서 빠진다. 배정 행은 남겨 두므로 다시 활성화하면 원래 자리로 돌아온다.
근거: `AH src/server/org.ts:394-399`(getOwnershipByAccountIds 안 `active: true`), `AH prisma/schema.prisma:377-379`.

**R1-6. 다른 테넌트의 행은 섞지 않는다.** 배정을 한 번에 조회한 뒤, 각 계정의 체인 id(account/service/project/customer)와 같은 행만 고른다.
근거: `AH src/server/org.ts:408-415`.

**R1-7. 라우팅 규칙이 트리 결과를 덮어쓴다.** 규칙은 고객사 단위다. `priority`가 작은 것부터 보고, 같으면 먼저 만든 것을 먼저 본다. 첫 매치가 이긴다. 조건은 namespace·metric·resource(`*` 글롭, 대소문자 무시), severity(쉼표 목록, 정확 일치, 대소문자 무시), serviceId(같아야 함)이다. 빈 조건은 와일드카드다. 패턴이 있는데 알람 값이 없으면 매치하지 않는다. 매치하면 그 팀의 "지금 순서"(R2)가 순서 전체를 대신하고, 스냅샷에 규칙 id·이름·팀이 남는다.
근거: `AH src/lib/routing.ts:1-66`, `AH src/server/routing.ts:13-55`. 처음 넣은 커밋은 e5ddb70.

**R1-8. 라우팅은 통지를 막는 쪽으로 실패하지 않는다.** 매치가 없거나, 팀에 활성 멤버가 없거나, 조회가 실패하면 트리 결과를 그대로 쓴다.
근거: `AH src/server/routing.ts:22-31, 56-59`.

**R1-9. 미매핑 계정의 알람에는 담당이 없다.** 아무에게도 페이징하지 않고, 스냅샷도 고객사도 없이 저장한다. 그 결과 에스컬레이션 대상에서도 빠진다(`snap` 없음 → skip).
근거: `AH src/server/alerts.ts:101-105`, `AH src/app/api/cron/escalate/route.ts:86-87`.

## 2. 시간대 온콜 (시프트 · 대체 근무)

**R2-1. 우선순위는 대체 근무 > 시프트 > 팀 기본 순서다.** 결과 순서는 이긴 레이어의 사람들 뒤에 팀 기본 순서를 이어 붙이고 중복을 없앤 것이다. 당번이 받지 못하면 에스컬레이션이 팀 나머지로 이어지게 하려는 것이다. 대체 근무자는 시프트 멤버 앞에 끼운다. 시프트 멤버를 대체하지 않는다.
근거: `AH src/lib/oncall.ts:1-10, 144-166`. 처음 넣은 커밋은 921ddd1.

**R2-2. 시프트는 요일 집합과 [startMin, endMin) 창으로 정의한다.** 분은 자정 기준이며 0..1440 범위다. `endMin <= startMin`이면 자정을 넘기는 창이다. 이때 요일은 **시작 요일 기준**이라서, 월요일 22:00–06:00 시프트는 화요일 05:59까지 덮는다. 시프트가 겹치면 priority가 큰 것을 쓰고, 같으면 목록 앞의 것을 쓴다. 꺼 둔(disabled) 시프트는 무시한다.
근거: `AH src/lib/oncall.ts:90-118`.

**R2-3. 대체 근무는 사람 1명과 [startAt, endAt) 절대 시각 구간이다.** 겹치면 가장 늦게 시작한 것이 이긴다("가장 구체적인 의도").
근거: `AH src/lib/oncall.ts:120-130`.

**R2-4. 시각은 팀 시간대로 해석한다.** 시간대가 잘못됐거나 비어 있으면 `Asia/Seoul`로 대신한다. 일부 런타임이 자정을 "24"시로 찍는 경우를 보정한다. 대체 근무 입력(datetime-local)은 팀 시간대 벽시계 시각으로 읽고, DST 보정을 한 번 한다.
근거: `AH src/lib/oncall.ts:56-88, 229-245`.

**R2-5. 해석 시점은 발화 시점이다.** 시프트와 대체 근무는 스냅샷을 만들 때 한 번 적용되고 순서에 얼려진다(R3). 에스컬레이션 도중에 시프트가 바뀌어도 진행 중인 사다리는 바뀌지 않는다.
근거: `AH src/server/org.ts:381-385`(resolveTeamOrders), `AH src/lib/escalation.ts:84-86`.

## 3. 수신 시점 스냅샷

**R3-1. 첫 접수 때와 재발화 때마다 담당 스냅샷을 알람에 얼린다.** 스냅샷에는 capturedAt, 채택 단계, 체인 id와 이름, order[{contactId, name, team, shift}], rule이 들어간다. 이름을 따로 복사해 두므로 이름을 바꾸거나 삭제한 뒤에도 기록이 맞게 읽힌다. 재발화하면 스냅샷을 새로 만든다. "지금 인시던트에 실제로 통지된 목록"이어야 하기 때문이다.
근거: `AH src/server/org.ts:486-541`, `AH src/server/alerts.ts:262-272`(생성), `:381-389`(재발화 갱신). 처음 넣은 커밋은 636b9b3(BR-05).

**R3-2. 스냅샷은 "누구·어떤 순서"만 얼린다. 연락 수단은 얼리지 않는다.** 에스컬레이션 통지 시점에 연락처(slackId/email/phone)를 다시 읽는다. 그 사이 삭제된 사람은 이름만 남고 연락 수단이 비어서, 채널마다 skipped가 된다.
근거: `AH src/app/api/cron/escalate/route.ts:114-125`.

**R3-3. 스냅샷이 깨졌으면 "스냅샷 없음"으로 처리한다.** 화면이 죽지 않게 하려는 것이고, 에스컬레이션도 건너뛴다.
근거: `AH src/server/org.ts:545-563`.

## 4. 에스컬레이션 시각 계산

**R4-1. 규칙은 하나다. FIRING인 채로 ack 창(N분)이 지나면 얼린 순서의 다음 사람 1명에게 통지한다.** N은 `ESCALATION_ACK_MINUTES` 값이고 기본 10이다. 값이 없거나, 숫자가 아니거나, 0 이하면 10을 쓴다. 이 값은 전역 하나이고 팀별로 따로 두지 않는다.
근거: `AH src/lib/escalation.ts:1-10, 78-82`.

**R4-2. "N분 내 ack 없음"의 기준 시각은 `escalatedAt ?? snapshot.capturedAt`이다.** 직전 에스컬레이션 통지가 있었으면 그 시각, 없으면 발화(스냅샷 생성) 시각이다. 따라서 각 단계 사이 간격이 N분이다. 누적 시각이 아니다. 판정식은 `now - base >= N분`이다. base가 없거나 숫자가 아니면 아무 일도 하지 않는다.
근거: `AH src/lib/escalation.ts:29-45`, 호출은 `AH src/app/api/cron/escalate/route.ts:89-99`.

**R4-3. 이벤트 문구에 기준 시각을 함께 적는다.** 형식은 `"{발화|이전 통지} YYYY-MM-DD HH:MMZ 이후 {N}분 내 ack 없음 → {k}순위 {이름}에게 자동 에스컬레이션"`이다. 시각만 적혀 있으면 이벤트 시각과 모순처럼 읽히는 문제가 있어 넣었다.
근거: `AH src/app/api/cron/escalate/route.ts:127-139`. 고친 커밋은 8b98366(personas P2).

**R4-4. 단계 번호.** `escalationStep`은 "이미 통지된 사람 수"이고 1이면 1순위만 받은 상태다. 기본값은 1이다. 다음 대상은 `order[escalationStep]`(0-based)이다. 통지하면 step+1을 하고 `escalatedAt=now`로 둔다. `step >= order.length`이면 사다리가 끝난 것이고 더는 아무것도 하지 않는다. 한 틱에 한 칸만 오른다.
근거: `AH src/lib/escalation.ts:13-21, 36-46`, `AH prisma/schema.prisma:58-59`, `AH src/app/api/cron/escalate/route.ts:104-111`.

**R4-5. 선점은 낙관적 갱신으로 한다.** `updateMany where {id, status:FIRING, escalationStep:<읽은 값>}`가 0건이면 이번 틱에서 건너뛴다. 겹친 틱이나 그 사이 들어온 ack/resolve와 경쟁하지 않게 하려는 것이다. 순서가 선점 → 이벤트 기록 → 통지이므로, 통지가 실패해도 단계는 이미 올라가 있다. 통지 재시도는 아웃박스가 맡는다.
근거: `AH src/app/api/cron/escalate/route.ts:102-112, 150-156`.

**R4-6. 뮤트(점검 창)가 덮고 있으면 에스컬레이션도 멈춘다. 단계는 건드리지 않는다.** 그래서 뮤트가 끝나면 base가 이미 오래전이라 **다음 틱에 밀린 한 단계가 바로 나간다**. 그 뒤로는 다시 N분 간격이다.
근거: `AH src/app/api/cron/escalate/route.ts:80-85`.

**R4-7. 재발화하면 사다리를 1순위부터 다시 시작한다.** RESOLVED나 INSUFFICIENT_DATA에서 FIRING으로 넘어갈 때 `escalationStep=1, escalatedAt=null`로 되돌리고 스냅샷을 새로 만든다.
근거: `AH src/server/alerts.ts:305-313`.

**R4-8. 틱 엔드포인트.** `GET /api/cron/escalate`는 `CRON_SECRET` Bearer 헤더나 `?secret=`로 인증하고, 비교는 constant-time으로 한다. 비밀이 설정되지 않았으면 503을 돌려주고 기능이 꺼진 것으로 본다. 매 틱마다 FIRING 전체를 스캔하고 `{checked, escalated, muted, ackMinutes}`를 돌려준다.
근거: `AH src/app/api/cron/escalate/route.ts:22-68, 160`.

**R4-9. 실제 틱 주기는 바깥 스케줄러가 정한다.** README는 1분 간격 외부 호출을 요구한다. 그런데 저장소의 `vercel.json`에는 `"0 0 * * *"`(하루 1회)만 등록돼 있다. 외부 스케줄러를 따로 두지 않으면 **에스컬레이션이 사실상 하루 1회만 돈다**.
근거: `AH vercel.json:3-5`, `AH README.md:126, 423-431`. D-10의 배경이 이것이다.

## 5. 반복

**R5-1. AH에는 반복이 없다.** 사다리 끝까지 가면 멈춘다. 처음으로 돌아가는 순환, 팀장 추가 통지, ack 뒤 재알림은 구현돼 있지 않다. 단계별 채널 사다리(0분 Slack → 5분 문자 → 10분 전화 → 15분 다음 순번)는 문서상 계획일 뿐이다.
근거: `AH src/lib/escalation.ts:13`(`>= orderLength → null`), `AH docs/oncall-paging.md` "재개할 때 만들 것" 2항.

**R5-2. AAM은 확인(ACK)된 뒤 풀리지 않은 사건을 다시 알린다.** ACKNOWLEDGED 상태에서 `after_sec`가 지나면 다시 알리고 `renotified_at`을 갱신해, 주기마다 한 번씩만 울린다. 다시 알릴 때도 원래 채널 조건(계정·리소스 유형)을 따른다.
근거: `AAM backend/common/incident.py:205-223`, `AAM backend/alert_router/lambda_handler.py:545-606`. 고친 커밋은 71aa6e2(M4).

## 6. ack · resolve 의미

**R6-1. 사람이 만드는 전이는 두 가지다.** FIRING → ACKNOWLEDGED, 그리고 {FIRING, ACKNOWLEDGED} → RESOLVED. 알람 상세 버튼, 대시보드 일괄 Ack, Slack 버튼이 모두 같은 함수(`transitionAlert`)를 지난다. 이 함수는 가드된 updateMany를 쓰므로 중복 제출이나 경쟁은 조용히 아무 일도 하지 않는다. ack에는 `ackedBy=actor`를 남긴다. 이력은 append-only AlertEvent에 남는다. 권한은 OPERATOR 이상이고, 알람이 자기 범위 안에 있어야 한다.
근거: `AH src/server/alert-transitions.ts:32-58`, `AH src/server/alert-actions.ts:25-90`.

**R6-2. ack는 끈질기다.** ACKNOWLEDGED인 알람에 공급자가 같은 FIRING을 다시 보내도(Prometheus/Grafana의 주기 재전송) 상태를 되돌리지 않고 다시 페이징하지 않는다. 필드 값만 갱신한다. INSUFFICIENT_DATA(NoData 플랩)도 ack를 풀지 않는다. ack를 푸는 것은 RESOLVED/OK뿐이다.
근거: `AH src/server/alerts.ts:298-336`.

**R6-3. ack하면 에스컬레이션이 멈춘다.** 판정 조건이 `status === FIRING`이기 때문이다.
근거: `AH src/lib/escalation.ts:35`.

**R6-4. 공급자의 RESOLVED/OK는 어떤 상태에서든 적용된다.** 이때 해결 기록을 `via=auto`로 남기고, 봇 메시지를 "해결됨"으로 동기화한다(notification.md R3).
근거: `AH src/server/alerts.ts:337-364`.

## 7. 해결 기록 ("이전 처리")

**R7-1. RESOLVED가 될 때마다 Resolution 행 하나를 남긴다.** 사람이 닫으면 `via=manual, resolvedBy=actor`, 공급자 OK면 `via=auto, kind=auto`다. 행에는 고객사·서비스·메트릭·리소스, 걸린 시간(durationSec), escalationStep이 함께 남는다.
근거: `AH src/server/history.ts:22-72`, `AH prisma/schema.prisma:143-176`. 처음 넣은 커밋은 adf175f.

**R7-2. 해결 방법 분류는 한 번 클릭이다.** 분류는 restart(재시작), config(설정·용량 변경), auto(저절로 회복), other(기타)다. 사람이 해결하면 Slack 스레드에 버튼 4개가 붙는다.
근거: `AH src/lib/history.ts:6-14`, `AH src/lib/notify/slack-blocks.ts:94-118`.

**R7-3. 24시간 안에 재발하면 표시한다.** 다시 FIRING이 되면 그 알람의 마지막 해결 기록 중 아직 재발 표시가 없고 24시간 안의 것에 `recurredAt`을 찍는다. "그 조치는 오답이었다"는 신호로 쓴다.
근거: `AH src/server/history.ts:16, 74-89`, `AH src/server/alerts.ts:314-318`.

**R7-4. "이전 처리"는 같은 고객사 안에서 가까운 순으로 고른다.** 가까운 정도는 tier 1(같은 서비스·메트릭·리소스) > tier 2(같은 서비스·메트릭) > tier 3(같은 서비스) 순이다. 같은 tier 안에서는 최근 것을 먼저 쓴다. 후보는 최근 200건이고 최대 5건까지 고른다. Slack 한 줄 형식은 `🕘 {요약} · 최근: {설명} "{메모}" ({날짜})`이고, 기록이 없으면 "🕘 이전 처리 기록 없음 · 처음 보는 알람"이다. 조회가 실패하면 빈 값으로 둔다(best-effort). 에스컬레이션 메시지에는 붙이지 않는다.
근거: `AH src/lib/history.ts:45-73, 143-149`, `AH src/server/history.ts:101-125`, `AH src/server/alerts.ts:167-176`, `AH src/lib/notify/slack-format.ts:157`.

## 과거 수정 사례

| 커밋 | 내용 | 교훈 |
|---|---|---|
| AH 8b98366 | 에스컬레이션 이벤트에 "N분"의 기준(발화 / 이전 통지)이 없어 모순처럼 읽혔다 | 기준 시각을 기록과 문구에 함께 남긴다 |
| AH 1b27f2f | 위쪽 단계 어디에도 담당이 없는데 편집기가 "상위에서 상속"이라고 표시했다. 아무도 받지 않는 스코프가 누군가 받는 것처럼 보였다 | 상속 표시는 알람 해석과 **같은 함수**로 계산한다 |
| AH fd67c37 | 동시에 들어온 FIRING이 count++와 통지를 두 번 냈고, 생성 경쟁에서 크래시가 났다 | 상태 가드 updateMany와 유니크 위반 흡수 |
| AH c20e6f0 | 조직 편집의 동시성 문제와 유니크 제약 누락 | 배정 유니크 (contact|team × scope) |
| AH vercel.json(코드 상태) | 에스컬레이션 cron이 하루 1회로 등록돼 있다 | D-10: 1분 틱과 heartbeat |
| AAM 277af15, e04d4f6 | 사건 쓰기 경쟁(낙관적 잠금 누락), 삭제된 알람의 사건이 열린 채로 남음 | 모든 쓰기에 버전 가드, 고아 사건 정리 |
| AAM 71aa6e2 | 재알림이 채널 조건을 무시했다 | 재알림도 최초 통지와 같은 라우팅을 탄다 |

## 새 구현에서 바꿀 점

1. **(D-10) 틱은 Postgres pg_cron으로 1분마다 돌린다.** 마지막 틱 시각을 heartbeat 행에 남기고, 그 값이 예를 들어 3분 넘게 묵으면 경보를 낸다. 틱 주기가 배포 설정 파일(vercel.json)에 숨어 있는 구조를 없앤다.
2. **(D-11) 단계별 채널 사다리를 팀 정책으로 둔다.** 예: 0분 Slack 채널 + DM → 5분 문자 → 10분 음성(키패드 1 = ack) → 15분 다음 순번. AH는 "사람 단위 사다리 + 모든 채널 동시 발송"이었고, 문자·음성은 에스컬레이션 단계(step ≥ 2)에서만 나갔다. 단계마다 `(사람, 채널, 대기 분)`을 두고, 기준 시각은 R4-2와 같은 **직전 통지 시각**으로 한다. ack 창 N은 전역 env가 아니라 정책 값으로 둔다.
3. **(D-11) 반복 정책을 넣는다.** 사다리가 끝났을 때 처음으로 돌지, 팀장에게 알릴지 정한다. AAM처럼 ack 뒤 미해결 사건을 다시 알리는 것도 넣는다(R5-2). AH의 "끝나면 침묵"은 그대로 옮기지 않는다.
4. **스냅샷 원칙은 그대로 둔다.** 순서는 발화 시점에 얼리고, 연락 수단은 통지 시점에 읽는다. 재발화하면 스냅샷을 새로 만들고 1순위부터 다시 시작한다. 뮤트가 끝난 직후 밀린 단계가 즉시 나가는 동작(R4-6)은 의도대로 둘지 검토한다(제안: 뮤트 종료 시각을 새 기준으로).
5. **통지 실패를 단계 진행과 연결한다.** 선점 후 통지가 실패했을 때 대상자가 받지 못했는데도 다음 단계로 넘어간다(R4-5). 새 구현에서는 단계 기록에 채널별 결과를 남기고, 모든 채널이 실패하면 즉시 다음 단계로 넘길지 정책으로 정한다 **(추정 필요성: AH에는 그런 처리가 없다)**.
6. **시프트의 자정 넘김 "시작 요일 기준", 대체 근무 "늦게 시작한 것 우선", 기본 순서를 꼬리로 붙이는 규칙은 테스트와 함께 그대로 옮긴다**(AH tests/oncall*).
