# UI

상태: 화면 명세·시안 초안 완료(11/9, D-26 반영). 이전 시안: https://claude.ai/artifact/GyYbFEdEHd1eahQ8D9zeFf

- 정보 구조: `IA.md`
- 화면 명세: `screens/*.md` (13개)
- 시안: `mockups/index.html` (탭 14개, 라이트·다크, 휴대폰 폭), 캡처 `mockups/shots/`

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

## 메뉴 구성 (D-26 확정)
- 상단: Incidents / Monitoring / On-call / Customers / Settings
- Monitoring은 독립 메뉴(고객사 횡단). 고객사 상세 Monitoring 탭은 같은 화면을 그 고객사로 필터
- On-call 하위: Now · Schedules · Escalation policies · Contacts · Maintenance
- Integrations는 고객사 상세 탭 + Settings › Integrations(전체)
- Reports는 PoC 이후

## 화면 목록
| 화면 | 명세 | 시안 | 주 페르소나 |
|---|---|---|---|
| Incidents 목록 | `screens/incidents-list.md` | 있음(휴대폰 폭 카드형) | 하은 |
| Incident 상세(RCA 자리, 자동 조치 패널) | `screens/incident-detail.md` | 있음 | 하은 |
| Monitoring(알람·리소스·빈틈·Needs review) | `screens/monitoring.md` | 있음 | 민재 |
| Resource 상세(임계치 출처·드리프트·이력) | `screens/resource-detail.md` | 있음 | 민재 |
| 온콜 팀(순서·당번·교환·프리셋, D-28) | `screens/oncall-team.md` | 있음 | 하은, 준호 |
| Contacts(MSP 직원, D-29) | `screens/contacts.md` | 있음 | 준호 |
| 점검 창 | `screens/maintenance-windows.md` | 있음 | 준호, 민재 |
| Integrations | `screens/integrations.md` | 있음 | 준호, 민재 |
| 고객 온보딩 마법사 | `screens/customer-onboarding.md` | 있음(3단계) | 준호 |
| Customers 목록·상세 | `screens/customers.md` | 있음 | 준호 |
| Settings(MSP 기본값, 심각도 매핑) | `screens/settings.md` | 있음 | 준호 |
| 고객 포털 | `screens/customer-portal.md` | 있음 | 소연 |
| 억제 이유 패널 | `incident-detail.md` Suppression 탭 | 탭 자리만 | 민재 |
| 모바일 온콜 | `incidents-list.md` 휴대폰 폭 | 목록만 | 하은 |

## 화면 명세 작성 형식
화면마다 `docs/ui/screens/<화면>.md`: 목적, 페르소나 시나리오 번호, 보이는 데이터(API-CONTRACT 항목), 동작, 빈/로딩/오류 상태, 휴대폰 폭 동작.
