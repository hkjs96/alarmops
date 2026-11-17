# 보안 검토 — feat/reveal-api (D-35 번호 보기 API, 커밋 `1e5cb65`)

- 범위: `POST /contacts/{id}/reveal`, `GET /contact-reveals`, Responders의 `canReveal`.
- 결론: [차단] 0건. 아래 항목을 후속 커밋에서 처리했다.
- 테스트: api·core·store-sql(실제 Postgres 16) 계약 테스트와 타입 검사 통과.

| # | 구분 | 내용 | 상태 |
|---|---|---|---|
| 1 | 권고 | 비상 열람 알림이 기록만 되고 발송되지 않는 사실이 계약에 분명하지 않았다 | **반영(문서).** API-CONTRACT §8.4에 "알림은 기록만, 발송 미구현(파일럿 게이트, hkjs96/alarmops#39)" 명시. 발송 코드는 넣지 않음 |
| 2 | 권고 | 알림 대상이 고객 쪽 사람·비활성·열람 대상 본인·호출자일 수 있고, 대상이 없을 때 빈 목록이 "문제 없음"과 구분되지 않았다 | **반영.** INTERNAL·활성만, 본인·호출자 제외, 없으면 다른 ADMIN, 그래도 없으면 `[]` + 목록 `notifyStatus: NO_RECIPIENT`. §8.4·Q-API-14에 기록 |
| 3 | 권고 | 비활성 연락처의 값을 열 수 있었다 | **반영.** 범위 밖과 같은 404(NORMAL·비상). 계약 테스트 추가 |
| 4 | 권고 | 거부된 시도(403·429·사유 없는 비상 422)가 흔적을 남기지 않았다 | **반영.** `deps.log`로 requestId·userId·contactId·status·code만 기록, 값·사유 글 없음. 테스트가 로그에 값이 없음을 확인 |
| 5 | 권고 | 사용자 잠금 대기가 풀 연결을 붙잡을 수 있다 | **반영.** `pg_try_advisory_xact_lock`, 못 잡으면 즉시 429 `Retry-After: 1`. 동시 40건 테스트는 "한도 초과 없음, 값을 준 건수 = 기록 행 수"로 바꿨고 실제 Postgres(동시 실행)에서도 돈다 |
| 6 | 참고 | 포털 열람이 직원 VIEWER로 보일 수 있다 | **반영.** `actorRole = 'PORTAL'`로 기록, 목록 `actor.kind: PORTAL\|STAFF`. 스키마 변경 없음 |
| 7 | 참고 | 알 수 없는 `auth.kind` | **반영.** `requireAuth`는 INTERNAL·CUSTOMER만 통과시키고, `revealStanding`도 그 밖은 거부(테스트) |

## 보류·남은 위험

- 비상 알림 **발송**은 보류(#39). 비인시던트 알림을 담을 자리(스키마)가 정해져야 한다. 그때까지 검토는 목록을 직접 열어야 한다.
- VIEWER인 Responder의 열람 가능 여부는 사용자 결정 대기(`VIEWER_RESPONDER_MAY_REVEAL = false`).
- 동시 요청이 사용자 잠금에 막혀 429를 받을 수 있다(정상 사용에서는 드묾).
