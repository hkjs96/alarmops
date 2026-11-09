# 통지 동작 명세

상태: 초안

- 출처: alert-hub(AH) 기준 커밋 49c83dc, aws-alert-manager(AAM) 기준 커밋 4eafce9. 두 저장소는 읽기만 했다.
- 표기: 코드로 확인하지 못하고 미루어 짐작한 내용은 **(추정)**으로 표시한다.
- 관련 결정: D-10, D-11.

## 1. 팬아웃과 아웃박스

**R1-1. 통지할 채널은 설정된 노티파이어(slack, email, twilio)에서 정해진다.** 설정된 채널마다 NotificationJob을 하나씩 만들고, 그 자리에서 곧바로 한 번 보내 본다. 설정된 채널이 하나도 없으면 아무 일도 하지 않는다. 큐 조작이 실패해도 그 실패를 삼키고, 수집(ingest)은 계속 진행한다.
근거: `AH src/server/notify-queue.ts:269-306`, `AH src/lib/notify/index.ts:74-79`.

**R1-2. 실패하면 다시 시도한다.** 간격은 30초, 1분, 2분, 5분, 10분이다. 5번 실패하면 포기하고 `failed`로 기록한다. 잡을 가져갈 때는 attempts를 낙관적으로 갱신하면서 다음 시도 시각을 미리 적어 둔다. 그래서 보내는 도중에 프로세스가 죽어도 그 시각이 되면 잡이 다시 살아난다. 채널 설정이 사라진 잡은 다시 시도하지 않고 바로 포기한다.
근거: `AH src/lib/notify/backoff.ts:1-17`, `AH src/server/notify-queue.ts:65-152`. 처음 넣은 커밋은 7b7068c.

**R1-3. NotificationLog에는 sent와 failed만 남긴다.** skipped(수신자가 없거나 해당하지 않는 채널)는 남기지 않는다. 대상은 "1순위 이름 외 n명" 형식으로 적고, 에스컬레이션 단계도 함께 남긴다.
근거: `AH src/server/notify-queue.ts:30-61`.

**R1-4. 재시도는 틱(`/api/cron/notify`)이 처리한다.** 한 틱에 최대 50건을 보낸다.
근거: `AH src/app/api/cron/notify/route.ts:43`. 그런데 `vercel.json`에는 이 틱이 **하루 1회**(`30 0 * * *`)로만 등록돼 있다. 외부 스케줄러가 없으면 재시도와 묶음 통지(R2)가 최대 24시간 늦어진다 **(추정: 운영에서 외부 1분 호출을 따로 두었는지는 저장소로 확인할 수 없다)**. 근거: `AH vercel.json:5`, `AH README.md:126`.

## 2. 묶음 통지(다이제스트)

**R2-1. 서비스를 알 수 있는 알람은 Slack 잡의 첫 시도를 묶음 창만큼 늦춘다.** 묶음 키는 `groupKey="service:<id>"`이고, 묶음 창은 `NOTIFY_DIGEST_WINDOW_SECONDS`로 정하며 기본 60초, 0이면 묶음을 끈다. email과 twilio 잡은 늦추지 않는다. 에스컬레이션 통지에는 groupKey가 없으므로 묶지 않는다.
근거: `AH src/server/alerts.ts:220-226`, `AH src/server/notify-queue.ts:244-292`, `AH src/app/api/cron/escalate/route.ts:150-156`.

**R2-2. 틱이 보낼 때가 된 Slack 잡을 키별로 모은다.** 가져온 잡이 1건이면 평소처럼 단건 메시지로 보낸다. 2건 이상이면 한 메시지로 묶어 보낸다. 헤더는 "🚨 {서비스} 알람 N건 — SEV-x n · …"이고, 그 아래에 체인 라벨, 알람마다 한 줄(이모지, 링크 걸린 제목, 사유 또는 메트릭), 첫 알람 기준 담당 1순위와 다음 순서, 대시보드 링크가 붙는다. 묶음 메시지에는 버튼이 없고 메시지 좌표도 기록하지 않는다. 그래서 묶여서 나간 알람은 나중에 상태 동기화(R4)를 받지 못한다(코드상 `sendSlackText`에 alertId를 넘기지 않는다). 묶음 발송이 성공하면 모든 잡이 sent가 되고, 실패하면 모든 잡이 각자의 백오프로 다시 시도한다.
근거: `AH src/server/notify-queue.ts:154-193, 224-240`, `AH src/lib/notify/slack.ts:116-166`.

**R2-3. AAM은 그룹마다 한 번, 채널마다 한 통을 보낸다.** "대표 1건 + 외 N건" 형식이다. 대표는 심각도가 가장 높은 것을 고른다. 발송은 claim-then-send 방식이라 많아야 한 번 나간다. 보내기 전에 `delivered_at`을 조건부로 적으므로 두 번 나가지 않고, 대신 보내다가 죽으면 그 통지는 빠진다. 결과는 이력과 `alert_delivery` 지표로 남는다.
근거: `AAM backend/alert_router/lambda_handler.py:1-20, 296-335`.

## 3. 재발화 스로틀

**R3-1. 마지막 팬아웃 후 N분 안에 다시 FIRING으로 넘어오면(플랩) 팬아웃을 건너뛴다.** N은 `REFIRE_THROTTLE_MINUTES`로 정하며 기본 10분, 0이면 끈다. 수집, 이벤트, count, 스냅샷은 평소대로 갱신한다. 스로틀 판정이 실패하면 막지 않고 통지한다(fail-open).
근거: `AH src/lib/refire-throttle.ts:1-28`, `AH src/server/alerts.ts:198-218`.

**R3-2. 스로틀의 기준 시각 `lastNotifiedAt`은 잡을 만든 순간에 찍는다.** 에스컬레이션 통지도 같은 `enqueueAndSend`를 거치므로 이 시각을 갱신한다 **(추정: 의도하지 않은 부수 효과로 보인다. 에스컬레이션 직후에 재발화하면 그것도 스로틀된다)**.
근거: `AH src/server/notify-queue.ts:296-301`.

**R3-3. 점검 창(뮤트)이 덮고 있으면 팬아웃을 생략한다.** 뮤트가 끝나면 남아 있던 FIRING을 바로 다시 팬아웃한다(`refireNotifications`).
근거: `AH src/server/alerts.ts:186-197, 412-420`.

## 4. Slack 메시지 형식과 버튼

**R4-1. 본문은 Block Kit으로 만들고 다음 순서로 쌓는다.**
1. header: "{심각도 이모지} {제목} · {리소스 이름}". 150자에서 자른다.
2. 조직과 담당: 체인 라벨, "담당 1순위 <@slack> · 다음 A → B". 에스컬레이션이면 "⏫ 자동 에스컬레이션 → k순위 … 앞 순위가 아직 확인하지 않았습니다"를 쓴다. 미매핑이면 "_담당이 정해지지 않은 알람입니다 (계정 미매핑)_".
3. 2열 필드(최대 10개): 지표, 현재값 / 임계값(비교 기호), 리소스(EC2 Name 태그), 계정 · 리전, 심각도, 출처(cloudwatch가 아닐 때).
4. 스파크라인: CloudWatch 사유 문구 안의 datapoints를 쓴다. 값이 2개 이상일 때만 넣는다.
5. 맥락 줄: 사유(280자 요약), 이전 처리(에스컬레이션 메시지에는 넣지 않음), 런북·콘솔 링크.
6. 그래프 image 블록.

fallback text는 "{이모지} {제목} — {상태} · 리소스 · 체인 · 값"이다.
근거: `AH src/lib/notify/slack-format.ts:99-178`. 심각도 이모지는 `:15-23`.

**R4-2. 버튼은 봇 메시지에만, 그리고 FIRING일 때만 붙는다.** 웹훅으로 보내는 메시지는 블록은 그리지만 버튼은 넣지 않는다. 클릭 신호가 우리 앱으로 오지 않기 때문이다. 상태별 버튼은 다음과 같다.
- FIRING: "✓ 확인 (Ack)"(primary), "해결 (Resolve)", "1시간 뮤트", "alert-hub 에서 열기"(URL 버튼)
- ACKNOWLEDGED: Resolve, 뮤트, 열기
- RESOLVED: 열기만

뮤트 중이면 뮤트 버튼을 숨긴다. 상태 줄은 "🔥 발화 중 — 확인 전", "👀 확인됨 · {누가} · {언제}", "✅ 해결됨 · …", "🔇 1시간 뮤트 · …" 중 하나다. action_id는 `ah_ack`, `ah_resolve`, `ah_mute`, `ah_kind:<k>`, `ah_open`이다.
근거: `AH src/lib/notify/slack-blocks.ts:20-77`, `AH src/lib/notify/slack.ts:38-69, 182-186`. 처음 넣은 커밋은 3727afe.

**R4-3. 목적지는 스코프 채널을 따라 정한다.** 서비스, 프로젝트, 고객사 순으로 보고, 채널이 하나라도 있는 가장 구체적인 단계의 목록을 통째로 쓴다. 담당 배정과 같은 규칙이다. 어디에도 없으면 전사 기본(봇 기본 채널 → `SLACK_WEBHOOK_URL`)으로 보낸다. 목적지 하나가 실패해도 다른 목적지는 계속 보내고, 모두 실패했을 때만 throw한다. 종류는 SLACK_BOT(우리 워크스페이스 채널)과 SLACK_WEBHOOK(고객사 워크스페이스의 Incoming Webhook)이다.
근거: `AH src/lib/notify/targets.ts:1-26`, `AH src/lib/notify/slack.ts:28-96`. 처음 넣은 커밋은 fec8209.

**R4-4. 에스컬레이션이면 채널 글에 더해 당사자에게 DM을 보낸다.** 봇이 없으면 DM은 건너뛴다. DM이 실패해도 통지 결과는 바꾸지 않는다.
근거: `AH src/lib/notify/slack.ts:187-197`.

**R4-5. 봇이 보낸 메시지는 좌표(channel, ts, text, blocks)를 SlackMessage에 저장한다.** 나중에 상태를 동기화할 때 본문을 원문 그대로 되살리는 데 쓴다. Slack이 돌려주는 text는 줄바꿈이 사라져 있어서 그대로 쓸 수 없다.
근거: `AH src/server/slack-sync.ts:12-32`.

## 5. 스레드와 상태 동기화

**R5-1. 상태가 바뀌면 메시지를 맞춘다.** 웹, 공급자 OK/ack, Slack 버튼 중 어디서 바뀌든 그 알람의 **이번 발화** 메시지를 모두 갱신한다. 본문은 그대로 두고 상태 줄과 버튼만 바꾼다(chat.update). 스레드에는 한 줄을 남긴다: "✓ {actor} 님이 확인했습니다 (via)", "● … 해결 처리했습니다", "🔇 … 1시간 뮤트했습니다". 사람이 아니면(공급자 OK) 상태만 적는다. 사람이 해결했으면 스레드에 분류 버튼 4개를 붙인다. 동기화가 실패해도 삼킨다. Slack 장애 때문에 ack가 실패하면 안 되기 때문이다.
근거: `AH src/server/slack-sync.ts:53-121`, `AH src/lib/notify/slack-blocks.ts:79-92`, `AH src/server/alert-transitions.ts:47-57`.

**R5-2. "이번 발화"는 마지막 FIRING 이벤트 시각에서 5초를 뺀 시각 이후에 보낸 메시지다.** 지난 발화 메시지의 상태 줄을 바꾸거나 그 스레드에 글을 다는 일을 막는다.
근거: `AH src/server/slack-sync.ts:74-89`. 고친 커밋은 4deb94f.

## 6. Slack 인터랙션 처리

**R6-1. 요청은 `SLACK_SIGNING_SECRET` 서명으로 확인한다.** 시각 차이가 5분을 넘으면 거부한다. 비밀이 설정되지 않았으면 503을 돌려준다. 세션은 보지 않는다.
근거: `AH src/lib/slack/verify.ts:17`, `AH src/app/api/slack/interactive/route.ts:29-41`.

**R6-2. 누른 사람은 Slack ID로 찾는다.** `active` 상태이고 status=ACTIVE인 Contact여야 한다. 고객사 담당자이거나 OPERATOR 미만이면 본인에게만 보이는(ephemeral) 거절 안내를 보내고 아무것도 바꾸지 않는다. 알람이 그 사람의 범위 밖이어도 거절한다.
근거: `AH src/app/api/slack/interactive/route.ts:60-102`.

**R6-3. 누른 메시지는 3초 안에 반응해야 하므로 `response_url`로 먼저 바꾼다.** 그다음 `transitionAlert`를 부르고, 이때 누른 메시지는 동기화 대상에서 뺀다. 그 메시지의 스레드 한 줄은 직접 남긴다. 그 사이 상태가 바뀌었으면 "그 사이 상태가 바뀌어 처리하지 않았습니다"를 ephemeral로 보낸다. 이미 해결됐거나 이미 확인된 알람이면 그 안내를 보낸다.
근거: `AH src/app/api/slack/interactive/route.ts:136-182`.

**R6-4. 뮤트 버튼은 알람 단위로 1시간짜리 Silence를 만들고 이벤트를 남긴다.** 이미 해결된 알람이면 거부한다.
근거: `AH src/app/api/slack/interactive/route.ts:111-134`.

**R6-5. 분류 버튼(`ah_kind`)은 알람 상태를 바꾸지 않는다.** 해결 기록만 갱신하고, 메시지를 "✓ {분류} 으로 기록 · {이름}"으로 바꾼다.
근거: `AH src/app/api/slack/interactive/route.ts:80-91`.

## 7. 그래프 첨부

**R7-1. 그래프는 서명 주소를 가리키는 image 블록으로 본문에 넣는다.** 주소는 `{APP_URL}/api/g/<alertId>.png?e=&s=`이고, HMAC(`graph:<id>:<exp>`)으로 서명하며 30일 동안 유효하다. 키는 GRAPH_URL_SECRET, AUTH_SECRET, CRON_SECRET 순으로 찾고 16자 이상이어야 한다. 로그인 없이 열리지만 그 알람 하나의 그래프만 볼 수 있다. 창은 발화 전후로 고정돼 있어서 Slack이 다시 불러와도 같은 그림이 나온다. 캡션은 "발화 전후 3시간 · 빨간 선 = 발화, 주황 선 = 임계값"이다. 그래프는 고객사 계정에 읽기 역할(readerRoleArn)이 연결돼 있을 때만 붙는다.
근거: `AH src/lib/aws/graph-url.ts:1-50`, `AH src/server/graph.ts:29-32`, `AH src/lib/notify/slack-format.ts:162-171`.

**R7-2. Slack이 이미지를 가져오지 못해 메시지 전체를 거절하면 그래프 블록만 빼고 다시 보낸다.** 알람 통지는 반드시 나가야 하기 때문이다. 봇, DM, 웹훅 모두 같다.
근거: `AH src/lib/notify/slack.ts:43-69, 99-114`.

**R7-3. 공개 주소가 없으면 그래프와 "열기" 버튼이 사라진다.** 그래서 APP_URL이 비면 Vercel 운영 도메인을 대신 쓴다.
근거: 커밋 20ece9e, `AH src/lib/app-url.ts`.

## 8. 이메일 · 문자 · 음성

**R8-1. 이메일은 SMTP로 보낸다.** 최초 통지는 담당 전원에게 간다: 첫 사람이 To, 나머지가 Cc다. 에스컬레이션 통지는 그 단계의 당사자 1명에게만 간다. 제목 앞에 `[에스컬레이션 k순위]`를 붙인다. 이메일 주소가 있는 사람이 없으면 skipped다.
근거: `AH src/lib/notify/email.ts:14-24, 54-87`.

**R8-2. 문자와 음성(Twilio)은 에스컬레이션 전용이다.** 최초 통지에는 보내지 않는다. 대상은 그 단계의 당사자 1명이고 phone이 있어야 한다. 문자는 "[alert-hub] k순위 에스컬레이션 — {제목} ({심각도}). 앞 순위 미ack. {링크}"이다. 음성이 켜져 있으면 TwiML `<Say language="ko-KR">`로 읽는다. 음성 통화에는 ack 회신 기능이 없다.
근거: `AH src/lib/notify/twilio.ts:70-105`. 처음 넣은 커밋은 98f098b.

**R8-3. Twilio는 국내에서 해외 번호로 표시돼 받지 않거나 스팸으로 차단된다.** 그래서 솔라피(SMS + TTS 음성, 키패드 1 = ack)로 결론을 냈지만 구현은 보류했다. 발신번호 등록 절차가 필요하다.
근거: `AH docs/oncall-paging.md` "결론"·"검토했지만 고른 안 이유".

## 9. 채널 확인 상태

**R9-1. Contact는 채널(slack/email/phone)마다 `*VerifiedAt`과 `*VerifiedVia`를 가진다.** Via 값은 code, link, sso, slack-lookup, `admin:<이름>` 중 하나다. 주소가 바뀌면 확인 상태를 초기화한다.
근거: `AH prisma/schema.prisma:380-392`.

**R9-2. 관리자가 대신 확인하는 방법은 두 가지다.**
1. 그 채널로 24시간짜리 1회용 링크를 보낸다. 토큰은 해시로 저장하고, 실제로 보낸 경우에만 ChannelVerification 행을 만든다.
2. 수동 확인: 누가 했는지와 메모를 기록한다.

링크가 만료되면 expired, 이미 썼으면 already로 처리한다.
근거: `AH src/server/verify-actions.ts:29-134`.

**R9-3. 확인 상태는 발송 여부를 막지 않는다.** 노티파이어는 확인되지 않은 주소로도 보낸다(notify 경로에서 VerifiedAt을 참조하지 않는다). 확인 상태는 화면에 보여 주는 용도로만 쓴다.
근거: `grep VerifiedAt` 결과에 `src/lib/notify/*`가 없음.

## 10. AAM 쪽 참고

- 어댑터 레지스트리는 slack, email, webhook이다. 비밀 필드는 공개 설정에서 가린다. 모든 사용자 문자열은 Slack mrkdwn으로 이스케이프한다(알람 이름의 `<` `>`). 등급 색 막대(attachment)를 쓰고, OK면 해결 색을 쓴다.
  근거: `AAM backend/common/notification_adapters.py:163-317`. 고친 커밋은 71aa6e2(M5).
- 채널 선택은 조건(고객사, 계정, 리소스 유형) 매칭으로 한다. 정렬은 고객사 채널이 먼저, 전역 채널이 나중이고, 그 안에서는 이름순이다.
  근거: `AAM backend/common/notification_channel.py:263-266`.
- 채널 API: POST가 기존 채널을 조용히 덮어쓰지 않게 했고, 쓸 수 없는 유형이 화면에 보이게 했고, 리디렉트를 따라가지 않게 했다. 커밋 4b5b079(L2–L4).
- 보낼 시간 예산을 넘기지 않게 했다. 커밋 517b3d3.

## 과거 수정 사례

| 커밋 | 내용 |
|---|---|
| AH 02a2012 → 09ab258 → 4deb94f | 그래프를 스레드에 업로드해 본문에 끼워 넣었더니, 채널에 공유되지 않은 파일은 그려지지 않았다. 서명 이미지 주소 방식으로 바꿔 해결했다. 같은 커밋에서 **지난 발화 메시지까지 갱신하던 버그**도 고쳤다 |
| AH 20ece9e | APP_URL이 비어 있어 Slack 버튼과 그래프가 사라졌다 |
| AH 3727afe | 버튼, 상태 동기화, 스레드를 처음 넣으면서 서명 재전송 창을 5분으로 정했다 |
| AAM 71aa6e2 | 재알림이 채널 조건을 무시했고, mrkdwn 이스케이프가 없었다 |
| AAM 27f20dd, 517b3d3 | sweep된 그룹이 라우터에 닿지 않았다. 발송 시간 예산을 넣었다 |

## 새 구현에서 바꿀 점

1. **(D-10) 아웃박스 드레인과 묶음 통지는 1분 pg_cron 틱으로 돌린다.** 하루 1회 cron 때문에 재시도와 다이제스트가 지연되던 문제(R1-4)를 없앤다. 묶음 창을 60초로 둘 거라면 틱을 그보다 촘촘하게 둘지 검토한다.
2. **(D-11) 문자와 음성은 국내 업체(솔라피 등)로 보낸다.** 발신번호를 등록하고, 음성은 키패드 회신 웹훅으로 ack를 받는다(기존 ack 경로를 재사용하고 actor는 담당자로 둔다). Twilio 어댑터는 옮기지 않는다. 채널별 단계와 대기 시간은 oncall-escalation.md "새 구현에서 바꿀 점" 2항을 따른다.
3. **묶음 메시지에도 버튼과 메시지 좌표를 넣어 상태 동기화가 되게 한다**(R2-2의 공백). 대안은 다이제스트를 스레드 부모로 쓰고, 알람마다 스레드 답글로 버튼을 다는 것이다.
4. **재발화 스로틀 기준을 최초 팬아웃 시각으로 한정한다.** 에스컬레이션 발송은 `lastNotifiedAt`을 갱신하지 않게 한다(R3-2).
5. **확인되지 않은 채널을 어떻게 다룰지 정책으로 정한다.** 경고만 할지, 문자·음성 에스컬레이션에서는 막을지 정하고, 온콜 대상자가 확인된 채널을 하나도 갖지 않으면 편집 화면에서 경고한다(R9-3).
6. 그래프 서명 주소, 이미지가 거절됐을 때 그래프만 빼고 다시 보내기, 이번 발화 메시지만 동기화, response_url로 먼저 교체하기, Slack ID → 인원 → 권한 → 범위 순서의 검사는 그대로 옮긴다.
