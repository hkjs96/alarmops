# 실제 연동 순서 (파일럿 실운영까지)

목표: 파일럿 고객 1곳의 AWS 알람이 들어오면 사람이 손대지 않아도 인시던트가 열리고, 정해진 순서대로 전화·문자가 가고, Ack/해결까지 콘솔에서 끝나는 상태.

이 문서는 "누가 무엇을 하는가"를 단계별로 적는다. **[사람]** 은 자격증명·결제·배포 승인이 필요해 사람이 직접 한다. **[에이전트]** 는 허브가 이슈로 배정한다. 비밀값은 어디에도 붙여 넣지 않는다(비밀번호 관리자, GitHub/Vercel 시크릿, 회사 PC `.env`만).

## 지금 상태 (11/16)

| 영역 | 상태 |
|---|---|
| 콘솔·API·틱(에스컬레이션, 발송 대기열, 보관·파기) | 코드 완료, mock·로컬 Postgres로 검증 |
| 개발 DB(Supabase) | 마이그레이션 0001~0005 적용, Data API 꺼짐 |
| 수집(ingest: 웹훅·EventBridge) | 코드 완료, **배포 묶음 없음** |
| 알람 엔진(알람 생성·동기화·해지 삭제) | 규칙·동기화 코드 완료, **리소스 수집기 29종 없음**(자동 알람 생성 불가), **배포 묶음 없음** |
| 고객 연결 스택·중앙 버스·명령 큐 | CloudFormation 템플릿 완료, 실제 계정 미배포 |
| 실제 알림 발송(전화·문자·Slack·이메일) | **어댑터 없음** — 업체 결정 대기(#10, #39) |
| 콘솔 배포(Vercel) | **배포 워크플로 없음**, env 검사 스크립트만 있음 |

굵게 표시한 4가지가 채워져야 "완전 자동"이 된다.

---

## 1단계 — 결정 [사람] (먼저, 다른 단계를 막는다)

- [ ] 문자·전화 업체(Q-API-06, 후보 솔라피): 계정 만들고 API 키 발급(키는 아직 어디에도 넣지 않는다)
- [ ] 이메일 발송 업체(D-44 DEGRADED 알림용)
- [ ] Slack 워크스페이스·앱, MSP 공용 채널 이름(D-46)
- [ ] 콘솔 도메인(예: `console.<회사도메인>`) — `CONSOLE_ORIGIN`이 된다
- [ ] Google SSO 연결 시점(파일럿 전 필수 여부)
- [ ] 파일럿 고객 1곳과 그 AWS 계정 ID

## 2단계 — GitHub·DB 기반 [사람, 30분]

- [ ] main 브랜치 보호(Rulesets): PR 필수, 필수 검사 `test`, `e2e`, `e2e-live`, `db`, `engine`, `infra` (`docs/SETUP-SUPABASE.md` 9단계)
- [ ] 회사 PC `.env`에 `DATABASE_URL`/`DIRECT_URL` (SETUP-SUPABASE 7단계) → 허브에 "채웠다"고만 알림
- [ ] 회사 PC에서 실제 DB로 콘솔 확인: seed → `LIVE_DEV_LOGIN=1 SESSION_SECRET=<임의 32자> npm run dev -w @alarmops/console` → `/auth/dev-login?as=admin` (순서는 허브가 그때 안내)

## 3단계 — 콘솔 배포(Vercel) [사람 + 에이전트]

[에이전트] 배포 워크플로(#46): `check-console-deploy-env.mjs` 통과 후 Vercel 배포, `next build`는 mock 없이.

[사람] Vercel 프로젝트 만들고 환경변수(Production) 입력:

| 변수 | 값 |
|---|---|
| `DATABASE_URL` | Supabase Transaction pooler(6543, `?pgbouncer=true&connection_limit=1`) — 운영 DB는 개발과 별도 프로젝트 권장 |
| `DATABASE_POOLER` | `transaction` |
| `SESSION_SECRET` | 32자 이상 임의 값 |
| `TICK_SECRET` | 32자 이상 임의 값(아래 pg_cron과 같은 값) |
| `CONSOLE_ORIGIN` | `https://console.<도메인>` |
| `TRUSTED_PROXY` | `1` |
| `ALARM_COMMANDS_QUEUE_URL`, `ALARM_COMMANDS_EXPECTED_ACCOUNT` | 4단계 후 |
| `AWS_ROLE_ARN` | 4단계 후(Vercel OIDC 역할, D-49) |
| `MOCK_API`, `E2E_ALLOW_MOCK` | **넣지 않는다**(배포 검사가 막는다) |

[사람] CDN에서 HTML 캐시 끄기(nonce CSP, `infra/aws/README.md`).

[사람] 1분 틱: Supabase Vault에 `tick_secret` 저장 → SQL Editor에서 `docs/API-CONTRACT.md` §5의 `cron.schedule('alarmops-tick', ...)` 실행(URL은 배포 주소). 확인: 콘솔 상단 `TICK` 표시가 1분마다 갱신.

## 4단계 — AWS 중앙 계정(서울) [에이전트 템플릿 → 사람 배포]

[에이전트] 중앙 배포 묶음(#47): 수집 Lambda(웹훅·EventBridge), `alert-events` 큐, 알람 엔진 Lambda(`alarm-commands` 소비), 엔진이 고객 역할을 맡는 **중앙 역할**, 중앙 버스 → 수집 규칙, Vercel OIDC 역할(SendMessage만). GitHub Actions 배포(`central` 환경 승인).

[사람] 한 번만:
- [ ] AWS에 GitHub OIDC 공급자와 배포 역할 만들기 → GitHub `central` 환경(main만, 승인자 본인) + 변수 `CENTRAL_BUS_DEPLOY_ROLE_ARN`
- [ ] Vercel OIDC 공급자 등록(D-49)
- [ ] 배포 워크플로 실행·승인 → 출력값(큐 URL, 역할 ARN)을 Vercel 환경변수에 입력
- [ ] **권한 실측**(#38): 시험 계정에 고객 스택 설치 → 알람 생성(Tags 포함)·삭제가 되는지, `ManagedBy` 없는 알람은 거부되는지

## 5단계 — 알림 발송 [에이전트, 1단계 결정 후]

- [ ] 문자·전화 어댑터(#10): 멱등 키 전달, 오류 문구 가리기, 부분 장애 규칙. 업체 키는 서버 비밀로만
- [ ] Slack·이메일 어댑터 + DEGRADED 감시자 + 10시 요약 + 비상 열람 알림(#39)
- [ ] seed 번호 가드는 이미 있음(#26) — 실제 번호 등록 후 확인 링크로 검증

[사람] 업체 키를 Vercel(또는 Lambda) 비밀로 입력, 본인 번호로 시험 호출 1건.

## 6단계 — 알람 자동 생성 [에이전트]

- [ ] 알람 엔진 리소스 수집기 29종(#48): `SYNC_ACCOUNT`가 리소스를 찾아 `Monitoring=on` 태그 대상에 알람을 만들고 맞춘다. 이게 있어야 "고객이 태그만 붙이면 알람이 생긴다"가 된다
- [ ] CloudTrail 태그 변경 → 즉시 동기화 연결

## 7단계 — 파일럿 고객 연결 [사람]

1. 콘솔에서 고객사·AWS 계정 등록 → ExternalId 발급
2. `bus-allowlist` 워크플로로 계정 추가(승인)
3. 고객에게 `infra/customer-stack/template.yaml` 설치 요청(파라미터: 중앙 역할 ARN, ExternalId, 중앙 버스 ARN)
4. 콘솔 "연결 확인" → 역할별 OK
5. 호출 순서·담당자 등록, 연락처 확인 링크 발송
6. 시험 알람 1건(임계값 낮춘 알람) → 인시던트 열림 → 전화 → Ack → 해결까지 확인
7. 실제 iPhone Safari로 콘솔 확인(#28)

## 완전 자동으로 도는 것과 사람이 남는 것

자동: 알람 수신 → 그룹·인시던트 → 호출 순서대로 발송 → 미응답 시 다음 단계 → Ack·해결 기록 → 업무 시간 요약 → 해지 고객 정리·파기.
사람: 새 고객 연결(스택 설치는 고객 계정), 해지 승인, legal hold, 비상 번호 열람, 업체·키 관리, 배포 승인.

## 진행 순서 요약

1단계 결정 → 2단계(오늘 가능) → 3·4단계는 에이전트 템플릿이 먼저, 사람 배포가 뒤 → 5·6단계는 에이전트 → 7단계 파일럿.
