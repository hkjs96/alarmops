# Supabase 개발 DB 설정

개발용 데이터베이스(Supabase, 서울)를 만들고, GitHub가 그 DB에 테이블을 만들 수 있게 연결하는 순서다. 처음 한 번만 하면 된다. 30분쯤 걸린다.

- Supabase 화면의 메뉴 이름은 자주 바뀐다. 아래 설명과 이름이 조금 달라도 **용도**가 같은 것을 고르면 된다.
- 비밀번호와 연결 주소는 채팅, 이슈, PR, 커밋 어디에도 붙여 넣지 않는다. 비밀번호 관리자, GitHub 시크릿, 회사 PC의 `.env` 세 곳에만 둔다.
- 테이블은 항상 `prisma migrate`로만 만든다. `prisma db push`는 쓰지 않는다(D-10).

## 1. Supabase 프로젝트 만들기

1. https://supabase.com 에 회사 계정으로 로그인하고 새 프로젝트를 만든다.
2. 이름은 `alarmops-dev`처럼 개발용임이 드러나게 짓는다.
3. 리전은 **Northeast Asia (Seoul)**, 코드로는 `ap-northeast-2`를 고른다. 리전은 나중에 바꿀 수 없다.
4. 데이터베이스 비밀번호는 화면의 자동 생성 버튼으로 만든다. 직접 지으면 `@`, `/`, `#` 같은 기호 때문에 주소가 깨질 수 있다.
5. 만든 비밀번호를 **바로** 비밀번호 관리자에 저장한다. 이 화면을 떠나면 다시 볼 수 없고, 잊으면 7단계처럼 새로 만들어야 한다.
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
3. (선택, 권장) 같은 화면의 **Required reviewers**에 본인을 넣는다. 그러면 DB를 바꾸는 작업이 매번 승인 버튼을 누를 때까지 기다린다. `db/prisma/` 변경이 main에 머지되면 이 작업이 자동으로 시작되므로, 승인 단계를 두면 모르는 사이에 DB가 바뀌는 일이 없다.
4. (선택) **Deployment branches**를 `main`만 허용으로 바꾼다. 다른 브랜치에서는 개발 DB를 건드릴 수 없게 된다.

## 5. 개발 DB에 테이블 만들기 (dev-db 워크플로)

1. 저장소의 **Actions** 탭 왼쪽 목록에서 **dev-db**를 고른다.
2. 오른쪽 **Run workflow**를 누르고, 브랜치는 `main`, 입력칸에 `migrate`라고 적은 뒤 초록색 **Run workflow** 버튼을 누른다.
3. 4단계에서 승인자를 넣었다면 실행 화면에 **Review deployments** 버튼이 뜬다. `dev`를 체크하고 승인한다.
4. 1~2분 뒤 결과를 본다.

결과 읽는 법:

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| 초록 체크. 요약에 "Applied in this run"과 마이그레이션 이름 목록 | 성공. 개발 DB가 저장소의 스키마와 같아졌다 | 없음 |
| 초록 체크. "(none, already up to date)" | 성공. 새로 적용할 것이 없었다 | 없음 |
| 빨간 X, `Nothing was changed. To run this, type exactly: migrate` | 입력칸에 `migrate`를 정확히 적지 않았다. DB는 그대로다 | 다시 실행 |
| 빨간 X, `Missing secret(s) in the GitHub environment 'dev': …` | 메시지에 나온 이름의 시크릿이 없다 | 4단계 2번 |
| 빨간 X, `Could not read the migration status …` 또는 `P1000`, `P1001` | DB에 접속하지 못했다. 주소나 비밀번호가 틀렸다 | 3단계를 다시 하고 시크릿을 새로 저장 |
| 빨간 X, "Apply migrations" 단계에서 실패 | 마이그레이션 SQL이 실패했다. 실패한 지점 이후는 적용되지 않았다 | 다시 실행하지 말고 로그의 해당 단계 내용을 허브에 전달 |
| 노란 경고(Annotations)에 포트나 `pgbouncer` 언급 | 두 주소가 뒤바뀌었거나 꼬리표가 빠졌다 | 3단계 3번 확인 |

로그에는 주소와 비밀번호가 `***`로 가려져 나온다. 가려지지 않은 주소가 보이면 7단계대로 비밀번호를 바꾸고 허브에 알린다.

주의: 이 저장소를 받기 전에 손으로 만든 개발 DB에 이미 `0001_init`이 들어 있다면 이 워크플로를 돌리기 전에 `db/README.md`의 마지막 항목을 먼저 본다. 1단계에서 새로 만든 프로젝트는 해당 없다.

## 6. 회사 PC의 `.env`에 같은 값 넣기 (나중에)

1. 저장소 루트의 `.env.example`을 복사해 `.env`를 만든다. Git Bash에서: `cp .env.example .env`
2. `.env`를 메모장이나 VS Code로 열어 두 줄을 비밀번호 관리자에 저장해 둔 값으로 바꾼다.
   ```
   DATABASE_URL=<3단계의 DATABASE_URL>
   DIRECT_URL=<3단계의 DIRECT_URL>
   ```
3. 나머지 키(`SESSION_SECRET`, `CONSOLE_ORIGIN`, `TRUSTED_PROXY`, `MOCK_API` 등)는 `.env.example`의 설명대로 채운다. 화면만 볼 때는 `MOCK_API=1`이면 DB 없이도 콘솔이 뜬다.
4. `.env`는 커밋되지 않게 이미 막혀 있다(`.gitignore`). 에이전트는 `.env`를 읽지 못한다. 값은 직접 넣는다.

## 7. 비밀번호 바꾸기

비밀번호가 채팅·로그·화면 공유에 노출됐거나, 담당자가 바뀌었을 때 한다.

1. Supabase 프로젝트 설정의 Database에서 **Reset database password**(데이터베이스 비밀번호 재설정)를 누르고 새 비밀번호를 자동 생성한다. 이 순간부터 옛 비밀번호로는 접속이 안 된다.
2. 새 비밀번호를 비밀번호 관리자에 저장하고, 저장해 둔 두 주소의 비밀번호 부분을 새 값으로 바꾼다.
3. GitHub **Settings > Environments > dev**에서 `DEV_DATABASE_URL`, `DEV_DIRECT_URL` 두 시크릿을 새 주소로 덮어쓴다(연필 아이콘).
4. 회사 PC `.env`의 `DATABASE_URL`, `DIRECT_URL`을 같은 값으로 바꾼다.
5. 나중에 Vercel 등 다른 곳에도 이 값을 넣게 되면 그곳도 같이 바꾼다.
6. 확인: 5단계대로 **dev-db**를 한 번 실행해 초록 체크("already up to date")가 나오면 끝이다.

## 8. main 브랜치 보호 (권장)

테스트가 통과하지 않은 변경이 main에 들어가지 않게 한다. 저장소 관리자만 설정할 수 있다.

1. **Settings > Branches**(또는 Rules > Rulesets)에서 `main`에 대한 규칙을 만든다.
2. **Require a pull request before merging**을 켠다. main 직접 푸시가 막힌다.
3. **Require status checks to pass**를 켜고 아래 세 개를 필수로 추가한다. PR 화면에는 `ci / test`, `ci / e2e`, `ci / db`로 보이고, 검색창에서는 `test`, `e2e`, `db`로 찾는다. 이 목록에는 한 번이라도 실행된 검사만 나오므로, 워크플로가 든 PR을 먼저 하나 올린 뒤에 설정한다.
   - `ci / test` : 타입 검사, 린트, 단위 테스트, 콘솔 빌드
   - `ci / e2e` : 브라우저로 화면을 실제로 눌러 보는 테스트(가짜 데이터)
   - `ci / db` : 실제 Postgres 16에 마이그레이션을 적용해 보고, 스키마 파일과 맞는지 확인
4. `dev-db`는 필수 검사에 넣지 않는다. PR에서는 돌지 않는다.
