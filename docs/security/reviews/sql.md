# 보안 검토 — feat/sql-adapter (SQL 저장소, 스키마, R-24)

- 대상: `/home/claude/wt-backend`, `feat/sql-adapter` @ 7226993, `origin/main` 대비 36개 파일
- 검토자: security 역할(읽기 전용). 저장소 파일은 수정하지 않았다. 탐침은 `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/sql/`에만 있다.
- 실행 환경: 실제 PostgreSQL **18.6**(`/opt/pglocal`, 사용자 `nobody`, 127.0.0.1:54329 — 검토 후 중지함)과 PGlite. **Postgres 16과 Supabase에서는 돌려 보지 못했다.** 저장소에 `.github/workflows`가 없어 문서가 말하는 "CI: postgres:16"도 확인할 수 없었다.

## 판정

**머지 보류 요청 — [차단] 1건.** SQL 주입, 테넌트 격리, 중복 발송 쪽에서는 결함을 찾지 못했다. 막는 이유는 실제 Postgres에서 계약 테스트가 간헐적으로 실패한다는 것(관문 1)이고, 그 원인이 동시 선점 시 빈 선점이라는 실제 동작이다.

| 등급 | 건수 | 항목 |
|---|---|---|
| [차단] | 1 | B-1 |
| [권고] | 9 | R-1 ~ R-9 |
| [참고] | 9 | N-1 ~ N-9 |

## 테스트·타입 검사 결과

| 실행 | 결과 |
|---|---|
| `npm run typecheck` (전 워크스페이스) | 통과 |
| `npm test` (전 워크스페이스, store-sql은 PGlite) | 통과 (실패 0) |
| `TEST_DATABASE_URL=… npm run test:sql -w @alarmops/store-sql` (PG 18.6) | **7회 중 2회 실패** (79개 중 1개, 같은 테스트) |
| 공유 API 계약(`contract.api.test.ts`)을 실제 PG로 | 7회 모두 통과 |

---

## [차단]

### B-1. 동시 선점에서 진 실행기는 빈 선점을 받는다 → 실제 Postgres에서 계약 테스트가 간헐 실패

- 위치: `packages/store-sql/src/tickRepo.ts:377-405` (`claimDueJobs`), 테스트 `packages/core/test/contract/tickContract.ts:712-728`
- 내용: 순위(`due → ranked → ordered → picked`)를 **잠금 없이** 먼저 정하고, 그 `picked`만 `FOR UPDATE SKIP LOCKED`로 잠근다. 동시에 들어온 실행기는 모두 같은 상위 N건을 고르고, 하나만 잠금을 얻고, 나머지는 건너뛴 만큼을 **다른 잡으로 채우지 않는다**. 중복 선점은 없다(아래). 문제는 만기 잡이 남아 있는데 선점이 0건으로 돌아오는 것이다.
- 재현 1 (저장소 테스트 그대로): `test:sql`을 7회 돌려 2회 실패.
  `two runners claiming at once never get the same job, and together never more than what is due` → `expected 100 to be 120`, `expected 119 to be 120`. 단독 실행(`-t`)으로는 6회 모두 통과했다. 파일 4개가 같이 돌아 트랜잭션이 실제로 겹칠 때만 난다.
- 재현 2 (`conc.probe.ts` 1번, 5회 반복 합계):

  | 실행기 × limit, 잡 수 | 중복 | 다 비우는 데 걸린 라운드(이상값) | 만기 잡이 남았는데 0건을 받은 선점 호출 |
  |---|---|---|---|
  | 2 × 25, 120 | 0 | 5 (3) | 12 / 46 |
  | 4 × 25, 120 | 0 | 4 (2) | 27 / 72 |
  | 8 × 50, 400 | 0 | 7 (1) | 137 / 264 |
  | 8 × 10, 400 | 0 | 29 (5) | 701 / 1056 |

- 영향: 실행기가 하나면 영향 없다. 틱이 겹치거나(틱은 60초까지 가고 다음 틱이 시작된다) 실행기를 늘리면, 진 쪽 레인은 그 틱에 아무것도 보내지 않고 다음 틱으로 밀린다. 유실·중복은 아니다. 같은 파일의 `sql.only.test.ts:127-140`(8 실행기)은 400건에 12라운드를 허용해서 이 현상을 통과시킨다.
- 수정안 (하나 선택):
  1. 선점 트랜잭션 첫 문장에 레인별 `pg_advisory_xact_lock(hashtext('claim:' || lane))` — 선점은 수 ms라 직렬화해도 되고 `lock_timeout` 3초가 상한이다. 순위 SQL은 그대로 둔다.
  2. 같은 트랜잭션 안에서 `RETURNING` 수가 `picked` 수보다 적으면 다시 고르기(최대 2~3회).
  어느 쪽이든 계약 테스트의 "4라운드 안에 120건"이 실제 PG에서 안정적으로 통과하는지 20회 이상 반복해 확인할 것. 의도된 동작("may get fewer than `limit`", tickRepo.ts:355-356)이라고 본다면 테스트 기대값을 그에 맞게 고쳐야 한다 — 지금은 구현 주석과 테스트가 서로 다른 말을 한다.

---

## [권고]

### R-1. R-24 보폭 규칙: 저장소가 느리면 회전이 기거나 멈춘다 (문서 수치와 다름)

- 위치: `packages/core/src/tick.ts:779-782`, 문서 `docs/API-CONTRACT.md` "탐침 시작 위치 회전" 문단, `tick.ts:709-716` 주석
- 방법: 실제 엔진 하네스(`packages/core/test/real-engine.ts`의 `world`·`drive`, 실제 `runTick` + `MemoryTickStore`). 레인의 고객 n곳 중 1곳만 정상(페이지 1건), 나머지 n−1곳은 무응답 × 20건(수신자 각각 다름), 만기 시각은 모두 같게 해서 **정상 고객을 n개 위치마다 한 번씩** 놓았다(시작 분을 전부 바꾸는 것과 같다). 값은 정상 페이지가 밀린 틱 수의 최악값(0 = 같은 틱), 12틱 관찰. 중복 발송 0, 틱 최장 56초.

  | 고객 수 n | 저장소 빠름 | 호출당 0.4초·1초 (4묶음 = 20탐침) | 호출당 2.5초 (3묶음 = 15탐침) |
  |---|---|---|---|
  | 1–15 | 0 | 0 | 0 |
  | 16–17 | 0 | 0 | 1 |
  | 18 / 19 | 0 | 0 | 3 / 4 |
  | **20** | 0 | 0 | **12틱 안에 미도달 (5개 위치)** |
  | 21–25 | 0 | 1 | 6, 4, 3, 3, 3 |
  | **26** | 1 | **6** | 11 |
  | 27 / 28 / 29 | 1 | 4 / 3 / 3 | 6 / 5 / 4 |
  | 30–45 | 1 | 2 | 3–7 |
  | 46 / 47 | 1 | 4 / 4 | 6 / 8 |
  | 48 | 1 | 6 | 10 |
  | **49** | 1 | **10** | 미도달 (9개 위치) |
  | **50** | 1 | **미도달 (10개 위치)** | 미도달 (20개 위치) |
  | 51–60 | 50번째 이후 위치 미도달 | 미도달 (n−40개 위치) | 미도달 (n−30개 위치) |

- 해석:
  - 저장소가 빠르면 문서대로다: n ≤ 25 같은 틱, 26–50 최대 1틱.
  - 보폭 25는 "한 틱에 25곳을 탐침한다"가 전제다. 5번째 묶음이 시작되지 못하면(작성자가 5차 검토에서 든 0.4초 조건) 한 틱 탐침은 20곳인데 시작 위치는 25씩 움직인다. n = 26이면 25 ≡ −1 (mod 26)이라 한 칸씩 뒤로 기고, n = 50이면 gcd(25, 50) = 25라 시작 위치가 0·25 둘뿐이어서 20–24, 45–49번 위치는 영영 차례가 오지 않는다(무응답 잡이 5회 실패로 포기될 때까지).
  - 보폭 20(n ≤ 25)도 같은 종류다: n = 20이면 20 mod 20 = 0으로 서 있고, 탐침이 15곳으로 줄면 15–19번이 굶는다.
  - 51곳 이상은 문서가 이미 "회전으로 풀리지 않는다"고 적은 선점 한도(50)다. 다만 "밀린다"가 아니라 관찰 구간 내내 도달하지 못했다.
- 문서와 어긋나는 문장: "저장소가 느린 경우(호출 1건 0.4초·1초)에도 24곳·40곳에서 1틱 안", "25~49곳: 1틱". 0.4초에서 40곳(정상 포함 n = 40)은 최악 2틱, 26곳 6틱, 49곳 10틱이다. 작성자 테스트는 정상 고객을 항상 맨 뒤(만기가 늦음)에 두고 24·40곳만 쟀다.
- 수정안: 보폭을 "틱이 실제로 해내는 최소 탐침 수" 이하의 상수로 둔다. 보폭 s ≤ 탐침 수 P이면 gcd와 무관하게 창 [r, r+P)가 이어 붙어 ⌈n ÷ s⌉틱 안에 모든 위치가 덮인다. core 사본에서 그 한 줄만 바꿔 같은 하네스로 쟀다(`r24fix.probe.ts`):

  | 보폭 | 빠름 | 0.4초 | 2.5초 |
  |---|---|---|---|
  | 현재 (20 / 25) | ≤ 1 | 최대 10, n = 50 미도달 | n = 20·49·50 미도달 |
  | 20 고정 | n ≤ 25: 0, 26–45: 1, 46–50: 2 | n ≤ 20: 0, 21–40: 1, 41–50: 2 | n = 20·40·41 미도달 |
  | 15 고정 | n ≤ 25: 0, 26–40: 1, 41–50: 2 | n ≤ 20: 0, 21–35: 1, 36–50: 2 | 미도달 없음, 최대 6 |

  빠른 저장소에서 46–50곳이 1틱 → 2틱이 되는 대신 미도달이 없어진다. 파일럿(고객 1곳)에는 영향이 없으므로 차단은 아니다. 고치지 않는다면 최소한 문서의 두 문장을 위 표에 맞게 고칠 것.

### R-2. 실행기·API 시계로 찍는 만기 (`dueAt`) — `LEAST(at, now())`는 맞지만 절반만 막는다

- 위치: `tickRepo.ts:321-334` (`insertJobs`, `$2` = `at`), `:247` (`at` = 이벤트 시각의 최댓값), `:250-254` (`restoreAckSkipped`), `:422-430` (`releaseJob` `notBefore`), `:64-66`·`:71-76`·`:216-223` (`listGroupsToClose`·`listGroupsToDeliver`·`listEscalationDue`의 `now` 인자), `:47-55` (`claimTick`)
- 재현 (`conc.probe.ts` 8번, DB 시계 기준):

  | 호출자 시계 | `commitIncident`가 넣은 페이지 | 지금 선점 가능 |
  |---|---|---|
  | 10분 빠름 | 10분 뒤 만기 | 아니오 — 10분 늦게 호출 |
  | 10분 느림 | 10분 전 만기 | 예 |
  | 2일 빠름 | 2880분 뒤 만기 | 아니오 — 사실상 호출되지 않음 |

  수동 에스컬레이션(`packages/api/src/incidents.ts:258-260`)도 같은 경로라 API 서버 시계도 해당된다.
- `LEAST(at, now())`에 대한 답: `insertJobs`와 `restoreAckSkipped`에는 맞는 수정이다. 두 곳 모두 "지금 보내라"는 뜻이라 미래 값이 정당할 일이 없고, 느린 시계는 그대로 과거가 되어 해가 없다. 이것으로 "늦게/영영 안 나감"은 막힌다.
- 그것으로 막히지 않는 것:
  1. **이르게 호출**: `listEscalationDue(now)`는 실행기 `now`로 만기를 판정한다. 8분 뒤가 만기인 사건이 10분 빠른 실행기에게는 지금 만기다(탐침: 실제 시계 0건, 10분 빠른 시계 1건). `listGroupsToClose`·`listGroupsToDeliver`도 같아서 그룹 대기가 일찍 닫힌다.
  2. `releaseJob(notBefore)`: 2일 빠른 실행기가 넘긴 값이 그대로 들어가 2880분 뒤 만기가 됐다. 여기는 미래 값이 정당하므로 `LEAST(notBefore, now() + 상한)`으로 묶어야 한다.
  3. `claimTick`: 분 키가 실행기 시계에서 온다. 시계가 다른 두 실행기는 같은 실제 1분을 서로 다른 키로 둘 다 얻는다. 또 3일 빠른 실행기가 한 번 선점하면 같은 문장의 `DELETE … < minute − 2 days`가 현재 분의 행을 지워서 현재 분을 **다시** 선점할 수 있었다. 행 버전·`claimSeq` 덕에 중복 발송으로 이어지지는 않는다.
- 수정안: `insertJobs`·`restoreAckSkipped`에 `LEAST($at, now())`. 그리고 근본 대책으로 `claimTick`에서 `abs(at − now())`가 한도(예: 30초)를 넘으면 틱을 하지 않고 오류 1건으로 끝낸다 — 인자 `at`은 이미 넘어오는데 SQL 저장소가 쓰지 않는다. 이러면 1·3번이 한 곳에서 막힌다. 삭제 기준도 `now()`로.

### R-3. 풀 밖 단일 문장의 타임아웃은 연결 기본값에만 기댄다 + 연결·응답 대기에 상한이 없다

- 위치: `packages/store-sql/src/drivers/pg.ts:25-28` (`options: -c statement_timeout…`, `connectionTimeoutMillis`·`query_timeout`·`keepAlive` 없음), 단일 문장 경로 `tickRepo.ts:47, 410, 435, 438, 500`과 모든 조회
- 확인한 것 (PG 18.6 직결): 풀 문장과 트랜잭션 모두 `statement_timeout=4500ms`, `lock_timeout=3s`. 잠긴 행에 대한 `completeJob`·`beginSend`는 3002ms 뒤 `55P03`. 실패한 트랜잭션 30개 뒤 `idle in transaction` 0, 롤백 정상. `commitIncident` 중간 실패 시 사건 행 변화 없음.
- 남는 문제:
  1. 트랜잭션 모드 풀러(Supabase 6543) 뒤에서는 세션 설정이 유지되지 않는다. 드라이버 주석도 "transaction 경로만 쓰라"고 하는데 정작 `claimTick`·`beginSend`·`releaseJob`·`completeJob`(로그 없는 경우)·모든 조회가 `pool.query`다. 시작 매개변수 `options`를 풀러가 받아 주는지도 **확인하지 못했다**.
  2. `connectionTimeoutMillis` 기본값 0: 풀이 다 차면 빈 연결이 날 때까지 기다린다(탐침: `max: 2`를 `pg_sleep(4)` 둘로 채우자 저장소 호출이 4010ms 대기). core의 5초 가드는 네 호출에만 있다.
  3. `statement_timeout`은 서버 쪽 제한이다. 네트워크가 끊겨 응답이 오지 않으면 클라이언트는 기다린다(`query_timeout`·`keepAlive` 없음). 샌드박스에서는 블랙홀 호스트를 만들지 못해 **실측하지 못했다**(ECONNREFUSED로 즉시 실패).
  4. `idle_in_transaction_session_timeout = 0`: 서버리스 인스턴스가 트랜잭션 도중 얼면 `FOR UPDATE` 잠금이 남는다. 선점은 건너뛰지만 `commitGroupDelivery`와 선점의 포기 처리 UPDATE(`tickRepo.ts:363-368`, SKIP LOCKED 아님)는 3초씩 기다리다 실패한다.
- 수정안: `connectionTimeoutMillis: 3000`, `query_timeout: 5000`, `keepAlive: true`; DB 역할에 `ALTER ROLE … SET statement_timeout / lock_timeout / idle_in_transaction_session_timeout = '15s'`(풀러와 무관하게 적용됨); 배포 대상 풀러에서 `SHOW statement_timeout`을 풀 문장으로 확인하는 서버 테스트 1개.

### R-4. Supabase Data API(PostgREST) 노출 — 배포 전 사람이 확인해야 함 (미검증)

- 위치: `db/prisma/migrations/0001_init/migration.sql` 전체(모든 테이블이 `public`, RLS 없음 — DATA-MODEL.md:6의 원칙), 저장소에 Supabase 설정 없음(`infra/`는 aws·customer-stack뿐)
- 내용: Supabase는 기본으로 `public` 스키마를 `anon`·`authenticated` 역할에 REST로 연다. RLS가 꺼진 테이블은 anon 키만으로 읽고 쓸 수 있다. 이 브랜치로 `Contact`(전화·이메일), `IdempotencyKey.response`, `ContactRevealLog`가 실제 저장소가 된다. **Supabase 프로젝트에서 확인한 것이 아니라 플랫폼 기본 동작에 근거한 지적이다.**
- 수정안 (택1, 첫 `migrate deploy` 전): Data API 끄기 / 노출 스키마에서 `public` 제외 / 마이그레이션 끝에 `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated` + `ALTER DEFAULT PRIVILEGES … REVOKE` (역할이 없는 일반 Postgres에서도 돌도록 `DO $$ IF EXISTS … $$`로 감쌀 것). "권한 판정에 RLS를 쓰지 않는다"는 원칙과 충돌하지 않는다.

### R-5. NUL 바이트·잘못된 커서가 500이 된다 (메모리 저장소와 다른 응답, DB 오류 문구가 로그로)

- 위치: `apiRepo.ts:127` (`q`), `:131` (커서 `t`를 `::timestamptz`), `:176, 182, 201, 217` (경로의 id), 검증 `packages/api/src/incidents.ts:24` (`isCursor`는 문자열 여부만 본다)
- 재현 (`api.probe.ts` A, 실제 PG, 포털 사용자 yuna):

  | 입력 | 응답 |
  |---|---|
  | `GET /incidents?q=%00`, `q=a%00b` | 500 INTERNAL |
  | 커서 `{t:"garbage"}`, `{t:"2026'; select pg_sleep(3)--"}`, `{id:"a\u0000"}` | 500 INTERNAL |
  | `GET /incidents/inc%00x`, `/timeline`, `/notifications` | 500 INTERNAL |
  | `/incidents/<다른 고객 id>%00` | 500 INTERNAL (없는 id + NUL과 같은 응답 → 존재 여부는 새지 않음) |

  주입은 아니다(값은 전부 매개변수이고 `Incident` 3행 그대로). 인증된 사용자가 원하는 만큼 500과 오류 로그(`invalid byte sequence for encoding "UTF8": 0x00`, `invalid input syntax for type timestamp…`)를 만들 수 있다는 것, 그리고 계약 스위트가 이 차이를 잡지 못한다는 것이 문제다.
- 수정안: HTTP 경계에서 `\u0000`이 든 질의·경로·본문 문자열은 400(경로 id는 404); `isCursor`에서 `t`가 ISO 시각인지 확인; 계약 스위트에 두 경우 추가.
- 같이 볼 것: 경보 제목에 NUL이 있으면 `Alert` INSERT 자체가 실패한다(시드 단계에서 `22021`). 수집이 SQL로 옮겨올 때 정규화가 필요하다. 짝 없는 서로게이트는 text 경로에서 U+FFFD로 바뀌어 통과했다.

### R-6. `deletePagingConfig`: 감사 레코드의 고객이 null이면 고객 조건이 사라진다

- 위치: `apiRepo.ts:298-300` — `"customerId" IS NOT DISTINCT FROM COALESCE($3, "customerId")`
- 재현 (`api.probe.ts` B): hanbit의 설정을 `audit.customerId = 'cus_mirae'`로 지우면 `CONFLICT`(정상), **`null`로 지우면 `OK`이고 행이 사라진다.**
- 현재 호출자(`pagingApi.ts:221`)는 항상 `customer.id`를 넘기므로 지금 닿는 경로는 없다. 다만 `AuditInput.customerId`는 `string | null` 타입이고, 빠지면 열리는 쪽으로 실패한다.
- 수정안: `COALESCE` 제거(`"customerId" = $3`), 또는 고객 id를 별도 필수 인자로 받기.

### R-7. `IdempotencyKey`: 응답 본문 평문 보관, 만료 행 청소가 "같은 사용자의 다음 쓰기"뿐

- 위치: `apiRepo.ts:342-355`, `migration.sql:1031-1039`, 호출 `packages/api/src/router.ts:105-107`
- 확인한 것 (`rest.probe.ts`, `conc.probe.ts` 7번):
  - 틱 + ack 뒤 51개 테이블 전체를 문자열로 훑었다. **연락처 전화·이메일은 `Contact` 밖에 없다.** `NotificationJob`은 `targetRef`(연락처 id)·`contactName`·문구만, `NotificationLog`는 이름·종류만 가진다.
  - `UndoRecord.token`은 SHA-256 16진 64자만 저장된다. 그런데 **같은 undo 토큰 평문이 `IdempotencyKey.response`에 24시간 들어 있다**(ack 응답 본문 전체가 저장됨). 토큰은 5분·본인·1회라 실익은 작지만 해시 저장의 취지와 어긋난다.
  - 만료 30일 지난 u1의 행 4개는 u2가 10번 써도 남는다 — 다시 쓰지 않는 사용자의 응답 본문(사건 제목, 고객·프로젝트 이름)은 지워지지 않는다.
  - 상한 경쟁은 문제없다: 소유자 2명 × 동시 60건, 상한 5 → 각 5행, 오류 0, 142ms. 같은 키 동시 20건도 오류 0.
- 수정안: 전역 만료 청소(틱 한 단계나 pg_cron: `DELETE … WHERE "expiresAt" < now()` — 인덱스는 `expiresAt` 단독이 필요, 지금은 `(ownerUserId, expiresAt)`뿐); 저장 전에 `undoToken` 제거 또는 재생 시 재발급하지 않음을 명시; **연락처 공개(D-35) 라우트를 만들 때 `replayable: false`** — 아니면 전화번호가 이 표에 들어간다.

### R-8. `0001_init` 제자리 수정 — 적용된 DB가 없다는 것을 사람이 확인해야 함

- 위치: `db/README.md:11`, `migration.sql` (+183줄: 열 30여 개, 표 5개, enum 4개, 인덱스·CHECK)
- 저장소만으로는 알 수 없다(README도 그렇게 적었다). 이미 적용한 DB가 하나라도 있으면 체크섬 불일치로 `migrate deploy`가 멈추고, 억지로 맞추면 열이 없는 채로 돈다.
- 요청: dev DB 소유자에게 `SELECT migration_name, checksum, finished_at FROM _prisma_migrations` 결과를 받아 PR에 붙인 뒤 머지. 행이 있으면 차이를 `0002_`로 분리.
- 버전: `NULLS NOT DISTINCT`(migration.sql:1537, 1546, 1566)는 15 이상이 필요하다. 18.6에서는 전체 마이그레이션과 스위트가 돈다. 16과 Supabase의 실제 버전·`citext` 위치(`CREATE EXTENSION IF NOT EXISTS "citext"`, migration.sql:2)는 확인하지 못했다.

### R-9. 저장소가 `NotificationLog.error`를 가리지 않고 쓴다

- 위치: `tickRepo.ts:487`(`lastError`는 `sanitizeProviderError` 적용) 대 `:496`·`:529-541`(`insertLogs`는 `log.error` 그대로)
- 재현 (`rest.probe.ts`): 같은 원문(전화번호·이메일·`api_key=…` + 500자)을 `completeJob`에 넘기면 `lastError`는 `rejected: to=[number] [email] [secret] [secret]`(47자), **`NotificationLog.error`는 원문 581자**.
- 현재 core는 `providerText()`를 거친 값만 넘기므로(`notify.ts:386-392`) 지금 새는 경로는 없다. 메모리 저장소도 같다. `STORE_PROVIDER_TEXT`의 120자 발췌도 core에서만 적용된다. 저장 경계에서 한 번 더 가리는 편이 안전하다(`lastError`와 같은 규칙).

---

## [참고]

- **N-1. SQL 주입 — 결함 없음.** `store-sql/src`의 모든 문장을 읽었다. 사용자 값은 전부 `$n`이다. 문자열로 끼워 넣는 것은 코드 상수뿐이다: 열 목록(`rows.ts`), `MAX_ATTEMPTS`·`CLAIM_LEASE_SEC`·`RETRY_DELAYS_SEC`·`MAX_MEMBERS`, `scopeSql`의 `true/false`와 별칭, `commitIncident`의 `'ACKNOWLEDGED'/'FIRING'`(`tickRepo.ts:257-260`), `sql.now()`. `LIMIT`·`OFFSET`·`IN` 목록(`= ANY($n::text[])`)·JSON 경로(`jsonb_path_exists(…, vars)`, `apiRepo.ts:129`)는 매개변수다. `ORDER BY`는 고정. 검색 `q`는 `LIKE`가 아니라 `position(lower($n) in lower(title))`이라 이스케이프가 필요 없다: `%`·`_`는 그 글자가 든 제목만, `'`, `\`, `' OR '1'='1`, `x'); DROP TABLE…`은 0건(탐침). Prisma 드라이버의 `$queryRawUnsafe`도 위치 매개변수만 쓴다. 테스트 전용: `withClock`의 시각 리터럴, `PgClientOptions.schema`(연결 옵션에 그대로 들어감 — 설정값이 사용자 입력에서 오면 안 된다).
- **N-2. 테넌트 격리 — 결함 없음.** 범위는 `scopeSql`로 질의 **안**에 들어간다(`apiRepo.ts:22-36`). 실제 PG, 고객 2곳 + 포털 사용자: 읽기 6종(상세·미매핑 상세·타임라인·알림·경보·호출 순서)과 쓰기 6종(ack·resolve·escalate·호출 순서 PUT·다른 고객 서비스의 override PUT/DELETE)에서 "남의 것"과 "없는 것"이 같은 바이트였고 쓰기 뒤 다른 고객 행은 그대로다. 저장소 직접 호출: 다른 고객 사건·경보·이벤트·알림 로그·리소스 0건, `total`도 0, 다른 사건의 이벤트 id를 커서로 줘도 자기 행만. 미매핑(고객 NULL) 행은 `unmapped: true`일 때만 보이고 `customerIds: '*'`만으로는 보이지 않는다. `customerIds: []`는 0건. 조인은 고객 열을 같이 건다(`Alert`, `CloudAccount`, `Service`, `Contact`). 예외 `incidentFingerprints`(`tickRepo.ts:103`)·`listAutoResolvable`(`:211`)은 `IncidentAlert`가 `commitGroupDelivery`에서 고객 조건으로만 들어가므로(`:176-177`) 틱 내부에서는 안전하다.
- **N-3. `orgTree`의 JS 좁히기.** 고객 조건은 SQL에, 프로젝트·서비스 하위 범위는 `nodeVisible`로 JS에서 거른다(`apiRepo.ts:46-64`). 같은 고객 안의 좁히기이고 메모리 저장소와 같은 함수다. 탐침: `svc_pay`만 가진 사용자 → 고객 1, 프로젝트 `prj_core`(부모), 서비스 `svc_pay`. 다른 고객만 가리키는 하위 범위는 그 고객을 넓히지도, 자기 고객을 좁히지도 않는다(문서화된 `inScope` 규칙).
- **N-4. 선점·가드 — 중복 없음.** 8 실행기가 선점 → `beginSend` → `completeJob`을 동시에: 업체 호출 300, 서로 다른 잡 300, 두 번 보낸 잡 0, `attempts` 최대 1, `claimSeq` 최대 1. 임대 만료 뒤 재선점(`claimSeq` 1 → 2)에서 옛 선점의 `beginSend`·`completeJob`·`releaseJob`은 null/false, 완료 뒤 재완료도 false. 잠금 아래 재확인은 `nextAttemptAt <= now`가 맡는다(선점이 임대 시각으로 밀어 놓으므로). `TickClaim`: 같은 분 16 동시 → 1명. 분 키는 core가 분 단위로 자른다(`tick.ts:288`). 저장소는 자르지 않으니 `…:59.999Z`는 다른 행이 된다. `takeUndo` 동시 20 → 1명.
- **N-5. 권고 잠금·교착.** `pg_advisory_xact_lock(hashtext('idem:' || owner))`(`apiRepo.ts:345`): 32비트 해시가 겹치면 두 사용자가 서로 잠깐 기다릴 뿐이다. 트랜잭션 범위라 네트워크 호출을 끼고 잡히지 않고 `lock_timeout`이 적용된다. 잠금 순서는 `commitGroupDelivery`가 AlertGroup → Incident → IncidentAlert → 잡, `commitIncident`가 Incident → 잡 → Alert라 둘 사이 순환은 찾지 못했다. 여러 행을 순서 없이 건드리는 곳은 `commitIncident`의 Alert UPDATE(`:258-262`)와 선점의 포기 UPDATE(`:363-368`)이고, 수집이 SQL로 오면 Alert 쪽을 다시 봐야 한다. 교착은 Postgres가 1초에 잡고(`40P01`) 호출은 오류로 끝난다. 격리 수준은 서버 기본값 READ COMMITTED에 기댄다(명시하지 않음) — 선점 로직이 이것을 전제하므로 `BEGIN ISOLATION LEVEL READ COMMITTED`로 못 박는 편이 낫다.
- **N-6. FK `ON DELETE`.** 연락처 삭제: 잡의 `contactId`는 NULL, `targetRef`·`contactName`은 남는다. 대기 중인 잡은 수신자를 찾지 못한다(`tick.ts:847`은 `contactId`로만 조회). `NotificationLog.contactId`도 NULL이 되지만 `targetSummary`(이름)는 남는다. 호출 순서 삭제: `Incident.pagingConfigId`는 NULL, `assignmentSnapshot`의 단계와 스냅샷 안의 id는 그대로라 진행 중 에스컬레이션은 유지된다. 고객 삭제: Incident·IncidentEvent·NotificationJob·NotificationLog·Alert는 `customerId` FK가 없어 고아로 남고(탐침: 삭제 전후 행 수 같음) 전체 범위 직원에게 계속 보인다. `PagingConfigTombstone`과 `IdempotencyKey`도 FK가 없다. 감사 표는 FK가 없어 지워지지 않는다. `ContactRevealLog.actorUserId`는 RESTRICT — 공개 기록이 있는 사용자는 삭제되지 않는다(의도로 보임).
- **N-7. slug.** CHECK `^[a-z0-9][a-z0-9-]{0,63}$`: 대문자·앞 하이픈·`..`·`/`·공백·개행·한글·65자·빈 값 거부. `trail-`, `a--b`, 그리고 `new`·`api`·`admin`·`all`·`unmapped`는 **통과**한다. 예약어는 "서비스 계층에서"라고 적혀 있는데(`migration.sql:1573`) 그 코드는 아직 없다(고객을 만드는 API가 없음). 만들 때 넣을 것.
- **N-8. 사소한 것.** ① 이벤트 없이 잡만 넣으면 `dueAt`·`createdAt`이 1970-01-01이 된다(`tickRepo.ts:247`, 메모리 저장소도 같음, 지금 호출자는 항상 이벤트를 같이 넘김). R-2의 `LEAST`가 아니라 `COALESCE(…, now())`가 필요한 자리다. ② `seq SERIAL`은 커밋 순서가 아니다: 동시 트랜잭션에서 낮은 seq가 늦게 커밋되면 타임라인·알림 로그 커서가 그 행을 건너뛸 수 있다. ③ `IdempotencyKey.key`는 전역 PK라 저장소 수준에서는 다른 소유자가 같은 키 문자열을 덮어쓸 수 있다. API는 키를 `sha(userId | scope | key)`로 만들므로 닿지 않는다. ④ `json`(IdempotencyKey.response) 대 `jsonb`: 응답을 바이트 그대로 재생하려는 것이면 `json`이 맞고 안전하다. ⑤ `ContactRevealLog`는 값 열이 없고(이름·채널·사유·ip·UA만) 이 브랜치에 쓰는 코드도 없다. ⑥ 다른 사람의 undo 토큰을 내면 `takeUndo` 뒤 `saveUndo`로 되돌리는데(`incidents.ts:387-390`) 두 문장 사이에 주인이 누르면 404가 된다.
- **N-9. Prisma 드라이버** (`drivers/prisma.ts`)는 작성자 말대로 실행된 적이 없다. 이 검토에서도 돌리지 못했다. 쓰기 전에 `test:sql`을 그 드라이버로 한 번 돌릴 것.

## 탐침 파일

모두 `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/sql/`:

| 파일 | 내용 |
|---|---|
| `api.probe.ts` | 주입·커서·NUL, 교차 테넌트 읽기/쓰기, 저장소 직접 범위 호출 |
| `conc.probe.ts` | 동시 선점, 전체 파이프라인, claimSeq, TickClaim, 타임아웃, 롤백, 멱등 상한, undo, 시계 |
| `rest.probe.ts` | 저장 데이터 전수 검색, 업체 문구, FK 삭제, slug |
| `r24.probe.ts`, `r24-slow{0,400,1000,2500}.jsonl` | R-24 n = 1..60 × 모든 위치 |
| `r24fix.probe.ts`, `core-patched/`, `r24fix-*.jsonl` | 보폭 고정안(core 사본에서만) |
| `testsql*.log`, `test.log`, `typecheck.log` | 스위트 실행 기록 |

실행: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres node node_modules/vitest/vitest.mjs run --config <위 폴더>/vitest.config.ts <파일>` (위 폴더에서; `node_modules`는 워크트리로 가는 심볼릭 링크).
