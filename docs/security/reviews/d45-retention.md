# 보안 검토 — feat/d45-retention (D-45, D-46, 이슈 #25)

- 대상: 커밋 `cc7fec7`(마이그레이션 0005, 보관 작업, legal hold, 파기 기록, 내보내기, 다이제스트)와 `58130fe`(5/1 휴일 제외). 반영 커밋은 그 뒤 커밋.
- 테스트: 코어·api·ingest·store-sql·db 테스트와 타입 검사 통과(커밋 메시지 참고).

## 결론

- **[차단] 1건**(B-1) — 반영.
- [권고] 5건(R-1~R-5)과 [참고] 5건을 반영했다.

## 항목

| # | 구분 | 내용 | 상태 |
|---|---|---|---|
| B-1 | 차단 | `GET /digests/latest`가 `kind==='INTERNAL'`만 보고 모든 고객을 조인해, 일부 고객으로 좁혀진 직원에게 다른 고객의 이름·건수가 샌다 | **반영** — `digestData(scope, from, to)`로 범위를 받아 두 저장소 모두 안에서 거른다(SQL은 `scopeSql`, 해지 잔여 이벤트는 프로젝트·서비스 없음으로 판정해 고객 전체 범위만 통과). 계약 테스트(좁힌 직원·빈 범위·하위 범위)와 `tenant.test.ts` 케이스로 고정 |
| R-1 | 권고 | GUARD가 잠금 없는 EXISTS라 실행 중인 삭제가 hold 커밋 뒤에도 끝까지 간다. `apiRepo`의 주석이 틀렸다. Contact·User 삭제가 한 문장 | **반영** — GUARD에 `FOR SHARE`(hold의 `FOR UPDATE`가 실행 중 문장을 기다림, 이후 문장은 hold를 봄). 주석 정정. Contact·User 삭제·가림을 1000/500건 청크로. **보류:** 이미 도는 한 문장은 끝까지 간다(청크 단위 한계). 두 연결 동시성 테스트는 PGlite로 못 하고 `TEST_DATABASE_URL` 서버 CI 필요 |
| R-2 | 권고 | 기한을 러너 시계로만 판정해 빠른 러너가 일찍 지울 수 있다 | **반영** — 각 단계 SQL 안에서 `statusChangedAt + make_interval(days) <= now()`(CONNECTIONS는 오프보딩 `completedAt`)를 다시 확인. 테스트 |
| R-3 | 권고 | 환경변수로 기간을 0에 가깝게 줄일 수 있다 | **반영** — 하한 7/90/365일, 미만은 무시하고 경고 로그 콜백. **콘솔 앱에 아직 연결 안 됨**(콘솔 후속, 허브가 추적). 연결 전에는 기본값 |
| R-4 | 권고 | 감사 기록의 중첩 JSON 안 연락처 값은 못 가린다 | **반영** — 모든 깊이에서 키 제거(SQL 함수 `retention_mask_json`, JS `maskContactValues`). 중첩 테스트. **보류:** 키 이름 기준이라 다른 이름의 키에 든 값은 못 가린다 |
| R-5 | 권고 | CONNECTIONS에서 Resource를 지우면 RemediationRequest(승인 이력)가 cascade로 사라진다 | **반영** — 요청이 있는 Resource는 이름·ARN·키·태그만 가려 두고, 요청과 그 Resource는 AUDIT_EXPIRY에 삭제, 목록에 `RemediationRequest`·`Resource.scrubbed`를 따로 센다. FK 변경이 필요 없어 마이그레이션 구조는 그대로. **보류:** `RemediationRequest.trigger/result` JSON은 2년까지 남는다 |
| 참고 | 참고 | 선점이 죽으면 그날 영영 안 돈다 | **반영** — `finishedAt` 컬럼, 미완료 30분 초과 선점은 다시 잡는다 |
| 참고 | 참고 | 끝난 고객이 후보 500명을 차지해 굶길 수 있다 | **반영** — SLA_EXPIRY가 기록된 고객은 후보에서 뺀다(지울 게 없어도 처음 한 번 기록) |
| 참고 | 참고 | 메모리 저장소가 SQL과 다르다 | **반영** — externalId `purged-…`, ContactRevealLog 가림·삭제 |
| 참고 | 참고 | `CustomerLegalHold`·`CustomerExport` 감사 행의 수명 | **문서화** — 보호 대상이 아니라 2년 뒤 삭제된다(DATA-MODEL) |

## 남은 위험

- `retentionConfigFromEnv`·`createApi({ retention })`·`runTick({ retention })`이 콘솔 앱에 연결되지 않았다. 연결 전까지 환경변수 기간은 적용되지 않는다(기본값 30일·2년·5년).
- PGlite로는 hold 동시성(R-1의 `FOR SHARE` 대기)을 시험하지 못했다.
- 휴일 목록은 손으로 쓴 2026–2027이고 공식 달력과 대조하지 않았다(TODO).
