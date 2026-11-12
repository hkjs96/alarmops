# 보안 검토 — CI 워크플로·글꼴 자체 호스팅 (`ci/workflows` @ e519964)

2026-11-11. 읽기 전용. 범위: `git diff origin/main...HEAD -- apps packages .github db .env.example docs/SETUP-SUPABASE.md`. 프로덕션 빌드를 띄워 응답 헤더와 요청 기록을 확인했고, 드리프트 검사 스크립트는 임시 파일로 직접 실행했다. 워크플로는 GitHub에서 실행해 보지 않았다.

## 결론

**[차단] 1건, [권고] 6건.** [차단]은 문서 한 단락으로 풀린다.

## [차단]

**S-1. `docs/SETUP-SUPABASE.md`에 Data API 끄기 · RLS 안내가 없다.**
- 문서 어디에도 Data API, RLS, anon 이야기가 없다(`grep -i "rls|data api|postgrest|anon"` 0건).
- 이 브랜치의 `db/prisma/migrations/0001_init/migration.sql`에는 `REVOKE`나 `ENABLE ROW LEVEL SECURITY`가 없다. Supabase 새 프로젝트는 `public` 스키마의 새 테이블에 anon · authenticated 권한을 기본으로 준다. 따라서 문서 5단계(dev-db 실행)를 그대로 하면 모든 테이블이 Data API에 anon 키로 읽기 · 쓰기 가능한 상태로 만들어진다. (Supabase 실제 프로젝트에서 확인하지는 못했다. 기본 동작에 근거한 판단이다.)
- 이전 검토(`alarmops-security-review-sql-2.md` "첫 배포 전 목록" 1번)가 요구한 항목이다.
- 고칠 것: 5단계 앞에 "프로젝트 설정 > API(Data API)에서 Data API를 끈다. 끌 수 없으면 노출 스키마에서 `public`을 뺀다"를 넣고, 5단계 뒤에 "anon 키로 `GET https://<프로젝트>.supabase.co/rest/v1/Contact`가 거부되는지 확인"을 넣는다. 콘솔은 Prisma로 직접 접속하므로 Data API가 필요 없다는 한 줄도.

## 통과

| 항목 | 확인 |
|---|---|
| CSP | 실제 응답: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. `fonts.googleapis.com` · `fonts.gstatic.com`이 빠져 좁아졌다. `script-src`는 바뀌지 않았다. `<head>`에서 `<body>` 맨 앞으로 옮긴 두 인라인 스크립트(테마, 셸)는 기존 `'unsafe-inline'`으로 허용되며 새로 넓어진 것은 없다. 단위 테스트(`security.test.ts`)도 새 값으로 고정 |
| 실행 중 요청 | 390 · 1440, 밝게 · 어둡게, 글꼴 차단 포함 6개 구성에서 요청 57~69건 모두 자기 출처. CSP 위반 · 콘솔 오류 0 |
| 글꼴 · 라이선스 | `apps/console/src/app/fonts/`에 woff2 5개와 OFL 1.1 전문 3개(Pretendard, Pretendard Std, Space Mono). 응답의 `Link: rel=preload` 3개도 자기 출처 |
| `ci.yml` | 트리거 `pull_request` · `push: main`(`pull_request_target` 아님). `permissions: contents: read`. `secrets.*` 참조 0. DB 주소는 작업 안의 일회용 Postgres(`postgres:postgres@localhost`)라 비밀값이 아니다. `run:`에 들어가는 `${{ }}`는 `job.services.postgres.id` 하나로 외부 입력이 아니다 |
| 포크 PR | `dev-db.yml`은 `pull_request`에서 돌지 않는다. 시크릿은 `environment: dev`에만 있다 |
| `dev-db.yml` | `permissions: contents: read`, `concurrency`로 겹침 방지. 실행하는 Prisma 명령은 `migrate status` · `migrate deploy`뿐이고 `db push`는 저장소의 워크플로 · package.json 어디에도 없다. 수동 실행의 입력값은 `env: CONFIRM`으로 받아 셸에 직접 끼워 넣지 않는다 |
| 마스킹(`mask-db-urls.mjs`) | 출력은 `::add-mask::`와 고정 문구 경고뿐. 전체 주소, 비밀번호(원문 · 디코딩), 호스트, 호스트:포트, `postgres.<프로젝트ID>`를 가린다. `npm ci` · Prisma 실행 전에 돈다 |
| `.env.example` | `USER:PASSWORD@HOST` 자리표시자와 빈 값뿐 |
| 문서의 나머지 조언 | 비밀번호 · 주소를 채팅 · 이슈 · 커밋에 넣지 말 것, 노출 시 재설정 절차(7단계), main 보호(8단계) — 안전하다 |

## [권고]

1. **`dev` 환경의 "Deployment branches: main만"과 "Required reviewers"를 선택이 아니라 필수로.** `workflow_dispatch`는 어느 브랜치에서나 그 브랜치의 워크플로 파일로 실행할 수 있다. 쓰기 권한이 있는 사람(또는 에이전트의 토큰)이 브랜치에서 `dev-db.yml`을 고쳐 실행하면 `DEV_DATABASE_URL`을 읽을 수 있다. 문서 4단계 3 · 4번이 지금은 "(선택)"이다.
2. **액션을 커밋 SHA로 고정.** 지금은 메이저 태그(`actions/checkout@v5`, `setup-node@v5`, `cache@v5`, `upload-artifact@v6`). 모두 GitHub 공식 액션이라 급하지 않지만, 시크릿을 쓰는 `dev-db.yml`부터 SHA로. `postgres:16` 이미지도 다이제스트 고정을 고려.
3. **`dev-db.yml`의 DB 주소를 작업 전체 env가 아니라 필요한 단계에만.** 지금은 `npm ci`(의존성의 설치 스크립트가 도는 단계)에도 `DATABASE_URL` · `DIRECT_URL`이 보인다. Prisma 단계와 마스킹 단계에만 주거나 `npm ci --ignore-scripts` 뒤 `prisma generate`.
4. **드리프트 검사의 주석 처리.** 줄 맨 앞 `--` 주석은 걸러져 우회되지 않는다(실행 확인: exit 1). 블록 주석은 걸러지지 않아 `/* ; CREATE UNIQUE INDEX "T_a_key" ON "T"("a") NULLS NOT DISTINCT; */`를 마이그레이션에 넣으면 `T_a_key`가 허용 목록에 들어가고 `DROP INDEX "T_a_key"` 차이가 무시된다(실행 확인: exit 0). `$$ … $$` 본문 안의 `;`도 같은 식으로 잘린다. 숨길 수 있는 것은 "스키마 파일에는 없고 DB에만 있는 고유 인덱스"와 `CREATE EXTENSION` 선언뿐이고, 표 · 열 · enum · FK · 일반 인덱스 차이는 숨길 수 없으며 PR 리뷰를 거쳐야 한다. 블록 주석을 지우고 나서 자르거나, 허용 이름을 스크립트에 고정 목록으로 두면 닫힌다.
5. **주소가 형식에 맞지 않을 때의 마스킹.** `new URL()`이 실패하면 전체 문자열만 가려지고 조각(호스트, 비밀번호)은 가려지지 않는다. Prisma의 오류 문구가 조각을 찍을 수 있다. 형식 오류면 그 자리에서 작업을 실패시키는 편이 안전하다.
6. **`.env.example`의 `MOCK_API=1` 기본값.** 로컬용으로는 맞다. 운영 배포 환경 변수 목록을 만들 때 이 줄이 따라가지 않게 `infra` 쪽 점검 항목에 넣을 것(프로덕션 빌드는 `E2E_ALLOW_MOCK` 없이는 목 모드를 거부하는 것으로 보이나 이번에 따로 시험하지 않았다).

## 확인하지 못한 것

GitHub에서의 실제 워크플로 실행과 로그 마스킹 결과, 환경 보호 규칙의 실제 설정, Supabase 실제 프로젝트의 기본 권한, main과의 동작 비교.
