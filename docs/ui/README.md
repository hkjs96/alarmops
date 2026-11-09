# UI

상태: 5일차에 확정. 시안: https://claude.ai/artifact/GyYbFEdEHd1eahQ8D9zeFf

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

## 메뉴 구성 (제안, 1주차 확정)
- 대응: Incidents, On-call
- 구성: Customers, Integrations, Monitoring(AWS 연결 고객사만)
- 분석: Reports
- Settings(오른쪽 위)
- 미정: Monitoring을 독립 메뉴로 둘지 Customers 안의 탭으로 둘지

## 화면 목록
| 화면 | 상태 | 주 페르소나 |
|---|---|---|
| Incidents 목록 | 시안 있음, 수정 필요(숫자 정의 통일, 휴대폰 폭) | 하은 |
| Incident 상세(RCA 카드 자리 포함) | 시안 있음, 수정 필요 | 하은 |
| 모바일 온콜 | 시안 있음(다크) | 하은 |
| Resources·커버리지 | 시안 있음, 수정 필요(29종 확장, 필터) | 민재 |
| Customer·조직 | 시안 있음, 수정 필요(출처 표시 통일) | 준호 |
| 고객 온보딩 마법사 + 설정 체크리스트 | 시안 없음 | 준호 |
| 에스컬레이션 정책·온콜 스케줄 편집 | 시안 없음 | 준호 |
| 채널 검증, 점검 창 | 시안 없음 | 준호 |
| Integrations(CloudWatch, Prometheus, Grafana) | 시안 없음 | 준호, 민재 |
| 리소스 상세(임계치 출처, 드리프트, 이력) | 시안 없음 | 민재 |
| 억제 이유 패널 | 시안 없음 | 민재 |
| 고객 포털(별도 화면, 쉬운 말 요약) | 시안 없음 | 소연 |

## 화면 명세 작성 형식
화면마다 `docs/ui/<화면>.md`: 목적, 페르소나 시나리오 번호, 보이는 데이터(API-CONTRACT 항목), 동작, 빈/로딩/오류 상태, 휴대폰 폭 동작.
