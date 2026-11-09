# 검증 결과

| 날짜 | 시나리오 | 버전(커밋) | 페르소나 | 측정값 | 판정 | 캡처 |
|---|---|---|---|---|---|---|

## On-call 비교 (v1 vs v2)

평가: 독립 UX 평가(화면만 보고 판단, 명세·결정 문서 미열람). 2026-11-09. v1=`docs/ui/mockups/archive/index-v1.html`, v2=`docs/ui/mockups/index.html`. 1440·390px 캡처.

| 과제 | 버전 | 성공 | 단계/클릭 | 망설인 곳 | 잘못 내릴 수 있는 결론 | 확신(1-5) |
|---|---|---|---|---|---|---|
| T1 하은·390px 목요일 근무 민재에게 넘기기 | v1 | 부분 | 4~6+ (Add override → 폼 화면 미노출, 추정) | 주간 타임라인이 390px에서 가로로 잘려 Junho/Minjae 칸이 안 보임. "override"가 스왑인지 대타인지 모호. Save 버튼이 무엇을 저장하는지 불명 | Thu 12에 이미 "Minjae · override"가 있어 이미 처리된 걸로 착각 | 2 |
| T1 | v2 | 예 | 3 (상단 Cover or swap → 스크롤 → Who 민재 → Send request) | 상단 버튼이 폼으로 이동하지 않고 폼은 2화면 아래. "Or pick part of a shift"가 클릭 가능한지 불명 | 요청 보내면 바로 바뀐다고 착각할 여지는 낮음(PENDING·"You stay on call" 명시, 좋음) | 4 |
| T2 "Mirae Pay payments-db 지금 고장나면 누가·어떻게·언제?" | v1 | 부분 | 3 탭 이동(Schedules→Escalation→Now) | "Next in owner snapshot", "Everyone in snapshot" 용어. 순서가 두 개(On call now: 하은→준호→민재 / Team default order: 준호→하은→민재) | 2단계 SMS를 "Same person"이 아닌 다음 사람으로 오해. 서비스→정책 연결이 안 보여 payments-db가 이 정책인지 확인 불가 | 2 |
| T2 | v2 | 부분 | 1 화면(스크롤) | Mirae Pay는 URGENT 배지인데 화면의 문장은 Standard 기준("Slack Haeun now…"). Urgent는 "Call right away"뿐 — 누구에게, 그다음은? payments-db가 목록에 없음(payments-api, settlement, checkout만) | Standard 문장을 Mirae Pay에 적용해 "Slack 먼저, 2분 뒤 SMS"라고 틀리게 답함 | 2 |
| T3 준호 신규 고객 온콜 설정 | v1 | 부분 | 3단계 진입 후 "Contacts & order"까지 미확인(5단계 위저드) | 위저드가 AWS 단계에서 길고 온콜 단계는 화면에 없음. 정책 편집은 별도 탭 | 정책을 고객마다 새로 만들어야 한다고 생각 | 2 |
| T3 | v2 | 예 | 2 선택 + Continue (팀 1, 프리셋 1) | "+ New team" 이후 흐름 미노출. Urgent/Quiet 선택 시 문장이 바뀌는지 불명 | 서비스별로 다른 팀(checkout→Data team) 지정이 여기서 안 되므로 고객 전체 단일 팀이라고 오해 | 4 |
| T4 민재 지금 당번 확인 + Slack→전화 시간 변경 | v1 | 예 | 당번 0클릭(On call now), 시간 변경 2~3 (Escalation 탭 → 3단계 wait 5 수정 → Save changes) | 전화가 3단계(누적 7분)인데 입력값은 5 — 누적인지 간격인지 하단 각주를 읽어야 이해 | 5를 누적 시간으로 오해해 2분 줄이려다 잘못 수정 | 3 |
| T4 | v2 | 부분 | 당번 0클릭, 시간 변경은 "Advanced: edit steps" 접힘 안 → 최소 2~3 + 미노출 | 시간 변경 입구가 접힌 "Advanced"뿐. 팀 기본을 바꾸면 3고객 모두 바뀌는지, Mirae Pay(Urgent)엔 무관한지 경고 없음 | 팀 기본 편집이 한 고객만 바꾼다고 착각 | 2 |

### v2에 남은 문제 (심각도순)
| # | 문제 | 근거(화면) |
|---|---|---|
| 1 | 고객별 프리셋이 다를 때 "누가·언제" 문장이 Standard만 보여줌. Urgent는 "Call right away" 한 줄뿐, 대상·후속 단계 없음 | How we get alerted / Who uses this team(Mirae Pay URGENT) |
| 2 | 서비스·리소스 → 팀 매핑이 불완전. payments-db 같은 리소스로 검색·확인할 방법 없음, "checkout uses Data team" 각주로만 예외 표기 | Who uses this team |
| 3 | 현재 당번 모순: 월 03:16인데 "Haeun · On shift until 09:00"이고 Mon 9 행이 Haeun NOW. 순환(H→J→M, 24h, 09:00 교대)이면 일요일 8일 당번은 Minjae여야 함 | If something breaks now / Shifts |
| 4 | 단계·시간 편집이 "Advanced" 접힘 안에 숨고, 팀 기본 변경이 여러 고객에 미치는 영향 범위 표시 없음 | Advanced: edit steps, team default |
| 5 | 390px: "Cover or swap a shift" 버튼과 실제 폼이 2화면 떨어짐(앵커 없음), 상단 모크 탭·GNB가 잘려 On-call 메뉴가 화면 밖. 다음 주 행은 이니셜(JP/ML)만이라 야간 판독 어려움 | 390 캡처 |
| 6 | 기타: Remind/Cancel이 누가 기준인지 모호, "Or pick part of a shift: 18:00–23:00" 상호작용 여부 불명, 재알림(ack 후)·반복 횟수 설정 사라짐, 오버라이드 사유(sick leave) 기록 없음 | |

### v1이 더 나았던 점 (v2에서 잃은 것)
- 고객별 정책(Mirae Pay — Critical)이 단계·채널·대기·반복·ack 후 재알림까지 한 화면에 명시 + 누적 시간 프리뷰(0′·2′·7′·12′…24′ stop).
- 버전·편집자 표시("version 7, edited by Junho Park on Nov 6") — 변경 추적.
- 기존 오버라이드 목록과 사유, 시간 단위 타임라인(부분 시간대 대타가 시각적으로 보임).

판정: v2가 하은(T1)·준호(T3)에는 확실히 개선(쉬운 말, 한 화면, PENDING 상태). 그러나 T2(“지금 이게 터지면 누가?”)는 두 버전 모두 화면만으로 정답 불가이며 v2는 틀린 답을 자신 있게 유도함. 문제 1~3 해결 전 파일럿 불가(P1).

## On-call·Contacts 재점검 (v3)

평가: 독립 UX 평가자, 2026-11-09, `docs/ui/mockups/index.html` (브랜치 docs/ui-specs), 1440·390 스크린샷만 근거로 판단(명세·결정 미열람).

### 과제 결과

| 과제 | 성공 | 클릭 | 망설인 지점 | 그럴듯한 오답 | 확신(1-5) |
|---|---|---|---|---|---|
| T1 하은(폰) 토요일 근무 대타·교환 | 예 | 2~3 | 폰에서 "Who gets paged for…" 박스가 맨 위에 있어 Cover 버튼까지 스크롤해야 함. PENDING 배너와 "You stay on call" 문구는 명확 | 요청만 보내면 이미 빠진 줄 앎 → 배너가 막아 줌 | 5 |
| T2 payments-db-1이 지금 터지면 누가·어떻게·언제·고객 누구에게 | 부분 | 0(On-call) / 탭 3개 비교 | 탭마다 답이 다름(아래 불일치 1). Resource detail은 orders-api-1(Hanbit)만 보여서 교차 확인이 불가 | Incident 타임라인을 보면 "Slack→2분 SMS→7분 Junho 전화(Standard)"가 맞다고 결론냄. On-call은 "즉시 전화→5분 Junho(Urgent)" | 2 |
| T3 준호 신규 고객 온콜 온보딩 | 부분 | 3~4 | 팀 카드에 Infra "Haeun, Junho, Minjae"(3명)라고 나오는데 On-call은 6명. Data 팀 "Sora, Taeyang"인데 Contacts의 Data 팀은 Yuna Kwon 외 1명이고 Sora는 Infra 소속 | 팀원 구성을 잘못 믿고 엉뚱한 팀을 고름. 고객 담당자는 "Contacts page"에 추가하라고 안내하지만 Contacts는 직원 전용 | 3 |
| T4 민재 Mirae Pay만 Slack→전화 시점 변경 | 아니오 | ? | "Advanced: edit timing"이 팀 프리셋 수준에 있음. Mirae Pay는 Urgent(즉시 전화, Slack 없음)인데 사건 화면은 "Mirae Pay — Critical" 정책에 Slack 단계가 있음. 고객 단위 편집 진입점을 찾을 수 없음 | 팀의 Urgent 타이밍을 고쳐서 같은 프리셋을 쓰는 다른 고객까지 바꿈 | 1 |
| T5 준호 미인증 채널 전체 찾아 링크 발송 | 부분 | 직원 1 + 고객 1~2 | 직원과 고객이 두 화면으로 나뉨(Contacts "(5)" / Customers "Send links to all 7"). 숫자가 4·5·7·26/32로 서로 맞춰지지 않음. "Slack not set"은 링크로 해결되지 않음 | 직원 쪽 버튼 하나로 전부 처리했다고 생각함 | 3 |
| T6 Daon Retail Checkout 전용 고객 담당자 + 승인권 | 부분 | 4~5 | 고객 전환 → 트리에서 서비스 선택 → "Add person here" → Approver + "This service only" 흐름은 좋음. 다만 예시 트리의 Checkout은 Mirae Pay 소속이고 Daon의 서비스명은 화면에 없음 | Mirae Pay › Checkout에 추가해 버림. 승인 채널이 People에서는 "Slack or email", 사건 화면에서는 "Slack only, Operator or higher"로 다름 | 3 |
| T7 6명 팀에서 지금 4번째 | 부분 | 1(펼치기) | 4번째부터는 "+3 more (Jiwoo, Sora, Dohyun)"로 접혀 있고 번호가 없음. 09:00 전후로 순서가 바뀜 | 접힌 이름의 나열 순서를 4·5·6번으로 볼지 확신할 수 없음. Fri 13 부분 대타가 순번에 영향을 주는지 알 수 없음 | 3 |

### 탭 간 데이터 불일치

| # | 내용 | 위치 |
|---|---|---|
| 1 | Mirae Pay 호출 방식: On-call은 Urgent "즉시 Haeun 전화→5분 Junho→10분 전원→20분 종료". Incident 헤더는 "Haeun called 03:12 → Junho at 03:17 · Urgent". 타임라인과 Escalation 패널은 "Slack 03:12 → SMS 03:14 → Junho 전화 03:19 → 전원 03:24"(Standard 타이밍) + 정책명 "Mirae Pay — Critical" | On-call / Incident detail |
| 2 | Infra 팀 6명 vs 온보딩 카드 3명. Data 팀 2명(Yuna Kwon…) vs 온보딩 "Sora, Taeyang" | On-call / Contacts / Onboarding |
| 3 | 원격 수정 승인: "Slack or email (D-15)" vs "Slack only (#mirae-ops), Operator or higher" | People / Incident |
| 4 | 미인증 건수: 사이드 배지 4, 버튼 (5), Needs action 4, 고객 7, Mirae Pay People 배지 2 vs Customers 표 PEOPLE "6 2" | Contacts / Customers / People |
| 5 | 이름이 비슷해 혼동됨: Yuna Seo(고객) / Yuna Kwon(직원), Dohyun Kang(직원) / Dohyun Yoon(고객) | 전반 |
| 6 | Resource detail 예시가 payments-db-1이 아니어서 T2 교차 확인 불가 | Resource detail |

### 용어·화면·확장성

| 구분 | 내용 |
|---|---|
| 용어 | "(D-15)"처럼 내부 결정 번호가 화면에 노출됨. preset, inherit, PRD, M of N, Owner snapshot, Remediator role 등 |
| 레이아웃 | 390px에서 가로 스크롤은 없음. 다만 하은에게는 "Who gets paged" 박스가 Cover 버튼보다 위에 있음. Customers 표는 390px에서 열이 잘림. 상단 내비게이션 "On-call"이 잘림 |
| 확장성 50+명 | 순번이 "+N more"로 접혀 있고 번호가 없음. Contacts는 팀별 카드를 펼치는 방식이라 검색·필터·일괄 선택이 없음 |
| 확장성 30+고객 | "Who uses this team"을 고객별 카드로 나열하는 구조. 미인증 고객 담당자는 "+4 more" 접힘만 있음. 프리셋 3개를 공유하므로 고객별 예외 타이밍을 넣을 자리가 없음 |

### 우선순위

- P1: 탭 간 호출 방식 불일치(불일치 1). T2에서 틀린 답을 자신 있게 유도함.
- P1: 고객 한 곳만 타이밍을 바꾸는 경로가 없고, 바꾸면 다른 고객에 번질 위험(T4).
- P2: 온보딩의 팀 구성 표시 오류, 고객 담당자 추가 위치 안내 오류(Contacts가 아니라 People).
- P2: 미인증 건수가 화면마다 다르고 직원·고객 일괄 발송이 나뉘어 있음.
- P2: 승인 채널·권한 문구 불일치, 내부 결정 번호(D-15) 노출.
- P2: 순번 4번째 이하에 번호 없음. 대규모 팀·고객에 대비한 검색·필터 없음.

판정: 하은(T1)은 파일럿 수준에 도달함. 하지만 "지금 터지면 누가 어떻게"(T2)는 탭끼리 서로 다른 답을 보여 주고, 고객별 타이밍 변경(T4)은 경로가 없음. P1 두 건을 해결하기 전에는 파일럿 불가.

## Responders 모델 점검 (v4)

- 일시: 2026-11-09 · 대상: `docs/ui/mockups/index.html` (브랜치 docs/ui-specs) · 1440px / 390px 스크린샷 기준
- 방식: 명세·결정 문서를 읽지 않고 화면만 보고 판단한 독립 평가

### 과제별 결과

| 과제 | 페르소나 | 성공 | 클릭 | 망설임 | 그럴듯한 오판 | 확신(1-5) |
|---|---|---|---|---|---|---|
| T1 Mirae Pay payments-db-1 누가·어떻게·언제 | 준호/소연 | 성공 | 1~2 | 낮음 | 사건 상세 상단 "call Haeun + all"을 "Haeun과 몇 명"으로 읽음(다른 화면은 "everyone in Responders (5)"). Data platform 오버라이드가 Core에도 적용된다고 오해할 여지 | 4 |
| T2 준호 휴가 11/20~24 → 민재 일괄 교체 | 준호 | 성공 | 3~4 | 중간 | 날짜 단위 입력인데 교대는 09:00~09:00. Thu 19 교대(→11/20 09:00)는 포함 안 됨, Tue 24 교대는 11/25 09:00까지 넘어감. "Junho left out"으로 everyone 인원이 줄어드는 것을 위험으로 표시하지 않음 | 3 |
| T3 Daon Retail 고객 담당자 추가, step 2에 전화 | 준호 | 부분 | 3 | 높음 | Daon은 All at once인데 "New step 2"를 고르면 기존 step 2(2분 SMS)가 밀리는지, 방식이 Custom으로 바뀌는지 안 보임. Pageable이면 이미 "everyone"에 포함되어 step 1부터 받는다는 점과 충돌 | 2 |
| T4 신규 고객 "everyone at once" | 준호 | 성공 | 1~2 | 낮음 | 없음(온보딩 3단계 + 미리보기 문장이 명확) | 5 |
| T5 준호 담당 고객 전체·현재 근무 | 준호 | 성공 | 2 | 낮음 | 헤더 "covers 12 customers"인데 목록은 11개만 보임(Jeil Insure 누락/잘림) | 3 |
| T6 하은 폰에서 night desk 교대 맞바꿈 | 하은 | 부분 | 2~3 | 중간 | 자기 행(Sun 8 NOW)에는 Swap 없음. Fri 13 행 "Haeun Kim 18:00–23:00 Junho → Minjae?"가 배너("Minjae에게 대리 요청")와 모순되어 누가 누구와 바꾸는지 혼란 | 2 |
| T7 night desk 순서 변경 + 영향 고객 | 민재 | 부분 | 2 | 중간 | 영향 고객(USED BY 6)은 잘 보이나 멤버·순서 편집 진입점(Edit/드래그)이 화면에 없음. "everyone"에 같은 사람이 있는 고객(Cheong 등)은 영향 없음이 맞지만 설명 없음 | 3 |
| T8 30+ 고객 중 호출 가능 담당자 없음/검증된 전화 없음 찾기 | 준호 | 실패 | 3+ | 높음 | Needs action은 사람·채널 단위라 "고객 단위로 호출 불가"를 못 찾음. Customers 표의 "2 need action"은 정렬·필터 불가. 모든 담당자가 SMS/Voice 미검증인 고객을 정상으로 오판 | 1 |

### 불일치·용어·레이아웃·규모

| 구분 | 위치 | 내용 | 등급 |
|---|---|---|---|
| 레이아웃 | On-call › Now, 390px 고객별 카드 "THEN" | 문장 조각이 열로 쪼개져 읽을 수 없음(인라인 요소가 세로 칸으로 배치) | P1 |
| 기능 공백 | Customers / Needs action | 고객 단위 "호출 가능자 0명 / 검증 전화 0명" 필터·경고 없음 | P1 |
| 불일치 | Rotations Fri 13 | 행 문구와 PENDING 배너 내용 모순 | P1 |
| 모델 모호 | Responders › Add person "Call them at" | All at once 고객에서 step 지정 시 결과(방식 전환·기존 step 재번호) 미표시 | P2 |
| 시간 경계 | Leave & replace | 날짜 단위 입력 vs 09:00 교대 경계, everyone 축소 경고 없음 | P2 |
| 수치 불일치 | People › Junho | 12 customers vs 목록 11 | P2 |
| 진입점 | Rotations | 멤버·순서 편집 버튼 없음 | P2 |
| 레이아웃 | Rotations, 390px CUSTOMER ROTATIONS 표 | 가로 넘침(CUSTOMER 배지 잘림) | P2 |
| 용어 | 전반 | "night desk"인데 24h 교대, "Haeun + all" vs "everyone in Responders", "Used by 1 customers" 복수형 | P2 |
| 규모 | Now 고객별 표 | 12개도 길다. 30+면 "문제 있는 고객만" 기본 필터 필요 | P2 |
| 양호 | T1 네 화면 | 순서·시간·채널이 동일 문장으로 일관, 사건 상세는 실제 시각으로 환산 | — |

### 판정
조건부 통과 아님 — P1 3건(모바일 THEN 깨짐, 고객 단위 호출 불가 탐지 없음, Fri 13 모순) 수정 후 재점검.
