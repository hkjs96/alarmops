# 운영 DB를 서울 리전으로 옮기기 (D-61)

11/25 확인 결과, 운영 Supabase 프로젝트가 **뭄바이(ap-south-1)**에 만들어져 있었다. `docs/SETUP-PROD-DB.md` 1단계는 원래 서울을 요구했다. 엔진(서울)과 콘솔 함수가 DB에 접근할 때마다 인도까지 왕복했고, 온보딩 화면은 약 30초 걸렸다. 이 문서는 새 서울 프로젝트로 옮기는 순서다. 대부분의 단계는 `SETUP-PROD-DB.md`를 그대로 다시 하는 것이다.

소요: 약 1시간. 모두 사람이 한다(비밀값 입력과 외부 콘솔 작업). 에이전트는 실행하지 않는다.

## 0. 데이터를 옮길지 정한다
- **다시 온보딩 (추천, PoC)**: 지금 데이터는 시험 고객과 리허설 계정뿐이다. 새 DB에서 고객과 계정을 다시 등록한다. 고객 계정 스택의 ExternalId는 새 DB가 새로 만든다. 그래서 리허설 계정은 고객 스택을 다시 설치해야 한다(`infra/scripts/rehearsal/install.sh`).
- **덤프 이전**: ExternalId와 이력을 그대로 두려면 아래 "덤프 이전"을 따른다.

## 1. 새 프로젝트 (SETUP-PROD-DB 1~3단계)
- 리전은 **Northeast Asia (Seoul)**이다. 생성 화면의 Region 기본값은 **Auto**라서 그대로 두면 서울이 아닐 수 있다. 목록에서 직접 고른다(11/26 실제). 만든 뒤 프로젝트 설정에서 리전이 서울인지 다시 본다.
- 생성 화면의 **Data access**에서 "Enable Data API"와 "Grant API access to new tables automatically"를 끄고 만든다. "Enable RLS on new tables automatically"도 끈 채로 둔다(옛 프로젝트와 같은 조건, 권한은 마이그레이션과 `roles.sql`이 정한다).
- PoC 동안은 개발 단계라 이름은 `alarmops-dev-icn`이다. 무료 플랜의 활성 프로젝트 수 제한에 걸리면 옛 프로젝트를 먼저 **Pause**(Settings → General → Project availability)한다. Pause는 1년 안에 되살릴 수 있다.
- 이름은 `alarmops-prod`와 겹치지 않게 짓는다(예: `alarmops-prod-icn`). 옛 프로젝트는 아직 지우지 않는다.
- Data API를 끈다(2단계, 필수).
- 연결 주소는 Connect 화면에서 **그대로** 복사한다. 호스트는 `aws-0`/`aws-1`, 리전 이름을 포함해 화면에 보이는 값을 쓴다. 문서 예시 값을 쓰지 않는다(11/25 OperationalError의 원인).

## 2. 테이블과 DB 사용자 (SETUP-PROD-DB 4~6단계)
1. GitHub → Settings → Environments → `production-db` → `PROD_DATABASE_URL`, `PROD_DIRECT_URL`을 새 주소로 바꾼다.
2. Actions → **prod-db** 실행으로 마이그레이션을 적용한다.
3. `db/sql/roles.sql`로 `alarmops_engine`과 `alarmops_ingest`를 만든다. 새 비밀번호를 쓴다.

## 3. 주소 바꾸기 (SETUP-PROD-DB 7단계)
- AWS Secrets Manager(서울): `alarmops/central/engine-database-url`(5432), `alarmops/central/ingest-database-url`(6543)
- Vercel Production: `DATABASE_URL`(소유자, 6543, `?pgbouncer=true&connection_limit=1`). 그 밖에 DB 주소가 들어간 변수가 있으면 함께 바꾼다.
- Vercel 재배포: 환경변수는 다음 배포부터 적용된다. Deployments → 최신 → Redeploy를 누르거나 main에 병합한다.
- 엔진과 수집 Lambda는 다음 콜드 스타트 때 새 비밀을 읽는다. 바로 바꾸려면 아무 PR이나 병합해 deploy-central을 돌리거나, 몇 분 기다린다.

## 4. 확인
- 콘솔 로그인과 고객 목록이 열리고 화면이 빠르다(온보딩 화면 수 초 이내).
- 엔진 로그에 `engine init failed`가 없다:
  ```bash
  MSYS_NO_PATHCONV=1 aws logs filter-log-events --profile dev --region ap-northeast-2 --log-group-name /aws/lambda/alarmops-alarm-engine --start-time $(( ($(date +%s) - 900) * 1000 )) --filter-pattern ERROR --query "events[].message" --output text
  ```
- 리허설 계정 연결 확인이 OK다.

## 5. 옛 프로젝트 정리
- 1주일 동안 옛 프로젝트를 일시 정지(Pause) 상태로 둔다. 문제가 없으면 삭제한다.
- 옛 DB 비밀번호는 비밀번호 관리자에서 "폐기"로 표시한다.

## 덤프 이전 (선택)
본인 PC에 PostgreSQL 클라이언트(`pg_dump`, `psql`, 버전은 서버 이상)가 필요하다. 주소는 Session pooler(5432)의 **소유자** 주소다.
```bash
pg_dump --data-only --no-owner --no-privileges --exclude-table=_prisma_migrations "<옛 소유자 주소>" > C:/Temp/<무작위>/data.sql
```
```bash
psql "<새 소유자 주소>" -v ON_ERROR_STOP=1 -c "SET session_replication_role = replica;" -f C:/Temp/<무작위>/data.sql
```
- 2단계(테이블 생성)를 마친 뒤 실행한다. 외래 키 순서 문제는 `session_replication_role = replica`로 피한다.
- 이 설정은 Supabase 소유자 권한으로 안 될 수 있다. 막히면 다시 온보딩으로 간다.
- 덤프 파일에는 고객 데이터가 들어 있다. 끝나면 즉시 삭제한다. OneDrive나 바탕화면에 두지 않는다.

## 막혔을 때
| 증상 | 원인·해결 |
|---|---|
| 콘솔 연결 확인이 "queued but no result", 엔진 로그 `engine init failed: OperationalError` | 엔진 비밀의 사용자 `.<프로젝트ID>`나 호스트가 Connect 화면과 다르다. GO-LIVE 4-4 참고 |
| 콘솔이 여전히 느리다 | Vercel 함수 리전 확인. Deployments → 최신 → Functions에 `icn1`이 보여야 한다(`apps/console/vercel.json`) |
| 이전 후 아무도 로그인이 안 된다 | 새 DB에는 사용자가 없다. `docs/SETUP-GOOGLE-SSO.md` 3단계 SQL로 첫 관리자 행을 넣는다. 주소는 Google 계정 주소 그대로 쓴다 |
| 새 주소를 넣었는데 콘솔이 옛 DB를 본다 | Vercel 환경변수는 새 배포부터 반영된다. Vercel Redeploy는 안 되므로 Actions → deploy-console → Run workflow로 배포한다 |
