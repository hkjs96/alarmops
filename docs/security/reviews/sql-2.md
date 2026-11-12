# 보안 재검토 — feat/sql-adapter (SQL 저장소 수정분: B-1, R-1 ~ R-9)

- 대상: `/home/claude/wt-backend`, `feat/sql-adapter` @ fd3d3c5 (이전 검토 7226993 이후 커밋 3개, 30개 파일)
- 검토자: security 역할(읽기 전용). 저장소 파일은 수정하지 않았다(`git status` 깨끗함). 탐침은 `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/sql2/`에만 있다.
- 실행 환경: 실제 PostgreSQL **18.6**(`/opt/pglocal`, 사용자 `nobody`, 127.0.0.1:54329, fsync on, CPU 2개 — 검토 후 중지함)와 메모리 저장소 + 실제 `runTick`.
- **돌려 보지 못한 것**: PostgreSQL 15·16, Supabase 실제 프로젝트(Data API·기본 권한·Supavisor), Prisma 드라이버(`drivers/prisma.ts`), 네트워크 단절(블랙홀). 아래에서 이 항목들은 "미검증"으로 표시했다.

## 판정

**[차단] 없음 — 보안 관점에서는 머지 가능.** 이전 [차단] B-1은 고쳐졌고 실제 Postgres에서 8회 연속 통과했다. 남은 것은 [권고] 6건(그중 2건은 실행기를 2개 이상 두기 전에, 3건은 첫 배포 전에 처리)과 [참고]다. 관문 4(사용자 승인)와 R-8의 사람 확인은 그대로 남아 있다.

| 등급 | 건수 | 항목 |
|---|---|---|
| [차단] | 0 | — |
| [권고] | 6 | P-1 ~ P-6 |
| [참고] | 7 | Q-1 ~ Q-7 |

## 1. 테스트·타입 검사

| 실행 | 결과 |
|---|---|
| `npm run typecheck` (전 워크스페이스) | 통과 (exit 0) |
| `npm test` (전 워크스페이스, store-sql은 PGlite) | 통과 — 파일 49개, 테스트 1,217개 통과 + 15개 건너뜀(서버 전용), 실패 0 |
| `test:sql` 실제 PG 18.6, **8회 연속** | **8 / 8 통과** (매회 파일 5개, 테스트 106개, 실패 0). 5~8회차는 내 탐침과 동시에 돌아 부하가 걸린 상태였다 |
| `TEST_PG_POOLER=transaction` 1회 | 통과 (106 / 106) |
| 공유 API 계약(`contract.api.test.ts`, 24개)을 실제 PG로 | 9회(위 8 + 풀러) 모두 통과 |

이전 검토에서는 같은 명령이 7회 중 2회 실패했다.

## 2. B-1 — 고쳐짐

수정: 선점 트랜잭션 첫 문장이 레인별 `pg_advisory_xact_lock(hashtext('alarmops:outbox-claim'), hashtext(lane))` (`tickRepo.ts:406`), 레인 이름은 정렬해서 잡는다.

| 측정 (`conc2.probe.ts`) | 결과 |
|---|---|
| 8 실행기 × limit 50, 400건 — 고객 8×50 / 80×5 / 400×1, 각 20회 | 비우는 데 **항상 1라운드**(이상값 1), 만기 잡이 남았는데 0건 받은 선점 **0 / 480**, 덜 받은 선점 0, 중복 0, 오류 0. (이전: 7라운드, 빈 선점 137 / 264) |
| 레인 섞어 잡기 — 12 실행기, 레인 조합 12가지(순서 뒤집힌 것·전체·SLACK 포함), 선점 + 발송/반납/실패 + 포기 경로, 900회 × 3 | 교착(`40P01`) **0**, 잠금 시간 초과(`55P03`) 0, 두 번 SENT 된 잡 0, GAVE_UP 로그 60 = 포기 대상 60 |
| 한 레인 잠금이 붙잡힌 상태에서 실제 `runTick` | 틱 3.03초에 끝남. 다른 레인 6건 발송, 막힌 레인은 오류 1건(`lane:SMS`, lock timeout)·잡 그대로·`dueSev1Unattempted 6`·heartbeat ERROR. 붙잡은 쪽은 풀어 주지 않아도 16초 안에 서버가 끊었고(`25P03`) 다음 선점은 6건 정상 |

선점 지연(선점 → `beginSend` → `completeJob`을 계속 도는 실행기, 한 레인):

| 그 레인의 만기 잡 수 | 실행기 1 (p50 / p99) | 8 (p50 / p99) | 16 (p50 / p99 / 최대) | 잠금 시간 초과 |
|---|---|---|---|---|
| 400 | 6 / 20 ms | 12 / 188 ms | 26 / 265 / 276 ms | 0 / 192 |
| 5,000 | 31 / 39 ms | 118 / 362 ms | 174 / 736 / 790 ms | 0 / 192 |
| 20,000 | 100 / 109 ms | 696 / 842 ms | 1,441 / 1,825 / 1,826 ms | 0 / 192 |

선점만 동시에 몰아서(가장 불리한 경우):

| 만기 잡 수 × 동시 실행기 | p50 / 최대 | `55P03` |
|---|---|---|
| 20,000 × 16 | 1.50 / 1.61 초 | 0 / 64 |
| 20,000 × 32 | 2.57 / 3.11 초 | 1 / 128 |
| 50,000 × 16 | 3.10 / 3.24 초 | 17 / 64 |
| 50,000 × 32 | 3.11 / 3.25 초 | 80 / 128 |

해석: 선점 한 번의 비용은 그 레인의 만기 잡 전체를 순위 매기는 데 들고(400건 6 ms → 20,000건 100 ms), 잠금이 그것을 직렬화하므로 대기는 "실행기 수 × 한 번 비용"이다. **16 실행기 · 20,000건까지는 `lock_timeout`(3초)에 닿지 않았다.** 닿는 것은 한 레인에 32 실행기가 동시에 몰리거나 만기 잡이 50,000건일 때다. 닿아도 결과는 그 레인이 그 틱을 건너뛰는 것(오류 기록, 잡 변화 없음, heartbeat ERROR)이고 유실·중복은 아니다. → Q-1.

## 3. R-1 회전(탐침 커서) — 정상 경로는 고쳐짐, 커서를 잃는 경로가 남음

내 전수 측정(`r24.probe.ts`, 실제 `runTick` + `MemoryTickStore`, n = 1..60 × 정상 고객의 모든 위치 × 지연 3종, 지연당 1,830 시나리오, 12틱 관찰):

| 저장소 호출 지연 | 최악 밀림 0틱 | 1틱 | 2틱 | 3틱 | ⌈n ÷ P⌉ − 1 초과 | 미도달 | 중복 | 틱 최장 |
|---|---|---|---|---|---|---|---|---|
| 빠름 (P = 25) | n 1–25 | 26–50 | 51–60 | — | 0 | 0 | 0 | 50.0초 |
| 0.4초 (P = 20) | 1–20 | 21–40 | 41–60 | — | 0 | 0 | 0 | 48.0초 |
| 2.5초 (P = 15) | 1–15 | 16–30 | 31–45 | 46–60 | 0 | 0 | 0 | 56.0초 |

이전 검토에서 미도달이던 n = 20 · 49 · 50 · 51–60이 모두 사라졌다. 무작위 10칸 (n, 위치, 지연 → 밀림 / 한도): (43,22,0.4초 → 0/2) (55,20,빠름 → 0/2) (33,11,2.5초 → 0/2) (28,15,빠름 → 0/1) (42,9,0.4초 → 2/2) (49,7,0.4초 → 2/2) (43,35,2.5초 → 1/2) (30,20,빠름 → 0/1) (31,1,빠름 → 0/1) (46,5,0.4초 → 2/2).

작성자 테스트(`packages/core/test/r24-rotation.test.ts`) 점검: 같은 하네스·같은 전수 범위다. 다만 한도에 "n > 50이면 +1"을 더하고 관찰을 한도 + 2틱에서 끊으며, P(25 / 20 / 15)는 측정값이 아니라 상수로 적혀 있다. 내 측정에서는 +1 없이도 성립했으므로 테스트가 실제보다 느슨하다(틀리지는 않다).

커서 실패 경로(`cursor.probe.ts`, n = 30 · 40 · 50 × 모든 위치 × 빠름 · 0.4초, 12틱 관찰):

| 경우 | 결과 |
|---|---|
| 커서가 없는 고객을 가리킴(`cus_zzz`, 중간의 없는 키, 빈 문자열, 숫자·객체, 모르는 레인 키) — n = 30 · 60 | 한도 안(1틱 / 2틱), 미도달 0. 처음으로 돌아가 시작한다 |
| 두 실행기가 같은 레인에서 겹침(둘째가 20초 뒤 시작, 매 틱) | 한도 안, 미도달 0, 중복 0 |
| **notify heartbeat 쓰기가 계속 실패** | **미도달: n = 30에서 5곳 / 40에서 15곳 / 50에서 25곳 (빠름), 10 / 20 / 30곳 (0.4초)** |
| **heartbeat 읽기가 계속 실패** | 위와 같음 |
| **시계가 어긋난 실행기가 정상 틱 사이에 끼어듦** (P-1) | 위와 같음 |

40틱까지 늘려 보면 n = 30의 5곳은 **20틱(20분) 뒤**에 도달한다 — R-24 이전의 수치 그대로다. 즉 "영영"은 아니지만(무응답 잡이 5회 실패로 포기될 때까지) 커서를 잃는 동안에는 회전이 없다. 코드 주석은 쓰기·읽기 실패 시 "공정 순서로 다시 시작한다"고만 적었고, 그 결과가 20틱이라는 것과 P-1 경로는 적혀 있지 않다.

## 4. R-2 시계 — 고쳐짐, 부작용 1건(P-1)

실제 PG, 운영 배선(DB `now()`), 실제 `runTick` (`misc.probe.ts`):

| 실행기 시계 | 결과 | 발송 | `TickClaim` 행 | 선점된 잡 | heartbeat |
|---|---|---|---|---|---|
| +10분 / −10분 / +3일 | `clock-skew` (clockSkewMs 600000 / −600000 / 259200000) | 0 | 0 | 0 | 4개 모두 ERROR, 종료 시각 없음 → `stale: true, ok: false` |
| +35초 / −35초 | `clock-skew` | 0 | 0 | 0 | 위와 같음 |
| +25초 / −25초 (한도 안) | 실행 | 지금 만기인 1건만 (5분 뒤 만기 잡은 안 나감) | 1 | 1 | OK |

- 이르게 호출: 8분 뒤가 에스컬레이션 만기인 사건을 +10분 시계로 `listEscalationDue`에 직접 물어도 0건.
- `releaseJob(notBefore = +2일)` → 600초 뒤로 묶임. `writeHeartbeat(+1일)` → 저장값은 DB 시각.
- `TickClaim`: 정상 틱 뒤 +3일 실행기가 돌아도 행 1 → 1, 같은 분을 정상 실행기가 다시 요청하면 `duplicate`(이전에는 재선점됐다). 저장소 직접 호출 `claimTick(키, +3일)` → `CLOCK_SKEW`.
- 정리: 3일 지난 행만 지워지고, "분은 미래인데 오래전에 선점된 행"과 "분은 옛날인데 방금 선점된 행"은 남는다(의도대로).

## 5. R-5 · R-6 · R-7 · R-9 · slug

- **R-5**: SQL 저장소에 이상 입력 79개(`api2.probe.ts`: NUL · 제어문자 · 짝 없는 서로게이트 · 10만 자 · 잘못된 base64 / 커서 / 열거형 / limit / If-Match / 경로 인코딩 · 깊이 40 본문 · 2^40 버전 · 5,000건 일괄 · 10,000단계 호출 순서 등) → 400 58건, 404 5건, 409 2건, 200 13건, **500 1건**(P-2). 사건 3행·호출 순서 2행 변화 없음. 이전에 500이던 입력(NUL, 깨진 커서, 경로 NUL)은 전부 400이다.
- **R-6**: `savePagingConfig`(cfg 또는 audit의 고객이 null · undefined · '' · 다른 고객 · 0 · 배열 · 객체, 14가지) 전부 예외, `deletePagingConfig`(7가지) 전부 `CONFLICT`, 그 뒤 설정 행은 그대로(버전 1). `putIdempotent`는 owner가 비거나 문자열이 아니면 예외. `commitIncident`에 고객을 바꾼 행(다른 고객 / null)을 넘겨도 저장된 `customerId`는 그대로다. 남는 것 → Q-4.
- **R-7**: ack 뒤 51개 테이블 전체를 훑어 **undo 토큰 평문 0행**, SHA-256은 `UndoRecord` 1행. 같은 키 재전송 → 200, `undoToken` 없음, 나머지 본문 동일, 사건 버전 2 → 2, 이벤트 4 → 4(다시 실행되지 않음). 같은 키를 다른 사용자가 쓰면 재생이 아니라 자기 요청으로 처리(409). 첫 응답의 토큰으로 본인 undo 200, 다른 사용자 404, 두 번째 사용 404. 전역 청소: 만료 행 3 / 살아 있는 행 1 → 3 삭제, 만료 하루 안 된 undo는 남음, 만료 12,000행은 3회 호출(5000 / 5000 / 2000, 합계 22 ms), `expiresAt` 인덱스 사용.
- **R-9**: 전화번호 · 이메일 · api_key · Bearer 토큰 + 500자를 `completeJob`의 로그로 넘김 → `NotificationLog.error`와 `lastError` 모두 56자 `rejected: to=[number] [email] [secret] [secret] [secret]`, 원문 없음.
- **slug**: 마이그레이션 CHECK 3개(Customer · Project · Service) 각 20단어 = `RESERVED_SLUGS` 20단어, 차이 0. 실제 PG에서 예약어 20개 전부 거부, `API` · `Admin` · `api ` · `_` · `favicon.ico`는 형식으로 거부, `trail-` · `a--b` · `apis` · `health` · `oncall` · `static` 등 16개는 DB와 앱 둘 다 허용(일치).

## 6. 마이그레이션 끝부분 (REVOKE)

`misc.probe.ts`, 전부 트랜잭션 안에서 돌리고 되돌렸다.

| 경우 | 결과 |
|---|---|
| anon · authenticated 있음 + 스키마에 Supabase식 기본 권한(IN SCHEMA GRANT ALL) — **끝부분 없이**(대조) | 52개 테이블 전부와 시퀀스 6개에 권한, anon으로 `Contact` 읽힘 |
| 같은 조건, **끝부분 포함** | 권한 있는 테이블 0, 시퀀스 0, 나중에 만든 테이블 · 시퀀스에도 권한 없음, anon의 `Contact` 조회 `42501` |
| 두 역할 없음 | 마이그레이션 통과, 경고 없음 |
| 앱 역할(직접 GRANT, `authenticated`의 멤버)에 끝부분을 다시 실행 | 읽기 · 쓰기 그대로 됨. 깨지지 않는다 |
| 기본 권한이 **스키마 지정 없이** 걸려 있음 | 기존 테이블은 회수되지만 **나중에 만든 테이블은 anon에 다시 열림**(P-4) |
| 슈퍼유저가 아닌 역할로 실행, 스키마에 **남이 소유한 함수** 또는 **권한을 받은 남의 테이블** | 통과 + 경고(`no privileges could be revoked`). 그 남의 테이블은 anon에 계속 열려 있음 |
| 슈퍼유저가 아닌 역할로 실행, 스키마에 **권한이 전혀 없는 남의 테이블 · 시퀀스** | **마이그레이션 전체 실패 `42501`**(P-4) |
| `citext`가 `extensions` 스키마에 있고 `search_path = public` | **실패 `42704 type "citext" does not exist`**. `public, extensions`면 통과, 미설치면 `public`에 만들어지고 통과(P-4) |

- `NULLS NOT DISTINCT`는 PostgreSQL 15에서 들어온 문법이고 마이그레이션에 3곳 있다. 그 밖에 16 이상에서만 되는 문법(`CREATE FUNCTION`, 생성 열 등)은 grep으로 찾지 못했다. **15 · 16에서 실행해 본 것은 아니다** — 18.6에서만 돌렸다.

## 7. 테넌트 격리 — 회귀 없음

실제 PG, 고객 2곳 + 미매핑 + 포털 사용자: 읽기 6종(상세 · 미매핑 상세 · 타임라인 · 알림 · 호출 순서 · 호출 경로)과 쓰기 6종(ack · resolve · escalate · 호출 순서 PUT · 다른 고객 서비스의 override PUT / DELETE)에서 "남의 것"과 "없는 것"이 **12 / 12 같은 바이트**. 쓰기 뒤 다른 고객 행은 그대로(hanbit TRIGGERED v1, 미매핑 v0, 설정 버전 1). 포털 목록은 자기 사건 1건, 다른 고객 문구 없음. 저장소 직접 호출 8종 모두 0건 / null. 새 인자 `rotateAfter`는 `$4` 매개변수이고 따옴표 문자열을 넣어도 0건 · 오류 없음.

---

## [권고]

### P-1. 시계가 어긋난 실행기가 공유 heartbeat를 덮어쓴다 → 정상 실행기의 상태가 "정체"로 보이고 탐침 커서가 지워진다

- 위치: `packages/core/src/tick.ts` `runTick`의 `skewed()` (약 362–376줄) — `TICK_JOBS` 전부에 `lastFinishedAt: null, lastStatus: 'ERROR', lastStats: { skipped, clockSkewMs, errors }`를 쓴다. `claimTick`보다 먼저 쓰므로 그 분을 정상 실행기가 이미 처리했어도 덮어쓴다.
- 재현(실제 PG): 정상 틱(OK, 커서 `{"SMS":"cus_x1"}`) → 같은 분에 +10분 실행기 → 4개 모두 ERROR · 종료 시각 없음, `heartbeatHealth.stale = true`, `probeCursor` 사라짐. 정상 실행기의 호출 자체는 계속된다(다음 분에 새 잡 발송, 상태 OK로 복귀).
- 영향 두 가지:
  1. 상태 표시: 어긋난 실행기가 정상 틱 **사이**에 돌면 `/health`가 정체로 읽힌다. 같은 순간에 시작하면 정상 실행기가 나중에 쓰므로 틱이 도는 동안만(무응답 레인이면 최대 약 56초) 정체로 보인다.
  2. 회전: 3절 표의 마지막 줄 — 무응답 레인에 고객이 26곳 이상일 때 n = 30에서 5곳이 12틱 안에 미도달, 20틱 뒤 도달. 중복 발송은 0.
- 조건: 실행기 2개 이상 + 그중 하나의 시계가 30초 넘게 틀림 + (2번은) 업체 무응답 + 그 레인에 고객 26곳 이상. 파일럿(실행기 1, 고객 1)에는 닿지 않으므로 차단이 아니다.
- 수정안: 어긋난 실행기는 공유 행을 건드리지 않는다. 실행기가 그것 하나뿐이면 아무도 쓰지 않으니 3분 뒤 저절로 정체가 된다(D-10이 원하는 신호 그대로). 기록은 로그(`tick_clock_skew`, 이미 있음)와 별도 이름의 행(예: `clock-skew`)이나 `consecutiveFailures`만 올리는 쓰기로 남긴다. 최소한 `lastFinishedAt`과 `lastStats.probeCursor`는 보존할 것. 계약 스위트에 "어긋난 실행기 뒤에도 notify 커서와 종료 시각이 남는다" 1건 추가.

### P-2. 커서의 `t`가 `0000-01-01T00:00:00.000Z`이면 500 (R-5의 남은 1건)

- 위치: `packages/api/src/http.ts:73-74` (`isIsoInstant`), 사용처 `packages/store-sql/src/apiRepo.ts:131` (`::timestamptz`)
- 재현: `GET /incidents?cursor=base64url({"t":"0000-01-01T00:00:00.000Z","id":"x"})` → 500 INTERNAL, 로그 `date/time field value out of range`. 0001년과 9999년은 200. JS는 0년을 유효한 시각으로 보고 Postgres는 받지 않는다. 타임라인 · 알림 커서는 같은 값에 200.
- 영향: 인증된 사용자가 500과 오류 로그를 원하는 만큼 만들 수 있다. 주입 · 누출은 아니다.
- 수정안: `isIsoInstant`에서 연도 0001 미만 거부(또는 `v >= '1970-'` 같은 현실적 하한). 계약 스위트의 커서 사례에 추가.

### P-3. `claimTick`의 분 키(`scheduledAt`)는 저장소 시계로 묶이지 않는다

- 위치: `packages/store-sql/src/tickRepo.ts` `claimTick` (약 62–71줄) — `$2`(실행기 시각)만 검사하고 `$1`(분 키)은 그대로 넣는다. `at`을 생략하면 검사 자체가 없다.
- 재현: 시계가 맞는 실행기로 `runTick({ scheduledAt: 지금 + 3일 })` → 실행됨, 3일 뒤 분의 `TickClaim` 행이 남는다. `claimTick('2030-01-01T00:00Z')`(at 없음) → `true`. 그 분이 실제로 오면 그 틱은 `duplicate`로 건너뛴다(같은 분 재요청이 `duplicate`인 것은 측정했고, 미래 분은 그 코드 경로에서 따라 나오는 결론이다). 청소는 분이 2일 지나야 지운다.
- 영향: `scheduledAt`을 호출자가 넣을 수 있는 틱 진입점이 생기면, 그 진입점을 부를 수 있는 쪽이 앞으로의 분을 미리 선점해 호출을 멈출 수 있다. 진입점(`services/`)은 이 브랜치에 없다.
- 수정안: `claimTick`에서 분 키도 `now()` ± 몇 분 안일 때만 받는다(벗어나면 `CLOCK_SKEW`와 같은 취급). `at`을 필수로. 틱 진입점을 만들 때 인증과 함께 다시 볼 것.

### P-4. 첫 배포 전에 사람이 확인할 것 — 마이그레이션 끝부분의 전제 3가지

- 위치: `db/prisma/migrations/0001_init/migration.sql` 마지막 `DO $$ … $$` 블록과 2줄(`CREATE EXTENSION`), `db/README.md` "Before the first deploy"
- 측정은 6절 표. 정리하면:
  1. `REVOKE ALL ON ALL TABLES / SEQUENCES IN SCHEMA`는 **이 마이그레이션이 만든 것만이 아니라 스키마의 전부**에 걸린다(주석과 다름). 마이그레이션 역할이 권한을 전혀 갖지 못한 남의 테이블 · 시퀀스가 `public`에 하나라도 있으면 **0001 전체가 `42501`로 실패**한다. 권한은 있지만 소유자가 아니면 경고만 나고 그 객체는 anon에 그대로 열려 있다.
  2. `ALTER DEFAULT PRIVILEGES IN SCHEMA … REVOKE`는 "마이그레이션을 돌린 역할이, 그 스키마에 건" 기본 권한만 되돌린다. 스키마 지정 없는 기본 권한이나 다른 역할(`supabase_admin` 등)의 기본 권한은 남아서 나중 테이블이 다시 열린다. README도 이 부분을 미검증으로 적어 두었다.
  3. `citext`가 이미 `extensions` 스키마에 켜져 있고 연결의 `search_path`가 `public`뿐이면(Prisma `?schema=public`) 첫 `CITEXT` 열에서 실패한다.
- 요청(배포 PR에 결과를 붙일 것): ① `SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v')` — 비어 있어야 한다. ② `SELECT * FROM pg_default_acl` — anon · authenticated가 들어간 행을 확인. ③ `SELECT extname, extnamespace::regnamespace FROM pg_extension WHERE extname = 'citext'`와 `SHOW search_path`. ④ 배포 뒤 anon 키로 `GET /rest/v1/Contact` → 거부되는지. Data API 끄기가 여전히 1차 방어다.
- 미검증: Supabase 실제 프로젝트에서의 동작 전부.

### P-5. `0001_init`이 이번에도 제자리 수정됐다 (R-8 그대로)

- 이번 커밋들로 +34줄(예약어 CHECK 3개, 인덱스 2개, REVOKE 블록). 적용된 DB가 하나라도 있으면 체크섬이 어긋난다. 저장소만으로는 알 수 없다. `SELECT migration_name, checksum, finished_at FROM _prisma_migrations` 결과를 PR에 붙인 뒤 머지할 것(README 3번 항목과 같음).

### P-6. 커서를 heartbeat 행 하나에 싣는다 — 문서에 실패 시 수치를 적을 것

- 위치: `packages/core/src/tick.ts` `notifyPhase`(커서 읽기)와 `drainLane` 주석 "Not covered"
- 3절 측정대로 heartbeat 쓰기나 읽기가 계속 실패하면 회전이 없어지고 n = 30에서 5곳이 20틱 밀린다. 이때는 heartbeat도 정체가 되어 경보가 나므로(D-10) 숨은 실패는 아니다. 고치지 않는다면 `docs/API-CONTRACT.md`의 "⌈n ÷ P⌉ − 1틱" 문장 옆에 "커서를 읽거나 쓰지 못하는 동안은 회전 없음(26곳째부터 최대 20틱)"을 적을 것. P-1을 고치면 남는 경로는 이것뿐이다.

## [참고]

- **Q-1. 선점 비용은 만기 잡 수에 비례하고 레인 잠금 아래에서 치른다.** 2절 수치. 한 레인에 만기 20,000건 · 16 실행기까지 시간 초과 0. 실행기를 16개 넘게 두거나 수만 건이 쌓이는 상황을 예상하면 선점 SQL의 `due`에 상한(예: 고객별 상위 N건)을 두는 것을 검토.
- **Q-2. 권고 잠금 키는 데이터베이스 단위다.** `hashtext('alarmops:outbox-claim')`에 스키마가 들어가지 않으므로 한 데이터베이스의 두 스키마(예: 스테이징과 운영)는 레인 잠금을 공유한다. 서로 기다릴 뿐 틀린 결과는 아니다. 환경은 데이터베이스를 나눌 것.
- **Q-3. 재생 응답에는 `undoToken`이 없다.** 첫 응답을 잃은 클라이언트는 재생으로 되돌리기를 얻지 못한다(코드 주석에 명시, 의도). 사건 자체는 보이는 버전으로 계속 조작할 수 있다. 콘솔이 "되돌리기" 버튼을 토큰이 있을 때만 보이게 하는지 console 쪽에서 확인.
- **Q-4. `saveUndo`는 `userId`를 검사하지 않는다**(`apiRepo.ts:239`). null은 NOT NULL로 막히지만 `''` · 숫자 · 배열 · 객체는 문자열로 바뀌어 저장됐다(`""`, `"0"`, `{"cus_a"}`). `takeUndo` 뒤 사용자 비교에서 걸러지므로 지금 닿는 문제는 없다. `putIdempotent`의 owner도 "비어 있지 않은 문자열"까지만 본다(더 볼 수 있는 것이 없다).
- **Q-5. 한도 안의 어긋남(±30초 이내)은 조용히 보정된다.** ±25초 실행기는 DB 시각으로 판정해 정상 동작했다. 어긋남이 한도에 가까워지는 것을 알 수 있게 `clockSkewMs`를 heartbeat `lastStats`에 남기면 좋다.
- **Q-6. 검증하지 못한 것(재확인).** PostgreSQL 15 · 16, Supabase(Data API · 기본 권한 · Supavisor 6543의 `SET LOCAL` 동작), Prisma 드라이버, 응답 없는 네트워크에서의 `query_timeout`(작성자 테스트는 통과하나 내가 따로 만들지는 못했다). 로컬 클러스터에 내가 만들지 않은 데이터베이스 `mig`와 역할 `anon` · `authenticated`가 있었다 — 건드리지 않았다.
- **Q-7. 이전 [참고] N-1 ~ N-9**는 이번 변경으로 달라진 것이 없다. N-5의 격리 수준은 이제 트랜잭션마다 `READ COMMITTED`로 명시된다(풀러 모드 포함 통과).

## 첫 배포 전 목록

1. P-4의 확인 4가지 + Data API 끄기(또는 노출 스키마에서 `public` 제외).
2. P-5: `_prisma_migrations`가 비어 있음을 확인.
3. Postgres 15 이상인지(`SELECT version()`), 가능하면 `test:sql`을 배포 대상과 같은 버전 · 같은 풀러 모드로 1회.
4. 앱 역할에 `statement_timeout` · `lock_timeout` · `idle_in_transaction_session_timeout` (`ALTER ROLE … SET`, README 4번).
5. Prisma 드라이버를 쓸 거면 `test:sql`을 그 드라이버로 1회(N-9).

실행기를 2개 이상 두기 전: P-1, P-3. 고객이 26곳을 넘기 전: P-6(문서) 또는 커서 저장 위치 재검토.

## 탐침 파일

모두 `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/sql2/`:

| 파일 | 내용 |
|---|---|
| `conc2.probe.ts`, `conc2.log` | B-1: 라운드 · 빈 선점 · 중복, 선점 지연, 레인 혼합 교착, 붙잡힌 레인 |
| `r24.probe.ts`, `r24-slow{0,400,2500}.jsonl` | R-1 전수(n = 1..60 × 모든 위치 × 지연 3종) |
| `cursor.probe.ts`, `cursor.jsonl`, `cursor-ghost.jsonl`, `cursor-long.jsonl` | 커서 실패 경로 5종 + 없는 고객 커서 + 40틱 관찰 |
| `misc.probe.ts`, `misc.log`, `misc2.log` | R-2 시계, R-9, R-7 청소, R-6, slug, 마이그레이션 끝부분 |
| `api2.probe.ts`, `api2b.log` | R-5 입력 79개, R-7 토큰 · 재생, 테넌트 12종 |
| `test.log`, `typecheck.log`, `testsql-{1..8}.log`, `testsql-pooler.log` | 스위트 실행 기록 |

실행: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres node node_modules/vitest/vitest.mjs run --config <위 폴더>/vitest.config.ts <파일>` (위 폴더에서).
