# 보안 재검토 — feat/tick-escalation (수정 커밋 6ccddf0 core, 7b85c90 api)

- 대상: `/home/claude/wt-backend`, HEAD `7b85c90` (origin과 동일, 작업 트리 깨끗함). 1차 검토: `/home/claude/alarmops-security-review-tick.md`
- 방법: 두 커밋 diff 정독 + 전체 테스트 실행 + 저장소 밖 프로브로 우회 시도. 저장소는 수정하지 않았다.
- 프로브 (실행: `cd /home/claude/wt-backend && npx tsx <파일> [항목]`)
  - `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/v2-api.mts` — B1, PORTAL, PORTALN, PORTAL_EDGE, PARITY, IDEM, R6, CAPS, R7
  - `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/v2-core.mts` — T1, T2, T3, X, S, SE, U, M, R9Q2, L (F1·F2·F4는 폭주가 만들어지지 않아 무효, 아래 v2-fair로 대체)
  - `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/v2-fair.mts` — A, A2, B (공정성, 업체 지연)
  - `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/v2-trace.mts`, `v2-redos.mts`, `v2-misc.mts`
  - 1차 프로브 `probe1.mts`·`probe2.mts`·`probe3.mts`도 그대로 다시 돌렸다(1차 재현이 모두 사라짐).
- 테스트: console 76, api 82, core 198, design-system 83, ingest 32 전부 통과. 타입 검사 5개 워크스페이스 통과. db 검사는 통과했으나 Prisma 엔진 다운로드가 이 샌드박스에서 403이라 스크립트의 대체 경로로 검증됐다.

## 결론

- **[차단] 0건. 보안 관점에서 머지 가능.**
- B-1, R-1~R-10, 포털 serializer, 두 플래그 기본값은 모두 확인됐다. 우회는 찾지 못했거나, 찾은 것은 아래 [권고]의 잔여 사항이다.
- **조건 1건 (R-11)**: 실제 SMS·음성 업체를 붙이기 전에 고쳐야 한다. 업체가 응답 없이 멈추면 정상 채널의 호출까지 10분 넘게 밀린다. 1차 R-1~R-4와 같은 관문(파일럿 전)이다.
- **확인 범위의 한계**: R-2·R-3·R-1(공정 순서)의 보장은 메모리 저장소(`memoryStore.ts`)에서만 검증됐다. `claimSeq`, `lastManualEscalationAt`, `errorCode`, `targetKind`는 `db/prisma/schema.prisma`와 `docs/DATA-MODEL.md`에 아직 없다. SQL 어댑터 PR에서 같은 프로브를 다시 돌려야 한다.

## 항목별 확인표

| 항목 | 결과 | 근거 (프로브) |
|---|---|---|
| B-1 역할 fail-open | 확인 | `kind`가 PORTAL·소문자·배열·String 객체·null·누락이면 전 경로 401. CUSTOMER는 저장 역할이 ADMIN이어도 쓰기 403, `'*'`는 무시. `role`이 `__proto__`·`constructor`·`toString`·숫자·없는 값이면 403 (B1). 잔여: R-16 |
| R-1 발송 상한·공정 배분 | 확인 (잔여 R-11, R-12) | 1차 최악 설정 PUT 400, 33명 `ALL_RESPONDERS` 422, 61건/회 422, 시간당 120 초과 422, 같은 `atMin` 400, `repeatCount` 6·5.5·"5" 400 (CAPS). 10개 고객 중 9곳이 분당 60건씩 쌓아도(적체 13,300건) 나머지 한 곳의 SEV-3 호출 91건은 최대 1분 지연 (v2-fair A) |
| R-2 겹친 틱 중복 발송 | 확인 (잔여 R-14, N-11) | 겹친 틱 4개에서 SENT가 QUEUED로 덮이지 않고 로그 1행. 실제 타임아웃 10초에서는 중복 0 (T1, T2 skew 0·15초) |
| R-3 예산 소진 | 확인 (잔여 N-12) | 예산 0인 틱 25회 뒤 잡이 `QUEUED / attempts 0 / claimSeq 0` 그대로, 다음 정상 틱에 전부 1회 발송. 배치 중간 소진 시 남은 잡은 시도 차감 없이 반환. 업체 무응답은 5회 뒤 FAILED + 로그(`TIMEOUT`) (X, L) |
| R-4 업체 문구·채널 ID | 포털: 확인 / 내부: 부분 (R-13) | 포털 응답에는 `reason` 코드만, `error`·`providerMessageId`·채널 ID 없음. 내부용 마스킹은 우회 가능 (S, SE) |
| R-5 멱등 재생 | 확인 | 역할·kind·고객·하위 범위가 바뀌면 재생 없이 새로 판정(403/404/409). 다른 경로·본문·If-Match는 422. 키 순서만 바꾼 본문은 재생, `"1"`과 `1`은 구분. 실패 응답은 저장 안 됨(포털 1,000회 → 0건). Escalate 재생은 단계를 한 번만 올림 (IDEM) |
| R-6 하위 범위 ADMIN | 확인 | 프로젝트·서비스 범위 ADMIN은 고객 단계 GET/PUT 404, 자기 하위 덮어쓰기만 201, 형제 서비스·상위 프로젝트·다른 고객 프로젝트 404 (R6, 10가지 범위 모양) |
| R-7 수동 Escalate | 확인 | 인시던트당 60초 1회: 다른 사용자, Ack↔Undo·Resolve↔Undo 끼워넣기, 시계 역행 모두 429. bulk에 escalate 없음(400). 점검 창 `[시작, 끝)`에서 409, SEV-1은 통과 (R7) |
| R-8 Undo 후 미발송 | 확인 | 재시도 중 Ack → SKIP → Undo → 1회 발송. Ack/Undo 3회 반복, 틱 사이 Undo, 발송 중 Undo, 토큰 재사용 모두 같은 호출이 2번 나가지 않음. 되살아나는 것은 현재 단계·반복의 `acknowledged` SKIP뿐 (U 1~8) |
| R-9 발송 시 테넌트 재확인 | 확인 | 다른 고객 사람, 고객 없는 CUSTOMER 연락처, kind 대소문자 다름·누락 모두 `tenant_mismatch` SKIP + 틱 오류 기록 (R9Q2) |
| R-10 점검 창 안 재시도 | 확인 (잔여 N-13) | 시작 시각 정각 SKIP, 끝 시각 정각 발송, SEV-1 발송, 취소된 창·다른 고객·다른 프로젝트·ALERT 범위 창은 무시 (M 15가지) |
| 포털 serializer (audience.ts) | 확인 (잔여 N-14) | 포털 사용자로 26개 요청을 돌며 직원 이름·`ct_`·`usr_`·`rot_`·`pc_`·로테이션 이름·채널 ID·계정 ID·전화·이메일 44개 문자열 검색 → 0건. 내부 응답과 키 비교: 포털에서 빠진 키는 `contactId`, `via`, `pagingConfigId`, `targetId`, `error`, `providerMessageId`, `warnings` (PORTAL) |
| `PORTAL_SHOWS_STAFF_NAMES=false` | 확인 (잔여 R-15) | 기본값에서 직원은 "MSP on-call". `true`로 켜도 ID류는 계속 빠짐 (PORTALN) |
| `SMS_VOICE_REQUIRE_VERIFIED=true` | 확인 | 미확인 번호 SMS·음성 0건, 타임라인 기록, `callHealth` AT_RISK. Slack DM·이메일은 경고만 (R9Q2) |
| 404 동일성 | 확인 | 범위 밖과 없는 ID가 바이트 단위로 같음: 인시던트 8개 요청 × 2사용자, paging 6개 × 2, 포털 paging-path와 없는 경로. 새 코드 429·409 `MUTED_BY_MAINTENANCE`·422 `SEND_CAP_EXCEEDED`는 범위 조회 뒤에만 나옴. 422 `IDEMPOTENCY_KEY_REUSED`는 조회 전이지만 본인 키에만 반응하고 범위 밖·없는 ID에 같은 응답 (PARITY) |
| 1차에서 문제없던 항목 | 회귀 없음 | Undo 토큰, 일괄 처리, 동시 Ack/Resolve(감사 1행), 대상 검증 422/400, 경로 열거를 1차 프로브로 재확인 |
| 새 상한값 | 타당 | 임대 60초 ≥ 예산 45초 + 타임아웃 10초, 타임아웃 10초 < 첫 재시도 30초. 회당 60 / 시간당 120 / 전원 호출 20명 / 재알림 12회 / 수동 60초. 시간당 120은 한 사람에게 96건까지 갈 수 있어 넉넉한 편이지만 상한은 있다 |

## [차단]

없음.

## [권고]

### R-11. 업체가 응답 없이 멈추면 정상 채널 호출이 10분 넘게 밀린다 (상, 실제 업체 연결 전)
- 위치: `tick.ts:539-547`(순차 발송, 잡마다 최대 10초), `memoryStore.ts:239`(`releaseJob`이 `nextAttemptAt = now`), `notify.ts:291`(정렬이 `nextAttemptAt` 기준)
- 내용: 발송이 한 줄로 이어져 멈춘 업체가 있으면 틱당 5건만 처리된다. 예산 때문에 반환된 잡은 만기가 "지금"으로 다시 찍히는데, 실패한 잡의 재시도 만기(30초 뒤)가 그보다 이르다. 그래서 재시도가 한 번도 시도하지 않은 잡보다 계속 앞선다.
- 재현 (v2-trace): 고객 1곳, SEV-1, 20명 × [SMS, VOICE], SMS만 무응답 → 음성 20통이 틱 12(11.5분 뒤)에야 나간다. 그동안 SMS 일부는 4번째 시도까지 갔다.
- 재현 (v2-fair B): SMS 호출이 걸린 고객이 5곳 이상이면, 다른 고객의 이메일 호출(SEV-1 포함)이 90분 안에 나가지 않았다. 1곳·3곳일 때는 0.2분·0.5분이다.
- 확인한 수정 방향: 프로브 안에서 `releaseJob`이 미시도 잡의 원래 만기를 유지하게 바꾸니 음성이 틱 5(4분)에 나갔다. 남은 4분은 순차 발송 때문이다.
- 수정안: (a) 반환 시 원래 만기 유지(임대 시각은 별도 열), (b) 정렬에 시도 횟수 오름차순 추가, (c) 업체별 병렬 발송 또는 연속 타임아웃 시 그 업체 잡을 그 틱에서 건너뛰기.
- 파일럿(고객 1곳)에서도 첫 번째 재현은 해당한다.

### R-12. 발송 상한은 저장 시점의 Responder 수로만 계산된다 (중)
- 위치: `pagingApi.ts:112-125`, `escalation.ts:298`(단계당 60건 절단만 있음)
- 재현 (CAPS): Responder 3명일 때 `ALL_RESPONDERS × 5채널 × 4단계, 반복 5` 저장(200) → 43명으로 늘린 뒤 인시던트 1건이 60분에 240건(상한 120). 12단계면 720건까지 가능하다.
- 이 브랜치에는 Responder를 늘리는 API가 없어 지금은 저장소를 직접 고쳐야 재현된다. 다른 고객으로의 영향은 공정 배분이 막는다.
- 수정안: Responder 추가 API에서 그 고객 설정들의 상한 재검사, 또는 엔진에서 인시던트당 시간 상한 적용.

### R-13. 내부 사용자용 업체 오류 마스킹이 우회된다 + 긴 문자열에서 12초 멈춤 (중)
- 위치: `notify.ts:80-87`
- 우회 (S, SE): 전각 숫자(`０１０-…`), 아랍 숫자, 구분자가 `‑`·`–`·`/`·`_`인 번호, `%20`으로 끊긴 번호, `user@host`(TLD 없음), `%40`·전각 `＠`, 한글 도메인 이메일, `apikey=`·`api_key:`·`pw=`·`pass=`·`password is …`·`client_secret=`·`session=`, AWS 키(`AKIA…` 20자), JWT, Slack 채널·사용자 ID(`C0123ABCD`). E.164·하이픈·공백·점 형식과 `sk_…`·`Bearer`·24자 이상 토큰은 가려진다.
- 노출 범위: `error`는 INTERNAL에게만 가지만 VIEWER 역할도 포함된다(SE에서 내부 VIEWER가 `apikey=9f8e7d6c`, `pw=hunter2` 확인). D-35의 번호 열람 절차 밖이다.
- 멈춤 (v2-redos): 300자 절단이 정규식 **뒤**라서, 구분자 없는 100,000자(base64 덩어리)에 12.4초, 30,000자에 1.1초가 걸린다. 틱 이벤트 루프가 그동안 멈춘다. HTML 오류 페이지 104KB는 2ms였다.
- 수정안: 먼저 2,000자로 자른 뒤 마스킹, `\p{Nd}` 기반 숫자 매칭, 비밀값 라벨 추가. 더 단순하게는 API의 `error`를 OPERATOR 이상에게만 주거나 원문은 서버 로그에만 남긴다.

### R-14. 겹친 틱 보장이 실행기 시계에 달려 있다 (하)
- 위치: `tick.ts:536`(`claimDueJobs(c.clock())`), 포트 정의 `tick.ts:170-180`
- 재현 (T2): 두 번째 실행기 시계가 21초 이상 앞서면 첫 발송이 진행 중인데 다시 선점해 2번 호출한다(SENT 로그는 1행). 15초까지는 1번.
- 수정안: SQL 어댑터는 선점·만기 판단에 DB 시각(`now()`)을 쓰도록 포트 주석에 명시. 업체 멱등 키는 이미 요건으로 적혀 있다.

### R-15. `portalShowsStaffNames`가 문자열 `'false'`면 켜진다 (하)
- 위치: `audience.ts:148`(`cfg.portalShowsStaffNames ? …`)
- 재현 (v2-misc): `config: { portalShowsStaffNames: 'false' }` → 포털에 "Haeun Kim". 환경 변수에서 읽어 그대로 넘기면 생긴다. `undefined`·`0`·`false`는 안전하다.
- 수정안: `=== true`.

### R-16. AuthContext 검사가 상속 속성과 배열 역할을 받는다 (하)
- 위치: `auth.ts:93-104`(`isAuthContext`), `auth.ts:117-119`
- 재현 (B1): `role: ['ADMIN']`과 `role: { toString: () => 'ADMIN' }`가 INTERNAL에서 ADMIN으로 통한다(키 변환). `Object.prototype.role = 'ADMIN'`이 오염돼 있으면 `role` 없는 INTERNAL이 Ack 200, `kind`·`customerIds`까지 오염되면 `{ userId }`만으로 전 범위가 열린다.
- 포털 사용자가 승격되는 경로는 아니다(CUSTOMER는 항상 VIEWER). 프로토타입 오염이 먼저 있어야 한다.
- 수정안: `Object.hasOwn`으로 `kind`·`customerIds`·`role` 확인, `typeof role === 'string'`.

## [참고]

- N-10. 문서·스키마 미반영: 새 오류 코드 `MUTED_BY_MAINTENANCE`, `SEND_CAP_EXCEEDED`, `RESPONDER_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`가 `docs/API-CONTRACT.md`에 없고, 새 열 4개가 스키마에 없다. CLAUDE.md의 "계약 먼저" 규칙 대상이다.
- N-11. 채널이 여러 개인 Slack 잡은 채널마다 10초를 기다린다. 5개가 모두 멈추면 잡 하나가 50초를 쓰고(예산 45초, 응답 한도 50초) 재시도 만기 30초를 넘긴다 (T3). 잡 단위 타임아웃 권장.
- N-12. 앞 단계 하나가 예산 전체를 넘기면 notify는 실행되지 않는다. 잡은 손상되지 않지만 10틱 동안 SEV-1 호출 0건인데 notify 하트비트는 `OK`, 오류 0건이고 `truncated: true`만 남는다 (X). 연속 truncated 경보 또는 notify 선실행 검토.
- N-13. 점검 창 안에서 재시도된 호출은 미뤄지지 않고 영구 SKIP된다. 한 단계짜리 순서에서 첫 시도가 일시 실패한 뒤 창이 시작되면, 창이 끝나도 그 인시던트는 아무도 호출하지 않는다 (M 마지막 줄). 만기를 창 끝으로 미루는 쪽이 D-17 "단계 유지"와 맞다.
- N-14. 포털 serializer가 믿는 값 (정상 데이터에서는 새지 않음, PORTAL_EDGE에서 저장소를 직접 고쳐 확인):
  - SYSTEM이 쓴 TRIGGERED·MERGED 문장과 `ALL_RESPONDERS` 단계의 `label`은 원문 그대로 나간다.
  - `reason`(`errorCode`)에 허용 목록이 없다.
  - 스냅샷에 다른 고객의 CUSTOMER 연락처가 들어 있으면 이름이 나간다(`ResolvedTarget`에 customerId가 없어 구분 못 함).
  - `planLabel`("Shared MSP rotation · Standard"), `targetType`, 응답자 수("everyone in Responders (3)"), `/scope-tree`의 `ownSteps`는 포털에도 나간다. ID·이름은 아니다.
- N-15. `subScopes` 항목의 `customerId`가 `customerIds`와 맞지 않으면(예: 대소문자) 좁히기가 무시돼 그 고객 전체가 보인다 (R6 "CUS_MIRAE"). 1차 때도 같은 동작이다. `isAuthContext`에서 불일치를 401로 처리할 수 있다.
- N-16. 하위 범위 ADMIN은 자기 프로젝트의 paging-path가 고객 단계를 상속할 때 그 단계(직원, `pagingConfigId`, 버전)를 본다. 수정은 404다. "자기 범위에서 누가 호출되는지"를 보여 주는 의도된 동작으로 판단했다.
- N-17. 공정 순서는 SEV-1 머리를 가진 고객이 배치 크기(50) 이상이면 SEV-1이 없는 고객을 굶긴다: 49곳이면 2분, 51곳이면 30분 안에 미발송 (v2-fair A2). 고객 수가 그 규모가 되기 전에 배치 크기 또는 순서 재검토.
- N-18. 발송 전 조회가 예외를 내는 잡은 시도 횟수가 늘지 않아 포기되지 않는다. 30틱 뒤 `SENDING / attempts 0 / claimSeq 30`, 틱마다 오류 1건 (X). 선점 횟수 상한 권장.
- N-19. 멱등 저장소: OPERATOR는 bulk preview로 키마다 1건(약 10KB)을 쌓을 수 있다(500회 → 500건). 운영 저장소에 사용자별 상한.
- N-20. `phoneVerifiedAt`이 Invalid Date이거나 미래여도 확인된 것으로 본다 (R9Q2).
- 1차 N-1, N-4, N-5, N-6, N-7은 그대로다(이 PR 범위 밖 또는 계약대로).

## 실행하지 못했거나 제한된 것

- SQL 어댑터가 없어 DB 수준의 선점·버전 조건은 확인하지 못했다(위 "확인 범위의 한계").
- `v2-core.mts`의 F1·F2·F4는 인시던트가 병합돼 폭주가 만들어지지 않았다. 결과를 쓰지 않고 `v2-fair.mts`로 대체했다.
- 업체 지연은 가짜 발송기와 모의 시계(호출당 10초 진행)로 재현했다. 실제 업체로는 돌리지 않았다.
