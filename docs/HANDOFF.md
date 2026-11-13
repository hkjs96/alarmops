# 인수인계 — 클라우드 세션 → 회사 PC Claude Code (2026-11-12)

회사 PC의 Claude Code에서 이어서 작업하기 위한 문서다. 먼저 `CLAUDE.md`와 `docs/decisions/DECISIONS.md`를 읽고, 그다음 이 문서를 읽는다.

## 1. 지금 상태 (main = #17 머지 직후)

| PR | 내용 |
|---|---|
| #8 | 에스컬레이션 엔진, 1분 틱, 알림 발송 로직, API 핸들러 (packages/core, packages/api) |
| #9 | 콘솔 Call order 화면 |
| #12 | GitHub Actions CI(test, e2e, db), dev-db 마이그레이션 워크플로 |
| #13 | SQL 저장소(packages/store-sql, pg·PGlite), 스키마 컬럼, R-24 |
| #14 | 모든 public 테이블 RLS, 정책 없음 (D-40) |
| #15 | 알람 엔진 이식, Python 3.12 (services/alarm-engine, 29종, 114행 골든 테스트) |
| #16 | 콘솔↔백엔드 한 앱(D-09), /me·/oncall/now·Responders 쓰기·paging-health·rotations·staff, /api/internal/tick, 수집 SQL 저장소, live e2e, 조회 권한(D-41), 고객사 상태(D-42) |
| #17 | 보안 후속: 사용자-연락처 불일치 시 401, 오류 원문 로그 제거(errorTag), seed 전화번호 검사, 세션 종료 화면 흐름 |

CI 작업: `test`, `e2e`(mock), `e2e-live`(postgres:16), `db`(migrate deploy, drift, RLS 검사, test:sql), `engine`(pytest·ruff·mypy). 모두 녹색.

확정 결정은 D-01~D-42. 이번 세션에서 추가된 것: D-36~D-42(D-40 RLS, D-41 조회 권한, D-42 고객사 상태).

## 2. 사용자가 할 일 (막힌 것)

1. **개발용 Supabase 프로젝트 생성.** `docs/SETUP-SUPABASE.md`의 1~6단계를 따른다. 끝나면 비밀값은 빼고 두 가지만 허브에 알린다.
   - dev-db 실행 결과(초록 또는 실패 단계)
   - anon curl 결과의 마지막 줄 숫자(200이 아니면 정상)
2. **회사 PC `.env` 채우기.** SETUP-SUPABASE 7단계. 에이전트는 `.env`를 읽지 않는다.
3. **main 브랜치 보호.** SETUP-SUPABASE 9단계. 필수 검사에 `engine`, `e2e-live`도 추가한다.

## 3. 결정 대기

| ID | 질문 | 허브 추천 |
|---|---|---|
| ~~Q-DM-20~~ | ~~정지·해지된 고객사의 수집과 호출~~ | **닫힘 → D-43**(11/13). 남은 질문 Q-DM-21(보관 기간), Q-DM-22(업무 시간·채널) |
| Q-DM-11 | 디스크 경로별 키(`Disk_*`)에 고객사·MSP 기본값 계층 적용 여부 | 미정. 레거시는 적용 안 함 |
| Q-DM-12 | 콘솔 임계값을 알람 태그(`AlarmOps:Console:*`)에 둘지 DB에 둘지 | 현재 태그 + DB 대체. 확정 필요 |
| Q-DM-13 | 자동 조치 승인 요청의 만료 시간 | 미정 |
| — | WebSocket API 지표 심각도(현재 SEV-5 기본값) | 미정 |
| — | D-27 주기·통계를 스키마에 넣을지(`ChangeField`에 PERIOD/STATISTIC, ManagedAlarm 컬럼) | 넣는 쪽 권장 |

## 4. 남은 작업 (추천 순서)

1. **실제 Supabase로 확인** (사용자 2번 이후)
   - dev DB에 seed를 넣고 콘솔을 live 모드로 띄운다.
   - 풀러(6543)와 `DATABASE_POOLER=transaction`으로 동작을 확인한다.
   - pg_cron과 pg_net으로 `/api/internal/tick` 호출을 시험한다(API-CONTRACT §5).
2. **알림 발송기 연결** (이슈 #10)
   - 문자·전화·Slack 어댑터. 멱등 키 전달을 확인한다.
   - 부분 장애 운영 규칙을 정한다. DEGRADED 알림 대상은 D-44(온콜 MSP 직원, Slack·이메일).
   - seed 번호(`+82100000…`, `phoneVerifiedVia='admin:seed'`)를 거부하는 코드 가드를 넣는다.
   - 정지·해지 고객 처리(D-43)를 반영한다.
3. **알람 엔진 마무리** (services/alarm-engine, infra)
   - 리소스 수집기 29종. 지금은 인터페이스만 있고, `wiring.py`가 SYNC_ACCOUNT를 거부한다.
   - CloudTrail 이벤트 소스, SAM 템플릿.
   - AlarmWriter 정책: `DeleteAlarms` 조건 `ManagedBy=AlarmOps`, `DescribeAlarms`와 `ListTagsForResource` 추가.
   - API-CONTRACT에 `restoreDrift`, APPLY_THRESHOLD의 `periodSec`·`statistic`, liveness의 `alarmNames`를 반영한다.
   - db CI 작업에 `ALARM_ENGINE_TEST_PG_URL`을 설정한다.
4. **콘솔 후속** (이슈 #11)
   - P3-K: Responders Edit 때 행 이동.
   - CONSOLE_ORIGIN 필수화, `/auth/session` 요청 제한, CSP nonce.
   - SSO 로그아웃을 서버에서 무효화.
   - 실제 iPhone Safari 확인.
   - 교대표·템플릿 탭, 번호 보기(D-35), 포털 읽기 전용.
   - 고객사 상태를 바꾸는 화면(D-42 공백).
   - `counts.meta`와 `updatedByName` 계산. `/oncall/now`의 `contactId`·`style` 인자.
   - 새 사람 추가 시 검증 링크 발송. 템플릿 동기화와 seed가 Responders 버전을 올리게 하기.
5. **이슈 #10 나머지**
   - 수정된 0001_init이 적용된 DB가 없는지 확인(N-36).
   - Prisma 드라이버 경로 시험. 지금까지 실행된 적이 없다.

이슈 정리: #11의 P3-J·P3-L·P3-M·zz-call-order와 #10의 P-2, ingest SQL은 #16에서 끝났다. #11은 체크했다.

## 5. 알아 둘 것

- **보안 검토 기록:** `docs/security/reviews/`(tick, sql, ci, callorder, scope). 알람 엔진(#15)과 #16·#17 검토 요약은 각 PR 본문과 이 문서 3·4절에 반영했다.
- **불안정 테스트:** `packages/core/test/security-review-4.baseline.test.ts`(VOICE 12×2)가 CI에서 5초 시간 제한을 한 번 넘겼다. 재실행하면 통과한다. 시간 제한을 늘리거나 이 테스트만 느린 묶음으로 분리할 것.
- **`next build`:** `MOCK_API=1`을 켠 채로 빌드하면 실패한다(운영 빌드에서는 mock을 막는다). Playwright 설정이 서버를 띄울 때 mock을 켠다.
- **live e2e:** `LIVE_DATABASE_URL`이 있어야 돈다. 개발용 로그인은 `LIVE_DEV_LOGIN=1`이고 NODE_ENV가 production이 아닐 때만 켜진다.
- **qa-ux 한계:** 클라우드에서는 "코드를 모르는 별도 검증자"를 띄우지 못해 qa-ux가 직접 판단했다. Claude Code에서는 persona-check 스킬대로 별도 검증자를 쓴다.
- **에이전트 규칙:** 코드 작성 에이전트는 동시에 최대 2개다. 커밋 꼬리말은 사용 중인 모델 이름으로 쓴다.
- **자격증명:** Claude Code는 실고객 AWS 자격증명이 없는 터미널에서만 실행한다. 개발 작업은 `dev` 프로필만 쓴다.
