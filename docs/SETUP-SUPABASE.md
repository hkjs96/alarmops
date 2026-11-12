# Supabase 개발 DB 설정

개발용 데이터베이스(Supabase, 서울)를 만들고, GitHub가 그 DB에 테이블을 만들 수 있게 연결하는 순서다. 처음 한 번만 하면 된다. 30분쯤 걸린다.

- Supabase 화면의 메뉴 이름은 자주 바뀐다. 아래 설명과 이름이 조금 달라도 **용도**가 같은 것을 고르면 된다.
- 비밀번호와 연결 주소는 채팅, 이슈, PR, 커밋 어디에도 붙여 넣지 않는다. 비밀번호 관리자, GitHub 시크릿, 회사 PC의 `.env` 세 곳에만 둔다.
- 테이블은 항상 `prisma migrate`로만 만든다. `prisma db push`는 쓰지 않는다(D-10).
- **5단계(Data API 끄기)와 4단계의 3·4번(승인자, main만 허용)은 건너뛸 수 없다.** 이 둘을 하기 전에는 6단계(테이블 만들기)를 실행하지 않는다.

## 1. Supabase 프로젝트 만들기

1. https://supabase.com 에 회사 계정으로 로그인하고 새 프로젝트를 만든다.
2. 이름은 `alarmops-dev`처럼 개발용임이 드러나게 짓는다.
3. 리전은 **Northeast Asia (Seoul)**, 코드로는 `ap-northeast-2`를 고른다. 리전은 나중에 바꿀 수 없다.
4. 데이터베이스 비밀번호는 화면의 자동 생성 버튼으로 만든다. 직접 지으면 `@`, `/`, `#` 같은 기호 때문에 주소가 깨질 수 있다.
5. 만든 비밀번호를 **바로** 비밀번호 관리자에 저장한다. 이 화면을 떠나면 다시 볼 수 없고, 잊으면 8단계처럼 새로 만들어야 한다.
6. 프로젝트가 준비될 때까지 1~2분 기다린다.
7. 프로젝트 설정의 데이터베이스 정보에서 Postgres 버전이 **15 이상**인지 확인한다. 새 프로젝트는 보통 15 또는 17이다.

## 2. 요금제와 백업 확인 (D-10)

- [ ] 조직 요금제가 **Pro**다. 무료 요금제는 한동안 쓰지 않으면 프로젝트가 멈춘다.
- [ ] 백업 설정에서 **PITR(Point in Time Recovery, 특정 시각으로 되돌리기)** 을 켤 수 있는지 본다. PITR은 Pro의 유료 추가 기능이고, 먼저 컴퓨트 크기를 Small 이상으로 올려야 켤 수 있다.
- [ ] 개발 프로젝트는 PITR 없이 하루 한 번 자동 백업만으로 시작해도 된다. **파일럿 고객 데이터가 들어가는 운영 프로젝트는 PITR을 켠 뒤에 연다.** 비용이 붙으므로 켜는 시점은 직접 정한다.

## 3. 연결 주소 두 개 찾기

프로젝트 화면 위쪽의 **Connect** 버튼(또는 프로젝트 설정의 Database)을 누르면 연결 주소가 여러 개 나온다. 그중 두 개가 필요하다.

| 우리가 부르는 이름 | 용도 | Supabase에서 고를 것 | 포트 |
|---|---|---|---|
| `DATABASE_URL` | 앱이 평소에 쓰는 연결. 짧은 연결을 많이 받는다 | 풀링 연결 중 **Transaction** 방식 (Transaction pooler) | 6543 |
| `DIRECT_URL` | 테이블을 만들고 바꾸는 작업(마이그레이션) 전용 | 풀링 연결 중 **Session** 방식 (Session pooler) | 5432 |

1. 두 주소를 각각 복사한다. 모양은 `postgresql://postgres.<프로젝트ID>:[YOUR-PASSWORD]@aws-0-ap-northeast-2.pooler.supabase.com:<포트>/postgres`와 비슷하다.
2. 두 주소의 `[YOUR-PASSWORD]` 자리(대괄호 포함)를 1단계의 비밀번호로 바꾼다.
3. `DATABASE_URL`(포트 6543) 끝에 아래를 붙인다. Prisma가 풀링 연결에서 동작하려면 꼭 필요하다.
   ```
   ?pgbouncer=true&connection_limit=1
   ```
   주소에 이미 `?`가 있으면 `?` 대신 `&`로 이어 붙인다.
4. `DIRECT_URL`(포트 5432)에는 아무것도 붙이지 않는다.
5. 완성한 두 주소를 비밀번호 관리자에 같이 저장한다.

참고: "Direct connection"이라고 적힌 주소(`db.<프로젝트ID>.supabase.co`)도 포트가 5432지만 IPv6 전용이라 GitHub Actions에서는 접속이 안 된다. `DIRECT_URL`에는 Session 방식 주소를 쓴다.

## 4. GitHub에 환경과 시크릿 만들기

1. GitHub 저장소에서 **Settings > Environments > New environment**를 누르고 이름을 정확히 `dev`로 만든다.
2. `dev` 환경 화면의 **Environment secrets**에서 **Add environment secret**으로 두 개를 넣는다. 이름은 글자 그대로여야 한다.
   - `DEV_DATABASE_URL` : 3단계의 `DATABASE_URL` (포트 6543, 끝에 `?pgbouncer=true&connection_limit=1`)
   - `DEV_DIRECT_URL` : 3단계의 `DIRECT_URL` (포트 5432)
3. **(필수)** 같은 화면의 **Required reviewers**(필수 승인자)를 켜고 저장소 소유자 본인을 넣는다. 그러면 DB를 바꾸는 작업이 매번 본인이 승인 버튼을 누를 때까지 기다린다. `db/prisma/` 변경이 main에 머지되면 이 작업이 자동으로 시작되므로, 승인 단계가 있어야 모르는 사이에 DB가 바뀌지 않는다.
4. **(필수)** 같은 화면의 **Deployment branches**(배포 가능한 브랜치)를 "선택한 브랜치만"으로 바꾸고 `main` 하나만 추가한다.
5. 저장하고 화면을 다시 열어 두 설정이 남아 있는지 확인한다.

3·4번이 필수인 이유: dev-db 작업은 수동으로 시작할 때 **시작한 브랜치에 있는 워크플로 파일**로 돈다. 브랜치 제한이 없으면, 저장소에 쓸 수 있는 사람이나 에이전트가 자기 브랜치에서 그 파일을 고쳐 실행해 위 두 시크릿(DB 주소와 비밀번호)을 읽어 낼 수 있다. `main`만 허용하면 리뷰를 거쳐 머지된 파일만 시크릿을 받고, 승인자를 두면 그마저도 본인이 누를 때만 실행된다.

## 5. 테이블을 만들기 전에: Data API 끄기 (필수)

Supabase는 프로젝트마다 **Data API**(데이터베이스를 인터넷 주소로 바로 읽고 쓰게 해 주는 기능, PostgREST라고도 부른다)를 기본으로 켜 둔다. 6단계 **전에** 반드시 끈다.

왜 필요한가:

- Data API가 켜져 있으면 `public` 스키마의 테이블은 **anon 키**만으로 인터넷에서 읽고 쓸 수 있다. 막아 주는 것은 테이블마다 거는 RLS(행 단위 보안) 정책뿐인데, 우리 테이블에는 아직 RLS가 없다.
- anon 키는 비밀값이 아니다. 원래 웹 페이지에 넣어 공개하라고 만든 키라서, 프로젝트 주소만 알면 누구나 쓸 수 있다고 봐야 한다.
- 즉 Data API를 켠 채 6단계를 실행하면 연락처(`Contact`), 인시던트 등 모든 테이블이 인터넷에 열린 채로 만들어진다.
- AlarmOps 콘솔과 백엔드는 Prisma로 데이터베이스에 직접 접속한다(3단계의 두 주소). Data API는 쓰지 않으므로 꺼도 아무것도 멈추지 않는다.

순서:

1. Supabase 프로젝트 설정에서 **API** 또는 **Data API** 항목을 연다. 메뉴 이름은 다를 수 있다. "Data API", "PostgREST", "Exposed schemas(노출 스키마)"라는 말이 있는 화면이다.
2. **Data API를 끈다**(Enable Data API 같은 스위치를 끔으로). 저장한다.
3. 끄는 스위치가 없으면, 같은 화면의 **노출 스키마(Exposed schemas)** 목록에서 `public`을 **뺀다**. 목록이 비어도 된다. 저장한다.
4. 같은 화면을 다시 열어 설정이 남아 있는지 확인한다.
5. Postgres 버전을 한 번 더 확인한다. Supabase의 **SQL Editor**(SQL 편집기)에서 아래를 실행해 **15 이상**인지 본다. 14 이하면 6단계가 실패한다(15부터 있는 문법을 쓴다). 이 경우 멈추고 허브에 알린다.
   ```sql
   select version();
   ```
6. 새 프로젝트가 맞는지(이전에 마이그레이션이 적용된 적이 없는지) 확인한다. 같은 SQL Editor에서 아래 두 줄을 실행한다.
   ```sql
   select to_regclass('public._prisma_migrations');
   select count(*) from pg_tables where schemaname = 'public';
   ```
   - 첫 줄 결과가 **비어 있고(NULL)** 둘째 줄이 **0**이면 새 프로젝트다. 6단계로 간다.
   - 첫 줄에 `_prisma_migrations`가 나오면 이미 누군가 마이그레이션을 적용한 DB다. `select migration_name, finished_at from _prisma_migrations;`의 결과가 0행일 때만 계속한다. 1행이라도 있으면 **6단계를 실행하지 말고** 결과를 허브에 전달한다(`db/README.md` 마지막 항목).
   - 둘째 줄이 0이 아니면 `public`에 우리가 만들지 않은 테이블이 있다. 멈추고 허브에 알린다.

알아 둘 것:

- 지금 이 저장소의 첫 마이그레이션(`0001_init`)에는 anon 권한을 거두는 문장이 **없다**. 그래서 현재 방어선은 이 단계(Data API 끄기) 하나뿐이다.
- `feat/sql-adapter` 브랜치의 마이그레이션은 여기에 더해 `anon`·`authenticated` 역할의 테이블 권한을 거둔다(REVOKE). 그 브랜치가 머지되면 방어선이 두 겹이 된다. 그래도 Data API는 계속 꺼 둔다.
- RLS를 켤지는 아직 정하지 않았다(이슈 #10에서 결정 대기). 정해지기 전까지 Data API를 다시 켜지 않는다. 나중에 Supabase의 다른 기능 때문에 켜야 한다면 먼저 허브에 묻는다.

## 6. 개발 DB에 테이블 만들기 (dev-db 워크플로)

시작하기 전에 확인한다. 하나라도 아니면 실행하지 않는다.

- [ ] 4단계 3·4번: `dev` 환경에 필수 승인자(본인)가 있고, 배포 가능한 브랜치가 `main`뿐이다.
- [ ] 5단계: Data API가 꺼져 있다(또는 노출 스키마에 `public`이 없다).
- [ ] 5단계: Postgres 15 이상이고, `_prisma_migrations`가 없거나 비어 있다.

1. 저장소의 **Actions** 탭 왼쪽 목록에서 **dev-db**를 고른다.
2. 오른쪽 **Run workflow**를 누르고, 브랜치는 `main`, 입력칸에 `migrate`라고 적은 뒤 초록색 **Run workflow** 버튼을 누른다.
3. 실행 화면에 **Review deployments** 버튼이 뜬다. `dev`를 체크하고 승인한다. 이 버튼이 뜨지 않고 바로 실행된다면 4단계 3번이 빠진 것이다. 실행을 취소하고 4단계로 돌아간다.
4. 1~2분 뒤 결과를 본다.

결과 읽는 법:

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| 초록 체크. 요약에 "Applied in this run"과 마이그레이션 이름 목록 | 성공. 개발 DB가 저장소의 스키마와 같아졌다 | 없음 |
| 초록 체크. "(none, already up to date)" | 성공. 새로 적용할 것이 없었다 | 없음 |
| 빨간 X, `Nothing was changed. To run this, type exactly: migrate` | 입력칸에 `migrate`를 정확히 적지 않았다. DB는 그대로다 | 다시 실행 |
| 빨간 X, `Missing secret DEV_… in the GitHub environment 'dev'` | 메시지에 나온 이름의 시크릿이 없다. DB에는 접속하지 않았다 | 4단계 2번 |
| 빨간 X, `DEV_… is not a valid connection string` 또는 `still has the [YOUR-PASSWORD] placeholder` | 시크릿 값이 연결 주소 모양이 아니다(공백·줄바꿈이 끼었거나, 일부만 복사했거나, 비밀번호 자리를 안 바꿨다). DB에는 접속하지 않았다 | 3단계대로 주소를 다시 만들어 시크릿을 새로 저장 |
| 빨간 X, `Could not read the migration status …` 또는 `P1000`, `P1001` | DB에 접속하지 못했다. 주소나 비밀번호가 틀렸다 | 3단계를 다시 하고 시크릿을 새로 저장 |
| 빨간 X, "Apply migrations" 단계에서 실패 | 마이그레이션 SQL이 실패했다. 실패한 지점 이후는 적용되지 않았다 | 다시 실행하지 말고 로그의 해당 단계 내용을 허브에 전달 |
| 노란 경고(Annotations)에 포트나 `pgbouncer` 언급 | 두 주소가 뒤바뀌었거나 꼬리표가 빠졌다 | 3단계 3번 확인 |

로그에는 주소와 비밀번호가 `***`로 가려져 나온다. 가려지지 않은 주소가 보이면 8단계대로 비밀번호를 바꾸고 허브에 알린다.

주의: 이 저장소를 받기 전에 손으로 만든 개발 DB에 이미 `0001_init`이 들어 있다면 이 워크플로를 돌리기 전에 `db/README.md`의 마지막 항목을 먼저 본다. 5단계 6번에서 새 프로젝트임을 확인했다면 해당 없다.

### 첫 실행 뒤 확인: anon 키로는 읽히지 않는다 (필수)

처음 초록 체크가 나온 직후 한 번 한다. Data API를 정말 껐는지 밖에서 두드려 보는 것이다.

1. Supabase 프로젝트 설정의 API 키 화면에서 **anon**(또는 "publishable", 공개용) 키를 복사한다. `service_role`(또는 "secret") 키는 쓰지 않는다. 복사하지도 않는다.
2. 회사 PC의 Git Bash에서 아래 한 줄을 실행한다. `<프로젝트ID>`와 `<anon 키>` 두 곳(키는 두 번)을 바꿔 넣는다. 키를 넣은 명령은 채팅·이슈에 붙여 넣지 않는다.
   ```
   curl -s -w "\n%{http_code}\n" "https://<프로젝트ID>.supabase.co/rest/v1/Contact?select=id&limit=1" -H "apikey: <anon 키>" -H "Authorization: Bearer <anon 키>"
   ```
3. 마지막 줄의 숫자를 본다.

| 마지막 줄 | 뜻 | 할 일 |
|---|---|---|
| `200` (그 위에 `[]` 또는 `[{"id":…}]`) | **열려 있다.** `[]`처럼 비어 있어도 읽힌 것이다 | 5단계 2·3번을 다시 하고 이 확인을 반복한다. 그래도 200이면 허브에 바로 알린다. 그때까지 실제 연락처·고객 데이터를 넣지 않는다 |
| `200`이 아닌 숫자 (`401`, `403`, `404` 등)와 오류 문구 | 거부됐다. 정상 | 숫자와 날짜를 PR이나 이슈에 한 줄로 남긴다(키는 빼고) |
| 숫자 없이 접속 오류 | 프로젝트 ID가 틀렸거나 네트워크 문제 | 주소를 확인하고 다시 실행 |

거부될 때의 숫자와 문구는 Supabase 버전에 따라 다르다. 기준은 하나다: **200이면 안 된다.**

## 7. 회사 PC의 `.env`에 같은 값 넣기 (나중에)

1. 저장소 루트의 `.env.example`을 복사해 `.env`를 만든다. Git Bash에서: `cp .env.example .env`
2. `.env`를 메모장이나 VS Code로 열어 두 줄을 비밀번호 관리자에 저장해 둔 값으로 바꾼다.
   ```
   DATABASE_URL=<3단계의 DATABASE_URL>
   DIRECT_URL=<3단계의 DIRECT_URL>
   ```
3. 나머지 키(`SESSION_SECRET`, `CONSOLE_ORIGIN`, `TRUSTED_PROXY`, `MOCK_API` 등)는 `.env.example`의 설명대로 채운다. 화면만 볼 때는 `MOCK_API=1`이면 DB 없이도 콘솔이 뜬다.
4. `.env`는 커밋되지 않게 이미 막혀 있다(`.gitignore`). 에이전트는 `.env`를 읽지 못한다. 값은 직접 넣는다.

## 8. 비밀번호 바꾸기

비밀번호가 채팅·로그·화면 공유에 노출됐거나, 담당자가 바뀌었을 때 한다.

1. Supabase 프로젝트 설정의 Database에서 **Reset database password**(데이터베이스 비밀번호 재설정)를 누르고 새 비밀번호를 자동 생성한다. 이 순간부터 옛 비밀번호로는 접속이 안 된다.
2. 새 비밀번호를 비밀번호 관리자에 저장하고, 저장해 둔 두 주소의 비밀번호 부분을 새 값으로 바꾼다.
3. GitHub **Settings > Environments > dev**에서 `DEV_DATABASE_URL`, `DEV_DIRECT_URL` 두 시크릿을 새 주소로 덮어쓴다(연필 아이콘).
4. 회사 PC `.env`의 `DATABASE_URL`, `DIRECT_URL`을 같은 값으로 바꾼다.
5. 나중에 Vercel 등 다른 곳에도 이 값을 넣게 되면 그곳도 같이 바꾼다.
6. 확인: 6단계대로 **dev-db**를 한 번 실행해 초록 체크("already up to date")가 나오면 끝이다.

## 9. main 브랜치 보호 (권장)

테스트가 통과하지 않은 변경이 main에 들어가지 않게 한다. 저장소 관리자만 설정할 수 있다.

1. **Settings > Branches**(또는 Rules > Rulesets)에서 `main`에 대한 규칙을 만든다.
2. **Require a pull request before merging**을 켠다. main 직접 푸시가 막힌다.
3. **Require status checks to pass**를 켜고 아래 세 개를 필수로 추가한다. PR 화면에는 `ci / test`, `ci / e2e`, `ci / db`로 보이고, 검색창에서는 `test`, `e2e`, `db`로 찾는다. 이 목록에는 한 번이라도 실행된 검사만 나오므로, 워크플로가 든 PR을 먼저 하나 올린 뒤에 설정한다.
   - `ci / test` : 타입 검사, 린트, 단위 테스트, 콘솔 빌드
   - `ci / e2e` : 브라우저로 화면을 실제로 눌러 보는 테스트(가짜 데이터)
   - `ci / db` : 실제 Postgres 16에 마이그레이션을 적용해 보고, 스키마 파일과 맞는지 확인
4. `dev-db`는 필수 검사에 넣지 않는다. PR에서는 돌지 않는다.
