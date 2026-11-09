# AlarmOps

클라우드 알람을 만들고 관리하는 것부터, 울린 알람을 인시던트로 묶어 온콜 담당자에게 전달하고 대응하는 것까지 하나로 하는 MSP용 제품(PoC). 이름은 PoC용이며 바뀔 수 있다.

alert-hub와 aws-alert-manager를 하나로 재구축하는 AlarmOps PoC. 목표: 8주 안에 파일럿 고객사 1곳 실운영.

## 구조
| 경로 | 내용 | 담당 에이전트 |
|---|---|---|
| `apps/console` | Next.js 콘솔과 API (Vercel) | console |
| `packages/design-system` | alert-hub 기반 디자인 토큰·컴포넌트 | console |
| `services/ingest` | 수집 Lambda (이벤트 버스, 웹훅 → SQS) | backend |
| `services/alarm-engine` | 알람 엔진 (aws-alert-manager에서 이식) | backend |
| `db` | Prisma 스키마·마이그레이션 (Supabase Postgres) | backend |
| `infra/aws` | 우리 AWS 리소스 (SAM, 서울) | infra |
| `infra/customer-stack` | 고객 연결 CloudFormation (Reader·EventForwarder 필수, AlarmWriter·TagWriter·Remediator 선택) | infra |
| `docs` | 결정, 명세, 데이터 모델, API 계약, UI, 이전 계획, 페르소나 | 허브·사람 |

## 시작
1. `docs/SETUP-WINDOWS.md`대로 회사 PC를 준비한다.
2. `docs/decisions/DECISIONS.md`를 읽는다.
3. `claude`로 허브 세션을 열고 1주차 작업을 시작한다.

## 1주차
| 일차 | 작업 |
|---|---|
| 1 | 저장소·하네스 설정, 프록시·원격 제어 확인 |
| 2~3 | 기존 두 저장소에서 동작 명세 추출(`docs/specs/README.md`), 사람이 검토·확정 |
| 4 | 데이터 모델, API 계약 |
| 5 | UI 문서(메뉴 확정, 화면 명세), 이전 계획 개요, 미결 결정 마무리 |
