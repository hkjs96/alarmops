# On-call › Teams (D-28, D-30, D-31)

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/teams` (목록) · `/oncall/teams/{id}` (팀 화면) |
| 목적 | "지금 터지면 누가", "내 당번은 언제", "이 날 바꿔줘", "어떻게 울리나", "이 고객만 타이밍 바꾸기" |
| 페르소나 | 하은(당번, 모바일), 준호(설정), 민재(고객별 타이밍) |

## 팀이란 (D-31)
- Team = **MSP 직원 당번 그룹**(Infra, Data, Night desk 등 몇 개). 고객마다 팀을 만들지 않는다. 고객 여럿이 한 팀을 쓴다.
- 고객 담당자는 팀이 아니라 연락처(Customer › People, D-29). 팀·로테이션에 넣을 수 없다.
- 화면 문구: "Teams are your MSP staff groups (e.g. Infra, Data, Night desk). Many customers share one team; customers never get their own team."

## 샘플 데이터 (목업 스크립트 맨 위 `D` 객체 하나에서 모든 탭이 렌더링)
- Infra team 6명, 순서 1 Haeun → 2 Junho → 3 Minjae → 4 Jiwoo → 5 Sora → 6 Dohyun, 하루 1교대, 교대 09:00 KST. 지금 Mon 9 03:16 → 1번 Haeun.
- Data team 2명: 1 Taemin Jung → 2 Eunji Kwon.
- 고객: Mirae Pay = Infra · **Urgent (customized)** (Checkout 서비스만 Data team · Urgent), Hanbit Logistics = Infra · Standard, Daon Retail = Infra · Quiet, Seoul Bio Labs = Infra · Standard(설정 중).
- 기준 사건 payments-db-1 (Mirae Pay › Core › Payments API), 03:12:04 발생: Slack Haeun 03:12 → call Haeun 03:14 → call Junho 03:19 → call everyone 03:24, 반복 1회, 03:36 정지. On-call 조회·Incident 헤더/타임라인/Escalation 패널·Incidents 목록·Resource detail이 모두 같은 값.

## 레이아웃 (390px에서도 같은 순서 1열)
| 영역 | 내용 |
|---|---|
| Teams 표 | 이름 · 인원 · 지금 당번 · 고객 수, 검색(팀 10개 이상 MSP 대비), New team. 행 선택 → 아래 팀 화면 |
| 헤더 | 팀 이름, 인원·시간대·교대 09:00·고객 수, 팀 전환, **Cover or swap a shift**(본인이 팀원일 때, 모바일 전체 폭) |
| 대기 배너 | "You asked Minjae to cover your Sat 14 shift… You stay on call until Minjae accepts." |
| If something breaks now | **모든 사람에 번호 1–N**. 1~3번은 펼침, 나머지는 "+3 more: 4 Jiwoo · 5 Sora · 6 Dohyun"(펼치면 번호 그대로). 각주: "09:00 교대 때 순서가 한 칸 당겨진다(Junho가 1, Haeun이 6). 대체·교환은 그 시프트의 근무자만 바꾸고 순서는 바꾸지 않는다." |
| Who gets paged for… | 당번 작업(Cover) 아래. 경로, 팀, "from <노드>", 알림 계획 배지, 문장, Customer notified(알림만, Customer › People 링크) |
| Shifts / Recent changes | 로테이션에서 계산. 다음 주 띠, "Rotation: 1 Haeun → … → 6 Dohyun" |
| Alert plans | 팀 계획 Standard/Urgent/Quiet, 문장, "Used by …"와 "X picked Urgent but has its own timing". **Edit timing of this plan…** |
| Customers using this team | **압축 표**(카드 아님): 고객 · 이 팀이 맡는 서비스 · 알림 계획 배지 · 문장 · 동작. 필터 입력 + 칩(All/Standard/Urgent/Quiet/Customized). 동작: **Customize for <고객> only** 또는 **Edit <고객>'s timing**. 390px에서는 카드 |

## 타이밍 모델 (D-30)
- 알림 계획(Alert plan, 내부명 preset)은 **팀** 소유: Standard / Urgent / Quiet.
- 고객은 계획 하나를 고르고, 필요하면 **고객 단위 타이밍**(계획 단계의 복사본을 고친 것)을 가진다. 배지 "Mirae Pay · Urgent (customized)".
- 고객 맥락(팀 화면 고객 표의 Customize 버튼, Customer 상세 On-call 카드)에서 편집 → **그 고객만** 바뀜. 배너 "Changes Mirae Pay only. Infra team's Urgent plan and every other customer stay as they are."
- 팀 계획 편집 → 배너 "Applies to N customers using <계획> (…). Except X, which has its own timing and won't change."
- "Go back to team's <계획> timing"으로 고객 타이밍 삭제.
- 서비스가 다른 팀을 쓰면(Checkout → Data team) 그 서비스는 그 팀의 계획을 쓰고 고객 타이밍은 적용되지 않는다.

## 계획 기본 단계
| 계획 | 단계(At = 발생 후 누적 분) | 문장 |
|---|---|---|
| Standard | 0 Slack 1번 → 2 SMS 1번 → 7 call 2번 → 12 Slack+SMS+call 전원, 반복 1, 24분 정지 | Slack Haeun now → SMS Haeun at 2 min → call Junho at 7 min → Slack + SMS + call everyone at 12 min → repeat once → stop at 24 min |
| Urgent | 0 call 1번 → 5 call 2번 → 10 call 전원, 반복 1, 20분 | Call Haeun now → call Junho at 5 min → call everyone at 10 min → … |
| Quiet | 0 Slack 1번 → 15 Slack 전원, 반복 1, 30분 | Slack Haeun now → Slack everyone at 15 min → … |
| Mirae Pay 고객 타이밍 | 0 Slack 1번 → 2 call 1번 → 7 call 2번 → 12 call 전원, 반복 1 | Slack Haeun now → call Haeun at 2 min → call Junho at 7 min → call everyone at 12 min → repeat once → stop at 24 min |

ack되면 즉시 멈춤. 점검 창: SEV-2 이하 조용, SEV-1 항상(D-17).

## 쓰지 않는 말
preset(화면은 "Alert plan"), inherit(화면은 "from <노드>"), owner snapshot, Team default order, 내부 결정 번호(D-xx).

## 동작 → API
| 동작 | API |
|---|---|
| 팀 목록 | GET `/teams?q=` (`memberCount`, `onCallNow`, `customerCount`) |
| 팀·순서·교대 방식 | GET/PATCH `/teams/{id}` |
| 시프트 / 대체·교환 | GET `/schedules/{id}`, POST `/schedules/{id}/overrides` → accept/decline/remind |
| 팀 계획 | GET/PUT `/escalation-policies/{id}` (If-Match, 응답 `affectedCustomers`, `excludedCustomers`) |
| 고객 계획 선택·고객 타이밍 | PUT `/customers/{id}/escalation` `{ teamId, plan, timing?: {steps, repeatCount} \| null }` |
| Who gets paged for… | GET `/oncall/paging-path?q=` |

## 미결
- Q-DM-14 주 단위 교대, Q-DM-15 뮤트 종료 직후 밀린 단계
