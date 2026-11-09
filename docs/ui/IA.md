# 정보 구조 (IA)

상태: 초안 (D-26 반영). 콘솔 문구는 영어(D-01). 화면 명세는 `docs/ui/screens/`, 시안은 `docs/ui/mockups/index.html`.

## 1. 상단 메뉴 (D-26)

```
AlarmOps   Incidents   Monitoring   On-call   Customers   Settings        [Customer: All ▾] [⌘K] [HK]
```

| 메뉴 | 하위 (밑줄 탭) | 화면 명세 |
|---|---|---|
| **Incidents** | Open · Acknowledged · Resolved (상태 칩) | `incidents-list.md` |
| └ Incident 상세 `/incidents/{id}` | Overview · Alerts · Timeline · Notifications | `incident-detail.md` |
| **Monitoring** | Alarms · Resources · Coverage gaps · Needs review · Sync runs | `monitoring.md` |
| └ Resource 상세 `/monitoring/resources/{id}` | Thresholds · Alarms · Tags · History | `resource-detail.md` |
| **On-call** | Now · Schedules · Escalation policies · Contacts · Maintenance | `oncall-schedule.md`, `escalation-policy.md`, `channel-verification.md`, `maintenance-windows.md` |
| **Customers** | 목록 | `customers.md` |
| └ Customer 상세 `/customers/{id}` | Overview · Org & owners · AWS accounts · Integrations · **Monitoring**(같은 화면, 고객 고정 필터) · Remediation · Portal access | `customers.md`, `integrations.md` |
| └ New customer `/customers/new` | 5단계 마법사 | `customer-onboarding.md` |
| **Settings** | MSP defaults · Severity mapping · Suppression · Integrations(전체) · Users · Audit log | `settings.md`, `integrations.md` |
| 고객 포털 `/portal` (별도 셸) | Status · Incidents · Contacts · Maintenance | `customer-portal.md` |

- 전역 고객 선택기(우상단)는 모든 목록에 `customerId` 필터로 적용된다. 고객사 상세의 Monitoring 탭은 이 선택기를 그 고객으로 잠근 것과 같다(D-26).
- 고객사 담당자(VIEWER 강제, org-tenant R4-3)는 콘솔 셸이 아니라 포털 셸로만 들어온다. 고객 선택기 없음.
- 모바일 폭(< 720px): 상단 메뉴는 햄버거 대신 하단 5칸 바. Incidents가 첫 칸.

## 2. 화면별 목적 · 주 페르소나 · 진입점

| # | 화면 | 목적 | 주 페르소나 | 진입점 |
|---|---|---|---|---|
| 1 | Incidents list | 지금 울리는 것, 가장 심각한 것, 담당자를 스크롤 없이 | 하은(P1-1, P1-3) | 로그인 기본 화면, 메뉴 |
| 2 | Incident detail | 무엇이 왜 터졌나 → Ack → Resolve. RCA 자리(D-14), 자동 조치 승인 상태(D-15) | 하은(P1-2, P1-4, P1-5), 소연(P3-2 읽기) | Slack `ao_open`, 확인 링크, 목록 행 |
| 3 | Monitoring | 고객사 횡단 알람·리소스·빈틈·확인 필요(D-16)·임계치 출처(D-19) | 민재(P4-2, P4-3) | 메뉴, 고객 상세 Monitoring 탭, 인시던트 상세 "Open resource" |
| 4 | Resource detail | 지표별 값과 출처 층, 변경 미리보기, 드리프트 복원/수용, 이력 | 민재(P4-3, P4-5) | Monitoring 행, 인시던트 상세 |
| 5 | On-call schedule editor | 팀·시프트·대체 근무, "지금 누가" 해석 근거 | 준호(P2-2, P2-4) | On-call › Schedules |
| 6 | Escalation policy editor | 단계·대기·채널·반복 횟수(D-20) | 준호 | On-call › Escalation policies, 고객 상세 |
| 7 | Channel verification | 연락처 채널별 확인 상태, 링크 발송/수동 확인 | 준호 | On-call › Contacts, 온보딩 4단계 |
| 8 | Maintenance windows | 점검 창 생성·해제. SEV-1은 통과(D-17) 고정 안내 | 준호, 민재, 소연(grant) | On-call › Maintenance, Slack 1h 뮤트, 포털 |
| 9 | Integrations | CloudWatch(계정·역할) / Prometheus / Grafana 연동, 토큰 1회 표시·회전 | 준호, 민재(P4-1) | 고객 상세 탭, Settings › Integrations, 온보딩 3단계 |
| 10 | Customer onboarding wizard | 고객사 → 조직 → AWS 계정 + IAM 역할 → 연락처·순서 → 확인 | 준호(P2-1), 민재(P4-1) | Customers › New customer |
| 11 | Customers list / detail | 고객사 상태 한눈에, 조직·담당·계정·포털 권한 | 준호(P2-1, P2-3) | 메뉴 |
| 12 | Settings | MSP 임계치 기본값(D-19), 심각도 매핑표(D-18), 억제 정책 | 준호(ADMIN), 민재 | 메뉴 |
| 13 | Customer portal | 고객사 하나의 상태를 쉬운 말로. 다른 고객 흔적 없음 | 소연(P3-1~3) | 고객 SSO 로그인, 통지 메일 링크 |

## 3. 공통 규칙

| 항목 | 규칙 | 근거 |
|---|---|---|
| 심각도 표기 | 도형 + 색 + 라벨: SEV-1 ● · SEV-2 ▲ · SEV-3 ◆ · SEV-4 ○ · SEV-5 – | ui/README |
| 상태 표기 | Triggered ● 빨강 · Escalated ▲ 주황 · Acknowledged ○ 슬레이트 · Resolved ✓ 초록 · Muted – 회색 | alert-hub tokens |
| 출처 배지 | `TAG` `CONSOLE` `CUSTOMER` `MSP` `CODE` — 모든 임계치 값 옆 | D-19 |
| 주 버튼 | 화면당 하나, 액센트 파랑. 보조는 흰 바탕 + 보더. 위험 동작은 보조 + 빨강 글자 + 확인 | ui/README "주 버튼 색 규칙 하나" |
| 스탯 타일 | 현재 필터 기준 수치(합 = 목록 수) | known-bugs 9-5 |
| 범위 밖 | 404 화면은 "Not found" 하나(존재를 드러내지 않음) | API §2 |
| 시간 | KST 표시, 상대 시각 + 절대 시각 툴팁 | DATA-MODEL §0 |
| 다크 모드 | 시스템 설정 따름 + 수동 토글 | ui/README |
