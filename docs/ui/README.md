# UI

상태: 콘솔 셸 확정(11/10, D-26 개정 · D-33 · D-34 · D-35). 화면 명세·시안 초안은 11/9. 이전 시안: https://claude.ai/artifact/GyYbFEdEHd1eahQ8D9zeFf

- 정보 구조: `IA.md`
- **셸 규칙(기준 문서 하나): `screens/shell-scope.md`** — 메뉴 + 트리 + 필터 줄 + 패널, 읽기 먼저, 저장·확인, 주소, 반응형
- 화면 명세: `screens/*.md` (화면 16개 + 셸 1개)
- 시안
  - `mockups/scope-variants.html` 변형 E(기본 피커 = 트리 · 시트) — **확정된 셸.** 화면 5개(Incidents, Monitoring, Call order, People, Maintenance) + Settings MSP defaults. A~D와 E-1·E-3은 비교 기록
  - `mockups/index.html` (탭 14개) — 셸은 옛것(상단 고객 선택기, On-call 메뉴). **화면 내용만 유효**
  - 캡처 `mockups/shots/`, 범위 시안 캡처 `mockups/shots/scope/`
- 검사: `mockups/checks/scope-e-check.py` (Playwright)
- 비교·평가 기록: `scope-variants.md`, `docs/qa/scope-eval-*.md`, `docs/qa/scope-scores/`

## 디자인 시스템
- 출발점: alert-hub `docs/design/tokens.md` (웜 페이퍼, 직각, 색 + 도형 상태, 모노 오버라인, 파랑 액센트 하나)
- 페르소나 검토에서 나온 조정
  - 데스크톱 다크 모드 추가(새벽 온콜)
  - 작은 회색 라벨 대비를 4.5:1 이상으로
  - 주 버튼 색 규칙 하나로 통일
  - SEV-1 긴급도 강화
  - 심각도 5단계 도형: SEV-1 ●, SEV-2 ▲, SEV-3 ◆, SEV-4 ○, SEV-5 –
  - 모노스페이스 대문자 라벨 사용 줄이기
- 글꼴: 본문 Pretendard(alert-hub와 같음, 셀프호스팅), 수치·코드 Space Mono

## 셸 (D-26 개정, D-33)
- 메뉴: Incidents / Monitoring / Call order / People / Maintenance / Customers + 오른쪽 Settings. 상단 고객 선택기는 없다
- 왼쪽 트리(Customer › Project › Service)가 범위를 고르는 유일한 장치다. 본문을 덮지 않고 밀어낸다. 휴대폰은 단계 시트
- 메뉴 아래 필터 줄: `Showing: …` + 필터가 걸렸을 때 `Outside this view: …`
- 목록의 기본 보기는 All customers, `My customers`는 필터(D-34)
- 편집은 범위가 정해진 패널에서만. 읽기 전용으로 열리고 `Edit`를 눌러야 편집. 저장 버튼에 전체 경로
- 저장 확인은 서비스 둘 이상이거나 범위를 넓혔을 때만. 서비스 하나는 바로 적용 + `Undo`
- 주소: 패널 `/c/<customer>/<project>/<service>/<screen>`, 목록 필터 `?filter=<customer>/<project>/<service>`
- 반응형: 1408px 이상은 트리가 패널 옆에 남고, 그 아래는 패널을 열 때 띠로 접히고, 760px 이하는 시트
- Call order 하위: Call order · Rotations · Templates. Integrations는 Customers 고객 관리 탭 + Settings › Integrations(전체). Reports는 PoC 이후
- Customers 메뉴 위치와 Call order 탭 구성은 E 시안에 없는 배치안이다(`IA.md` §1, 확인 필요)

## 화면 목록
"시안" 열: E = `scope-variants.html` 변형 E(새 셸), I = `index.html`(옛 셸, 내용 유효).

| 화면 | 명세 | 시안 | 주 페르소나 |
|---|---|---|---|
| 셸·범위 규칙 | `screens/shell-scope.md` | E | 전원 |
| Incidents 목록 | `screens/incidents-list.md` | E, I | 하은 |
| Incident 상세(RCA 자리, 자동 조치 패널) | `screens/incident-detail.md` | E(패널 축약), I(전체) | 하은 |
| Monitoring(알람·리소스·빈틈·Needs review) | `screens/monitoring.md` | E(Alarms + 임계치 패널), I(전체) | 민재 |
| Resource 상세(임계치 출처·드리프트·이력) | `screens/resource-detail.md` | I | 민재 |
| Call order(고객별 호출 순서, 구 On-call › Now) | `screens/oncall-now.md` | E, I | 하은, 준호 |
| Call order 패널(단계·Responders, 구 Customer › Responders & paging) | `screens/customer-responders.md` | E(읽기·분 편집), I(단계 편집기 전체) | 준호 |
| Call order › Rotations | `screens/oncall-rotations.md` | I | 하은, 준호 |
| Call order › Templates | `screens/oncall-templates.md` | I | 준호 |
| People(표 하나: 직원 + 고객 사람, 휴가 대체) | `screens/oncall-people.md` | E(목록·패널), I(휴가 대체·일괄) | 준호 |
| 채널 확인 정의·Needs action | `screens/contacts.md` | I | 준호 |
| Maintenance | `screens/maintenance-windows.md` | E, I | 준호, 민재 |
| Customers 목록·고객 관리 | `screens/customers.md` | I | 준호 |
| Integrations | `screens/integrations.md` | I | 준호, 민재 |
| 고객 온보딩 마법사 | `screens/customer-onboarding.md` | I(3단계) | 준호 |
| Settings(MSP 기본값, 심각도 매핑) | `screens/settings.md` | E(MSP defaults), I | 준호 |
| 고객 포털 | `screens/customer-portal.md` | E(포털 모드), I | 소연 |
| 억제 이유 패널 | `incident-detail.md` Suppression 탭 | 탭 자리만 | 민재 |

## 화면 명세 작성 형식
화면마다 `docs/ui/screens/<화면>.md`: 목적, 페르소나 시나리오 번호, **셸·범위(트리 필터 적용 여부, 패널, 읽기 화면, 저장 버튼 문구)**, 보이는 데이터(API-CONTRACT 항목), 동작, 빈/로딩/오류 상태, 휴대폰 폭 동작. 셸 공통 규칙은 `shell-scope.md`에만 적는다.
