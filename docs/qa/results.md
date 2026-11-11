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

### v4 수정 반영 (2026-11-09, 재점검 대기)
- P1 모바일 THEN: 단계별 한 줄 세로 배치. P1 고객 단위 탐지: pagingHealth 4종(D에서 계산) → Customers 열·필터, Now 기본 필터(10곳 초과), Customer 배너. 샘플 Kumho Clinic·Lumen Bank 추가. P1 Fri 13: 수락 대리(Wed 11)와 대기 요청(Fri 13 전체) 분리.
- P2: Custom 전환 경고+Before/After, Leave 교대 경계(Thu 19 09:00 → Wed 25 09:00)·축소/유일 호출자 경고, Junho 12 전부 표시, Rotations 편집 진입점+영향 미리보기, 390 카드, 용어·복수형·교대 시각.
- 화면 워크스루(작성자): T1–T8 화면에서 답 확인. T8: Customers › Paging problems → Kumho Clinic, Lumen Bank 외 계산상 문제 고객(Hanbit·Haneul·Iruda: 미검증 채널)도 표시됨.

## 최종 점검 (v5) — 2026-11-09

독립 평가자 관점, 화면만 보고 판단(명세 미참조). 대상: `docs/ui/mockups/index.html` (D-32 2단계 연락 상태 반영 커밋 이후). Playwright, 1440·390px. 캡처: `docs/ui/mockups/shots/v5-*.png`.

### 시나리오

| 시나리오 | 페르소나 | 결과 | 클릭 | 헤맴 | 관찰 | 점수(5) |
|---|---|---|---|---|---|---|
| T1 Mirae Pay payments-db-1 누가 호출되나 | 하은 | 성공 | 1~2 | 낮음 | Now 조회·Resource·Responders 모두 "Slack+call Haeun(night desk) → 10분 Yuna → 15분 everyone(5) → 1회 반복 → 30분 정지"로 동일. Incident는 03:12/03:22/03:27 실제 시각으로 환산, 일치 | 5 |
| T2 준호 휴가 11/20–24 → 민재 | 준호 | 성공 | 3 | 낮음 | 교대 단위 경계(Thu 19 09:00 → Wed 25 09:00), 넘어가는 교대 3건, everyone 축소 16건 경고가 적용 전 보임. Hanbit on-call(10:00 교대)도 "09:00에 복귀"로 표기돼 경계 규칙과 살짝 어긋남(P3) | 4 |
| T3 Daon에 고객 담당자 추가, step 2로 전화 | 준호 | 성공 | 3 | 낮음 | All at once → Custom 전환 경고와 Before/After가 명확. 단 **BEFORE에 아직 추가 안 된 Jaehyun이 everyone(4)로 이미 포함**(P2) | 4 |
| T4 신규 고객 all-at-once | 준호 | 성공 | 2 | 낮음 | 온보딩 5단계·진행 저장·다음 단계 입구 명확 | 5 |
| T5 준호 담당 12곳 + 현재 근무 | 준호 | 성공 | 1 | 낮음 | 12곳 전부·경로(template/added/rotation) 표시, 현재 Hanbit on-call. 단 **Rotations의 Wed 11 "Junho covers 18:00–23:00 (accepted)"가 준호 Upcoming shifts에 없음**(P2) | 4 |
| T6 하은 폰에서 night desk 교대 | 하은 | 성공 | 2 | 낮음 | 자기 행(Sun 8 NOW) "Cover or swap" → 폼(대상·전체/일부·사유), 수락 전 변경 없음 안내. 390에서 깨짐 없음 | 5 |
| T7 night desk 순서 편집 + 영향 고객 | 민재 | 성공 | 2 | 중간 | 영향 6곳, everyone 불변 설명, Before→After 교대 목록. 단 **순서 변경이 지금 근무 중(Sun 8 NOW Haeun→Junho)과 대기 요청(Fri 13)을 바꾸는데 경고 없음**(P2) | 4 |
| T8 Unreachable vs At risk 고객 찾기 | 준호 | 성공 | 1 | 낮음 | Customers 칩 Unreachable 3 / At risk 2, 빨강 먼저 정렬, 행 좌측 빨강/노랑 띠, 정의 문장. Now도 같은 칩(10곳 초과 시 문제 고객만 기본). 샘플이 14곳이라 30+ 규모는 직접 확인 못 함(P2, 데이터 한계) | 4 |

### 불일치·용어·레이아웃 (16개 화면 스캔)

| 구분 | 위치 | 내용 | 등급 |
|---|---|---|---|
| 불일치 | Responders › Add person 미리보기 | BEFORE가 추가 후 인원(4, Jaehyun 포함)을 보여 줌 | P2 |
| 불일치 | People › Junho vs Rotations Wed 11 | 수락된 부분 대리(18:00–23:00)가 개인 일정에 없음 | P2 |
| 경고 누락 | Rotations › Edit members & order | 현재 교대·대기 중 요청에 영향 주는 변경에 경고 없음 | P2 |
| 규모 | Customers / Now | 샘플 14곳. 30+에서 칩·정렬은 동작하겠지만 화면으로 미검증 | P2 |
| 표현 차이 | Haneul Air 배너 vs Now | 배너 "step 4 (call Junho, Sora)" vs Now "call everyone in Responders (2)" | P3 |
| 시간 경계 | Leave & replace | 10:00 교대 로테이션도 "Wed 25 09:00 복귀"로 표기 | P3 |
| 용어 | Now Responders 열 | "1 incl. 1 customer person" 어색 | P3 |
| 용어 | 고객 예시 선택 | "(paging problem)" — 2단계(Unreachable/At risk) 미반영 | P3 |
| 레이아웃 | 390px 전 화면 | 페이지 가로 스크롤 없음(상단 목업 탭 바만 자체 스크롤), 콘솔 오류 0 | — |
| 양호 | D-32 | 2단계가 Customers 열·칩, Now 칩·정렬, Responders 배너(빨강/노랑, ●/▲)에 일관 | — |

### 판정
**통과** — P1 없음. P2 4건은 다음 화면 이슈로 추적(구현 전 수정 권장).

## Console 로그인 점검 — 2026-11-10

대상: `apps/console` (feat/console-scaffold, origin/main 병합 후 `next build` → `next start -p 3107`, MOCK_API=1). 페르소나 하은(P1, 새벽 Slack 핑 링크로 진입). Playwright, 390×844·1440×960, light. 캡처: `docs/qa/shots/console/login-{390,1440}.png`, `login-landed-{390,1440}.png` (스크립트 `apps/console/e2e/login-shots.ts`).

| 단계 | 390 | 1440 | 관찰 |
|---|---|---|---|
| 세션 없이 인시던트 링크 진입 | `/login?next=%2Fincidents%2Finc-…`로 이동 | 동일 | 원래 가려던 주소가 `next`에 보존됨 |
| 로그인 화면 | Sign in 카드 1개, 가로 스크롤 없음 | 카드 상단 중앙, 깨짐 없음 | "Continue with Google"은 비활성, 아래에 "Google SSO is not connected in this build. Mock mode: sign in as Haeun Kim (dev) →" |
| dev sign-in 클릭 | 인시던트 상세로 바로 도착 (약 1.2초) | 동일 (약 0.9초) | 클릭 1번. 목록을 거치지 않고 의도한 페이지 h1 "payments-db-1 FreeStorageSpace below 10 GB" 표시, 우상단 아바타 HK |
| 도착 화면 | Acknowledge가 첫 화면 안, 전체 폭 버튼 | Acknowledge 우상단 | 로그인 포함 Ack까지 클릭 2번 (성공 기준 3번 이하 충족) |

| 구분 | 위치 | 내용 | 등급 |
|---|---|---|---|
| 터치 영역 | /login 390 | 유일하게 동작하는 "sign in as Haeun Kim (dev) →" 링크가 156×14px 본문 크기. 졸린 상태로 폰에서 누르기 작음. mock 전용이지만 44px 높이 권장 | P2 |
| 위계 | /login | 가장 크게 보이는 버튼(Continue with Google)이 비활성이라 먼저 눌러 보게 됨. 설명 문구가 바로 아래 있어 헤맴은 짧음. SSO 연결 시 해소 | P3 |
| 콘솔 오류 | 전 화면 | `ERR_TUNNEL_CONNECTION_FAILED` 2건 — 외부 폰트 요청이 점검 환경 프록시에서 막힌 것으로 보임(스모크 테스트도 fonts 도메인은 제외). 앱 오류 없음 | — |

**판정: 통과** — P1 없음. 다크 테마·실제 Google SSO 경로는 이번 점검 범위 밖.

## Console 범위 틀 점검 — 2026-11-10

대상: `apps/console` (feat/console-scope, 커밋 `1fa37ca`), `MOCK_API=1 next dev -p 3117` (개발 서버. 준호 시나리오는 `MOCK_CUSTOMERS=34`로 재기동). Playwright로 실제 화면을 조작, 1440×900 · 1280×900 · 1024×768 · 390×844(터치), 라이트·다크. 판정은 화면과 스크린샷만으로 했고 제품 소스는 읽지 않음. 캡처: `docs/qa/shots/console-scope/qa-1110/` (gitignore 대상, 로컬 전용). 디자인 기준: `docs/ui/mockups/scope-variants.html` 변형 E.

### 시나리오 결과

| # | 페르소나·폭 | 시나리오 | 결과 | 클릭/탭 | 관찰 | 캡처 |
|---|---|---|---|---|---|---|
| H1 | 하은 390 | 로그아웃 상태로 인시던트 링크 → 로그인 → 그 인시던트 도착 | 통과 | 1 | `/incidents/<id>` → `/login?next=…` → dev sign-in 1탭 → `/c/mirae/core/payments-api/incident/<id>` 패널로 바로 도착. 가로 스크롤 없음. 로그인 링크는 여전히 156×14px (이전 점검 P2 그대로) | h-01, h-02 |
| H2 | 하은 390 | 목록에서 Mirae Pay payments 인시던트 찾기, 고객/프로젝트/서비스 말하기 | 통과 | 0 (스크롤 1) | 카드에 "Mirae Pay › Core › Payments API" 한 줄로 읽힘. 다만 첫 화면(844px)은 배너+통계 5칸이 차지해 첫 인시던트 카드는 스크롤해야 보임 (P2-5) | h-03 |
| H3 | 하은 390 | 목록에서 Acknowledge → Undo | 부분 (P1-1, P1-3) | 2 | Ack 44px 버튼 1탭 → ACK'D, 토스트 "Acknowledged in Mirae Pay › Core › Payments API · … Undo" 약 9초, Undo 1탭 → "Acknowledge undone … paging continues", 배지 4→3→4. 하지만 토스트가 폰에서 깨지고(P1-3), Ack한 행이 아래로 내려가면서 같은 자리에 다음 인시던트의 Acknowledge가 올라옴(P1-1) | h-05, h-06 |
| H4 | 하은 390 | 패널(링크로 도착한 화면)에서 Acknowledge → Undo | 실패 (P1-2) | 1 | Ack 후 Undo가 어디에도 없음(토스트 없음, 목록 행에도 없음). Acknowledge 자리에 Resolve 버튼이 그대로 들어옴 | m-03 |
| H5 | 하은 390 | 시트로 타이핑 없이 Daon Retail › Commerce › Checkout | 통과 | 4 | Showing 버튼 → Daon Retail → Commerce → Checkout. 시트 항목 전부 44px 이상, 단계 탭(1·Customer/2·Project/3·Service)으로 위치가 보임. 주소 `?customer=daon&project=commerce&service=checkout` | h-07~h-10 |
| H6 | 하은 390 | 필터 켠 상태에서 "Outside this view" 읽기 | 통과 (P2-3 용어) | 0 | "Outside this view: 4 open (1 from an unmapped account) · 2 acknowledged" 가 필터 줄 바로 아래. ? 버튼 설명이 정확함. 줄을 누르면 필터 해제된 목록으로, 뒤로 가기 시 필터 복귀. 단 같은 화면의 "Open 1" 탭과 "0 open" 문구가 서로 다른 뜻 | h-10, h-11 |
| H7 | 하은 390 | 고객 3번 바꾸기 (Mirae Pay → Hanbit → Bora) | 통과 | 4, 3, 3 | 열기 → 고객 → "Use <고객> only". 서비스까지 좁힌 상태에서 다시 열면 3단계(서비스)에서 시작해 "1 · Customer" 탭 1번이 더 듦. 고객 행을 누르면 바로 적용되지 않고 프로젝트 단계로 감(하단 파란 버튼으로 확정) | h-12~h-14 |
| J1 | 준호 1440, 34곳 | 트리 훑기 | 통과 (P2-6) | — | My customers 7 / Other customers 27 그룹, 그룹 제목 고정. Other 27곳이 이름순이 아님(… Zio Fashion, Nuri Soft, Maru Homes …) | j-01, j-05 |
| J2 | 준호 1440 | "Only with problems" | 통과 | 1 | 34곳 → 5곳(Mirae Pay, Daon Retail, Hanbit, Kumho Clinic=Unreachable, Lumen Bank=At risk), 접힌 그룹 자동 펼침, "1 of 7 / 4 of 27" 표기. 목록 필터는 안 바뀜 | j-02 |
| J3 | 준호 1440 | 키보드만으로 선택 (화살표, 타이핑) | 부분 (P2-1) | — | 트리 안에서는 ↑↓←→, Home/End, Enter 선택, 타이핑 이동("dao"→Daon Retail, "han"→Hanbit, 접힌 그룹 안도 찾음) 동작. 하지만 새로 연 화면에서 첫 Tab이 LEGEND로 가서 상단 메뉴·트리를 건너뜀. Space는 선택 안 됨(P3) | j-03~j-05 |
| J4 | 준호 1440 | 인시던트 패널 열기 — 트리가 내용을 밀어내는가, 목록이 쓸 만한가 | 통과 (P2-4) | 1 | 트리 272 + 목록 약 688 + 패널 442. 목록은 Sev/Status/고객/인시던트/Ack 열 유지(Paged·Age 열은 숨김), 가로 스크롤 없음, 다른 행 클릭 시 패널만 교체. 통계가 2줄로 접히며 목록 첫 행이 y≈605 → 900px 높이에서 2.5행만 보임 | j-11-panel-1440 |
| J5 | 준호 1280 | 1408 미만 자동 레일, 다시 펼치기 | 통과 | 1 | 패널 열면 1407px 이하에서 트리가 45px 레일(세로 "All customers" + 펼침 버튼)로, 패널 닫으면 복귀. 레일 버튼 1번으로 패널 옆에 트리 재펼침(목록은 카드형 530px로 유지). 1024에서 재펼침하면 목록이 숨고 "← Back to the list"만 남음 | j-11-panel-1280, j-13, j-32 |
| J6 | 준호 1440 | 딥 링크 복사 → 새로고침 → 뒤로/앞으로 | 통과 | 1 | Copy link → "Copied" + 클립보드에 내 필터가 빠진 `/c/mirae/core/payments-api/incident/<id>`. 새 탭에서 열면 All customers + 같은 패널. 새로고침 시 필터·패널 유지. 뒤로 3번(패널→필터 목록→전체), 앞으로 2번 모두 주소·필터 줄·트리 선택·패널이 일치 | j-40, j-41 |
| J7 | 준호 1440 | 없는 고객 slug → Not found | 통과 | — | `?customer=nope`, `/c/nope/…`, 없는 인시던트 id, 프로젝트 불일치, 다른 고객 경로에 남의 인시던트 id 모두 같은 "Not found — There is nothing to show at this address" + Back to Incidents. 상단 메뉴·트리 유지, 존재 여부를 구분해 주지 않음(좋음) | j-43, j-44 |
| N1 | 신입 1440 | 이름을 모른 채 문제 있는 고객 찾기 | 통과 | 1 | 기본 화면에서도 Mirae Pay에 빨간 1, 접힌 "Other customers"에 UNREACHABLE·2 요약이 보임. "Only with problems" 1클릭이면 5곳만 남음 | n-01 |
| N2 | 신입 1440 | Mirae Pay의 서비스 알아내기 | 통과 | 4 | ▸ Mirae Pay → Core(Payments API, Settlement, Checkout) / Merchant(Merchant portal) / Data platform(Ledger). 프로젝트마다 한 번씩 펼쳐야 함 | n-02 |
| N3 | 신입 1440 | 트리 태그를 도움 없이 이해 | 부분 (P2-7) | 0 | LEGEND가 기본으로 펼쳐져 있어 n / UNREACHABLE / AT RISK는 문장으로 이해됨. "OWN STEPS — own call order", "own steps inside (collapsed)"는 steps가 뭔지 몰라 추측. "Only with problems" 옆 숫자 5는 설명 없음(마우스 올려야 나옴) | d-01 |
| S1 | 1440·390 | 스텁 화면(Monitoring, Call order, People, Maintenance, Settings)의 틀·범위 일관성 | 통과 | 각 1 | 필터(Daon Retail › Commerce)를 켠 채 이동하면 주소 쿼리·필터 줄·트리 선택이 그대로 따라옴, 본문은 "This list will show Daon Retail › Commerce". Settings만 트리가 사라지고 "MSP-wide settings · all 34 customers"로 바뀌며, Incidents로 돌아오면 필터 복귀. 390에서도 동일, 가로 스크롤 없음 | s-* |

### 문제 목록

| 등급 | # | 문제 | 재현 |
|---|---|---|---|
| P1 | 1 | 목록에서 Ack하면 그 행이 Ack'd 묶음으로 내려가고, 방금 누른 자리에 다음 인시던트의 Acknowledge 버튼이 올라온다. 졸린 상태의 두 번 탭/더블클릭이 다른 고객의 인시던트를 Ack한다 | 390 또는 1440, `/incidents` → Mirae Pay 행 Acknowledge → 같은 좌표에 "Acknowledge api-alb 5XX rate above 2%"(Hanbit)가 위치 (h-05, m-09) |
| P1 | 2 | 패널에서 Ack하면 Undo가 없다. 토스트도 없고 목록 행에도 Undo가 안 생긴다. Acknowledge가 있던 자리를 Resolve 버튼이 덮어(390: x193–361, Ack는 x228–361) 두 번 탭하면 Resolve가 눌린다. Ack 후에도 "→ call Yuna 03:22 → call everyone…"이 그대로 남아 호출이 멈췄는지 알 수 없음 | 390 또는 1440, `/c/mirae/core/payments-api/incident/inc-7f3a0c91b2d4-20261108181204` → Acknowledge (m-03, m-10). Slack 링크로 들어온 하은의 기본 경로 |
| P1 | 3 | 폰에서 Ack 토스트가 깨진다. 폭 약 195px 상자에 글이 "Acknowle/dged in/Mirae/Pay ›…" 12줄로 쪼개지고 화면 가운데 카드 2개를 가린다. Undo 버튼은 52×44로 눌리긴 함 | 390, `/incidents` → 아무 행 Acknowledge (h-05). 1440에서는 640px 한 줄로 정상 |
| P2 | 1 | 새로 연 화면에서 첫 Tab이 트리 아래 LEGEND 버튼으로 간다. Skip to content, 상단 메뉴, Find by name, Only with problems, 트리를 모두 건너뛰어 키보드 사용자는 Shift+Tab으로 거슬러 올라가야 한다 | 1440, `/incidents` 또는 `/people` 로드 직후 Tab 1번 |
| P2 | 2 | 트리를 레일로 접어 둔 뒤 새로고침하면 첫 그림은 272px 트리로 나왔다가 약 0.3초 뒤 45px 레일로 줄어든다(본문이 옆으로 튐). 테마(다크)는 깜빡임 없음. 개발 서버 측정이라 빌드본에서 재확인 필요 | 1440, « 클릭 → 새로고침, 프레임별 폭 272→45 |
| P2 | 3 | "open"이 두 뜻으로 쓰인다. 탭 "Open 7"은 Ack 포함, 제목 줄 "7 incidents listed, 4 open"·배지 4·"Outside this view: 4 open"은 Ack 제외. 필터 뒤 "Open 1" 탭 바로 위에 "0 open" | `/incidents`, `/incidents?customer=daon&project=commerce&service=checkout` (h-10) |
| P2 | 4 | 패널을 열면 통계 5칸이 2줄로 접히고 배너도 2줄이 되어 목록 첫 행이 화면 아래쪽(y≈605/900)으로 밀린다. 1440·1280·1024 공통. 패널이 열렸을 때는 통계를 줄이거나 접는 편이 낫다 | 1440, 아무 행 열기 (j-11) |
| P2 | 5 | 폰 첫 화면에 인시던트가 한 건도 안 보인다. 배너 + 통계 5칸(약 500px) + 탭·필터 뒤에 첫 카드가 y≈745에서 시작해 하단 메뉴에 가린다. 하은의 "스크롤 없이 가장 심각한 것" 기준 미달(숫자 "1 SEV-1 · oldest 26m"는 보임) | 390, `/incidents` (h-03) |
| P2 | 6 | 34곳일 때 Other customers 27곳이 이름순이 아니어서 눈으로 찾기 어렵다. 타이핑 이동·Find by name으로 보완은 됨. 폰 시트도 같은 순서 | 1440, `MOCK_CUSTOMERS=34`, Other customers 펼침 (j-05) |
| P2 | 7 | "OWN STEPS / own call order / own steps inside" 설명이 용어를 되풀이할 뿐이라 처음 보는 사람은 뜻을 모른다. 예: "has its own paging order, different from the customer's" 같은 문장 필요. 폰 시트에는 범례가 아예 없음(OWN STEPS, Unreachable, At risk 태그만 표시) | 1440 LEGEND, 390 시트 2단계 (h-13) |
| P2 | 8 | 필터 줄이 폰에서 스크롤과 함께 사라진다. 목록을 내리면 지금 어떤 고객으로 좁혀 보고 있는지, "Outside this view"가 몇 건인지 안 보인다 | 390, 필터 켠 뒤 300px 스크롤 |
| P3 | 1 | 패널 제목(고객 › 프로젝트 › 서비스)이 442px 패널과 390에서 2줄로 접히며 둘째 줄이 "›"로 시작. 도착 시 제목에 굵은 파란 포커스 테두리가 남아 강조처럼 보임 | j-11-panel-1440, h-02 |
| P3 | 2 | 트리에서 Space로 선택 안 됨(Enter만). 트리에 포커스가 있을 때 Esc로 패널이 안 닫힘. 맨 아래 고객을 →로 펼치면 자식이 범례 뒤로 내려가 안 보임 | j-05 |
| P3 | 3 | 패널이 열린 채 트리에서 다른 고객을 고르면 패널이 닫히고 목록으로 돌아간다("Opening a row never changes what this list shows"의 반대 방향은 안내 없음) | 1440, 패널 연 뒤 Bora Foods 클릭 |
| P3 | 4 | "Other customers …"가 272px에서 말줄임되어 "· 27" 개수가 안 보임. 펼친 범례가 트리 높이 약 170px을 계속 차지(기준 목업은 "What do these mean?" 링크 한 줄) | d-01 |
| P3 | 5 | 폰 하단 메뉴 "Incidents"가 왼쪽 가장자리에 붙음(x≈2). 브라우저 탭 제목이 모든 화면에서 "AlarmOps" | h-03 |
| P3 | 6 | 다크에서 목록·패널의 "›" 구분자가 거의 안 보임. 그 밖의 다크 대비·배지 색은 양호 | k-02 |
| P3 | 7 | 서비스까지 좁힌 뒤 시트를 다시 열면 3단계에서 시작(고객 바꾸려면 탭 1번 추가). "All projects"와 "Use <고객> only"가 같은 동작 | h-12 |
| P3 | 8 | 목 데이터: Hanbit api-alb는 목록에 "Escalated · Junho called 03:12"인데 패널은 "No events yet / No paging steps / Notifications 0". Ack된 인시던트만 있는 고객은 "Only with problems"에서 빠짐(5→4) | j-13 |

### 디자인 기준(변형 E)과 비교

| 항목 | 판단 |
|---|---|
| 틀 | 상단 메뉴 · Showing 줄 · 272px 트리 · 본문 · 패널 구성이 목업과 같음. 간격·정렬·글꼴 굵기 일치, 1440/1280/1024/390 어디서도 페이지 가로 스크롤 없음 |
| 다른 점 | Settings가 상단 메뉴 안으로(목업은 우측 버튼), "Filter to… Ctrl K" 검색 없음, 통계가 5칸(목업 4칸: Listed 대신 Resolved·Muted), 범례가 기본 펼침 |
| 글 잘림 | 폰 토스트(P1-3), "Other customers …"(P3-4), 패널 제목 줄바꿈(P3-1) 외에는 없음 |
| 첫 그림 | 테마·필터 줄·트리 선택·패널은 첫 프레임부터 맞게 나옴. 접힌 레일만 깜빡임(P2-2) |
| 다크 | 1440·390 목록/패널/스텁 모두 깨짐 없음. 구분자 대비만 약함(P3-6) |
| 터치 | 390에서 44px 미만: Sev·Assignee 선택(42px), 패널 안 텍스트 링크(Open resource 20px, Call order for Mirae Pay 18px, Runbook 15px) |
| 콘솔 오류 | 앱 오류 0건 (Not found 주소의 404 응답 로그만) |

### 판정

**머지 보류 — P1 3건.** 범위 틀 자체(트리, 시트, 주소에 담긴 필터, 딥 링크, 뒤로/앞으로, Not found, 스텁 일관성, 자동 레일)는 세 페르소나 모두 통과했고 목업 E와도 잘 맞는다. 막는 것은 전부 Acknowledge 주변이다: 목록에서 Ack 직후 다른 인시던트의 버튼이 손가락 밑으로 오는 것(P1-1), 패널 Ack에 Undo가 없고 Resolve가 같은 자리에 오는 것(P1-2), 폰 토스트 깨짐(P1-3). 세 건 수정 후 하은 H3·H4만 재실행하면 됨. P2 8건은 백로그 또는 같은 PR에서 처리.

점검 한계: 개발 서버(`next dev`)라 속도와 첫 그림 시점은 빌드본과 다를 수 있음. 대비 4.5:1 자동 측정은 하지 않고 눈으로만 확인. 점검 중 Ack 상태가 목 서버 메모리에 남아 시나리오 사이에 서버를 재기동함.

## Console 범위 틀 재점검 — 2026-11-10

대상: `apps/console` (feat/console-scope, 커밋 `cdc5a1c`). 수정한 쪽과 무관한 독립 재점검. `MOCK_API=1 next dev -p 3118`로 직접 기동해 Playwright로 조작했고, 레일 깜빡임·헤더·Ack 핵심 경로는 `next build && next start -p 3118`(E2E_ALLOW_MOCK=1) 빌드본에서도 다시 봄. 390×740(터치)·390×844·1440×900·1280×900·1024×768, 라이트·다크 일부. Part A 판정은 화면과 스크린샷만으로 함(제품 소스는 판정 뒤 보안 검토 때 열람). 시나리오마다 서버를 재기동해 Ack 상태를 초기화. 캡처: `docs/qa/shots/console-scope/qa-1110b/` (gitignore 대상, 로컬 전용).

### 이전 실패 항목 재실행

| # | 이전 문제 | 폭 | 결과 | 측정·관찰 | 캡처 |
|---|---|---|---|---|---|
| H3-a | P1-1 같은 자리 빠른 두 번 탭 | 390·1440 | 통과 | 간격 80/300/550ms 두 번 누름 → 서버 요청 1건, 4 open → 3 open(1건만 Ack). Ack한 행은 5초간 제자리, 버튼은 "Acknowledged ✓ · Undo"로 바뀜. 빌드본에서도 동일 | h3-390-gap80-b, h3-1440-gap80-b |
| H3-b | P1-1 변형: Ack 후 다음 행으로 마우스 이동 | 1440 | **실패 (신규 P1-A)** | 1행(Mirae Pay) Ack → 마우스를 2행(Hanbit) Acknowledge 위로 옮기는 순간(포인터가 1행을 벗어나자마자) 목록이 재정렬되어 2행이 위로 올라가고, 포인터 밑에는 3행(Daon Retail) Acknowledge가 옴 → 클릭하면 Daon이 Ack되고 Hanbit는 ESCALATED로 남음. 대기 0.7초/1.5초, 머문 시간 50ms~1초 4회 모두 재현, 빌드본에서도 재현 | h3-1440-move-next-700-300, prod-1440-move-next |
| H3-c | 목록 Ack → Undo | 390·1440 | 통과 | 토스트 Undo 1번 → "Acknowledge undone in Mirae Pay › Core › Payments API · paging continues", 3 open → 4 open. 토스트 Undo를 빠르게 두 번 눌러도 다른 버튼이 눌리지 않음 | h3-390-undone |
| H3-d | 서로 다른 두 행을 일부러 빠르게 Ack | 390·1440 | 통과 | 0.7초 간격으로 1행·2행을 각자 자리에서 누름 → 둘 다 Ack(2 open). 390은 0.25초 간격도 둘 다 됨, 1440은 0.25초 간격이면 두 번째가 무시됨(버튼 잠김) — 0.6초 넘으면 정상 | h3-390-two-rows, h3-1440-two-rows |
| H3-e | 오래된 목록에서 Ack (다른 사람이 먼저 바꿈) | 390·1440 | 통과 | 행에 "Changed since you loaded this list · not acknowledged" + Reload. Ack되지 않음, Reload 후 정상 버튼 복귀 | h3-390-409, h3-1440-409 |
| H4-a | P1-2 패널 Ack에 Undo 없음 | 390·1440 | 통과 | Ack → 그 자리에 "Acknowledged ✓ · Undo", 토스트에도 Undo, 목록 행에도 Undo. 호출 줄이 "Paging stopped at 03:16 — acknowledged by Haeun"으로 바뀌고 "→ call Yuna…" 사라짐, Escalation 카드도 "stopped at step 1/3" | h4-390-1-acked |
| H4-b | P1-2 같은 자리에 Resolve | 390·1440 | 통과 | Resolve…는 약 5.3초 뒤에 나타남. 80ms 두 번 탭은 1건만 Ack. Resolve…를 누르면 "Resolve this incident in Mirae Pay › Core › Payments API?" 확인 상자, 원래 자리에는 "Keep it open"(기본 포커스), Resolve…를 두 번 탭해도 닫히지 않음. Esc·Keep it open으로 취소, "Resolve incident"로만 RESOLVED | h4-390-resolve-confirm, h4-1440-resolved |
| H4-c | 패널에서 오래된 화면으로 Ack | 390 | 통과 | "Someone else updated this incident. Nothing was changed — reload to see it as it is now." + Reload | h4-390-409 |
| T | P1-3 폰 토스트 깨짐 | 390 | 통과 | 374×65px(이전 195px·12줄), 3줄, 하단 메뉴 위. Undo 52×44. 다크도 정상 | h3-390-gap80-b, dark-390-acked |
| V | P2-5 첫 화면에 인시던트 | 390×740·1440×900 | 통과 | 390×740: 첫 카드(SEV-1 Mirae Pay)와 Acknowledge 버튼(y 609–653)이 하단 메뉴(y 685) 위에 다 보임. 통계는 한 줄 띠로 줄어듦. 1440×900: 4.5행 | a-01-list-390, a-01-list-1440 |
| V2 | P2-4 패널 열면 첫 행 밀림 | 1440·1280·1024 | 통과 | 첫 행 y≈427(이전 605). 통계가 한 줄 띠로 줄어듦 | r-panel-1280, r-panel-1024 |
| K | P2-1 새 화면 첫 Tab | 1440 | 통과 | Skip to content → 로고 → 메뉴 6개 → Filter to… → 테마 → Find by name → « → Only with problems → 트리. /people도 같음. Skip 후 Tab은 본문 첫 링크 | tab-1440-skip |
| R | P2-2 레일 새로고침 깜빡임 | 1440 빌드본 | 통과 | 레일로 접고 새로고침: /incidents, /people, 패널 주소에서 프레임마다 본문 x=45로 일정(약 90프레임, CPU 6배 느리게 해도 동일). 272→45 튐 없음 | rail-prod-1440 |
| O | P2-3 "open" 두 뜻 | 390·1440 | 통과 | 탭 이름이 Active로 바뀜. Daon›Commerce›Checkout: 제목 "1 listed · 0 open · 1 acknowledged", OPEN 0, Active 1, "Outside this view: 4 open … · 2 acknowledged", 배지 4 (0+4). Mirae: 1 open + Outside 3 = 4. My customers: 2 + 2 = 4. 범례도 같은 정의 | open-390-…checkout |
| F | Ctrl/⌘K "Filter to…" 없음 | 1440·390 | 통과 | Ctrl+K·⌘K·상단 버튼으로 열림, Esc 닫힘. "checkout" → "2 customers have a match … Nothing is selected" + Mirae Pay › Core › Checkout / Daon Retail › Commerce › Checkout 두 줄(고객 이름 굵게), Enter만으로는 아무것도 선택 안 됨. ↓ Enter → `?customer=mirae&project=core&service=checkout`. 없는 이름은 "No customer, project or service starts with …". /people에서도 그 화면 필터로 적용. 폰: 돋보기 44×44 → 전체 화면, 결과 줄 52px, 둘째 줄 탭 → Daon 필터 | k-1440-1-checkout, k-390-1-checkout |
| L | P2-7 범례 문구 | 1440·390 | 통과 | 기본 접힘("What do these mean?"). "OWN STEPS — This project or service has its own call order instead of the customer's", 숫자는 "Open incidents here: triggered or escalated, and nobody has acknowledged them yet". 폰 시트에도 같은 링크 있음 | legend-1440, sheet-390-legend |
| S | P2-8 폰 필터 줄이 스크롤로 사라짐 | 390 | 통과 | 400px 내려도 Showing 줄이 위에 붙어 있음 | r-390-scrolled-filter |

### Acknowledge 안전 추가 시도

| 시도 | 폭 | 결과 | 관찰 |
|---|---|---|---|
| 느린 두 번째 누름(0.7~1.5초), 같은 자리 | 1440 목록 | P2-A | Acknowledge(x1303–1403) 오른쪽 절반 자리에 행의 Undo(x1351–1403)가 생김. 0.6초가 지난 두 번째 클릭은 Undo로 들어가 Ack가 취소되고 호출이 계속됨(토스트 "Acknowledge undone … paging continues"는 뜸). 0.3·0.55초는 무시됨 |
| 느린 두 번째 탭(1~1.5초), 같은 자리 | 390 패널 | P2-A | Ack 후 줄이 24px 올라오며 Undo(297–361 × 517–561)가 직전 탭 지점(294, 563) 바로 옆에 옴. 터치 보정으로 Undo가 눌려 취소됨. 0.3·0.7초는 무시됨. 5초 뒤에는 그 자리 근처가 "Undo acknowledge"라 같은 결과. 390 목록은 Undo가 옆(x155–219)에 있어 해당 없음 |
| Ack 직후 스크롤해서 다음 행 버튼을 손가락 밑으로 | 390 | 통과 | 0.3초 뒤 탭은 무시, 0.8초 뒤 탭은 그 행을 Ack(의도한 동작으로 봄) |
| Ack 직후 SEV 필터 변경 | 1440 | 통과(참고) | 목록이 바뀌면 고정이 풀림. 0.2초 뒤 같은 자리 클릭은 무시, 0.8초 뒤에는 그 자리에 온 다른 인시던트가 Ack됨 — 사용자가 직접 목록을 바꾼 경우라 결함으로 보지 않음 |
| 키보드: J → A, A (0.1·0.8·2초) | 1440 | 통과 | 1건만 Ack. 두 번째 A는 아무것도 안 함(취소도 안 됨). 포커스는 그 행 제목에 유지 |
| 키보드: Ack 버튼에 포커스 → Enter/Space 반복 | 1440 | 통과 (P3-A) | 1건만 Ack. 다만 Enter 직후 포커스가 문서 맨 위(body)로 떨어져 Undo까지 Tab으로 처음부터 가야 함 |
| 5초 고정이 끝난 뒤 같은 자리 | 390·1440 | 참고 | 5초 뒤 행이 Ack'd 묶음으로 내려가고 그 자리에 다음 인시던트의 Acknowledge가 옴(390×740에서는 토스트가 9초간 그 자리를 덮음). 설계대로이나 P1-A 수정 때 함께 볼 것 |

### 회귀 점검 (이전 통과 항목)

| 시나리오 | 폭 | 결과 | 관찰 |
|---|---|---|---|
| 시트로 타이핑 없이 Daon Retail › Commerce › Checkout | 390 | 통과 | 4탭, `?customer=daon&project=commerce&service=checkout`, 시트 안 44px 미만 없음 |
| Only with problems | 1440 | 통과 | 14곳 → 5곳(Mirae Pay, Daon Retail, Hanbit, Kumho Clinic, Lumen Bank), "1 of 7 / 4 of 7", 목록·주소 안 바뀜 |
| 딥 링크 새로고침·뒤로·앞으로 | 1440 | 통과 | 필터+패널 주소 새로고침 유지, Copy link는 필터 뺀 주소, 뒤로 2번(패널→필터 목록→전체)·앞으로 2번 일치, Esc로 패널만 닫힘 |
| 로그아웃 상태 링크 | 390 | 통과 | `/login?next=…`로 이동, 다른 화면·`/api/…`도 전부 로그인으로 |
| Not found | 1440 | 통과 | 없는 고객, 없는 id, 다른 고객 경로+남의 id, 프로젝트 불일치, `..`·`%2e%2e`·`....`·`<script>` id, `?customer=..` 모두 같은 "Not found — There is nothing to show at this address", 메뉴·트리 유지 |
| 트리가 내용을 밀어냄 | 1440·1280·1024 | 통과 | 1440: 트리 272 + 본문, 1280·1024: 패널 열면 45px 레일. 페이지 가로 스크롤 없음 |
| 스텁 화면 필터 유지, Settings | 390 | 통과 | /people이 Daon Retail › Commerce 유지, Settings는 "MSP-wide settings · all 14 customers" |
| 터치 44px, 가로 스크롤, 콘솔 오류 | 390 | 통과 | 목록 화면 44px 미만 0개, scrollWidth 390, 앱 오류 0건(샌드박스에서 Google Fonts 요청만 실패) |

### 문제 목록

| 등급 | # | 문제 | 재현 |
|---|---|---|---|
| P1 | A | 데스크톱에서 한 건 Ack한 뒤 바로 아래 행의 Acknowledge로 마우스를 옮기면, 포인터가 Ack한 행을 벗어나는 순간 목록이 재정렬되어 목표 버튼이 한 칸 위로 도망가고 그 자리에 그다음 인시던트(다른 고객)의 Acknowledge가 온다. "연달아 두 건 Ack"라는 가장 흔한 동작에서 엉뚱한 고객의 인시던트가 Ack된다. 이전 P1-1과 같은 피해, 다른 경로 | 1440, `/incidents` → Mirae Pay 행 Acknowledge 클릭 → 0.7~1.5초 뒤 Hanbit 행 Acknowledge로 마우스 이동 → 클릭 → Daon Retail이 Ack됨, Hanbit는 ESCALATED 그대로 (h3-1440-move-next-700-300). 빌드본 동일 |
| P2 | A | Undo가 방금 누른 Acknowledge 자리(또는 바로 옆)에 생긴다. 0.6초 보호 구간이 지난 "눌렸나?" 식의 두 번째 누름이 Ack를 취소한다(호출 재개 — 안전한 쪽이지만 사용자는 Ack했다고 믿고 잠든다) | 1440 목록: Acknowledge 버튼 가운데를 0.7초 간격으로 두 번 클릭. 390 패널: Acknowledge를 1~1.5초 간격으로 두 번 탭 |
| P2 | B | 패널이 열린 상태(1440·1280)에서 한 건이 Ack되면 Action 열이 넓어져 표가 750px/688px로 넘친다. 다른 행의 버튼이 "Ackno"로 잘리고, Ack한 행의 Undo는 표를 옆으로 밀어야 보인다 | 1440 또는 1280, 패널 주소에서 Acknowledge (h4-1440-3-after-hold, clip-1280-panel-acked) |
| P3 | A | Ack 버튼을 Enter/Space로 누르면 포커스가 body로 떨어진다(Undo로 가려면 처음부터 Tab) | 1440, 행의 Acknowledge에 포커스 → Enter |
| P3 | B | 이전 P3-1(패널 제목 2줄·둘째 줄이 "›"로 시작, 도착 시 제목의 굵은 파란 테두리), "Only with problems" 옆 숫자 설명 없음은 그대로 | r-panel-1024, a-01-list-1440 |

### 판정

**머지 보류 — P1 1건(P1-A).** 이전 P1 3건(같은 자리 두 번 탭, 패널 Undo·Resolve, 폰 토스트)과 P2 8건 중 확인 대상 전부가 고쳐졌고 회귀는 없다. 그러나 데스크톱에서 Ack 후 다음 행으로 마우스를 옮기면 다른 고객의 인시던트가 Ack되는 경로가 새로 확인됐다(4/4 재현, 빌드본 포함). 수정 방향 제안: 포인터가 행을 벗어났다고 바로 재정렬하지 말고 5초(또는 포인터가 목록 밖으로 나갈 때)까지 순서를 유지. P1-A 수정 후 H3-b와 "Ack 안전 추가 시도" 표만 재실행하면 됨. P2-A·P2-B는 같은 PR에서 처리 권장(P2-A는 Undo를 Acknowledge가 있던 자리와 겹치지 않게 두면 해결).

점검 한계: 목 서버에 목록 자동 갱신(12초 tick)·다른 사람의 Ack로 인한 재정렬이 없어 "고정 중 서버가 목록을 바꾸는 경우"는 못 봄. 터치는 Playwright 에뮬레이션(실기기 아님). 대비 4.5:1은 눈으로만 확인. 샌드박스에서 Google Fonts가 막혀 Space Mono는 대체 글꼴로 렌더링됨.

## Console 범위 틀 최종 점검 — 2026-11-10

대상: `apps/console` (feat/console-scope, 커밋 `de84c34` = `acfb425` + origin/main 문서 PR #6 병합). 수정한 쪽과 무관한 독립 점검. 빌드본을 직접 기동(`next build` → `E2E_ALLOW_MOCK=1 MOCK_API=1 next start -p 3119`, 시나리오마다 재기동해 Ack 상태 초기화, 34곳은 `MOCK_CUSTOMERS=34`)하고 Playwright로 1440×900·1280×900·1024×768(마우스), 390×740·390×844(터치)를 조작했다. 마우스는 곡선 경로로 12ms 간격 이동. 모든 Ack/Undo/Resolve 구간에서 프레임마다 각 행의 x·y·폭·높이와 행 순서를 기록해 변화를 셌고, 결과는 화면이 아니라 새 세션으로 다시 읽은 서버 상태로 확인했다. 캡처: `docs/qa/shots/console-scope/qa-1110c/` (gitignore 대상, 로컬 전용).

### 통합 (origin/main 병합 뒤)

| 항목 | 결과 |
|---|---|
| 병합 | 충돌 없음(문서만 추가·변경, `package-lock.json` 변화 없음) |
| `npm test` | 통과 — console 76, core 81, design-system 83, ingest 32 (합 272), db 스키마 검사 통과 |
| `npm run typecheck` | 통과 (console, core, design-system, ingest) |
| console `eslint .` | 통과 (경고 0) |
| `next build` | 통과 |
| Playwright (3107) | 81 / 81 통과 |

### 이전 실패 항목 재실행

| # | 이전 문제 | 폭 | 결과 | 측정·관찰 | 캡처 |
|---|---|---|---|---|---|
| P1-A | 1행 Ack 뒤 2행 Acknowledge로 이동해 클릭 (0.3 / 0.7 / 1.5초) | 1440 | 통과 | 3회 모두 포인터 밑은 2행(Hanbit) 버튼, 서버에서도 Mirae Pay·Hanbit만 Ack, Daon은 Triggered 그대로. 행 이동 0건 | A1-700 |
| P1-A | 1·2·3행 연달아 Ack (간격 0.65초, 0.2초) | 1440 | 통과 | 두 속도 모두 세 건이 각자 Ack, 미매핑 계정 행만 Triggered. 행 이동 0건. 14초 더 기다려도 재정렬 없음 | A2-three |
| P1-A | 패널이 열린 상태에서 목록 1행 → 2행 | 1440·1280 | 통과 | Mirae Pay·Hanbit Ack, 행 이동 0건, 표 넘침 0px | B-panel-1440, B-panel-1280 |
| P1-A | 스크롤한 뒤 1행 → 2행 | 1440×700 | 통과 | 300px 내린 상태에서 동일. 행 이동 0건 | C-scrolled |
| P1-A | 필터를 켠 상태 (SEV-2, 고객=Daon) | 1440 | 통과 | SEV-2: Hanbit → Daon 순서대로 Ack, 목록 밖 두 건은 그대로. 고객 필터: 1건 Ack, "Outside this view: 3 open … · 2 acknowledged" 일치. 행 이동 0건 | D-filter |
| 행 고정 | Ack / Undo(행 메뉴, 토스트) / Resolve(패널) 뒤 행 위치 | 1440·1280·390 | 통과 | 모든 구간에서 어떤 행의 상자도 변하지 않음(프레임 기록 0건, 전후 비교 일치). Resolve한 행은 제자리에 "Resolved ✓", 다른 사람이 바꾼 행도 제자리 | B2-resolved-1440, X2-others |
| 재정렬 줄 | "N acknowledged in place · Re-sort" | 1440·390 | 통과 | 1·2·3건마다 숫자 일치. Undo하면 줄이 사라지고, 재정렬 뒤 Undo는 "1 reopened in place", Resolve는 "1 no longer in this list". Re-sort를 눌렀을 때만 순서가 바뀜(Ack'd 묶음으로 이동). 더블클릭해도 한 번만 정렬되고 그 자리에는 아무것도 없음. 패널 열고 닫기·14초 대기로는 정렬되지 않음 | A2-resorted, F-resorted |
| P2-A | Undo 위치, 같은 자리 느린 두 번째 누름 | 1440 목록 | 통과 | Ack 자리(x1303–1403)에 0.3·0.7·1.5·3.0초 뒤 다시 눌러도 아무 일 없음(그 자리는 글자뿐, 패널도 안 열림). Undo는 "⋯"(x1199–1231) → "Undo acknowledge"(행 아래쪽에 뜸), 토스트, 패널 링크 세 곳. "⋯" 더블클릭은 열렸다 닫힐 뿐 Undo에 닿지 않음 | E-menu |
| P2-A | 같은 자리 느린 두 번째 탭 | 390 목록·패널 | 통과 | 목록: 0.15·0.7·1.5·3.0초 탭 모두 무시, 1건만 Ack. "⋯"는 카드 반대쪽(x315–359, 44×44). 패널: 0.3·1.0·1.5·2.5초 탭 모두 무시, "Undo acknowledge"는 왼쪽 아래(x29–141)로 Ack 버튼(x228–361)과 떨어져 있음 | M1-acked-390, M3-panel-acked-390 |
| P2-B | 패널 열린 상태에서 Ack 뒤 넘침·잘림 | 1440·1280 | 통과 | 목록에서 Ack, 패널에서 Ack, Resolve 뒤 모두 표 넘침 0px, 잘린 버튼·글자 0개, 문서 가로 넘침 0 | B2-panel-acked-1280 |
| P3-A | 키보드 Ack 뒤 포커스 | 1440 | 통과 | Enter 뒤 포커스가 그 행의 "Acknowledged ✓"에 남음. Shift+Tab → "⋯" → Enter → 메뉴 항목 → Enter로 Undo, 포커스는 돌아온 Acknowledge 버튼. Enter 3번·A 3번을 쉬지 않고 눌러도 1건만 Ack | K1-focus |
| 409 | 다른 세션이 먼저 바꾼 행·패널 | 1440 | 통과 | 행: "Changed since loaded" + Reload / "Not acknowledged", Ack 자리는 비어 있고 행 이동 없음, Reload 뒤 제자리에서 Ack'd. 패널: "Someone else updated this incident. Nothing was changed…" + Reload. 오래된 패널의 Escalate now도 같은 안내(호출 안 됨) | K2-409 |
| 패널 Resolve | Ack 뒤 5초, 확인 상자 | 1440·1280·390 | 통과 | Resolve…는 약 5.3초 뒤에 나타남. 누르면 확인 상자, 기본 포커스 "Keep it open", 같은 자리 두 번째 누름으로는 닫히지도 Resolve되지도 않음. "Resolve incident"로만 Resolved | B2-resolve-ask-1280, M3-panel-ask-390 |

### 엉뚱한 인시던트를 Ack/Undo/Resolve하려는 새 시도

| # | 시도 | 폭 | 결과 | 관찰 |
|---|---|---|---|---|
| X1 | 패널을 연 채 J → A | 1440 | 통과(참고) | 포커스가 패널 안이면 J·A 무시. 목록 쪽을 누른 뒤에는 포커스된 행이 Ack되고 토스트가 경로를 말함. 패널에 보이는 인시던트가 아니라 포커스된 행 기준이라는 점만 기억할 것 |
| X2 | 내가 움직이는 동안 다른 세션이 1행 Ack, 3행 Resolve | 1440 | 통과 (P3-D) | 1행은 제자리에서 Ack'd로 바뀌고 내 2행 클릭은 2행에 적용. 3행 Acknowledge를 누르면 "Not acknowledged" + Reload, Reload 뒤 제자리에 "Left this list". 행 이동 0건. 다만 그 행은 빨간 TRIGGERED 배지와 "next: call all 3…" 문구가 그대로 남음 |
| X3 | Ack 뒤 창 폭을 바꿈 (-1, -40, +60px) | 1440 | 통과(참고) | -1·-40px은 변화 없음. +60px은 Ack한 행 높이가 99→79.5로 풀리며 아래 행이 20px 올라옴(사용자가 창을 바꾼 경우). 2행 버튼 자리에는 버튼이 아닌 빈 칸이 옴 |
| X4 | 1행 Ack → 2행 패널 열기 → Esc → 2행 Acknowledge 자리 클릭 | 1440 | 통과 | 순서·y 좌표 그대로, 그 자리는 여전히 2행 버튼 |
| X5 | A 키를 누른 채 유지(40회 반복), 패널 Acknowledge에서 Enter를 8초 유지 | 1440 | 통과 | A: 1건만 Ack, 오류 문구 없음. Enter: Acknowledge → 글자 → Resolve… → 확인 상자 "Keep it open" → 닫힘에서 멈춤. Resolve되지 않음 |
| X6 | 1·2행 Ack 뒤 토스트 Undo, 재정렬된 행의 Undo 항목 더블클릭 | 1440 | 통과 | 토스트는 마지막 것(Hanbit)을 이름으로 말하고 그것만 취소. 재정렬 뒤 Mirae Pay 행 Undo → 그 행만 Triggered, 두 번째 클릭은 빈 칸에 떨어짐, 순서 유지 |
| X7 | 16px 고정 스크롤바(Windows식) | 1440×760 | 통과 | 표 폭 변화 없음, 행 이동 0건, 2행 클릭은 2행에 적용 |
| X8 | 느린 네트워크(지연 0.9초): 2행 제목 클릭 직후, 패널이 바뀌기 전에 패널 Acknowledge | 1440 | 통과 | 누른 순간 화면에 보이던 Mirae Pay가 Ack되고 토스트도 Mirae Pay. 바뀐 패널(Hanbit)은 Acknowledge 그대로 |
| X9 | Ack 뒤 스크롤해서 다음 카드 버튼을 누름 | 390 | 통과 (P3-C) | 버튼이 y≈500이면 0.3·0.9초 모두 그 카드(Hanbit)가 Ack. 버튼이 토스트 밑(y 611–676)에 오면 탭이 토스트에 먹혀 아무것도 Ack되지 않음 |
| X10 | 패널 409 직후 같은 자리 | 1440 | 통과(참고) | 409면 Resolve…가 5초 대기 없이 바로 나옴. 확인 상자를 거치므로 한 번 더 눌러도 Resolve되지 않음 |

### 회귀 점검

| 시나리오 | 폭 | 결과 | 관찰 |
|---|---|---|---|
| 시트로 타이핑 없이 Daon Retail › Commerce › Checkout | 390×844 | 통과 | 4탭, `?customer=daon&project=commerce&service=checkout`, "Outside this view: 4 open (1 from an unmapped account) · 2 acknowledged" |
| Only with problems (34곳) | 1440 | 통과 | 34곳 → 5곳(Mirae Pay / Daon Retail, Hanbit Logistics, Kumho Clinic, Lumen Bank), "1 of 7 / 4 of 27", 주소·목록 7행 그대로. Other customers 27곳은 이름순(Byeol Media … Zio Fashion) |
| Ctrl/⌘K | 1440 | 통과 | "checkout" → 두 고객 안내 + 두 줄, Enter만으로는 선택 없음, ↓↓ Enter → Daon 필터. ⌘K도 열림, Esc 닫힘 |
| 딥 링크 새로고침·뒤로·앞으로 | 1440 | 통과 | 필터+패널 주소 새로고침 뒤 패널 유지, 뒤로 2번(필터 목록 → 전체), 앞으로 2번 뒤 같은 패널 |
| Not found | 1440 (390은 없는 고객 경로만) | 통과 | 없는 고객(쿼리·경로), 없는 id, 다른 고객 경로+남의 id, `..`, `%2e%2e`, `<script>` 모두 같은 "Not found", 메뉴·트리 유지 |
| 트리가 내용을 밀어냄 | 1440·1280·1024 | 통과 | 1440: 트리 272 + 본문 1168(패널 442 포함, 표 688). 1280: 목록은 트리 272 + 본문, 패널 열면 45px 레일. 1024: 45px 레일. 전부 문서 가로 넘침 0, 표 넘침 0 |
| 가로 넘침 | 390 | 통과 | /incidents, Resolved 탭, 패널, /people, /customers, /settings, /monitoring, /oncall, Not found, 필터 목록 모두 scrollWidth 390 |
| 첫 화면에 첫 인시던트 | 390×740·1440×900 | 통과 | 390: 첫 카드 Acknowledge y 618–662, 하단 메뉴(685) 위. 1440: 첫 행 y 491, 4행까지 보임 |
| Customers 메뉴(스텁) | 1440·390 | 통과 | 상단·하단 메뉴에 Customers, 트리와 필터 줄 유지, "This list will show Daon Retail › Commerce", 주소에 필터 유지 |
| 다크, 콘솔 오류 | 1440 | 통과 | Ack한 행·메뉴·재정렬 줄·토스트 다크 정상. 앱 오류 0건(샌드박스에서 Google Fonts 요청만 실패) |

### 보안 재검토 (`git diff cdc5a1c..HEAD -- apps packages`, 읽기 전용)

| # | 항목 | 결과 | 확인 |
|---|---|---|---|
| S-3 | `next=` 검증 (`lib/safe-next.ts`) | 통과 | 실행 중인 `/auth/dev-login`에 40개 값 시도. `/\evil`, `/%5Cevil`, `/%255Cevil`, `//evil`, `/%2f%2fevil`, 2~4겹 인코딩, `/%09/evil`, `/%2509/evil`, `/%0a/`, `/%0d%0aSet-Cookie:`, `/%00/`, `/.//evil`, `/./%2fevil`, `/..%2f%2fevil`, `https:evil`, `https:/evil`, `https://evil`, `javascript:`, U+2028, U+0085, 앞 공백, 빈 값은 전부 `/incidents`로. 유니코드 빗금(U+2215, U+FF0F, U+2044, U+FF3C)과 `/@evil`, `/;@evil`은 퍼센트 인코딩된 같은 출처 경로로만 감. `next`를 두 번 주면 첫 값만 사용. Location이 다른 호스트를 가리킨 경우 0건. 로그인 화면의 dev 링크도 같은 검사를 거쳐 나쁜 값은 `next` 없이 출력 |
| S-4 | Escalate에 If-Match | 통과 | 서버 액션이 id·version을 검증해 `If-Match`로 보냄(ack·resolve와 동일, 단위 테스트 있음). 실제 화면에서 오래된 패널의 "Escalate now"는 409 안내만 뜨고 상태 변화 없음 |
| R-4 | 응답 헤더 (`curl -I`) | 통과 | /login, 리다이렉트(/incidents, /api/x), /auth/dev-login, 404 모두 CSP(`frame-ancestors 'none'`, `object-src 'none'`, 원격 스크립트 없음, 빌드본에 `unsafe-eval` 없음), X-Frame-Options DENY, Referrer-Policy, nosniff, Permissions-Policy, HSTS. 세션 쿠키 HttpOnly · SameSite=Lax |
| — | 그 밖의 변경 | 통과 | 추가된 코드에 `dangerouslySetInnerHTML`·`eval`·새 외부 요청·새 환경 변수·저장소 사용 없음. 행 메뉴·재정렬은 화면 상태뿐이고 서버 호출은 기존 액션(세션 확인 → 입력 검증 → API) 그대로. 로그인 없는 POST는 /login으로 |
| 참고 | [차단] 아님 | — | `X-Powered-By: Next.js` 헤더가 나감(`poweredByHeader: false` 권장). `next=` 값의 쿼리에 `//`가 있으면(예: `?q=http://…`) 안전한 쪽으로 `/incidents`로 떨어짐. CSP의 `script-src 'unsafe-inline'`은 이전과 같음(nonce는 다음 단계) |

### 문제 목록

| 등급 | # | 문제 | 재현 |
|---|---|---|---|
| P1 | — | 없음 | — |
| P2 | — | 없음 | — |
| P3 | C | 폰에서 토스트(약 9초)가 화면 아래 띠(y 611–676)를 덮는다. 방금 Ack한 카드의 "Acknowledged ✓"와 "⋯"가 가려지고, 그 띠에 온 다른 카드의 Acknowledge는 눌러도 반응이 없다(Ack되지 않음 — 안전한 쪽). Undo 직후에는 첫 카드의 Acknowledge가 "Acknowledge undone" 토스트 밑에 있어 다시 누르려면 ×를 먼저 눌러야 함 | 390×740, 첫 카드 Acknowledge → 190px 스크롤 → 다음 카드 Acknowledge 탭 (M1-acked-390) |
| P3 | D | 다른 사람이 Resolve해 목록에서 빠진 행이 "Left this list"라고만 하고 빨간 TRIGGERED 배지·"next: call…" 문구는 그대로다. 아직 호출 중인 것처럼 읽힘. 배지를 흐리게 하거나 "Resolved by someone else"로 | 1440, 두 세션: B가 3행 Resolve → A가 3행 Acknowledge → Reload (X2-others) |
| P3 | E | Ack 뒤 포커스가 놓이는 "Acknowledged ✓" 글자에서 Space를 한 번 더 누르면 페이지가 약 290px 스크롤된다(Enter는 아무 일 없음) | 1440, Acknowledge에 포커스 → Space → Space |
| P3 | F | 패널에서 Ack하면 주 버튼 줄의 위치가 바뀐다(1280: y 409 → 357, 1440: 455 → 471 → 431, 390: 541 → 517). 그 자리에 누를 수 있는 것이 오지는 않음 | 패널 주소에서 Acknowledge (B2-panel-acked-1280) |
| P3 | B | 이전 P3-B 중 패널 도착 시 제목의 굵은 파란 포커스 테두리는 그대로 | R-1280-panel |

### 판정

**머지 가능 — P1 0건, P2 0건, [차단] 0건.** P1-A는 고쳐졌다: 1행 Ack 뒤 2행으로 옮겨 누르면 2행이 Ack되고(0.3/0.7/1.5초, 패널 열림, 스크롤, 필터, 세 건 연속 모두), Ack·Undo·Resolve 어느 구간에서도 행 상자가 움직이지 않았으며 재정렬은 Re-sort·탭·필터·검색 변경 때만 일어난다. P2-A(Undo가 Ack 자리와 떨어짐)·P2-B(패널 옆 넘침)도 통과, 새로 시도한 10가지 경로에서 엉뚱한 인시던트가 Ack/Undo/Resolve된 경우는 없었다. P3 5건은 백로그. 남은 관문은 사용자 승인.

점검 한계: 목 서버에는 새 인시던트가 들어오는 자동 갱신이 없어 "N new · Show" 줄은 화면에서 못 봄(단위 테스트만 있음). 터치는 Playwright 에뮬레이션이고 폰 스크롤은 휠 입력으로 대신함. 대비 4.5:1은 눈으로만 확인. 샌드박스에서 Google Fonts가 막혀 Space Mono는 대체 글꼴로 렌더링됨.

---

## Console Call order 점검 — 2026-11-11

대상: `apps/console` Call order 화면 (feat/console-call-order, 커밋 `7b636ae`). 만든 쪽과 무관한 독립 점검이며 제품 코드는 고치지 않았다. 빌드본을 직접 기동(`next build` → `E2E_ALLOW_MOCK=1 MOCK_API=1 next start -p 3120`, 시나리오 묶음마다 재기동해 목 상태 초기화, `/auth/dev-login`으로 로그인)하고 Playwright로 1440×900·1280×800(마우스·키보드), 390×844(터치)에서 밟았다. 판정은 화면과 캡처를 직접 보고 했다. 캡처: `docs/qa/shots/console-call-order-check/` (gitignore). 보안 검토는 `/home/claude/alarmops-security-review-callorder.md`.

### 준호 (1440, 키보드 우선)

| 시나리오 | 결과 | 클릭/키 | 관찰 |
|---|---|---|---|
| Mirae Pay의 호출 순서 읽기 (누가·어떻게·언제) | 통과 | 행 열기 1 | "Slack + call on shift in MSP night desk (Haeun now) now → Call Yuna Seo (Mirae Pay) at 10 min → Call everyone in Responders (5) at 15 min → repeat once." Paged (5)·Also notified (4) 이름까지 한 화면. Edit 전 입력 요소 0개 |
| 인시던트 패널 Paged 줄과 일치 | 통과 (P2-A) | — | Mirae Pay › Core › Payments API 인시던트(03:12 발생): "Slack + call Haeun 03:12 ✓ → call Yuna 03:22 → call everyone in Responders (5) 03:27". 사람·수단·시각(0/10/15분) 모두 일치. 다만 플랜 이름이 다름: 인시던트 "CUSTOM STEPS · URGENT (EDITED)", Call order "Custom, started from Standard (edited)" |
| Edit → 2단계 분 변경 → Save (Mirae Pay) | 통과 | 16키 (열린 패널에서는 4키) | Ctrl K, `mirae`, Enter, Tab×4, Enter, E(2단계 분에 바로 포커스·전체 선택), `8`, Ctrl+Enter, Enter. 확인 상자가 "step 2 10 → 8 min", 바뀌는 4개 서비스, "Not changed: Data platform (own steps)"를 보여 줌. 저장 뒤 패널 닫힘, 포커스는 Mirae Pay 행, 토스트 "Saved for Mirae Pay · step 2 10 → 8 min · 4 services" |
| 이어서 Daon Retail, Hanbit Logistics | 통과 | 15키 / 17키 | 각각 자기 고객에만 저장(2→3, 2→4). 저장 버튼·확인 상자·토스트가 매번 고객 이름을 말함. 공유 로테이션을 쓰는 다른 고객 행은 변화 없음 |
| 엉뚱한 고객에 저장 시도: 편집 중 트리로 다른 고객 | 통과 | — | "Unsaved changes for Mirae Pay" (Save for Mirae Pay / Keep draft and continue / Discard / Cancel). 네 선택 모두 Mirae Pay에만 적용되거나 아무것도 저장 안 됨. 가드가 뜬 상태의 Ctrl+Enter는 무시 |
| 〃 Ctrl/⌘K로 다른 고객 | 통과 | — | 같은 가드. Save를 고르면 Mirae Pay에 저장한 뒤 Daon 목록으로 이동 |
| 〃 목록에서 다른 고객 행 클릭 | 통과 | — | 같은 가드. Discard 뒤 열린 Daon 패널은 읽기 화면, Daon 값 변화 없음 |
| 〃 편집 중 뒤로가기 | 통과 | — | 앱 안 이동이면 가드("Keep draft and go back"), 문서를 새로 불러온 이전 주소로 가면 묻지 않고 초안으로 남김. 어느 경우에도 다른 고객에 저장되지 않음 |
| 〃 Mirae 초안을 둔 채 Daon 편집 | 통과 | — | Daon 편집기는 Daon 값(2분)으로 열리고 저장 버튼은 "Save for Daon Retail". Mirae 초안은 "Draft for Mirae Pay" 줄에 따로 남음 |
| 편집 중 인시던트 Ack하고 돌아오기 (초안 이어가기) | 통과 | 클릭 5 | 메뉴 Incidents → Keep draft → Acknowledge → Call order → Resume. 2단계 6분이 그대로, 문장에 "at 6 min was 10 min". 새로고침 뒤에도 패널 안에 초안 줄이 남고 E로 이어짐. Call order 밖(Incidents)에서는 초안이 있다는 표시 없음(P3) |
| 서비스 → 고객 전체로 넓히기 | 통과 | 클릭 3 | Orders API 편집 → "Edit the whole customer instead…" → 상자가 넓어지는 범위(2개 서비스), 닿지 않는 곳(Orders API, own steps)을 말하고 기본 포커스는 "Stay on …". 넓힌 뒤 헤더·저장 버튼이 "Hanbit Logistics", "← Back to Orders API" 있음. 저장 확인 상자에 "Wider than the row you opened". 서비스에서 고치던 값은 넘어가지 않고 그 서비스 초안으로 남음 |
| 상속 서비스에 own steps 만들기 | 통과 | 3키 (E, 숫자, Ctrl+Enter) | Mirae Pay › Core › Checkout: 버튼 "Create own steps for …", 저장 버튼 "Save own steps for Mirae Pay › Core › Checkout". 서비스 1개라 확인 상자 없이 저장, 토스트에 Undo. 목록에 OWN STEPS 행이 생기고 고객 패널은 "used by 3 services (Core › Checkout, Data platform keep own steps)" |
| own steps 제거 | 통과 | 클릭 3 | Edit → "Remove own steps of …" → 확인 상자(기본 포커스 "Keep them", "This has no Undo"). 제거 뒤 다시 Mirae Pay를 따름, 고객 단계는 변화 없음 |
| 두 탭에서 같은 고객 편집 (409) | 통과 | — | 먼저 저장한 탭의 값(8분)만 남음. 두 번째 탭: "Changed — reload. Someone else changed the call order of Mirae Pay… Nothing was saved, and your draft is kept", 저장 버튼 비활성. Reload 뒤 NOW SAVED / YOUR DRAFT 두 문장을 나란히 보여 주고 Keep my draft / Discard 선택. 오래된 초안을 Resume해 저장해도 같은 409 |

### 민재 (1440)

| 시나리오 | 결과 | 클릭/키 | 관찰 |
|---|---|---|---|
| UNREACHABLE / AT RISK 고객 찾기 | 통과 | 0 (첫 화면) | 목록 맨 위 두 행이 Kumho Clinic(UNREACHABLE, 빨간 띠), Lumen Bank(AT RISK). 트리 "Other customers"에도 표시, "What do these mean?"에 뜻 설명. Only with problems를 켜면 목록도 5개 고객으로 줄고 "9 customers … are not listed · Show all customers" 안내 |
| 패널에서 이유 이해 | 통과 (P3) | 클릭 1 | Kumho: "Nobody in Responders can be called or texted. Add a staff member or a Pageable customer person." + Paged (0). Lumen: 단계별로 "reaches only Kyungmin Oh, who has no verified …" 3줄 + "nobody on shift from Sat Nov 14 09:00 to Sun Nov 15 09:00 KST". 다만 Lumen 1단계는 "no verified Slack"이라는데 아래 Kyungmin 카드에는 SMS·Call만 not verified로 나옴 |
| Pageable 응답자를 추가해 하나 고치기 | 통과 | 클릭 5 | Kumho 행 → Edit responders for Kumho Clinic → MSP staff 선택(2) → Add to Kumho Clinic. 배너가 바로 사라지고 Paged (3), 목록 행·트리 표시도 갱신, 토스트에 Undo. 고객 사람을 Pageable로 바꾸는 길(선택 상자)도 동작: 전화 없는 사람만 있으면 UNREACHABLE 유지 + 이유, 미확인 전화면 AT RISK |
| Responders에서 사람 제거 | **P1-A** | 클릭 2 | Remove는 확인 없이 바로 실행되고 아래 사람이 같은 자리로 올라온다. 같은 자리를 한 번 더 누르면 다음 사람도 제거됨(아래 문제 목록) |

### 하은 (390, 터치)

| 시나리오 | 결과 | 클릭/키 | 관찰 |
|---|---|---|---|
| 타이핑 없이 Daon Retail › Commerce › Checkout에 누가 호출되는지 읽기 | 통과 | 탭 4 (+1로 패널) | SHOWING → Daon Retail → Commerce → Checkout. 목록에 "YOUR FILTER" 행: Junho, Minjae, Soyeon · Slack → 2 min SMS → 7 min call, "inherits from Daon Retail". 행을 누르면 패널에 문장과 Paged (3) 이름 |
| 폰에서 작은 수정 | 통과 | 탭 3 + 숫자 1 | Create own steps… → 2단계 분(숫자 자판, 글자 16px) → Save own steps for Daon Retail › Commerce › Checkout. 저장 버튼은 화면 아래 고정, 전체 경로가 한 줄에 다 보임. 토스트에 Undo |
| 폰에서 이탈 가드 | 통과 | — | 하단 메뉴·뒤로가기 모두 가드. 버튼 4개 전부 316×44 이상, 가로 넘침 없음. Keep draft 뒤 목록에 "Draft for …" 줄(Resume/Discard 44px), Resume하면 값 유지 |
| 폰에서 고객 수준 확인 상자 · 넓히기 상자 · Responders 편집 | 통과 | — | 확인 상자 358×499, 넓히기 358×538로 화면 안, 버튼 44px. Responders 편집의 선택 상자·Remove·입력도 44px 이상 |

### 신입 (1280)

| 시나리오 | 결과 | 클릭/키 | 관찰 |
|---|---|---|---|
| "Inherited from" 이해 | 통과 | — | "INHERITED FROM Mirae Pay. Checkout has no steps of its own and follows it. Open the call order of Mirae Pay →", 아래 "Where steps come from" 트리에 inherits / OWN STEPS / CUSTOMER STEPS 표시. 바닥 글: "Read only. To change these steps for everything that follows them, open Mirae Pay." |
| "Own steps" 이해 | 통과 (P3) | — | 편집 화면 맨 위 "Creating own steps for … Started from the steps of Mirae Pay. Nothing changes until you save… Mirae Pay itself is not changed." 다만 E 키로 들어가면 2단계 입력으로 스크롤되어 이 설명이 화면 위로 밀려남. 문장 "1 service of … stop following"은 어색 |
| 순서 방식 4가지 | 통과 | — | 각 카드에 한 줄 설명, 쓸 수 없는 방식은 이유와 함께 비활성("Mirae Pay has no rotation of its own"). 방식을 바꾸면 문장이 바로 바뀌고 "was …"로 이전 값 표시. 플랜을 누르면 단계가 바뀌고 "Steps replaced with the Urgent plan. Put my steps back" |
| 분이 늘어나지 않음 (7,7 / 9,7 / 0) | 통과 | — | "Step 3 (7 min) would not come after step 2 (9 min). Fix the minutes to save." 저장 시도하면 해당 입력으로 포커스, 저장 안 됨 |
| 닿는 사람 없음 | 통과 | — | 채널 전부 끔: "Step n: choose at least one of Slack, SMS or Call." Responders 0명(Kumho): "Nobody would be called… add someone to Responders", 저장 안 됨 |
| 단계 전부 지우기 | 통과 | — | 마지막 1단계의 ✕는 비활성. 1단계만 남긴 저장은 가능(확인 상자에 지워진 단계 표시) |
| 13단계 | **P2-B** | — | + Add step이 끝없이 눌림. 15단계가 경고 없이 저장되고, 21단계는 "Could not save: Invalid steps."만 나옴(한도 20이라는 말도, 어느 단계인지도 없음) |
| 반복 99 | 통과 | — | 입력이 한 자리로 잘려 "9", "Repeat must be a whole number from 0 to 5.", 저장 안 됨 |
| 음수·큰 값·문자 붙여넣기 | 통과 (P3) | — | 숫자가 아닌 글자는 입력 단계에서 버려짐: `abc`·전각 `３` → 빈 칸(오류 표시), `99999` → `9999`(0–1440 오류), `12 minutes<script>` → `12`. 그런데 `-5` → `5`, `2.5` → `25`, `1e1` → `11`로 조용히 바뀜(문장의 "was"로만 알 수 있음) |

### 공통 점검

| 항목 | 폭 | 결과 | 관찰 |
|---|---|---|---|
| 저장 뒤 포인터 아래가 움직이지 않음 (단계 저장) | 1440·390 | 통과 | 저장하면 패널이 닫히고 목록 행 순서·y 좌표 유지(Mirae 287, Daon 287, Hanbit 287 그대로). 저장 버튼 자리에는 목록 셀(누르면 읽기 패널)만 옴. 서비스 저장 버튼 더블클릭 → 1번만 저장. 390에서는 토스트 글자가 그 자리에 옴(Undo 버튼은 옆) |
| 〃 (Responders 변경) | 1440·390 | **P1-A** | Remove 뒤 다음 사람의 Remove가 같은 자리에 옴. Add 뒤에는 그 자리에 선택 상자가 옴(해 없음) |
| 저장 라벨은 항상 전체 경로 | 전 폭 | 통과 | "Save for Mirae Pay", "Save for Hanbit Logistics › Fulfilment › Orders API", "Save own steps for Daon Retail › Commerce › Checkout". 확인 상자·가드·토스트·초안 줄도 같은 경로. 가드 안 버튼은 own steps 생성일 때도 "Save for …"(P3) |
| 읽기 먼저 | 전 폭 | 통과 | 패널을 열면 입력 요소 0개. 링크·새로고침은 항상 읽기 화면. Responders도 "Edit responders for …"를 눌러야 입력이 나옴. 단 Responders 편집 중에도 바닥 글은 "Read only until you press Edit."(P3) |
| 레이아웃 | 1440·1280·390 | 통과 (P3) | 가로 넘침 0(390 scrollWidth 390: 목록, 패널, 편집, 가드, 확인 상자, Responders 편집). 1280은 패널을 열면 트리가 레일로 접힘. 1440 편집기의 1단계 선택 상자 글자가 "On shift in MSP night desk (Haeun no"에서 잘림 |
| 터치 44px | 390 | 통과 | 패널·편집·가드·확인 상자·초안 줄·Responders 편집의 버튼·선택 상자·입력 모두 44px 이상(방식 라디오 자체는 13px이고 카드 영역의 누름 범위는 재지 않음) |
| 다크 모드 | 1440·390 | 통과 | 읽기·편집·UNREACHABLE/AT RISK 배너 대비 정상(눈으로 확인, 확인 상자는 캡처만 하고 판정에 쓰지 않음) |
| Incidents 화면과의 일관성 | 1440 | P2-A · P3 | 사람·수단·시각은 일치. 플랜 이름 불일치(P2-A). Incidents는 J/K로 행 이동, Call order는 J/K 없음(Tab만 — 페이지 맨 위에서 Mirae 행까지 23번, Ctrl K를 쓰면 4번). 확인 상자 기본 포커스: Incidents Resolve와 own steps 제거는 안전한 쪽, 단계 저장은 "Save for …" 쪽 |
| 막다른 곳 | 전 폭 | 통과 (P3) | Rotations·Templates 탭은 "Not built yet" 스텁(메뉴·탭 유지). 없는 주소는 같은 Not found인데 Call order 주소에서도 버튼은 "Back to Incidents". 409·검증 오류·가드 모두 빠져나갈 길 있음 |
| 콘솔 오류 | 전 폭 | 통과 | 앱 오류 0건(샌드박스에서 Google Fonts 요청만 실패) |

### 문제 목록

| 등급 | # | 문제 | 재현 |
|---|---|---|---|
| P1 | A | Responders의 Remove가 확인 없이 한 번에 실행되고, 지워진 줄 아래 사람이 같은 자리로 올라와 그 사람의 Remove가 포인터 아래에 온다. 같은 자리를 한 번 더 누르면(1.5초 뒤에도) 다음 사람까지 제거된다. 토스트 Undo는 마지막 한 건만 되돌리고 첫 번째 제거의 Undo는 사라진다. Daon Retail(열린 인시던트 있음)에서 두 번 누르면 MSP staff 0명, "UNREACHABLE … nobody for Daon Retail is reached"가 된다. 이전 Incidents P1-A(Ack 뒤 행이 포인터 아래로 올라옴)와 같은 종류 | 1440: `/c/daon/call-order` → Edit responders for Daon Retail → Junho Park의 Remove 클릭 → 같은 자리 다시 클릭 → Minjae Lee도 제거, Undo는 Minjae만. 390도 같은 배치 (P1-1440-after-first, P1-1440-after-second) |
| P2 | A | 같은 Mirae Pay 단계를 인시던트 패널은 "CUSTOM STEPS · URGENT (EDITED)", Call order는 "Custom, started from Standard (edited)"(편집기에서도 Standard (edited) 선택)라고 한다. 어느 플랜에서 출발했는지 두 화면이 다르게 말함 | `/incidents?customer=mirae` → 인시던트 패널 PAGED 아래 줄 vs `/c/mirae/call-order`의 COMES FROM (A-mirae-incpanel-1440, A-mirae-read-1440) |
| P2 | B | 단계 수 한도가 화면에 없다. + Add step이 계속 눌리고 15단계가 그대로 저장되며(목록 행·토스트가 매우 길어짐), 21단계부터는 "Could not save: Invalid steps."만 나와 무엇을 고쳐야 하는지 알 수 없다 | 1280: `/c/daon/call-order` → Edit → + Add step 12번 → 저장됨. `/c/hanbit/fulfilment/orders-api/call-order` → Edit → + Add step 19번 → Ctrl+Enter (V-15steps-list, V-21steps) |
| P3 | C | 여러 서비스에 걸친 저장 확인 상자("This save has no Undo")의 기본 포커스가 "Save for …"라 Ctrl+Enter 뒤 Enter(또는 Enter를 누른 채)로 저장된다. 같은 화면의 own steps 제거와 Incidents Resolve는 기본이 안전한 쪽 | 1440: 고객 패널 E → 숫자 → Ctrl+Enter → Enter |
| P3 | D | 분 입력이 `-5`→`5`, `2.5`→`25`, `1e1`→`11`로 조용히 바뀐다 | 1280: Edit → 2단계 분에 `2.5` 입력 |
| P3 | E | Call order 목록에 J/K 행 이동이 없다(Incidents에는 있음). 바닥 안내도 "Enter open · E edit"뿐 | 1440: `/call-order`에서 J |
| P3 | F | Responders를 편집하는 중에도 패널 바닥 글이 "Read only until you press Edit." / "Read only. An edit here reaches 3 services." | Edit responders for … 누른 상태 (H-resp-edit-390) |
| P3 | G | 문구: 문장의 "(Haeun now) now →" 반복, "After saving, 1 service of … stop following Mirae Pay", 단계만 추가했는데 "Ordering switched from All at once to Custom, because you changed who a step calls", 플랜을 바꾼 뒤 문장이 "Call was Slack … was on shift in …"로 읽기 어려움 | 각 편집 화면 |
| P3 | H | Lumen Bank 배너는 Kyungmin Oh에게 "no verified Slack"이라는데 Responders 카드에는 SMS·Call만 not verified로 나온다 | `/c/lumen/call-order` (M-lumen-1440) |
| P3 | I | 상속 서비스에서 E 키로 편집에 들어가면 2단계 입력으로 스크롤되어 "Creating own steps for …" 설명이 보이지 않는다(저장 버튼 라벨로는 알 수 있음) | 1280: `/c/mirae/core/checkout/call-order` → E (N-inherited-edit-1280) |
| P3 | J | 1440 편집기 1단계 선택 상자 글자 잘림("(Haeun no") | `/c/mirae/call-order` → Edit (A-mirae-edit-1440) |
| P3 | K | Call order 주소의 Not found 버튼이 "Back to Incidents". 초안이 있어도 Call order 밖에서는 표시가 없음 | `/c/nope/call-order` |

### 판정

**머지 불가 — P1 1건, P2 2건. 보안 [차단] 0건.** 단계 편집의 핵심(읽기 먼저, 전체 경로 저장 라벨, 이탈 가드, 초안, 넓히기, own steps, 409)은 세 폭 모두에서 통과했고, 트리·Ctrl/⌘K·행 클릭·뒤로가기·초안 Resume 어느 경로로도 엉뚱한 고객에 단계가 저장되지 않았다. 막는 것은 Responders 편집의 Remove(P1-A)다: 확인 없이 실행되고 줄이 포인터 아래로 올라와 두 번 누르면 두 사람이 빠지며 고객이 UNREACHABLE이 될 수 있다. P1-A를 고치고(줄 자리를 유지하거나 확인을 받고, Undo를 건마다 남김) P2-A·B를 고치거나 사유와 함께 백로그로 넘긴 뒤 재점검 필요.

점검 한계: 목 API 기준이라 백엔드의 실제 409·검증 문구는 다를 수 있다. 터치는 Playwright 에뮬레이션. 대비는 눈으로만 확인. 샌드박스에서 Google Fonts가 막혀 대체 글꼴로 렌더링됨. Rotations·Templates 탭은 스텁이라 점검 대상이 아님.

---

## Console Call order 재점검 — 2026-11-11

대상: `apps/console` (feat/console-call-order, 커밋 `d9e91b9`, origin/main은 움직이지 않아 병합 없음). 고친 쪽과 무관한 독립 재점검이며 제품 코드는 고치지 않았다. 빌드본을 직접 기동(`next build` → `E2E_ALLOW_MOCK=1 MOCK_API=1 next start -p 3121`, 시나리오 묶음마다 재기동해 목 상태 초기화, `/auth/dev-login`·`?as=operator`·`?as=viewer`)하고 Playwright로 1440×900(마우스·키보드), 390×844(터치)를 밟았다. 판정은 캡처를 직접 보고 했고, 결과는 화면이 아니라 새 세션으로 다시 읽은 서버 상태로 확인했다. 행 위치는 조작 전후 각 행의 상자(y·높이)를 기록해 비교. 캡처: `docs/qa/shots/console-call-order-recheck/` (gitignore). 보안 검토는 `/home/claude/alarmops-security-review-callorder-2.md`.

### 통합

| 항목 | 결과 |
|---|---|
| 병합 | 필요 없음 (`origin/main`에 새 커밋 없음) |
| `npm test` | 통과 — console 156, core 81, design-system 96, ingest 32 (합 365), db 스키마 검사 통과 |
| `npm run typecheck` | 통과 (console, core, design-system, ingest) |
| console `eslint .` | 통과 (경고 0) |
| `next build` | 통과 |
| Playwright (3107) | 118 / 118 통과 (새로 띄운 서버). 첫 실행 때는 3107에 이전 작업이 남긴 서버(09:57 기동, 목 상태가 이미 바뀐 것)가 떠 있어 `reuseExistingServer`가 그것을 잡았고 25건 넘게 실패했다. 새 서버(3122)에서 118/118, 그 서버가 사라진 뒤 3107에서 다시 118/118. 코드 문제가 아니라 실행 환경 문제이나, 남은 서버가 있으면 결과가 틀어진다는 점은 기억할 것 |

### 이전 실패 항목 재실행

| # | 이전 문제 | 폭 | 결과 | 측정·관찰 | 캡처 |
|---|---|---|---|---|---|
| P1-A | Remove를 같은 자리에서 빠르게 두 번 | 1440·390 | 통과 | 90ms 간격 두 번 → 확인 상자 "Remove Junho Park from Responders of Daon Retail?"만 뜨고 기본 포커스 "Keep Junho Park". 서버: 아무도 안 빠짐 | P1A-1440-1-dialog, P1A-390-1-dialog |
| P1-A | 같은 자리 느린 두 번째 누름 (0.7 / 1.5 / 3초) | 1440·390 | 통과 | 세 번 모두 확인 상자 그대로, 포커스도 "Keep …" 그대로, 서버 변화 없음. 확인 버튼은 Remove… 자리와 떨어져 있음(1440: Remove… 1329×747, 확인 481–725×530 / 390: Remove… y 422, 확인 y 500–544) | — |
| P1-A | 확인 버튼 더블클릭, 그 뒤 Remove… 자리 다시 누름 (0.8 / 1.6 / 2.4초) | 1440·390 | 통과 | Junho 한 명만 제거. Remove… 자리에는 "Junho Park · Removed · kept here until you press Done"(누를 것 없음), Undo는 줄 반대쪽(1440 x 1040, 390 x 29–93). 행 이동 0건 | P1A-1440-2-tombstone |
| P1-A | 두 명 제거 뒤 첫 번째 사람 Undo | 1440·390 | 통과 | Junho·Minjae 각자 자기 줄에 Undo. Junho의 Undo(더블클릭) → Junho만 돌아옴, Minjae는 제거된 채. 서버 일치. Undo 자리에는 글자만 옴. 행 이동 0건(1440에서 두 번째 제거 때 아래 세 줄이 1px 내려감) | P1A-1440-4-two-tombstones, P1A-390-5-undo-first |
| P1-A | 범위를 AT RISK로 만드는 제거 | 1440·390 | 통과 | Junho 제거 뒤 Minjae: 확인 상자에 노란 "AT RISK After this, Daon Retail is harder to reach: Step 2 (SMS at 2 min) reaches only Soyeon Choi, who has no verified SMS. Step 3 …". 제거 뒤 목록 행·패널 모두 AT RISK | P1A-1440-3-unreachable-warning |
| P1-A | 범위를 UNREACHABLE로 만드는 제거·역할 변경 | 1440·390 | 통과 | 남은 Pageable 한 명(Soyeon)을 Remove… 또는 Notify only로: 빨간 "UNREACHABLE After this, nobody for Daon Retail is reached if something breaks. … Add someone else first, or keep Soyeon Choi.", 기본 포커스 "Keep Soyeon Choi Pageable". Enter를 누르고 있어도 유지(서버 변화 없음). 명시적으로 확인하면 적용되고 패널·목록이 UNREACHABLE, 토스트 Undo로 복귀 | A3-390-unreachable-warning, A3-1440-unreachable-after |
| P1-A | Notify only로 역할 변경 | 1440·390 | 통과 | 도달에 영향이 있으면 묻고(위), 없으면(Hanbit의 Eunbi Song) 바로 적용 + 토스트 "… is now Notify only for Hanbit Logistics · Undo". 행 이동 0건 | — |
| 행 고정 | Incidents (Ack 두 건, 같은 자리 더블·느린 누름) | 1440·390 | 통과 | 1행 더블클릭 → 2행으로 이동 → 포인터 밑은 2행 버튼, 두 건만 Ack, 행 이동 0건, "2 acknowledged in place · Re-sort". 같은 자리 0.7·1.5·3초 누름은 아무 일 없음. 390 탭 5회도 1건만 | R6-incidents-1440 |
| 행 고정 | Call order 목록 (저장, own steps 생성·제거) | 1440 | 통과 | 저장 뒤 패널이 닫히고 행 순서·위치 유지, own steps 행은 추가되고(17행) 제거 뒤 "follows Mirae Pay again" | — |
| 행 고정 | Responders (제거, Undo, 역할, 409) | 1440·390 | 통과 (P2-B) | Chromium에서는 모든 구간 0~1px. 단 범위 상태가 바뀌는 제거에서는 문서 좌표로 줄이 225~269px 내려가고 브라우저의 스크롤 보정이 화면 위치를 지켜 준 것이다 — 아래 P2-B | A3-390-after-minjae |
| P2-A | 플랜 이름 | 1440·390 | 통과 | 인시던트 패널(두 곳)과 Call order 모두 "Custom, started from Urgent (edited)". 편집기에서도 Urgent (edited)가 선택됨 | P2A-1440-incident, P2A-1440-callorder |
| P2-B | 한도 표시, 12단계 | 1280·390 | 통과 | "Limits: Up to 12 steps · minutes 0–1,440 … · repeat 0–5 · at most 60 notifications … 120 in an hour · "everyone" reaches at most 20 people", "3 of 12 steps", 보내는 수 "7 of 60 … 14 of 120". 12에서 + Add step 비활성 + "12 of 12 steps — that is the limit. Remove a step to add another."(강제로 눌러도 12). 오류는 단계와 고칠 것을 말함: "Step 3 (2 min) would not come after step 2 (2 min). Fix the minutes to save.", "Step 3: "2.5" was not entered — minutes are a whole number from 0 to 1440, digits only. It stays at 2 min.", "Repeat must be a whole number from 0 to 5." | P2B-390-12steps |
| 초안 | 로그아웃하면 초안 삭제 | 1440·390 | 통과 | 편집 중이 아닐 때: Sign out → `/login?signedOut=1`, `ao-…` 키 0개, 쿠키 없음, 뒤로가기는 `/login?next=…`, 다시 로그인해도 초안 없음 | SIGNOUT-1440-login |
| 초안 | 다른 사용자는 이전 사용자의 초안을 못 봄 | 1440·390 | 통과 | 관리자 초안 2개(Mirae Pay, Daon Retail) → 같은 탭에서 로그아웃 없이 operator 로그인 → 초안 줄 0, 키 0, 패널은 저장된 값(10분). 관리자로 돌아와도 돌아오지 않음. 다른 사용자 id로 키를 직접 심어도 안 보임 | DRAFT-1440-operator |
| 로그아웃 | 편집 중 Sign out | 1440·390 | **P2-A** | 가드가 뜨는 것까지는 맞음. 그런데 "Keep draft and sign out" / "Discard changes" / "Save for …" 어느 것을 눌러도 로그아웃되지 않는다(아래 문제 목록) | SIGNOUT-GUARD-1440-Keepdraft |
| 역할 | operator·viewer | 1440·390 | 통과 (P3) | 계정 메뉴에 Operator/Viewer. Edit call order·Create own steps·Edit responders 비활성 + 이유가 글로 보임: "Read only. Changing the call order needs the Admin role. You are signed in as Operator.", "Changing Responders needs the Admin role. …". 입력 요소 0개, E 키·비활성 속성을 지우고 눌러도 편집 화면이 안 열림. viewer는 Acknowledge 비활성, operator는 가능. 관리자의 요청을 operator·viewer 세션으로 다시 보내도 `ROLE_REQUIRED`, 서버 변화 없음 | ROLE-operator-390-resp, ROLE-viewer-390-incidents |
| 409 | Responders 두 탭 | 1440 | 통과 | A가 Junho 제거 → 낡은 B가 Minjae 제거: "Changed — reload. Someone else changed the Responders of Hanbit Logistics while you were editing. Your last change was not applied." 서버 변화 없음, B의 버튼 전부 비활성, Reload 뒤 Junho 줄은 "No longer in Responders · changed by someone else"로 제자리 | 409-resp-B, 409-resp-B-reloaded |

### 회귀 점검

| 시나리오 | 폭 | 결과 | 관찰 |
|---|---|---|---|
| 세 고객 키보드만으로 저장 (Mirae Pay, Daon Retail, Hanbit Logistics) | 1440 | 통과 | Ctrl K → 이름 → Enter → J → Enter → E(2단계 분에 포커스) → 숫자 → Ctrl+Enter → Shift+Tab → Enter. 14~17키. 각자 자기 고객에만 저장(8·3·4분), Ara Games 변화 없음. 확인 상자 기본 포커스가 Cancel로 바뀌어 Enter만으로는 저장되지 않음(이전 P3-C 해결), J/K 행 이동 동작(이전 P3-E 해결) |
| 편집 중 인시던트 Ack하고 돌아와 이어가기 | 1440 | 통과 | Incidents → 가드 "Keep draft and continue" → Ack 두 건 → Call order → "Draft for Mirae Pay · Resume" → 2단계 6분 그대로, 저장 버튼 "Save for Mirae Pay" |
| 서비스 → 고객 전체로 넓히기 | 1440 | 통과 | 넓히기 상자 기본 포커스 "Stay on Hanbit Logistics › Fulfilment › Orders API"(Enter는 머무름). 넓힌 뒤 "Save for Hanbit Logistics" + "← Back to Orders API", 저장 확인에 "Wider than the row you opened". 저장 뒤 고객은 5분, Orders API의 own steps는 그대로 |
| own steps 생성·제거 | 1440 | 통과 | Mirae Pay › Core › Checkout: E → 7 → Ctrl+Enter, "Own steps created for … · 1 service · Undo", 고객은 8분 그대로. 제거 상자 기본 포커스 "Keep them"(Enter는 유지), 제거 뒤 다시 Mirae Pay를 따름 |
| 폰에서 읽기·수정 | 390 | 통과 | 시트 4탭으로 Daon Retail › Commerce › Checkout, "YOUR FILTER" 행 → 패널 문장 + Paged (3) 이름, 입력 요소 0. Create own steps → 2단계 4분(숫자 자판, 16px) → "Save own steps for Daon Retail › Commerce › Checkout". 44px 미만 0개, 가로 넘침 0, 고객 값은 그대로 |
| Ack 안전 | 1440·390 | 통과 | 위 "행 고정 · Incidents" 줄 |
| 콘솔 오류, 가로 넘침 | 전 폭 | 통과 | 앱 오류 0건(샌드박스에서 Google Fonts 요청만 실패), scrollWidth = 화면 폭 |

### 엉뚱한 사람·범위를 제거/강등/저장하려는 새 시도

| # | 시도 | 폭 | 결과 | 관찰 |
|---|---|---|---|---|
| X1 | Remove…에 포커스 두고 Enter 3초, Space 3초 유지 | 1440 | 통과 | 상자가 열리고 "Keep …"으로 닫히기를 반복할 뿐, 아무도 안 빠짐 |
| X2 | 확인 버튼으로 옮겨 Enter 3.5초 유지 | 1440 | 통과 (P3) | 이름이 뜬 Junho 한 명만 제거, 다음 사람 상자는 열리지 않음. 다만 제거 뒤 포커스가 문서 맨 위(body)로 떨어짐 |
| X3 | 묘비 줄: 글자 클릭, Undo 3연타, Undo 자리 0.8·1.5초 뒤 누름, Undo에서 Enter 유지 | 1440 | 통과 (P3) | 글자는 반응 없음. Undo는 한 번만 실행(Junho 복귀), 그 자리에는 글자만 와서 이후 누름은 아무 일 없음. Enter 유지도 한 번만. Undo 뒤에도 포커스가 body로 떨어짐 |
| X4 | 제거 뒤 다른 고객 패널로 나갔다가 예전 Undo 자리 누름·뒤로가기 / 역할 토스트 Undo를 다른 고객 패널에서 누름 | 1440 | 통과 | 나가면 묘비·Undo는 사라짐(안내대로), 예전 자리에는 Hanbit 패널의 글자, Hanbit 변화 없음. 돌아오면 Junho는 제거된 상태. 역할 토스트는 Daon 패널에서 눌러도 "Undone · Eunbi Song is Pageable for Hanbit Logistics again" — 원래 고객에만 적용 |
| X5 | 두 탭: B가 Junho 확인 상자를 띄운 사이 A가 Junho 제거 → B 확인 → B가 Done→Edit 뒤 Minjae 제거 → A가 Undo | 1440 | 통과 (P3) | B의 확인은 "Not found. It may have been removed…"(아무도 안 빠짐), 이어진 Minjae 제거는 "Changed — reload"로 막힘. A의 Undo는 Junho만 복귀. 단 404 뒤에는 B 화면에 Junho가 그대로 남고 Reload 안내가 없음 |
| X6 | 확인 상자가 뜬 채 Ctrl K로 다른 고객 필터, 뒤로가기 | 1440 | 통과 (P3) | 확인 상자 위로 "Filter to…"가 열리고 Hanbit을 고르면 필터가 바뀌며 패널·상자가 닫힘 — 아무도 안 빠짐, Hanbit 변화 없음. 뒤로가기도 상자가 닫히고 변화 없음. 상자가 Ctrl K를 막지는 않음 |
| X7 | 확인 상자가 뜬 채 창을 1440→390으로, 제거 뒤 1380·1280·1024·1440으로 | 1440→390 | 통과 | 상자·이름·기본 포커스 유지(390에서 버튼 316×44). 제거 뒤 폭을 바꿔도 묘비 유지, 예전 Remove… 자리에는 버튼이 오지 않음, 가로 넘침 0 |
| X8 | 제거 직후 스크롤로 다음 사람의 Remove…를 같은 자리로 가져와 0.45초·1.7초 뒤 누름, 상자 뜬 채 두 번 더 | 1440·390 | 통과 | "Remove Minjae Lee from Responders of Daon Retail?"이 이름과 함께 뜨고 기본 포커스 "Keep Minjae Lee". 같은 자리를 더 눌러도 그대로. Minjae는 안 빠짐 |
| X9 | 역할 선택 상자에서 ↓ 12번, ↑↓ 번갈아 6번 | 1440 | 통과(참고) | 도달에 영향 없는 Eunbi는 마지막 값(Notify only)으로 한 번 적용 + 토스트 Undo, 충돌·오류 없음. 확인 없이 바뀌는 것은 설계대로이나 키 한 번으로 호출 대상에서 빠진다는 점은 기억할 것 |
| X10 | 확인 누른 직후(40ms) 다른 두 사람의 Remove…를 연달아 | 1440 | 통과 | 마지막에 누른 사람(Minjae) 이름의 상자 하나만 뜸. 확인하면 Junho·Minjae 각자 묘비+Undo, 세 번째 사람(Sungmin)은 그대로 |
| X11 | Remove…에서 눌러 다른 사람의 Remove…에서 뗌(드래그) | 1440 | 통과 | 아무 일 없음 |
| X12 | Responders 편집 중(묘비 있음) E 키·Edit call order | 1440 | 통과 | Edit call order 비활성 + "Editing Responders of Daon Retail: each change applies at once. The steps stay as they are until you press Edit.", E 무시 |
| X13 | 스크롤 보정이 없는 브라우저 흉내(`overflow-anchor: none`)로 범위 상태가 바뀌는 제거 | 1440·390 | **P2-B** | 아래 문제 목록 |

### 보안 재검토 요약 (`git diff 7b636ae..HEAD -- apps packages`, 읽기 전용)

| 항목 | 결과 | 확인 |
|---|---|---|
| 로그아웃 경로 | 통과 (화면 경로는 P2-A) | GET·HEAD 405, 다른 출처·`Origin: null`·cross-site POST 403(세션 유지), 같은 출처 POST 303 + `ao_session=; Max-Age=0; HttpOnly; SameSite=lax` |
| 초안 키·삭제 | 통과 | 키에 사용자 id, 본문과 불일치하면 버림, 사용자가 바뀌면 읽기 전에 삭제, 로그아웃 때 삭제 |
| Responders If-Match | 통과 | 세 쓰기 모두 버전 전송, 낡은 요청은 409·변화 없음 |
| 서버 액션 검증 | 통과 | 화면과 같은 규칙(12단계, 분 증가, 채널 중복, 닿는 사람, 발송 한도, 이메일·전화 형식) |
| 역할 | [권고] | 화면은 버튼을 끄고, 실제 거부는 API가 함. 콘솔 서버 액션은 세션만 확인한다. 목 API는 `ROLE_REQUIRED`로 거부(확인함) — 실제 백엔드의 역할 검사는 백엔드 PR에서 확인 필요 |
| `?as=` | 통과 | 목 모드에서만(아니면 404, 운영에서는 목 모드 자체가 예외), 알 수 없는 값·`__proto__`는 기본 사용자, 역할은 쿠키가 아니라 API 쪽 |
| 0.6초 가드 | 통과 | 포인터만, 표시한 지점 24px 안만 삼킴. 삼켜지면 "아무 일 없음"이라 Cancel·Keep이 삼켜져도 상태는 안 바뀜. 키보드는 안 막음 |
| 헤더·미들웨어 | 통과 | CSP·XFO·Referrer·nosniff·Permissions·HSTS 유지, 공개 경로는 `/auth/sign-out` 하나만 추가 |
| [차단] | 0건 | [권고] 4건(편집 중 로그아웃 실패, 역할은 백엔드 의존, `X-Forwarded-Host` 신뢰, 404 뒤 Reload 안내 없음) |

### 문제 목록

| 등급 | # | 문제 | 재현 |
|---|---|---|---|
| P1 | — | 없음 | — |
| P2 | A | 편집 중 Sign out을 누르고 가드에서 "Keep draft and sign out", "Discard changes", "Save for …" 중 어느 것을 골라도 로그아웃되지 않는다. 화면은 편집기 그대로이고 세션 쿠키가 남아 `GET /call-order`가 200이다. 한편 브라우저의 초안은 지워진다("Keep draft"를 골랐는데도). 가드의 버튼을 누르는 순간 계정 메뉴가 닫히며 로그아웃 폼이 사라지는 것이 원인으로 보임(`AccountMenu.tsx`). 편집 중이 아닐 때의 로그아웃은 정상. 기존 e2e는 가드의 Cancel만 확인 | 1440·390: `/c/iruda/call-order` → Edit → 2단계 분 변경 → 계정(HK) → Sign out → "Keep draft and sign out" → 주소·화면 그대로, 다시 `/call-order`에 들어가짐 (SIGNOUT-GUARD-1440-Keepdraft) |
| P2 | B | "행이 움직이지 않는다"가 Responders에서는 브라우저의 스크롤 보정에 기대고 있다. 제거·역할 변경으로 고객 상태가 바뀌면(정상 → AT RISK → UNREACHABLE) 패널 위쪽에 상태 띠가 생기고 그 아래 전부가 내려간다. Chromium은 스크롤을 자동으로 맞춰 화면 위치를 지키지만(0~1px), 그 보정을 끄면 Responders 줄이 225~269px(AT RISK), 39px(UNREACHABLE) 움직인다. 스크롤 보정이 없는 것으로 알려진 Safari(아이폰)에서는 이렇게 보일 가능성이 높다. 모든 Remove…가 이름을 넣어 다시 묻고 기본이 "Keep …"이라 엉뚱한 사람이 조용히 빠지지는 않으며, 이번 재현에서 예전 자리에 온 것은 안내 글과 "Add MSP staff…" 선택 상자였다. 409 띠("Changed — reload")도 같은 자리에 생기지만 그때는 버튼이 전부 꺼져 있다. 실기기 확인 필요 | 390 또는 1440, 페이지에 `*{overflow-anchor:none}` 적용: `/c/daon/call-order` → Edit responders → Junho Park 제거 → Minjae Lee 제거(확인) → 줄 전체가 269px/225px 아래로 (A3-390-noanchor-after-minjae) |
| P3 | A | viewer가 폰에서 Incidents 목록의 꺼진 Acknowledge를 보면 이유가 없다(이유는 `title`뿐이라 터치에서는 안 보임). 패널을 열면 글로 나옴 | 390, `?as=viewer`, `/incidents` (ROLE-viewer-390-incidents) |
| P3 | B | Responders에서 키보드로 제거를 확인하거나 Undo하면 포커스가 문서 맨 위로 떨어진다(Incidents는 그 줄에 남음) | 1440: Remove…에 포커스 → Enter → Shift+Tab → Enter |
| P3 | C | 다른 탭에서 이미 제거된 사람을 제거하면 "Not found…"만 나오고 그 사람이 목록에 남으며 Reload 안내가 없다(다음 변경은 409로 막힘) | 두 탭에서 같은 사람 Remove… |
| P3 | D | 확인 상자가 떠 있어도 Ctrl K "Filter to…"가 그 위로 열린다(고르면 패널이 닫힐 뿐 변화는 없음) | Remove… → Ctrl K |
| P3 | E | 3107에 이전 서버가 남아 있으면 Playwright가 그것을 재사용해 무관한 실패가 난다. 시작 전에 포트를 확인하거나 CI에서는 `reuseExistingServer`를 끌 것 | 남은 `next start -p 3107`이 있는 상태에서 `npx playwright test` |
| P3 | — | 이전 P3-F·G·H·I·K는 이번에 다시 보지 않았다(P3-C·D·E·J는 해결 확인) | — |

### 판정

**머지 불가 — P1 0건, P2 2건, 보안 [차단] 0건.** 이전 P1-A는 고쳐졌다: Remove…는 사람과 고객 이름으로 묻고 기본이 "Keep …"이며, 같은 자리 두 번(90ms~3초)·확인 더블클릭·Enter 유지·스크롤·창 크기 변경·두 탭·필터 변경 어느 경로로도 이름이 뜨지 않은 사람이 빠지지 않았고, 제거된 사람은 제자리에 남아 각자 Undo를 가진다. UNREACHABLE·AT RISK 경고, P2-A(플랜 이름), P2-B(한도), 초안의 사용자 분리, 역할, Responders 409도 통과했고 회귀는 없다. 막는 것은 새로 생긴 로그아웃 경로의 P2-A다: 편집 중에 누른 Sign out이 "sign out"이라고 답하고도 세션을 남긴다. 고칠 범위는 좁다(폼이 메뉴와 함께 사라지지 않게) — 고친 뒤 "로그아웃" 두 줄과 가드의 세 버튼만 재실행하면 된다. P2-B는 같은 PR에서 고치거나(상태 띠·409 띠가 목록을 밀지 않게 자리 확보), 아이폰 Safari 실기기 확인을 조건으로 사유와 함께 백로그로 넘길 수 있다.

점검 한계: 목 API 기준(역할·If-Match·검증의 실제 강제는 백엔드에서 확인 필요). 터치는 Playwright 에뮬레이션이고 Safari는 `overflow-anchor: none`으로 흉내만 냈다. 역할 선택 상자의 ↓ 반복은 헤드리스에서 값이 안 바뀌는 경우가 있어 Eunbi 한 건만 판정에 썼다. 대비는 눈으로만 확인. 샌드박스에서 Google Fonts가 막혀 대체 글꼴로 렌더링됨.

---

## Console Call order 최종 점검 — 2026-11-11

대상: `apps/console` (feat/console-call-order, 커밋 `28e60b0`, origin/main은 `1eb757f` 그대로라 병합 없음). 고친 쪽과 무관한 독립 점검이며 제품 코드는 고치지 않았다. 재점검에서 실패한 것(P2-A, P2-B, P3-A~D)과 새 동작("Responders 편집 중 패널 나머지는 멈춰 있다가 Done에 갱신")만 다시 밟았고, 회귀는 빠르게만 봤다. 빌드본을 직접 기동(`E2E_ALLOW_MOCK=1 MOCK_API=1 next start -p 3142`, 묶음마다 재기동해 목 상태 초기화), Playwright 1440×900(마우스·키보드)·390×844(터치), 캡처를 직접 보고 판정했고 결과는 새 세션으로 다시 읽은 서버 상태로 확인했다. 행 위치는 `overflow-anchor: none`을 넣은 뒤 각 행의 화면 좌표(top·height, 소수점 그대로)와 모든 스크롤 위치를 조작 전후로 비교. 캡처: `docs/qa/shots/console-call-order-final/` (gitignore). 보안 검토는 `/home/claude/alarmops-security-review-callorder-3.md`.

### 통합

| 항목 | 결과 |
|---|---|
| 병합 | 필요 없음 (`origin/main`에 새 커밋 없음) |
| `npm test` | 통과 — console 173, core 81, design-system 97, ingest 32 (합 383), db 스키마 검사 통과(샌드박스에서 Prisma 엔진 내려받기가 막혀 스크립트의 대체 경로로 검증) |
| `npm run typecheck` | 통과 (console, core, design-system, ingest) |
| console `eslint .` | 통과 (경고 0) |
| `next build` | 통과 |
| Playwright (`PORT=3141 PW_NO_REUSE=1`) | 133 / 133 통과 (직접 띄운 새 서버, 6.3분) |

### 이전 실패 항목 재실행

| # | 이전 문제 | 폭 | 결과 | 측정·관찰 | 캡처 |
|---|---|---|---|---|---|
| P2-A | 편집 중 Sign out — 가드 | 1440·390 | 통과 | 버튼이 셋으로 바뀜: "Save for Iruda Edu and sign out" / "Sign out without saving" / "Cancel"(초안 유지는 없앰 — 로그아웃이 초안을 지우므로). 본문이 그 이유와 "If the save does not go through, you stay signed in."을 말함. 가로 넘침 0 | P2A-1440-1-guard, P2A-390-1-guard |
| P2-A | Sign out without saving | 1440·390 | 통과 | `/login?signedOut=1`, 세션 쿠키 없음, `ao-…` 키 0개(직전 초안 키 1개), 다시 `/call-order` → `/login?next=…`. 서버 값 그대로(5분), 다시 로그인해도 초안 없음 | P2A-1440-2-after-nosave |
| P2-A | Save … and sign out (저장 성공) | 1440·390 | 통과 | 서버에 9분 저장된 뒤 로그아웃(쿠키 없음·키 0·`/login`) | — |
| P2-A | 저장이 막힘 (2단계 0분) | 1440·390 | 통과 | 로그인 유지, 토스트 "Not signed out: Iruda Edu was not saved. Fix what is marked and save, or sign out without saving.", 문제 줄 "Step 2 (0 min) would not come after step 1 (0 min)…", 포커스는 2단계 분, 초안 유지 | P2A-1440-4-blocked |
| P2-A | 저장이 서버에서 실패 (다른 세션이 먼저 저장 → 409) | 1440·390 | 통과 | 로그인 유지, 같은 토스트 + 패널 "Changed — reload. Someone else changed the call order of Iruda Edu while you were editing. Nothing was saved, and your draft is kept as you typed it." 서버는 다른 세션의 값(7분). 그 상태에서 "Sign out without saving"은 정상 로그아웃 | P2A-390-5-failed-409 |
| P2-A | 저장 확인 상자에서 Cancel (여러 서비스에 닿는 저장, Cheong Media) | 1440·390 | 통과 (P3-F) | 로그인 유지, 편집 화면 그대로, 서버 변화 없음. 다만 이때는 "Not signed out" 안내가 없고, 확인 상자("Save for Cheong Media?")도 저장 뒤 로그아웃된다는 말이 없다 | P2A-1440-6-confirm-wide, -7-confirm-cancelled |
| P2-A | 가드의 Cancel · Esc | 1440·390 | 통과 | 가드만 닫힘, 입력 값·세션 그대로 | — |
| P2-A | 편집 중이 아닐 때 Sign out / 다른 고객 초안만 남아 있을 때 | 1440·390 | 통과 | 가드 없이 바로 로그아웃, 쿠키 없음·키 0, 다시 로그인해도 초안 없음. 메뉴에 "Signing out removes the drafts kept in this tab." | P2A-1440-8-menu |
| P2-B | Responders 행 고정 (`overflow-anchor: none`) — 제거 → AT RISK → UNREACHABLE → 역할 복귀 → Undo 두 번 | 1440·390 | 통과 | 여섯 구간 모두 0.00px, 스크롤 위치도 그대로(재현 때는 225~269px·39px). 상태는 목록 위의 44px 고정 줄("Reach now: OK" → "AT RISK … harder to reach now" → "UNREACHABLE Nobody for Daon Retail is reached now")과 마지막 줄 아래 상세로 나옴. 가로 넘침 0 | P2B-1440-1-at-risk, P2B-390-2-unreachable |
| P2-B | 409 띠 (다른 세션이 먼저 변경) | 1440·390 | 통과 | 0.00px. 고정 줄 "Changed — reload. The last change was not applied · details below the list [Reload]", 상세는 목록 아래. 남는 버튼은 Done·Reload 둘뿐. 서버 변화 없음 | CONF-1440-409, CONF-390-409 |
| P2-B | 새 동작: 편집 중 패널 나머지는 멈춤, Done에 갱신 | 1440·390 | **P2-C** | Done을 누르면 패널이 최신이 된다(AT RISK 띠, "Paged (1): Soyeon Choi"). 그러나 편집 중에는 아래 문제 목록 P2-C | P2B-1440-3-held-top, P2B-390-3-held-top, P2B-1440-4-after-done |
| P3-A | viewer가 폰에서 꺼진 Acknowledge의 이유 | 390 | 통과 | 목록 위에 글로 "Read only. Acknowledging needs the Operator role. You are signed in as Viewer."(13px, 첫 화면 y 431). operator에게는 안 나옴. Call order 패널에도 두 이유가 글로 보임 | P3A-390-viewer-incidents |
| P3-B | 키보드로 제거·Undo 뒤 포커스 | 1440 | 통과 | Enter → (기본 "Keep Junho Park") Shift+Tab → Enter: 포커스가 Junho 줄(2px 테두리 보임). Tab → "Undo: put Junho Park back" → Enter: 다시 Junho 줄. 다음 Tab은 그 줄의 Remove… | P3B-1440-focus-after-remove |
| P3-C | 다른 탭이 이미 제거한 사람을 제거 (404) | 1440·390 | 통과 | "Changed — reload. Someone else changed the Responders of Daon Retail …"(맨 "Not found" 없음), 0.00px, Reload 뒤 그 줄은 "Junho Park · No longer in Responders · changed by someone else" | P3C-1440-404 |
| P3-D | 질문 위로 Ctrl/⌘K | 1440 | 통과 | Remove 확인, Unsaved changes 가드, Save 확인 세 상자 모두에서 Ctrl K·⌘K가 아무것도 열지 않고 상자·기본 포커스 유지. 질문이 없을 때는 전처럼 열림 | — |

### 회귀 점검 (빠르게)

| 시나리오 | 폭 | 결과 | 관찰 |
|---|---|---|---|
| 세 고객 키보드만으로 저장 (Mirae Pay, Daon Retail, Hanbit Logistics) | 1440 | 통과 | Ctrl K → 이름 → Enter → Tab → Enter → E(2단계 분에 포커스) → 숫자 → Ctrl+Enter → Shift+Tab → Enter, 16~18키. 확인 상자 기본 포커스 Cancel. 서버: 8·3·4분, Ara Games 그대로 |
| Incidents Ack 안전 | 1440·390 | 통과 | 같은 자리 5번(90ms·0.7·1.5·3초 간격): 한 건만 Ack, 행 이동 0, 그 자리에는 글자만("Acknowledged ✓"), "1 acknowledged in place · Re-sort" |
| 폰에서 읽기·수정 | 390 | 통과 | Daon Retail › Commerce › Checkout: 입력 요소 0, 가로 넘침 0, 44px 미만은 "Skip to content"뿐. Create own steps → 2단계 4분(숫자 자판, 16px) → 저장. 서버: Checkout 4분, 고객 값 그대로 |
| 서비스 → 고객 전체로 넓히기 | 1440 | 통과 | 넓히기 상자 기본 포커스 "Stay on Hanbit Logistics › Fulfilment › Orders API"(Enter는 머무름). 넓힌 뒤 "Save for Hanbit Logistics", 확인에 "Wider than the row you opened". 서버: 고객 5분, Orders API own steps 그대로 |
| 콘솔 오류 | 전 폭 | 통과 | 위 시나리오에서 앱 오류 0건 (세션이 사라진 경우 제외 — P2-D) |

### 로그아웃·Responders 편집 주변의 새 시도

| # | 시도 | 폭 | 결과 | 관찰 |
|---|---|---|---|---|
| A1 | 가드의 "Save … and sign out"을 60·40ms 간격 3번 / "Sign out without saving" 3번 | 1440·390 | 통과 | 저장 요청 1건 + 로그아웃 1건만 나감, 오류 0. 저장 안 함 쪽은 저장 요청 0건 |
| A2 | 둘째 탭에서 로그아웃한 뒤 첫 탭에서 Save / Responders Remove 확인 | 1440·390 | **P2-D** | 서버에는 아무것도 안 바뀐다(좋음). 그런데 화면은 "Saving…" / "Removing…"에서 영원히 멈추고 아무 말이 없다. 아래 문제 목록 |
| A3 | 로그아웃 뒤 뒤로가기 3번·앞으로 | 1440·390 | 통과 | 매번 `/login?next=…`, 고객·사람 이름 없음, 이전 문서가 되살아나지 않음(bfcache 복원 없음 — 응답이 `no-store`) |
| A4 | 관리자 초안을 둔 채 같은 탭에서 `?as=operator` → `?as=viewer` → 관리자 | 1440·390 | 통과 | 초안 키 0, 초안 줄·"Draft for" 없음, 화면 값은 저장된 5분, 뒤로가기로도 관리자의 입력(9분)이 안 보임. 관리자로 돌아와도 초안은 돌아오지 않음. operator 세션에서 관리자 id의 키를 직접 심어도 안 보임 |
| A5 | 저장이 진행 중(3초 지연)일 때 Sign out | 1440·390 | 통과 (P3-G) | 가드가 뜬다. "Sign out without saving" → 로그아웃. "Save … and sign out" → 아무 말 없이 무시되고 진행 중이던 저장만 끝나 "Saved for Iruda Edu" 토스트, 로그인 유지 |

### 보안 재검토 요약 (`git diff d9e91b9..HEAD -- apps packages`, 읽기 전용)

| 항목 | 결과 | 확인 |
|---|---|---|
| 로그아웃 폼(body에 붙임) | 통과 | GET 405. 다른 출처·`Origin: null`·다른 포트·`Sec-Fetch-Site: cross-site`/`same-site` 모두 403(세션 유지). 같은 출처 303 → 항상 `/login?signedOut=1`(`next`·본문 값은 읽지 않음 — 열린 리다이렉트 없음), `ao_session=; Max-Age=0; HttpOnly; SameSite=lax`. CSP `form-action 'self'` 유지 |
| `TRUSTED_PROXY` | 통과 | 미설정: `X-Forwarded-Host`를 위조해도 403. `=1`: XFH(첫 값)와 Origin 비교, XFH 없으면 Host. README에 조건 명시 |
| 서버 액션의 `requireRole` | 통과 | 서버 액션 11개 전부(`call-order/actions.ts` 5개 ADMIN, `incidents/actions.ts` 6개 OPERATOR) `run()` 안에서 세션 → 역할 → 입력 순서. 빠진 것 없음. 관리자의 실제 요청을 operator·viewer 세션으로 다시 보내면 없는 고객·없는 사람이어도 똑같이 `ROLE_REQUIRED`, 서버 변화 없음. 세션 없으면 `/login`으로 307 |
| `/me` 실패 | 통과 | 예외는 `run()`의 catch로 가서 거부, 모르는 역할 값은 최하위 취급. 단위 테스트 있음 |
| 로그아웃 뒤 캐시 | 통과 | 인증 페이지·RSC 응답 `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, 뒤로가기는 `/login`. localStorage에는 테마뿐 |
| 헤더 | 통과 | CSP·X-Frame-Options·Referrer-Policy·nosniff·Permissions-Policy·HSTS 그대로 |
| [차단] | 0건 | [권고] 4건: 세션이 사라진 뒤의 쓰기가 멈춤(P2-D), Origin 비교가 호스트만 봄(스킴 무시), 서명 쿠키라 로그아웃이 서버에서 토큰을 무효화하지는 않음(SSO 연결 때), 다른 탭에서 로그아웃하면 이 탭의 초안 키는 남음(다른 사용자가 로그인하면 읽기 전에 삭제됨 — 확인) |

### 문제 목록

| 등급 | # | 문제 | 재현 |
|---|---|---|---|
| P1 | — | 없음 | — |
| P2 | A·B | 재점검의 P2-A(편집 중 로그아웃), P2-B(스크롤 보정 의존)는 해결 확인 | — |
| P2 | C | (P2-B 수정으로 생김) Responders 편집 중 패널 위쪽이 거짓을 "지금"이라고 말한다. 두 명을 빼고 한 명을 Notify only로 바꿔 서버가 UNREACHABLE인 동안에도 패널 맨 위는 "IF SOMETHING BREAKS NOW — Slack everyone in Responders (3) now … Paged (3): Junho Park, Minjae Lee, Soyeon Choi"이고 STEPS도 "(3)"이다. 그 자리에는 "편집 시작 때 기준"이라는 표시가 전혀 없다(흐리게도, 문구도 없음). 설명은 아래 Responders 카드 안의 한 문장("…the summary above this card stays as it was, until you press Done")과 카드의 상태 줄뿐인데, 위로 스크롤하면 둘 다 화면 밖이다. 1440에서는 바로 옆 목록 행이 "UNREACHABLE · nobody · Responders (0)"라 같은 화면에서 답이 둘이고, 390에서는 틀린 쪽만 보인다. 준호가 사람을 뺀 뒤 "그래서 지금 누가 불리나"를 확인하려고 위로 올리면 방금 뺀 사람이 그대로 Paged에 있다 — 제거가 안 먹었다고 읽거나, Done 없이 "Back to the list"로 나가면서 3명이 불린다고 믿을 수 있다. 완화: UNREACHABLE·AT RISK로 만드는 변경은 그 전에 이름을 넣어 묻고, 카드의 줄은 맞게 말하며, 편집한 본인의 그 탭에서 Done 전까지만이다. 고칠 범위는 좁다: 멈춘 구간에 Edit을 누르는 순간부터 "As of when you started editing Responders · updates on Done" 같은 표시를 두거나(Edit 때 한 번 생기므로 행을 밀지 않는다) "NOW" 문장·Paged 줄을 가린다 | 1440·390: `/c/daon/call-order` → Edit responders → Junho Park, Minjae Lee 제거 → Soyeon Choi를 Notify only → 패널을 맨 위로 (P2B-1440-3-held-top, P2B-390-3-held-top) |
| P2 | D | (이 브랜치에서 생긴 것이 아님 — main의 Incidents도 같음) 세션이 사라진 탭(다른 탭에서 로그아웃, 또는 8시간 만료)에서 쓰기를 누르면 화면이 "Saving…" / "Removing…" / "Acknowledging…"에서 영원히 멈추고 아무 안내가 없다. 서버에는 아무것도 적용되지 않으므로 잘못 저장되지는 않지만, 온콜이 밤새 열어 둔 탭에서 Acknowledge를 누르면 "처리 중"으로 보인 채 호출은 계속된다. 원인: 서버 액션 POST가 미들웨어에서 `/login`으로 307 → 클라이언트가 "An unexpected response was received from the server."를 던지는데 잡는 곳이 없다. 새로고침하면 `/login`으로 가고 초안은 남아 있다. 콘솔 전체 문제라 별도 이슈를 권함(액션 호출을 감싸 "Signed out — sign in again" 안내 + 로그인으로) | 두 탭: 첫 탭 `/c/iruda/call-order` Edit → 값 변경, 둘째 탭 Sign out, 첫 탭 Save (A2-390-save-after-other-tab-signout, A2-1440-remove-after-other-tab-signout, EXP-1440-ack-no-session) |
| P3 | F | "Save … and sign out" 뒤의 저장 확인 상자가 로그아웃이 이어진다는 말을 하지 않고, 거기서 Cancel하면 "Not signed out" 안내가 없다(README는 "told"라고 적음). 로그인은 유지되고 편집 화면 그대로라 헷갈릴 여지는 작다 | `/c/cheong/call-order` Edit → 값 변경 → Sign out → Save for Cheong Media and sign out → Cancel |
| P3 | G | 저장이 진행 중일 때 뜬 가드에서 "Save … and sign out"은 조용히 무시된다(저장은 끝나고 로그인 유지, 안내 없음). 같은 가드의 "Sign out without saving"은 이미 보낸 저장이 적용될 수 있는데도 그렇게 적혀 있다. 느린 망에서만 가능 | Save 직후 응답 전에 계정 → Sign out |
| P3 | H | 409 뒤 아래쪽 "Reload the Responders of …"를 누르면 띠가 사라지고 묘비 줄 높이가 바뀌어(76→55px) 줄들이 화면에서 140~161px 움직인다. 명시적 새로고침이고 포인터 밑에 온 것은 줄의 글자(버튼 아님), 같은 자리 재누름은 아무 일 없음 | 두 탭 409 → 아래 Reload (CONF-1440-after-bottom-reload) |
| P3 | I | 상태 줄이 한 줄 고정이라 뒷부분이 잘린다("… is reached now · d…"). 핵심 낱말(UNREACHABLE / AT RISK / Changed — reload)은 보임 | 390·1440 (P2B-390-2-unreachable) |
| P3 | — | 재점검의 P3-A·B·C·D 해결 확인, P3-E는 `PW_NO_REUSE=1`로 해결. 이전 P3-F·G·H·I·K(첫 점검 번호)는 이번에도 다시 보지 않았다 | — |

### 판정

**머지 불가(조건부) — P1 0건, P2 2건(C: 이번 수정에서 생김, D: 기존·콘솔 전체), 보안 [차단] 0건.** 재점검에서 막았던 두 건은 고쳐졌다. 편집 중 로그아웃은 세 선택 모두 말한 대로 움직이고(저장 성공 → 로그아웃, 저장이 막히거나 실패 → 로그인 유지 + 안내, 저장 안 함 → 쿠키·초안 삭제 후 `/login`), Responders 줄은 스크롤 보정을 꺼도 1440·390 모두 0px이다. P3-A~D도 해결됐고 회귀는 없다. 남은 것은 P2-B를 고치는 방법에서 나온 P2-C다: 줄을 붙들기 위해 패널 위쪽을 멈춰 두었는데, 그 멈춘 구간이 "NOW"라는 제목 아래 방금 뺀 사람을 Paged로 보여 주면서 멈췄다는 표시가 없다. 이 화면이 답해야 하는 바로 그 질문("지금 터지면 누가 불리나")에 틀린 답이 표시 없이 남는 것이라 P2로 둔다. 표시 한 줄(또는 멈춘 구간 가리기)이면 되고, 고친 뒤에는 P2-B 묶음과 이 한 장면만 재실행하면 된다. P2-D는 이 PR이 만든 문제가 아니고 main에도 있으므로 별도 이슈로 넘기는 것을 권한다 — 그 경우 이 PR을 막는 것은 P2-C 하나다. 사용자가 P2-C를 사유와 함께 백로그로 받아들이면 그대로 머지할 수 있다.

점검 한계: 목 API 기준(역할·If-Match의 실제 강제는 백엔드에서 확인 필요). 터치는 Playwright 에뮬레이션이고 Safari는 `overflow-anchor: none`으로 흉내만 냈다(WebKit 실기기 미확인). A5의 "저장 안 하고 로그아웃"은 지연을 브라우저 쪽에서 걸어 저장 요청이 서버에 닿기 전에 취소됐다 — 실제 느린 서버에서는 저장이 적용될 수 있다. 대비는 눈으로만 확인. 샌드박스에서 Google Fonts가 막혀 대체 글꼴로 렌더링됨.
