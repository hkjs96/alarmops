# 운영 DB 설정 (Supabase 운영 프로젝트)

이 문서는 파일럿 고객이 쓰는 **운영 데이터베이스**(Supabase, 서울)를 처음 만들고, 테이블을 올리고, 알람 엔진과 수집 Lambda가 쓸 **권한이 작은 DB 사용자 둘**을 만드는 순서다. 개발 DB 설정(`docs/SETUP-SUPABASE.md`)을 한 번 해 본 사람이 이어서 하도록 썼고, 처음이어도 따라 할 수 있게 값을 전부 적었다. 처음 한 번만 하면 된다. 1시간쯤 걸린다.

- Supabase 화면의 메뉴 이름은 자주 바뀐다. 아래 설명과 이름이 조금 달라도 **용도**가 같은 것을 고르면 된다.
- 비밀번호와 연결 주소는 채팅, 이슈, PR, 커밋 어디에도 붙여 넣지 않는다. 비밀번호 관리자, GitHub 환경 시크릿, AWS Secrets Manager, Vercel 환경변수 네 곳에만 둔다.
- 테이블은 항상 `prisma migrate`로만 만든다. 이 저장소에서 운영 DB에 닿는 길은 `prod-db` 워크플로 하나다. `prisma db push`와 seed는 운영 DB에서 쓰지 않는다(D-10).
- 운영 DB는 **개발과 다른 프로젝트**다. 개발 프로젝트의 비밀번호·주소·시크릿(`DEV_*`)을 여기에 쓰지 않는다.
- **2단계(Data API 끄기), 4단계의 3·4번(승인자, main만 허용), 6단계(권한 작은 사용자)는 건너뛸 수 없다.**
- 이 작업은 사람이 한다. 에이전트는 운영 DB 주소나 비밀번호를 보지 못하고, 보면 안 된다.

## 이 문서가 만드는 것

```
Supabase 운영 프로젝트(alarmops-prod)
  ├─ postgres (테이블 소유자)      ← 콘솔(Vercel)이 쓴다.  prod-db 워크플로도 이 사용자로 테이블을 만든다
  ├─ alarmops_engine (6단계)       ← 알람 엔진 Lambda 전용.  AWS 비밀 EngineDbSecret
  └─ alarmops_ingest (6단계)       ← 수집 Lambda 3개 전용.   AWS 비밀 IngestDbSecret
```

## 알아 둘 것: 왜 사용자를 나누고, RLS와는 어떻게 맞물리나

D-40은 `public`의 모든 테이블에 RLS(행 단위 보안)를 켜고 **정책은 하나도 두지 않으며**, 소유자만 RLS를 건너뛰게 한다. 그 결과:

| 접속하는 쪽 | 사용자 | RLS를 어떻게 지나가나 |
|---|---|---|
| 콘솔(Vercel, `packages/store-sql`) | 테이블 소유자 `postgres.<프로젝트ID>` | 소유자는 RLS를 건너뛴다(FORCE를 안 걸었으므로). 지금 이대로 동작한다 |
| 알람 엔진 Lambda | `alarmops_engine` | 소유자가 아니므로 그냥 두면 **모든 조회가 0행이고 쓰기는 `row-level security` 오류**다. 그래서 이 사용자에게 `BYPASSRLS`를 준다 |
| 수집 Lambda | `alarmops_ingest` | 위와 같다. `BYPASSRLS`를 준다 |
| Supabase `anon`·`authenticated` (Data API) | 마이그레이션이 권한을 거둠 | RLS가 켜져 있고 정책이 없어 0행. 그대로 둔다 |

`BYPASSRLS`는 **행 필터만 건너뛴다. 테이블 권한(GRANT)은 그대로 적용된다.** 두 사용자는 아래 표의 테이블에만 권한이 있고, 그 밖의 테이블은 `permission denied`다. 정책을 사용자별로 만드는 방법(`USING (true)`)도 따져 봤지만 아무것도 걸러 주지 못하고, D-40이 금지한 정책을 테이블마다 늘리며, CI 검사(`check-rls.mjs`)를 바꿔야 해서 택하지 않았다. 이 선택은 D-40 본문("정책 없음, FORCE 없음")을 그대로 둔다. D-40의 "역할을 나누면 이 결정을 다시 연다"는 문장은 D-56(11/18, 사용자 결정)으로 닫혔다: 소유자 외에 엔진용·수집용 사용자 두 개를 둔다.

## 두 사용자가 할 수 있는 일

권한은 `db/sql/roles.sql`에 있고, 코드가 실제로 보내는 SQL에서 뽑았다(`services/alarm-engine/src/alarm_engine/pg_repository.py`, `packages/store-sql/src/ingestRepo.ts`). `db/scripts/test-roles.mjs`가 CI의 db 작업에서 이 표대로인지, 그 밖의 테이블은 막혔는지 매번 확인한다.

**공통:** 시퀀스·함수 권한 없음, 스키마에 테이블 만들기 불가, `TRUNCATE`·`REFERENCES`·`TRIGGER` 없음, 슈퍼유저·`CREATEROLE`·`CREATEDB` 없음, 동시 접속 20개 제한, 비밀번호는 사람이 정한다.

### `alarmops_engine` (알람 엔진)

| 테이블 | 권한 | 이유 |
|---|---|---|
| `Customer`, `ThresholdDefault`, `RemediationPolicy` | 읽기 | 고객 상태, 기본 임계값, 조치 정책을 읽는다 |
| `CloudAccount` | 읽기, 일부 열만 쓰기 (`readerStatus`, `alarmWriterStatus`, `tagWriterStatus`, `remediatorStatus`, `lastCheckedAt`, `updatedAt`) | 역할 점검 결과만 기록한다. 역할 ARN·`externalId`는 못 바꾼다 |
| `Resource`, `ManagedAlarm` | 읽기, 추가, 수정은 upsert가 바꾸는 열만 (`id`·`customerId`·`cloudAccountId` 등 식별 열은 못 바꾼다). `ManagedAlarm`은 삭제도 | 발견한 리소스와 만든 알람을 upsert한다. 알람 삭제는 동기화가 한다 |
| `ThresholdChange` | 읽기, `applyStatus`·`error`만 수정 | 변경 이력은 추가만 되는 기록이다. 엔진은 적용 결과만 적는다 |
| `AlarmSyncRun` | 읽기, 추가, 수정은 `status`·`heartbeatAt`·`counts`·`error`·`finishedAt`만 | 동기화 실행 기록 |
| `RemediationRequest` | 읽기, 추가는 엔진이 쓰는 9개 열만(`decidedBy`·`decidedAt`·`decisionVia` 제외), `status`·`result`·`version`·`executedAt`만 수정 | 요청을 만들고 `EXECUTING`→`SUCCEEDED`/`FAILED`로 옮긴다. 승인 열은 못 쓴다: 승인은 사람이 Slack에서 하고 콘솔이 기록한다. 승인 열 없이 `APPROVED` 등으로 넣는 것은 테이블의 CHECK가 막는다. 남는 구멍(이미 사람이 결정한 행의 `status`를 `APPROVED`로 바꾸기)은 backend의 DB 트리거 후속 작업 대상이다 |
| `CustomerOffboarding` | 읽기, `steps`·`completedAt`만 수정 | `ALARMS_DELETED` 단계만(D-43) |

### `alarmops_ingest` (수집 Lambda 3개)

| 테이블 | 권한 | 이유 |
|---|---|---|
| `Customer` | `id`, `status` 열만 읽기 | 정지·해지 고객인지 본다 |
| `CloudAccount` | `id`, `customerId`, `awsAccountId` 열만 읽기 | 계정 번호로 고객을 찾는다. `externalId`·역할 ARN은 읽지 못한다 |
| `IntegrationSource` | 읽기, `lastReceivedAt`만 수정 | 토큰 해시로 출처를 찾고 마지막 수신 시각을 적는다 |
| `SeverityMapping`, `SuppressionPolicy`, `MaintenanceWindow` | 읽기 | 심각도 표, 억제 정책, 점검 창 |
| `IngestRejection` | 추가 | 거부한 요청을 기록한다 |
| `OffboardResidual` | 읽기, 추가, `firstAt`·`lastAt`·`count`만 수정 | 해지된 고객에게 계속 오는 이벤트를 센다 |
| `RawEvent` | 읽기, 추가, `decision`·`decisionReason`·`groupId`만 수정 | 받은 이벤트 원본을 저장하고(원본은 고치지 못한다) 판정을 적는다 |
| `Alert` | 읽기, 추가, 상태·값 열만 수정 (`fingerprint`·`customerId`·`id`는 못 바꾼다) | 알림 생성·갱신 |
| `AlertGroup` | 읽기, 추가, `status`·`closedAt`·`sweptReason`·`version`·`deliveredAt`만 수정 | 묶음 열기·닫기 |

두 사용자 모두 삭제 권한은 `ManagedAlarm`(엔진)뿐이다. 다른 모든 테이블(`User`, `Contact`, `Incident`, `NotificationJob` 등)은 읽지도 못한다.

## 1. 운영 Supabase 프로젝트 만들기

1. **어디서:** https://supabase.com, 회사 계정으로 로그인 후 새 프로젝트.
   **값:** 이름 `alarmops-prod`(운영임이 드러나게). 개발 프로젝트를 재사용하지 않는다.
   **확인:** 프로젝트 목록에 `alarmops-prod`가 따로 보인다.
2. **어디서:** 같은 화면의 리전.
   **값:** **Northeast Asia (Seoul)** (`ap-northeast-2`). 나중에 바꿀 수 없다.
   **확인:** 프로젝트 설정에서 리전이 서울이다.
3. **어디서:** 같은 화면의 데이터베이스 비밀번호.
   **값:** 자동 생성 버튼으로 만든다. 직접 지으면 `@`, `/`, `#` 같은 기호가 주소를 깨뜨린다. 만든 즉시 비밀번호 관리자에 저장한다. 이 화면을 떠나면 다시 볼 수 없다.
   **확인:** 비밀번호 관리자에 `alarmops-prod / postgres` 항목이 있다.
4. **어디서:** 프로젝트 설정 > Database의 정보.
   **값:** Postgres 버전 **15 이상**.
   **확인:** 15, 17 등으로 보인다. 14 이하면 멈추고 허브에 알린다(마이그레이션이 15 문법을 쓴다).
5. **어디서:** 조직 요금제와 백업 설정.
   **값:** 조직 요금제 **Pro**. **PITR(특정 시각으로 되돌리기)** 켜기: 먼저 컴퓨트 크기를 Small 이상으로 올려야 켤 수 있다(D-10).
   **확인:** 백업 화면에 PITR이 "켜짐"이다.
   > **주의** 파일럿 고객 데이터를 넣기 **전에** PITR을 켠다. 비용이 붙는다. 켜는 시점은 직접 정한다. 켜기 전에는 고객 데이터를 넣지 않는다.

## 2. 테이블을 만들기 전에: Data API 끄기 (필수)

1. **어디서:** 프로젝트 설정의 **API** 또는 **Data API** 항목.
   **값:** Data API를 끈다(Enable Data API 스위치를 끔). 스위치가 없으면 **Exposed schemas**에서 `public`을 뺀다. 저장한다.
   **확인:** 화면을 다시 열어도 꺼져 있다.
   > **주의** 켜 둔 채 3단계 이후를 하면 연락처 등 모든 테이블이 anon 키만으로 인터넷에 열린 채 만들어진다. 이유와 자세한 설명은 `docs/SETUP-SUPABASE.md` 5단계와 같다.
2. **어디서:** Supabase **SQL Editor**.
   **값:**
   ```sql
   select version();
   select to_regclass('public._prisma_migrations');
   select count(*) from pg_tables where schemaname = 'public';
   ```
   **확인:** 첫 줄 15 이상, 둘째 줄 비어 있음(NULL), 셋째 줄 `0`. 다르면 새 프로젝트가 아니다. **5단계를 실행하지 말고** 허브에 알린다.

## 3. 연결 주소 두 개 찾기

1. **어디서:** 프로젝트 화면 위쪽 **Connect**.
   **값:** `docs/SETUP-SUPABASE.md` 3단계와 같다.

   | 이름 | 고를 것 | 포트 | 끝에 붙일 것 |
   |---|---|---|---|
   | `DATABASE_URL` | 풀링 연결 > **Transaction** | 6543 | `?pgbouncer=true&connection_limit=1` |
   | `DIRECT_URL` | 풀링 연결 > **Session** | 5432 | 없음 |

   `[YOUR-PASSWORD]`(대괄호 포함)를 1단계 3번의 비밀번호로 바꾼다. 사용자 이름은 `postgres.<프로젝트ID>` 모양이다. `db.<프로젝트ID>.supabase.co` 주소는 IPv6 전용이라 GitHub Actions와 AWS에서 접속이 안 된다. 쓰지 않는다.
   **확인:** 두 주소를 비밀번호 관리자에 같이 저장했다. 호스트(`aws-0-ap-northeast-2.pooler.supabase.com` 형태)가 서울이다.

## 4. GitHub 환경과 시크릿 만들기

1. **어디서:** GitHub 저장소 **Settings > Environments > New environment**.
   **값:** 이름 `production-db` (글자 그대로. `dev`나 `production`을 재사용하지 않는다).
   **확인:** 환경 목록에 `production-db`가 있다.
2. **어디서:** `production-db` 화면의 **Environment secrets** > Add environment secret.
   **값:** 두 개를 넣는다. 이름은 글자 그대로.
   - `PROD_DATABASE_URL` : 3단계의 `DATABASE_URL`
   - `PROD_DIRECT_URL` : 3단계의 `DIRECT_URL`

   **확인:** 두 이름이 목록에 보인다(값은 보이지 않는다).
   > **주의** **저장소 시크릿(Repository secrets)이 아니라 환경 시크릿**에 넣는다. 저장소 시크릿에 두면 모든 워크플로가 읽을 수 있다.
3. **어디서:** 같은 화면의 **Required reviewers**.
   **값:** 켜고 저장소 소유자 본인을 넣는다. **(필수)**
   **확인:** 저장 후 다시 열어도 남아 있다.
4. **어디서:** 같은 화면의 **Deployment branches**.
   **값:** "선택한 브랜치만"으로 바꾸고 `main` 하나만 추가한다. **(필수)**
   **확인:** 저장 후 다시 열어도 `main` 하나만 있다.
   > **주의** 3·4번이 필수인 이유는 `docs/SETUP-SUPABASE.md` 4단계와 같다. 수동 실행은 시작한 브랜치의 워크플로 파일로 돈다. 브랜치 제한이 없으면 다른 브랜치가 이 시크릿을 읽어 갈 수 있다.
5. **어디서:** 같은 화면의 **Allow administrators to bypass configured protection rules**.
   **값:** **끈다.** (켜 두면 관리자는 승인 없이 실행할 수 있다.) 가능하면 승인자를 실행하는 사람과 다른 사람 1명 이상 더 넣고 **Prevent self-review**를 켠다.
   **확인:** 저장 후 다시 열어도 꺼져 있다.
   > **주의** 승인자가 본인 한 명뿐이면 `migrate-production` 입력은 **두 번째 통제가 아니다**(같은 사람이 입력하고 승인한다). 오타 방지 장치일 뿐이다. 그래서 승인 화면에서 승인하기 전에 **표시된 커밋 SHA**가 CI를 통과해 머지한 `main`의 커밋과 같은지 Actions 실행 화면과 `main` 커밋 목록으로 직접 비교한다. 다르면 승인하지 않고 거부한다.

## 5. 운영 DB에 테이블 만들기 (`prod-db` 워크플로)

시작하기 전에 확인한다. 하나라도 아니면 실행하지 않는다.

- [ ] 2단계: Data API가 꺼져 있다.
- [ ] 2단계: 새 프로젝트다(`_prisma_migrations` 없음, 테이블 0개).
- [ ] 4단계 3·4번: 승인자가 있고 배포 브랜치가 `main`뿐이다.
- [ ] 1단계 5번: PITR이 켜져 있다(고객 데이터를 넣기 전에는 필수는 아니지만, 이 시점에 켜 두는 것을 권한다).
- [ ] 실행할 `main`이 CI(`ci / db` 포함)를 통과한 커밋이다.

1. **어디서:** 저장소 **Actions** 탭 왼쪽 목록의 **prod-db** > **Run workflow**.
   **값:** 브랜치 `main`, 입력칸에 `migrate-production` 을 정확히 적고 **Run workflow**.
   **확인:** 실행 화면에 **Review deployments** 버튼이 뜬다. 바로 실행되기 시작하면 4단계 3번이 빠진 것이다. 취소하고 4단계로 돌아간다.
2. **어디서:** 실행 화면의 **Review deployments**.
   **값:** `production-db`를 체크하고 승인한다.
   **확인:** 작업이 시작된다.
3. **어디서:** 실행 로그(`Status before` 단계를 먼저 본다).
   **값:** "Following migrations have not yet been applied:" 아래에 `0001_init`부터 저장소의 마이그레이션 이름이 전부 나와야 한다.
   **확인:** 새 DB이므로 전부 "적용 안 됨"으로 나온다. 일부만 적용된 것으로 나오면 4번을 기다리지 말고 승인된 실행을 취소한다.
4. **어디서:** 로그의 `Apply migrations`, `Drift check`, `Status after` 단계와 실행 요약.
   **확인:** 초록 체크, 요약에 "Applied in this run"과 마이그레이션 이름 목록, 로그 끝에 `Database schema is up to date!`와 `Migrations match schema.prisma.`.

결과 읽는 법과 막혔을 때는 맨 아래 표를 본다.

## 6. 권한 작은 DB 사용자 두 개 만들기 (필수)

엔진과 수집 Lambda가 테이블 소유자(`postgres`)로 접속하면 둘 중 하나가 뚫렸을 때 모든 테이블이 열린다. 그래서 위 표의 권한만 가진 사용자 둘을 만든다. **5단계 뒤**에 한다(테이블이 있어야 권한을 줄 수 있다).

1. **어디서:** 저장소의 `db/sql/roles.sql`을 연다(GitHub에서 `main`의 파일을 열어 내용 전체를 복사해도 된다).
   **값:** 내용 전체를 복사한다.
   **확인:** `CREATE ROLE`, `GRANT`가 보이고 **비밀번호가 없다**.
2. **어디서:** Supabase **SQL Editor** > 새 쿼리. 접속 사용자는 기본값(`postgres`)이다.
   **값:** 복사한 내용을 붙여 넣고 **Run**.
   **확인:** `Success. No rows returned`. 오류가 나면 7번을 먼저 본다. 같은 파일을 다시 실행해도 안전하다(처음부터 다시 권한을 준다).
3. **어디서:** 회사 PC의 Git Bash.
   **값:** 비밀번호 두 개를 만든다. 기호가 없어 주소가 깨지지 않는다.
   ```
   openssl rand -hex 24
   openssl rand -hex 24
   ```
   **확인:** 48자 영문·숫자가 두 줄 나온다. 첫째는 엔진용, 둘째는 수집용으로 비밀번호 관리자에 저장한다(`alarmops_engine`, `alarmops_ingest`). 두 개는 서로 달라야 하고, 1단계의 `postgres` 비밀번호와도 달라야 한다.
4. **어디서:** 회사 PC의 Git Bash에서 `psql`로 운영 DB에 접속한다(권장: 비밀번호가 SQL 문장이나 편집기 기록에 남지 않는다. `psql`은 비밀번호를 내 PC에서 해시해 보낸다). `psql --version`이 나오지 않으면 PostgreSQL 클라이언트를 설치하거나 아래 대체 방법을 쓴다.
   **값:** 3단계의 `DIRECT_URL`에서 비밀번호를 뺀 주소로 접속하고(비밀번호는 물어볼 때 입력), 두 사용자의 비밀번호를 정한다. `\password`는 입력을 두 번 받고 화면에 보이지 않는다. 3번에서 만든 값을 붙여 넣는다.
   ```
   psql "postgresql://postgres.<프로젝트ID>@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require"
   \password alarmops_engine
   \password alarmops_ingest
   \q
   ```
   **확인:** 두 번 모두 오류 없이 프롬프트로 돌아온다. 이 명령에는 주소·비밀번호를 붙여 넣은 채팅이나 파일이 없어야 한다.
   **대체(psql이 없을 때만):** SQL Editor, 새 쿼리에서 `alter role alarmops_engine password '<엔진용 비밀번호>';`와 `alter role alarmops_ingest password '<수집용 비밀번호>';`를 실행하고, 실행 뒤 쿼리 **내용을 지우고** 저장·기록된 스니펫을 삭제한다.
   > **주의** 대체 방법은 평문 비밀번호가 Supabase의 쿼리 기록에 남을 수 있다. 쓴 뒤에는 6단계 3번처럼 비밀번호를 새로 만들어 `psql` 방법으로 다시 바꾼다. 어느 방법이든 저장소·채팅·이슈에 붙여 넣지 않는다.
5. **어디서:** SQL Editor.
   **값:**
   ```sql
   select rolname, rolcanlogin, rolsuper, rolbypassrls, rolconnlimit
   from pg_roles where rolname in ('alarmops_engine', 'alarmops_ingest');

   select grantee, count(*) as tables
   from information_schema.role_table_grants
   where grantee in ('alarmops_engine', 'alarmops_ingest') and table_schema = 'public'
   group by grantee;

   select r, has_schema_privilege(r, 'public', 'USAGE') as usage, has_schema_privilege(r, 'public', 'CREATE') as can_create
   from unnest(array['alarmops_engine', 'alarmops_ingest']) as r;
   ```
   **확인:** 마지막 질의에서 두 사용자 모두 `usage = t`, **`can_create = f`**(`public`에 테이블·함수를 만들 수 없다). `can_create`가 `t`면 멈추고 허브에 알린다. 첫 질의(역할 속성)는 두 사용자 모두 `rolcanlogin = t`, `rolsuper = f`, `rolbypassrls = t`, `rolconnlimit = 20`. 둘째 질의의 테이블 수는 엔진 10, 수집 9(수집의 `Customer`·`CloudAccount`는 열 단위 권한이라 이 표에 안 잡힌다).
6. **어디서:** 마이그레이션이 새 테이블이나 열을 더한 뒤.
   **값:** 그 테이블을 엔진 또는 수집이 쓰면 `db/sql/roles.sql`(과 `db/scripts/test-roles.mjs`)에 먼저 반영하는 PR을 머지하고, 위 2번을 다시 한다.
   **확인:** 새 테이블은 이 두 사용자에게 **자동으로 권한이 없다**(기본 권한을 주지 않았다). 반영하지 않으면 해당 Lambda가 `permission denied`로 실패한다.

> **주의** `rolbypassrls = t`가 안 되면(CREATE ROLE이 `BYPASSRLS`를 거부하는 경우) 멈추고 허브에 알린다. 이 사용자는 그 속성 없이는 모든 조회가 0행이다. 대안은 허브와 정한다.

## 7. 연결 주소를 어디에 넣나

| 어디에 | 값 | 사용자 | 포트 | 끝에 붙일 것 |
|---|---|---|---|---|
| Vercel(Production) `DATABASE_URL` | 3단계의 `DATABASE_URL` | `postgres.<프로젝트ID>`(소유자) | 6543 | `?pgbouncer=true&connection_limit=1` |
| Vercel(Production) `DATABASE_POOLER` | `transaction` | | | |
| AWS 비밀 `EngineDbSecretArn` | 아래 만드는 주소 | `alarmops_engine.<프로젝트ID>` | **5432** (Session pooler) | `?sslmode=require` |
| AWS 비밀 `IngestDbSecretArn` | 아래 만드는 주소 | `alarmops_ingest.<프로젝트ID>` | 6543 (Transaction pooler) | `?sslmode=require` |

풀러에 접속할 때 사용자 이름은 **`<사용자>.<프로젝트ID>`** 형태다(`alarmops_engine.abcdefghijklmnop`). 점 뒤 프로젝트 ID가 빠지면 풀러가 어느 프로젝트인지 몰라 거부한다.

엔진이 5432(Session)를 쓰는 이유: 엔진의 Python 드라이버(psycopg)는 같은 문장이 반복되면 서버 쪽 준비된 문장을 쓰는데, 트랜잭션 풀러(6543)는 이를 처리하지 못해 `prepared statement does not exist` 오류가 날 수 있다. 수집 쪽은 풀러 모드로 접속하도록 만들어져 있어(포트 6543이면 자동) 6543이 맞다. **엔진의 풀러 호환은 아직 검증하지 않았다**: 첫 실행에서 오류가 나면 허브에 알린다.

`sslmode=require`는 암호화만 하고 **서버 인증서를 검증하지 않는다**(엔진의 psycopg/libpq). 엔진 코드는 `require`·`verify-ca`·`verify-full`을 받아들이지만(`pg_repository.py`), `verify-full`에 필요한 CA 파일(`sslrootcert`)을 Lambda 묶음에 넣는 부분은 아직 없다. 그래서 지금은 `require`로 시작하고, `verify-full` 전환은 backend 후속 작업(CA 파일 묶기)이 끝난 뒤에 한다. Supabase CA 파일을 어디서 받는지는 확인 필요(Supabase 문서에서 직접 확인한 뒤 적는다).

1. **어디서:** AWS 콘솔(중앙 계정, SSO·MFA 로그인) > Secrets Manager > `EngineDbSecretArn` 비밀 > **Retrieve secret value** > **Edit** > **Plaintext**. (권장: 파일도 셸 기록도 남지 않는다.)
   **값:** 엔진용 한 줄을 붙여 넣는다. 줄바꿈 없이, 따옴표 없이, 비밀번호 관리자에서 복사한다.
   ```
   postgresql://alarmops_engine.<프로젝트ID>:<엔진용 비밀번호>@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=require
   ```
   호스트는 3단계에서 본 주소의 호스트 그대로 쓴다. 저장한다. 이어서 `IngestDbSecretArn` 비밀에는 수집용 한 줄을 같은 방식으로 넣는다(사용자 `alarmops_ingest.<프로젝트ID>`, 포트 `6543`).
   **확인:** 두 비밀 모두 새 버전이 생겼고, 값에 `[YOUR-PASSWORD]`나 `<`가 남아 있지 않다. 엔진 비밀에 수집용 주소(또는 반대)를 넣지 않았는지 사용자 이름을 다시 읽는다. `docs/GO-LIVE.md` 4단계 9번과 같은 작업이다.
2. **어디서(콘솔을 쓸 수 없을 때만):** 본인 터미널(SSO·MFA로 로그인한 중앙 계정 세션. 에이전트가 쓰는 세션이 아니다).
   **값:** 주소를 임시 파일에 한 줄로 저장해 `file://`로 준다. 파일은 **OneDrive·바탕화면·문서처럼 동기화되는 폴더에 두지 않는다**. 동기화되지 않는 임시 폴더(예: `C:/Temp/<무작위 이름>/`)를 쓴다.
   ```
   aws secretsmanager put-secret-value --region ap-northeast-2 --secret-id <EngineDbSecretArn 값> --secret-string file://C:/Temp/<무작위 이름>/engine.txt
   aws secretsmanager put-secret-value --region ap-northeast-2 --secret-id <IngestDbSecretArn 값> --secret-string file://C:/Temp/<무작위 이름>/ingest.txt
   ```
   **확인:** 두 번 모두 `VersionId`가 출력된다. 그 즉시 파일과 폴더를 **삭제**하고 휴지통도 비운다.
   > **주의** `--secret-string`에 주소를 직접 쓰지 않는다. 직접 쓰면 셸 기록에 비밀번호가 남는다.
3. **어디서:** Vercel 프로젝트 > Settings > Environment Variables (Production).
   **값:** `DATABASE_URL`에 3단계의 `DATABASE_URL`(소유자, 6543, `?pgbouncer=true&connection_limit=1`), `DATABASE_POOLER`에 `transaction`. 나머지 변수는 `docs/GO-LIVE.md` 3단계 표를 따른다.
   **확인:** 변수 목록에 두 이름이 Production 범위로 있다.
   > **주의** 콘솔에는 `alarmops_engine`·`alarmops_ingest` 주소를 넣지 않는다. 콘솔은 사용자·연락처·인시던트 등 모든 테이블을 읽고 써야 해서 소유자로 접속한다. 소유자가 아니면 BYPASSRLS가 있어도 이 권한 목록 밖의 테이블에서 `permission denied`가 난다.

## 8. 잘 됐는지 확인

1. **어디서:** 실행한 `prod-db` 요약.
   **확인:** 마이그레이션 전체가 적용됐고 `Database schema is up to date!`.
2. **어디서:** SQL Editor.
   **값:**
   ```sql
   select count(*) from pg_tables where schemaname = 'public' and not rowsecurity;
   ```
   **확인:** `0`(모든 테이블에 RLS가 켜져 있다, D-40).
3. **어디서:** 회사 PC의 Git Bash. **anon** 키만 쓴다(`service_role` 키는 쓰지 않는다). 방법과 판정은 `docs/SETUP-SUPABASE.md`의 "첫 실행 뒤 확인: anon 키로는 읽히지 않는다"와 같다.
   **확인:** 마지막 줄이 `200`이 **아니다**. 200이면 2단계를 다시 하고 고객 데이터를 넣지 않은 채 허브에 알린다.
4. **어디서:** AWS 중앙 계정 배포(`deploy-central`) 뒤, 콘솔에서 만든 수집 토큰으로 시험 이벤트를 한 번 보낸다(`services/ingest/README.md`).
   **확인:** Supabase **Table Editor** 또는 SQL Editor에서 `select count(*) from "RawEvent";`가 1 이상. Lambda 로그에 `permission denied`(`42501`)가 없다. 있으면 6단계의 표와 `roles.sql`이 어긋난 것이니 허브에 알린다.
5. **어디서:** 같은 시험의 엔진 쪽(계정 동기화 한 번).
   **확인:** `select status from "AlarmSyncRun" order by "startedAt" desc limit 1;`에 `SUCCEEDED` 또는 `PARTIAL`. 엔진 Lambda 로그에 `permission denied`와 `prepared statement`가 없다.

## 9. 비밀번호 바꾸기

- **`postgres`(소유자):** 노출됐거나 담당자가 바뀌면 Supabase 프로젝트 설정 Database의 **Reset database password**로 새로 만들고, GitHub `production-db` 환경 시크릿 두 개와 Vercel `DATABASE_URL`을 새 주소로 덮어쓴다. 확인: `prod-db`를 한 번 실행해 "already up to date".
- **`alarmops_engine`·`alarmops_ingest`:** 6단계 3·4번으로 새 비밀번호를 만들어 `alter role`을 실행하고, 7단계 1·2번으로 해당 AWS 비밀을 덮어쓴다. 다음 콜드 스타트부터 새 값을 쓴다. 한 번에 한 사용자만 바꾸고 8단계 4·5번으로 확인한다.

## 막혔을 때

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| `prod-db` 실행 화면에 승인 버튼 없이 바로 시작됨 | `production-db` 환경에 필수 승인자가 없다 | 실행 취소, 4단계 3번 |
| `prod-db`가 시작하자마자 "Environment ... branch is not allowed" 또는 건너뛰어짐 | `main`이 아닌 브랜치에서 실행했다 | 브랜치를 `main`으로 하고 다시 실행 |
| `Nothing was changed. To run this, type exactly: migrate-production` | 입력칸이 틀렸다. DB는 그대로다 | 다시 실행 |
| `Missing secret PROD_… in the GitHub environment 'production-db'` | 환경 시크릿이 없다(저장소 시크릿에 넣었을 수도 있다). DB에는 접속하지 않았다 | 4단계 2번 |
| `PROD_… is not a valid connection string` 또는 `[YOUR-PASSWORD] placeholder` | 값이 주소 모양이 아니다(공백·줄바꿈, 일부만 복사, 비밀번호 자리 미교체) | 3단계대로 다시 만들어 시크릿을 새로 저장 |
| `Could not read the migration status ...`, `P1000`, `P1001` | DB에 접속하지 못했다 | `PROD_DIRECT_URL`(Session, 5432)과 비밀번호 확인, 시크릿 다시 저장 |
| `The production database has a failed migration, or a migration history that differs` | 누군가 먼저 손댔거나 이전 실행이 중간에 멈췄다 | **다시 실행하지 말고** 로그의 상태 부분을 허브에 전달 |
| `Apply migrations` 단계에서 실패 | 마이그레이션 SQL이 실패했다. 실패한 파일 이전 것은 적용돼 있다 | 다시 실행하지 말고 로그를 허브에 전달 |
| `Drift check` 실패, 목록에 테이블·열이 나옴 | 운영 DB가 `schema.prisma`와 다르다(손으로 바꾼 흔적, 또는 Supabase가 `public`에 더한 것) | 목록을 허브에 전달. 임의로 고치지 않는다 |
| 노란 경고에 포트나 `pgbouncer` | 두 주소가 뒤바뀌었거나 꼬리표가 빠졌다 | 3단계 |
| 6단계 2번에서 `permission denied to create role` 또는 `BYPASSRLS` 관련 오류 | SQL Editor의 사용자가 `postgres`가 아니거나 호스트가 거부했다 | 사용자를 `postgres`로 확인. 그래도 안 되면 멈추고 허브에 알린다 |
| 6단계 2번에서 `relation "…" does not exist` | 5단계가 끝나지 않았다 | 5단계 결과 확인 |
| Lambda 로그의 `permission denied for table …`(42501) | 그 사용자의 권한 목록에 없는 테이블·열을 코드가 쓴다 | 허브에 알린다(`roles.sql`·`test-roles.mjs`와 코드를 함께 고친다). 임의로 `GRANT`하지 않는다 |
| 수집·엔진 로그에 오류 없이 조회가 0건 | 사용자의 `BYPASSRLS`가 꺼졌다 | 6단계 5번으로 확인하고 `roles.sql`을 다시 실행 |
| `password authentication failed for user "alarmops_…"` | 6단계 4번을 안 했거나, 주소의 비밀번호가 다르다 | 6단계 4번, 7단계 1·2번 |
| `Tenant or user not found` | 풀러 사용자 이름에 `.프로젝트ID`가 빠졌다 | 7단계 표대로 `<사용자>.<프로젝트ID>` |
| 엔진 로그에 `prepared statement ... does not exist` | 엔진이 6543(Transaction)에 붙었다 | 엔진 비밀의 포트를 5432로 |
| 엔진을 `sslmode=verify-full`로 바꾸고 싶다 | 코드는 받지만 CA 파일(`sslrootcert`)을 묶는 부분이 없고 Supabase CA의 출처도 **확인 필요** | backend 후속 작업 전에는 `require`를 유지하고 허브에 알린다 |
| Lambda가 시작하지 않고 `sslmode` 언급 | 주소 끝에 `?sslmode=require`가 없다 | 7단계 1번 |
| 수집 Lambda가 `self-signed certificate` 류의 TLS 오류 | Node가 Supabase 인증서 체인을 믿지 못한다 | 허브에 알린다(`sslrootcert`를 번들에 넣는 방법이 있다, `docs/GO-LIVE.md` 4단계 9번) |
