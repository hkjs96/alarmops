# 보안 검토 — feat/tick-escalation (packages/core 틱·에스컬레이션·알림, packages/api)

- 대상: `/home/claude/wt-backend`, `git diff origin/main...HEAD` (28개 파일, +4571)
- 방법: 코드 정독 + 기존 테스트 실행(api 58개, core 173개 모두 통과) + 임시 프로브 스크립트(저장소 밖, 저장소는 수정하지 않음)
- 프로브: `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/probe1.mts`, `probe2.mts`, `probe3.mts`
  (실행: `cd /home/claude/wt-backend && npx tsx <파일>`)
- 기준: API-CONTRACT §2·§5·§8.0·§8.1·§8.3, D-15·D-17·D-20·D-24·D-30·D-34·D-35, security.md 점검 항목

## 결론

- **[차단] 1건** (B-1). 한 줄 수정이라 고친 뒤 머지 가능.
- **[권고] 10건**. 이 중 R-1~R-4는 실제 SMS·음성 업체를 붙이기 전(파일럿 전)에 반드시 처리해야 한다.
- **[결정 필요] 2건** (Q-1, Q-2). 사용자 결정 사항.
- 테넌트 격리 자체(조회·쓰기의 customer 조건, 404 동일성, 일괄 처리, Undo 토큰, 멱등 키, 미매핑 계정, 호출 대상 검증, 스냅샷 해석)는 **뚫리는 경로를 찾지 못했다**. 아래 "확인하고 문제없던 것" 참조.
- D-15(승인 없는 자동 조치): 이 브랜치에 조치 실행 경로가 없다(`remediation: null` 자리만 있음). 해당 없음.

---

## [차단]

### B-1. 역할 검사가 `kind` 값이 예상 밖일 때 열린다 (fail-open)
- 위치: `packages/api/src/auth.ts:84` (`requireRole`)
- 내용: `auth.kind === 'CUSTOMER' ? 'VIEWER' : auth.role`. 포털 사용자 강등이 문자열 `'CUSTOMER'` 정확 일치에만 걸려 있다. `kind`가 빠지거나(`undefined`) 다른 값이면 저장된 `role`이 그대로 쓰인다. 주석대로 포털 사용자의 저장 역할은 ADMIN일 수 있으므로(org-tenant R4-3), 어댑터가 `kind`를 못 채우면 포털 사용자가 자기 고객의 Ack·Resolve·Escalate·호출 순서 수정까지 할 수 있다. 범위(`scopeOf`)는 닫히게 되어 있어 다른 고객으로 넘어가지는 않는다.
- 재현(probe3): `{ userId:'usr_x', kind:'PORTAL', customerIds:['cus_mirae'], role:'ADMIN' }` → `POST /incidents/{mirae}/ack` 200, `GET /customers/cus_mirae/paging` 200.
- 수정: `const effective = auth.kind === 'INTERNAL' ? auth.role : 'VIEWER';` + `requireAuth`에서 `kind`가 `INTERNAL|CUSTOMER`가 아니면 401. 테스트 1개 추가.
- 비고: 타입상으로는 막혀 있고 어댑터(세션 → AuthContext)는 이 PR에 없다. security.md의 "설정이 빠지면 닫히는지(열리면 차단)" 기준으로 차단에 올렸다.

---

## [결정 필요] (설계 의도일 수 있음 — 사용자 결정)

### Q-1. 포털(고객) 사용자에게 MSP 직원 이름·내부 ID·호출 순서가 나간다
- 위치: `incidents.ts:62,71`(assignee, acknowledgedBy), `incidents.ts:94-97`(assignmentSnapshot), `incidents.ts:89`(paged), `incidents.ts:184`(timeline actorId·message), `incidents.ts:199`(notifications), `pagingApi.ts:200-272`(paging-path, 역할 검사 없음)
- 재현(probe1 A): 포털 사용자 yuna가 자기 고객 인시던트에서 받는 것
  - `assignee {"contactId":"ct_haeun","name":"Haeun Kim","via":"rotation"}`
  - 스냅샷 전체: 단계별 `resolved[{contactId,name,via}]`(직원 Haeun Kim, Junho Park), `targetId: rot_night`, 로테이션 이름 "MSP night desk", `pagingConfigId`
  - 타임라인 문구 "Paged step 1/4: Slack Haeun Kim.", `actorId: "usr_haeun"`(내부 사용자 ID), `acknowledgedBy {"contactId":"usr_haeun",...}`
  - `GET /oncall/paging-path?customerId=cus_mirae` 200: `nowIds`, `names`, `sharedRotationId`, 문장(실명)
- 계약 근거: §8.0 규칙 3은 `callHealth`를 "MSP 내부 정보라 내보내지 않는다"고 했는데, 같은 종류의 정보(누가 당번인지, 내부 로테이션 구성)는 인시던트·paging-path로 그대로 나간다. §8.1·§8.3의 권한 열은 `V`뿐이고 포털(`P`) 표기는 `/scope-tree`에만 있다. `PORTAL_GRANT_REQUIRED`는 코드 어디에도 없다.
- 선택지
  1. (추천) 포털 응답에서는 MSP 직원을 "MSP on-call"로 뭉개고 `contactId`·`actorId`·`targetId`·`pagingConfigId`·`sharedRotationId`를 뺀다. 자기 고객 사람 이름은 유지. `/oncall/paging-path`는 INTERNAL 전용.
  2. 실명은 주되 ID류만 뺀다(D-30 "화면 문장은 실명"을 포털에도 적용).
  3. 지금대로 둔다(고객이 누가 대응 중인지 보는 것이 의도인 경우). 계약 §8.1·§8.3에 `P`를 명시.

### Q-2. 확인되지 않은 전화번호로 SMS·음성이 나간다 (Q-DM-16 미결)
- 위치: `packages/core/src/notify.ts:112`
- 재현(probe2 K): `phoneVerifiedAt = null`인 번호로 SMS·VOICE 발송, 로그에 `UNVERIFIED_ADDRESS` 경고만.
- 위험: 오타 번호·퇴사자 번호로 제3자에게 고객 이름·알람 제목이 반복 발송된다(알람 제목은 가공 없이 본문에 들어간다).
- 선택지: 1. (추천) SMS·VOICE는 확인된 번호만, Slack DM·이메일은 지금대로 2. 전부 지금대로(R9-3 유지) 3. 전부 확인 필수. 1·3이면 `pagingHealth`의 UNREACHABLE 계산과 맞춰야 한다.

---

## [권고]

### R-1. 한 고객의 호출 순서 설정이 다른 고객의 호출을 늦춘다 (상)
- 위치: `pagingApi.ts:20-22,87`(상한), `notify.ts:27`(전역 50건/틱), `memoryStore.ts:196-208`(FIFO)
- 내용: PUT 검증은 단계 12개·반복 5회·채널 5종까지 받고, `atMin`이 같은 단계를 허용하며(`<`만 거부), Responder 수에는 상한이 없다. 아웃박스는 전 고객 공용으로 틱당 50건이고 고객별 배분이 없다.
- 재현(probe1 D): Responder 33명 고객에 `ALL_RESPONDERS × 5채널 × 12단계(atMin 0) × repeatCount 5` PUT → 200. 그 고객 인시던트 1건이 120분 동안 잡 9,576건(음성 1,485통 발송, 3,602건 적체). 같은 시각에 열린 **다른 고객의 SEV-1** 호출은 생성 1분 → 발송 3분, 6분 → 17분, 11분 → 30분, 16분 → 35분으로 최대 19분 늦었다.
- 수정: (a) PUT에서 설정당 예상 발송 수 상한(단계 × 대상 × 채널 × (반복+1), 예 200) 및 `atMin` 엄격 증가, (b) 틱 아웃박스에 고객별 몫(라운드로빈) 또는 SEV·INITIAL 우선, (c) 엔진에서도 `repeatCount`를 상한으로 자름(`escalation.ts:78`은 DB 값을 그대로 믿음).

### R-2. 겹친 틱에서 같은 호출이 여러 번 나간다 (상)
- 위치: `tick.ts:487-509`, `memoryStore.ts:196-224`, 포트 정의 `tick.ts:166,171`
- 내용: 선점 시 `nextAttemptAt = now+30초`. 발송이 30초 넘게 걸려 다음 틱까지 끝나지 않으면 다음 틱이 `SENDING` 잡을 다시 선점해 보낸다. 또 `completeJob`에 선점 확인(시도 번호)이 없어, 늦게 끝난 앞 틱이 `SENT`를 `QUEUED`로 덮어쓰고 또 보낸다. core에는 발송 타임아웃이 없다.
- 재현(probe2 B): 첫 SMS가 멈춘 상태에서 다음 분 틱 실행 → `ct_haeun`에게 3회 발송(00:00 멈춘 호출, 01:00 재선점, 03:00 덮어쓰기 뒤 재발송), 잡 3건에 SENT 로그 4건.
- 수정: `completeJob(jobId, attempt, …)`를 `WHERE status='SENDING' AND attempts=?`로 가드, 발송에 타임아웃(재선점 간격보다 짧게), 업체 멱등 키 지원 여부를 어댑터 요건으로 명시.

### R-3. 예산이 바닥난 틱이 잡을 보내지 않고 시도 횟수만 태운다 → 기록 없는 미발송 (상)
- 위치: `tick.ts:487-491`(선점 후 예산 확인), `memoryStore.ts:203-204`
- 내용: 예산은 틱 전체 공용(45초)이다. 앞 단계가 예산을 쓰면 notify 단계는 50건을 선점(시도 +1)한 뒤 곧바로 반환한다. 5번 반복되면 6번째 선점에서 `FAILED`("gave up after a send that never finished")가 되고 NotificationLog도 남지 않는다.
- 재현(probe2 C): notify 단계가 예산 초과인 틱을 계속 돌리면 최초 호출 SMS 3건이 한 번도 발송되지 않고 FAILED, 발송 로그 0건. 약 19분(30초·1·2·5·10분 간격) 걸린다. 알림 폭주 때가 조건이라 정작 호출이 필요한 때 일어난다.
- 수정: 선점 전에 예산 확인, notify에 별도 최소 예산 보장, 실제 발송 때만 시도 횟수 증가(또는 못 보낸 잡은 시도 되돌림), 포기 시 FAILED 로그 1행.

### R-4. 업체 오류 문구와 Slack 채널 ID가 모든 조회자(포털 포함)에게 나간다 (상, D-35 관련)
- 위치: `incidents.ts:199-200`, `notify.ts:163,184-192`
- 내용: `DeliveryLog.error`는 업체 어댑터의 오류 문자열 그대로이고 `/incidents/{id}/notifications`가 이를 가공 없이 돌려준다. 업체 오류에는 수신 번호가 들어가는 경우가 흔해, D-35의 열람 절차·기록을 거치지 않고 전화번호가 VIEWER·포털에게 나갈 수 있다. Slack 대상은 `targetSummary`에 채널 ID가 들어가며, 고객 채널이 없으면 MSP 기본 채널 ID가 고객에게 보인다. `providerMessageId`도 나간다.
- 재현(probe3): 포털 사용자 응답에 `["SLACK_BOT","SENT","C_MSP",…]`, `["SMS","FAILED","Dohyun Han","vendor: number +82100008995 rejected (acct AC123, key sk_live_x)…"]`.
- 수정: 저장 시 오류를 분류 코드로 바꾸고 원문은 내부 로그에만(번호·키 마스킹), API는 INTERNAL에게만 `error` 원문·`providerMessageId`, Slack `targetSummary`는 "Customer Slack channel"/"MSP channel" 같은 이름으로.

### R-5. 멱등 재생이 현재 권한을 다시 보지 않고, 본문과 묶여 있지 않다 (중)
- 위치: `router.ts:66-74`
- 재현(probe1 E): Ack 후 같은 `userId`가 범위·역할을 잃어도(다른 고객의 포털 VIEWER로 바뀜) 같은 키로 24시간 동안 200과 인시던트 상세·`undoToken`이 재생된다. 같은 키로 본문만 바꾼 `bulk`(preview:false, 다른 대상)는 첫 응답(preview 결과)이 재생되고 실행되지 않는다.
- 다른 사용자·다른 테넌트로는 새지 않는다(키에 `userId` 포함, 확인함).
- 수정: 재생 전에 라우트의 범위·역할 검사를 통과시키거나 저장 키에 `scopeKey(auth)` 포함, 본문 해시를 같이 저장해 다르면 422. `req.path` 대신 정규화한 경로(`/api/v1` 접두 제거) 사용. 운영 저장소에는 사용자별 건수 상한.

### R-6. 프로젝트·서비스 범위 사용자가 고객 단계 호출 순서를 읽고 고칠 수 있다 (중)
- 위치: `pagingApi.ts:114-119`(`visibleCustomer`), `pagingApi.ts:242-243`
- 재현(probe1 I): `subScopes: [{cus_mirae, prj_data}]`인 ADMIN이 `GET`·`PUT /customers/cus_mirae/paging` 200. 같은 범위의 포털 사용자가 `/oncall/paging-path?customerId=cus_mirae` 200(범위 밖 서비스는 404로 맞음).
- 수정: 그 고객에 `subScopes`가 있으면 고객 단계 설정은 404, 덮어쓰기는 자기 하위만.

### R-7. 수동 Escalate가 점검 창을 무시하고 연속 호출 제한이 없다 (중)
- 위치: `incidents.ts:236`, `escalation.ts:323`
- 재현(probe2 G): 점검 창 중 OPERATOR가 1분 안에 Escalate 7회 → 남은 단계와 반복 전체가 발사(음성 12통). 사다리 길이로 상한은 있고 감사 기록은 남는다.
- 수정: 인시던트당 분당 1회 제한, 점검 창 중이면 응답·타임라인에 "muted window overridden" 표시(또는 확인 파라미터 요구). 의도라면 D-17에 한 줄 추가.

### R-8. Ack 후 재시도 중이던 호출은 Undo해도 다시 나가지 않는다 (중)
- 위치: `notify.ts:155`, `incidents.ts:363-370`
- 재현(probe2 H): 2단계 SMS가 재시도 대기 중일 때 Ack → 잡 `SKIPPED(acknowledged)` → Undo → 그 단계는 끝까지 미발송, 다음 단계까지 공백.
- 수정: Undo 때 그 단계·반복의 SKIPPED(acknowledged) 잡을 QUEUED로 되돌리거나, `escalationStep`을 1 내려 다시 발사.

### R-9. 발송 시점에 수신자의 테넌트를 다시 확인하지 않는다 (하, 방어 심화)
- 위치: `tick.ts:494`, `notify.ts:102-113`
- 내용: 스냅샷 생성 때는 올바르게 걸러지지만(아래 확인 항목), 발송은 `getContact(job.contactId)`만 보고 보낸다. 스냅샷 JSON이나 잡 행이 잘못되면 다른 고객 사람에게 간다.
- 수정: `contact.kind === 'INTERNAL' || contact.customerId === job.customerId`가 아니면 SKIP + 오류 로그.

### R-10. 점검 창 시작 전에 쌓인 호출이 창 안에서 재시도로 나간다 (하)
- 위치: `notify.ts:153-156`
- 재현(probe2 M): 창 02:30 시작, 재시도 SMS 03:04 발송.
- 수정: 발송 시 SEV-1이 아니면 점검 창 재확인 후 SKIP.

---

## [참고]

- N-1. `pagingApi.ts:102-108`: 다른 고객의 연락처·로테이션 ID는 422 `CROSS_CUSTOMER`, 없는 ID는 400. 고객 일부만 맡는 ADMIN에게는 ID 존재 여부가 드러난다. §8.3이 422를 정했으므로 계약대로다. 없애려면 둘 다 400으로.
- N-2. `escalation.ts:333`: Ack 후 재알림에 횟수 상한이 없다(72시간 Ack 상태 → 72회, probe2 L). 명세(I-6 4)대로지만 SMS·음성이면 상한을 권한다.
- N-3. `memoryRepo.ts:141`: 덮어쓰기를 지우고 다시 만들면 버전이 1부터 다시 시작해 옛 `If-Match: 1`이 맞는다. 운영 스키마에서는 버전을 이어 가거나 삭제 표시로.
- N-4. `pagingApi.ts:128`: 볼 수 있는 고객의 `GET /customers/{id}/paging`이 역할 부족이면 403. §2 문구는 "403은 쓰기에만"이라 엄밀히는 어긋난다(범위 밖은 404라 정보 노출은 없음).
- N-5. 입력 크기: 이 패키지에는 본문 크기 제한이 없다. `items[].id` 길이(`incidents.ts:299`), paging-path `q`, cursor가 무제한이다. 어댑터에서 본문 상한(예 256KB)과 요청 빈도 제한이 필요하다.
- N-6. `scope.ts:79`: `/scope-tree`가 고객마다 `pagingContext`를 불러 30초마다 사용자 수 × 고객 수만큼 조회한다. 성능 사항.
- N-7. 틱 인증(`TICK_SECRET`, 미설정 503, constant-time)은 이 PR에 없다. 라우트 핸들러 PR에서 검토 필요. `scheduledAt`은 중복 방지 키로만 쓰이고 시각 판단은 서버 시계라 조작해도 조기 발사는 안 된다.
- N-8. 한 인시던트가 매 틱 예외를 내면 `nextEscalationAt`이 그대로라 항상 목록 앞에 남는다. 200건 넘게 쌓이면 뒤가 굶는다. 실패 시 뒤로 미루는 처리 권장.
- N-9. 감사·타임라인·틱 로그에 전화번호·이메일·비밀값은 없다(이름과 contactId만). 감사 `before/after`에는 단계의 targetId만 들어간다. 하드코딩된 비밀값, `.env` 없음.

---

## 확인하고 문제없던 것

| 항목 | 결과 |
|---|---|
| 조회·쓰기의 customer 조건 | 모든 핸들러가 `scopeOf(auth)`로 만든 범위를 저장소 호출에 넘긴다. id·slug 해석은 범위 안 트리에서만 한다 |
| 404 동일성 | 범위 밖과 없는 것이 상태·본문·헤더까지 같다(requestId 제외). 인시던트 3개 조회·3개 쓰기, paging GET/PUT, 덮어쓰기 PUT/DELETE, paging-path, 목록 필터에서 확인. ETag는 404에 없다. 헤더·본문 검증이 조회보다 먼저라 400도 대상과 무관하다 |
| 경로 열거 | 세션 없으면 전 경로 401, 없는 경로·메서드·깨진 인코딩은 같은 404 |
| 일괄 처리 | 항목마다 범위 조회. 다른 고객 id는 `NOT_FOUND`로 건드리지 않음. `ids[]` 형식 거부, 200건 상한 |
| Undo 토큰 | 192비트 난수, 본인만, 5분, 1회용. 남의 토큰과 없는 토큰이 같은 404이고 주인은 계속 쓸 수 있다. 복원 때 범위와 버전을 다시 확인 |
| 멱등 키 | 다른 사용자·다른 테넌트에게 재생되지 않음(R-5의 같은 사용자 건만 남음) |
| 역할 | Ack·Resolve·Escalate·Undo는 OPERATOR, 호출 순서는 ADMIN, 포털은 VIEWER 고정, `role` 누락은 403 |
| If-Match·경합 | 누락 400, 불일치 409, 저장은 버전 조건부. 동시 Ack/Resolve는 하나만 성공하고 감사 1행 |
| 호출 순서 PUT 대상 검증 | 다른 고객 사람·로테이션 422, Notify only 422, 비활성·없는 사람 400. 템플릿 경로도 같은 검증을 탄다 |
| 다른 고객 연락처로 호출 | 엔진에서도 `resolveStep`이 고객 world(자기 고객 사람 + 직원 + 자기·공용 로테이션)로 다시 거른다. 휴가 대체자·교대 대체자도 같은 검사를 거친다. Slack 채널은 `job.customerId`로 고른다 |
| 미매핑 계정 | INTERNAL 전 범위 사용자에게만. 포털·일부 고객 직원은 404 / `[]` / 0. 미매핑 인시던트는 MSP 채널 한 번만 |
| 이중·누락 틱 | 같은 분 중복은 skip, 가드 없이도 버전 조건과 잡 키 유일성으로 중복 단계 없음. 건너뛴 분은 틱당 한 단계 |
| Ack 후 호출 | 발송 직전 상태 확인으로 INITIAL·ESCALATION 잡 SKIP |
| 점검 창 | SEV-1 외 묵음, 단계 유지(R-7·R-10만 예외) |
| 재시도 폭주 | 30초·1·2·5·10분 5회 후 포기, 재시도 불가 오류는 즉시 실패 |
| 연락처 값 | API 응답·스냅샷·타임라인·감사에 전화·이메일 없음(R-4의 업체 오류 문구만 예외) |
| D-15 | 조치 실행 경로 없음 |
