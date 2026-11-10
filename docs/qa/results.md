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
