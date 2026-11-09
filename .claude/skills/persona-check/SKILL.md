---
name: persona-check
description: docs/PERSONAS.md의 페르소나 시나리오를 실행 중인 콘솔 화면에서 밟아 사용자 관점으로 검증한다. 인자로 페르소나(하은|준호|소연|민재)를 주면 그 시나리오만, 없으면 풀 패스. 화면 변경 PR 전과 단계 종료 시 사용.
---

# persona-check

alert-hub의 같은 이름 스킬을 이 저장소(Windows 회사 PC)에 맞게 옮긴 것이다.

## 절차
1. **환경 기동:** `apps/console`에서 개발 서버를 띄운다(`npm run dev`). 데모 시드 데이터에 FIRING 인시던트가 최소 1건 있어야 한다(`npm run seed:demo`).
2. **검증자 분리(필수):** 시나리오 수행은 구현 맥락이 없는 서브에이전트에게 시킨다. 주는 것: `docs/PERSONAS.md`의 해당 섹션, 앱 주소(http://localhost:3000), 아래 Playwright 실행법, 보고 형식. **금지:** `apps/`, `services/` 소스 읽기. 화면과 문서만 보고 판단한다.
3. **캡처:** 데스크톱 1440×900, 휴대폰 390×844, 라이트·다크. `docs/qa/shots/<날짜>/<페르소나>/`에 저장하고, 판정에 쓴 캡처는 직접 열어 본다.
4. **자동 점검:** 대비 4.5:1, 터치 영역 44px, 390px 가로 스크롤.
5. **판정:** 시나리오별 통과/P0/P1/P2 + 근거 캡처. 등급 정의는 `docs/PERSONAS.md`.
6. **기록:** `docs/qa/results.md` 표에 한 줄씩 추가.
7. **후처리:** P0는 즉시 수정 후 재실행. P1은 머지 전 수정이 원칙(예외는 사유와 함께 백로그).

## Playwright (Windows)
- 처음 한 번: `npx playwright install chromium` (사내 프록시에서 막히면 `docs/SETUP-WINDOWS.md`의 프록시 설정 참고)
- 실행: `node docs/qa/shoot.mjs <페르소나>` 같은 스크립트를 두고 `page.goto`/`click`/`screenshot({ fullPage: true })`로 시나리오를 수행한다.

## 보고 형식
```
## 페르소나: <이름>
- 시나리오 1 (<제목>): 통과 / P1 — <한 줄 근거> (shot: 경로)
### 종합: P0 n · P1 n · P2 n
```
