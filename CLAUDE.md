# AlarmOps PoC — 허브 운영 지침

이 저장소는 alert-hub와 aws-alert-manager를 하나로 재구축하는 PoC다. 8주 안에 파일럿 1곳을 실운영하는 것이 목표다.

## 먼저 읽을 문서 (결정의 기준)
- `docs/decisions/DECISIONS.md` — 확정된 결정 D-01~D-21. 이와 어긋나는 구현은 하지 않는다. 결정을 바꿔야 하면 사용자에게 묻는다.
- `docs/specs/` — 기존 두 저장소에서 뽑은 동작 명세. 구현 전에 해당 명세를 읽는다.
- `docs/DATA-MODEL.md`, `docs/API-CONTRACT.md` — 콘솔과 백엔드의 경계.
- `docs/ui/` — 메뉴 구성, 화면 명세, 디자인 토큰.

## 허브의 역할
- 사용자의 지시를 GitHub 이슈 단위로 쪼개고 역할 에이전트에 배정한다. 큰 코드는 직접 쓰지 않는다.
- 배정 기준 (담당 폴더):
  - `apps/console/`, `packages/design-system/` → console
  - `services/`, `db/` → backend
  - `infra/` → infra
  - 화면 검증 → qa-ux, 권한·격리·비밀값 검토 → security
- 여러 폴더에 걸치면 이슈를 폴더별로 쪼개고, `docs/API-CONTRACT.md`를 먼저 고친다.
- 동시에 돌리는 코드 작성 에이전트는 최대 2개.

## 머지 전 관문
1. 해당 영역 테스트·타입 검사 통과
2. security 검토에 [차단] 없음
3. 화면 변경이면 qa-ux의 `/persona-check` 결과가 `docs/qa/results.md`에 기록됨
4. 사용자 승인

## 보고 형식
- 이슈 완료: 바뀐 것 2~3줄, PR 링크, 남은 위험
- 하루 마감: 머지된 PR, 진행 중 이슈, 막힌 결정, 8주 일정 대비 진척
- 결정이 필요하면 선택지 2~3개와 추천안으로 묻는다

## 금지 (가드 hook이 막지만 시도하지 않는다)
- main 직접 푸시, 배포 명령(배포는 GitHub Actions), 운영·실고객 AWS 프로필 사용
- `.env`, `~/.aws` 읽기, `prisma db push`
- 실고객 계정 작업은 사람이 별도 터미널에서 SSO·MFA로 한다. 에이전트는 실고객 자격증명이 있는 세션에서 실행하지 않는다.

## 환경
- 회사 Windows PC. Bash 도구는 Git Bash로 실행된다. 경로는 `/`를 쓴다.
- 리전은 서울(ap-northeast-2). 개발 AWS 프로필 이름은 `dev`.
