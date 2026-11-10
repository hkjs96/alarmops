# 스코프 변형 E(Combined) — 독립 UX 평가 E1

- 대상: `/home/claude/wt-scope/docs/ui/mockups/scope-variants.html`, 탭 **E · Combined** 만
- 방법: Playwright(Chromium)로 과제마다 새로 로드해 실제 조작, 스크린샷을 눈으로 확인. 설계 문서는 읽지 않았고 화면에 보이는 것만으로 판단.
- 뷰포트: 하은 390×844(터치), 나머지 1440×900
- 한계
  - 목업 페르소나 토글은 Junho/Haeun 둘뿐이라 **신입·민재 과제는 Junho(12개 고객 담당)로 수행**.
  - `Ctrl+Enter`(저장)는 화면에 안내가 없어 추측으로 찾았음.
  - 격리(S1)는 목업 화면 기준일 뿐, 백엔드 격리 검증이 아님.
  - 34개 고객 모드에서도 목록 데이터는 14개 모드와 같았음(인시던트 7건 동일) → 대량 데이터에서의 밀도·정렬은 검증 못 함.

## 1. 과제별 결과

### 하은 (390, 새벽 3시)

| 과제 | 성공 | 조작 수 | 잘못된 스코프 위험 (재현 가능한 실수) | 확신도 |
|---|---|---|---|---|
| H1 Mirae Pay 결제 인시던트 찾고 확인(ack) | 성공. 첫 카드에 `Mirae Pay › Core › Payments API`, SEV-1. Acknowledge 후 토스트·배너 "Acknowledged in Mirae Pay › Core › Payments API · paging stopped" + Undo 5:00 | 탭 1 (스크롤 0) | 낮음. 카드마다 폭 328px Acknowledge가 있어 스크롤 중 엄지로 다른 카드 ack 가능 → Undo로만 복구. 확인 문구에 스코프 전체 경로가 나와 사후 인지는 됨 | 5 |
| H2 Mirae Pay 필터 상태에서 담당 타 고객 미해결 인시던트? | 성공(해석 필요). 필터 즉시 바 옆 빨간 칩 `1 outside +1 ack'd`, 부제 "1 in Mirae Pay · 2 open across My customers", 탭 배지 `1/2`. 칩 탭 → "1 open incident outside Mirae Pay" 목록(목록 필터는 유지) | 필터 3탭(바 → Mirae Pay → Show all of it) + 확인 1탭 | 중간. "1 outside"의 실체는 **타 고객이 아니라 UNMAPPED ACCOUNT**, Bora Foods 건은 "+1 ack'd"로 따로 셈. 칩만 보고 "타 고객 1건 터짐"으로 오독 → 탭해야 정정됨. "open"이 ack된 건을 제외한다는 정의도 화면에 없음 | 4 |
| H3 Daon Retail › Commerce › Checkout 담당자 찾기("checkout" 검색) | 성공. 5명(MSP 2, 고객 3), "whole customer, so also Checkout" 설명 포함 | 탭 4(People → 바 → 검색칸 → 결과) + 8자 | **높음.** 결과 순서가 `MY CUSTOMERS: Mirae Pay › Core › Checkout` 먼저, Daon은 `OTHER CUSTOMERS` 아래 둘째. 첫 결과를 누르면 Mirae Pay의 Checkout 사람들(Dami Ko "Checkout PM")이 나옴. "2 customers have a match… Nothing is selected" 경고와 결과 화면 제목이 방어선. 모바일은 검색칸 자동 포커스 없음, 전역 Jump 없음(숨김) | 4 |

### 신입 (1440, 2일차 — Junho 계정)

| 과제 | 성공 | 조작 수 | 잘못된 스코프 위험 | 확신도 |
|---|---|---|---|---|
| N1 Hanbit › Fulfilment › Orders API 호출 순서: 자체/상속? | 성공. **자체(OWN STEPS)**. 목록 행에 파란 `OWN STEPS`, 패널에 "own steps · used by 1 service", "INHERITS: Nothing from Hanbit Logistics while these own steps exist" | 클릭 1(답 확인), 패널까지 2 | 중간. 패널이 열리자마자 분(min) 입력칸에 포커스 → 무심코 친 숫자가 초안이 됨. 패널 상단 `EDIT AT` 라디오에서 CUSTOMER를 누르면 같은 패널이 Hanbit 전체 편집으로 바뀜(P1-2) | 5 |
| N2 Mirae Pay › Core 오늘 밤 유지보수 창 생성, 스코프 문구 | 성공. "APPLIES TO **Mirae Pay › Core — 3 services: Payments API, Settlement, Checkout. Includes every service below it, also ones added later.**" / "NOT AFFECTED Other projects of Mirae Pay and other customers." 버튼 "Create window for Mirae Pay › Core", 확인창에 서비스 3개 나열 | 클릭 6(Maintenance → New window → Mirae Pay → Core → Create → 확인) | 낮음. 사전 선택 없음("Nothing is pre-selected"). 필터가 걸려 있으면 "Use exactly this" 1클릭으로 필터 스코프 사용 — 고객 필터면 고객 전체 창이 됨(확인창에 5개 서비스 표시) | 5 |
| N3 이어서 Monitoring: 누구 데이터? | 성공. 바 "My customers · 12", 부제 "13 alarms in the 12 customers Junho covers" → Junho 담당 12개 고객 전체 | 클릭 1 | 중간. 방금 만든 창의 `DONE Window created for Mirae Pay › Core` 배너+토스트가 **Monitoring 화면 상단에 그대로** 따라옴 → 신입은 화면이 Mirae Pay › Core로 좁혀졌다고 읽을 수 있음 | 4 |

### 준호 (1440, 34개 고객, 키보드 우선)

| 과제 | 성공 | 조작 수 | 잘못된 스코프 위험 | 확신도 |
|---|---|---|---|---|
| J1 Mirae Pay → Daon Retail → Hanbit 호출 타이밍 변경, 엉뚱한 고객에 저장 시도 | 성공. 엉뚱한 고객 저장은 **재현 실패**(초안이 스코프에 묶임) | 전환 1회당 키 약 9: `Ctrl+K`, 3글자, `Shift+Enter`, `Ctrl+A`, 값, `Ctrl+Enter`, `Enter`. 마우스 0. 단 `Ctrl+Enter`는 화면 안내 없음 → 모르면 Save까지 **Tab 11회**(비대화형 트리 9칸 통과) | 중간. (1) Mirae 편집 중 팔레트로 Daon을 열면 묻지 않고 패널이 Daon으로 교체(토스트 "Draft kept for Mirae Pay"만). 값은 섞이지 않지만 포커스가 바로 Daon 2단계 분 칸에 들어가 "아직 Mirae"라 믿고 숫자를 칠 수 있음. 방어: 패널 머리 색·이니셜, "Save for Daon Retail", 확인창. (2) **확인창에 바뀐 값(전→후)이 없고, 편집 중 미리보기 문장이 옛 값(8 입력인데 "at 10 min")** → 무엇을 저장하는지 검증 불가(P1-1) | 4 |
| J2 Mirae 편집 미저장 → Daon 인시던트 처리 → 복귀 | 성공. 보존됨: 모든 화면 상단 "Draft for Mirae Pay — paging steps, not saved · 03:16 [Resume][Discard]", 새로고침·뒤로가기 후에도 유지. Daon에서 마무리될 가능성: **없음**(Daon 패널은 2/7/12 자기 값, Resume은 Mirae 패널을 8로 복원) | 이탈: 클릭 1 + 모달 Enter. 복귀: Resume 1클릭 | 낮음. 다만 이탈 방식마다 동작이 다름: 탭 이동=차단 모달, 팔레트 전환=조용히 보관, 브라우저 뒤로=조용히 닫힘. 모달은 새벽 인시던트 대응을 한 박자 막음 | 4 |
| J3 Mirae Pay › Core 호출 설정 링크 복사·새로고침·뒤로/앞으로 | 부분 성공. URL `/c/mirae/core/paging`, 새로고침 시 같은 패널 복원, 뒤로 1=패널 닫힘, 2=이전 탭, 앞으로 복원 | 키 6(`Ctrl+K`, `mir`, `↓`, `Shift+Enter`) + 복사 1클릭 | 중간. (1) **제품 안에 링크 복사/공유 버튼이 없음**(목업 하네스의 COPY LINK뿐). (2) 복사 토스트는 "scope **All customers**"라는데 열면 "My customers · 12" → 받는 사람이 보는 목록을 예측 못 함. (3) URL 안내는 "목록 필터는 링크에 없음"인데 필터 건 채 새로고침하면 필터가 유지됨 → 계약 불명확. (4) "core"만 치면 Lumen Bank › Core banking과 겹쳐 선택 없음(올바른 방어지만 화살표 필요). (5) 새로고침 후 포커스가 body | 4 |
| J4 스코프 선택 없이 전 고객 아침 점검 | 부분 성공. 기본값이 "My customers · 12"라 **34개 전체는 스코프를 한 번 골라야 함**(`Ctrl+K ↓ Enter`). 이후 탭 간 유지. 인시던트 7건, 유지보수 5(ACTIVE 2), People "Needs action 12" 확인 | 키 3 + 클릭 3 (Maintenance, People, Needs action 칩) | 낮음. All customers가 탭 이동에도 붙어 다니지만 생성 흐름은 사전 선택을 안 함. 불편: 탭 이동 단축키 없음, 한 화면 요약 없음, 유지보수에 "active만" 칩·건수 없음("5 active or scheduled" 합산), Incidents 배지 4 vs 화면 7건(배지 정의 없음) | 4 |

### 민재 (1440 — Junho 계정)

| 과제 | 성공 | 조작 수 | 잘못된 스코프 위험 | 확신도 |
|---|---|---|---|---|
| M1 고객 전반 임계값 문제 리소스 찾기 → Mirae Pay만 기본값 변경, 적용 범위 문구 | 성공. "Needs review 2"(ledger-aurora-r1, orders-api-1). 패널: "APPLIES TO **Mirae Pay — every resource without its own value: 4 of 6 alarms listed.** / NOT CHANGED 2 alarms set by resource tag or in the console keep their value (tag wins). / INHERITS Blank fields use the MSP default, then the code default." 확인창: "This changes the default for **all of Mirae Pay — 3 projects, 5 services**" | 클릭 3 + 값 + 저장 2 | 낮음(타 고객 오염 경로 없음). 품질 문제: 확인창에 전→후 값과 상태가 바뀔 알람 목록이 없음(MSP 설정에는 있음). "4 of 6 alarms listed"의 "listed"가 어느 목록인지 불명. 입력칸에 단위 없음. "Needs review"가 무엇을 뜻하는지 설명 없음 | 4 |
| M2 필터 Mirae Pay › Core에서 기본값 변경: 고객 전체 영향이 분명한가 | 성공, **분명함**. 카드 "These defaults belong to all of Mirae Pay, not to Core.", 패널 "This changes all of Mirae Pay, not only Core.", 확인창까지 3중 고지 | 키 `Ctrl+K`+검색+Enter, 클릭 1, 저장 2 | 낮음. 잔여: 목록은 5개인데 확인창은 "4 of 6 alarms listed" → 숫자가 화면과 안 맞음 | 5 |
| M3 전 고객 MSP 기본값 변경: 실수로 하기 쉬운가 | **매우 어려움.** Monitoring에서는 "Not editable here" + Settings 링크뿐. Settings는 편집 → Preview impact(영향 고객 12/14, 바뀌는 알람 나열) → "all 12 customers" 직접 입력해야 Apply 활성. 빈 칸 Enter·틀린 문구 모두 무효 | 최소 클릭 3 + 16자 입력 | 매우 낮음. 혼란: 바·APPLIES TO는 "all **14** customers", 입력 문구·버튼은 "all **12** customers" | 5 |

### 소연 (포털 모드, Daon Retail 고객사 직원)

| 과제 | 성공 | 조작 수 | 잘못된 스코프 위험 | 확신도 |
|---|---|---|---|---|
| S1 타 고객 이름·건수·인시던트가 보이는가 | 5개 화면 모두 **안 보임**. 고객 열 제거, outside 칩·UNMAPPED 행·핀·Jump 없음(Ctrl+K 무반응), MSP 직원은 "Your MSP team / Reached through your MSP"(담당 고객 수 숨김). 타 고객 딥링크(패널·인시던트·outside 뷰·새 창)는 "Not found · Nothing here belongs to Daon Retail" | 탭 5개 순회 + 딥링크 8종 시도 | 확인 필요 1건: ID만 있는 링크(`o=inc:i1`)를 열자 목업 URL 줄이 `portal…/c/mirae/core/payments-api/incidents/i1`로 표시됨. 실제 라우터가 ID를 정규 경로로 바꿔 주소창에 쓰면 **타 고객·프로젝트·서비스 이름 유출**. 내용은 Not found였음 | 4 |

## 2. 문제 순위

### P1 (방향 채택 전 반드시 수정)

| # | 문제 | 재현 | 왜 심각한가 |
|---|---|---|---|
| P1-1 | 저장 전 "무엇이 바뀌는지"를 볼 수 없음 | Paging → Mirae Pay → 2단계 10→8 입력. "IF SOMETHING BREAKS NOW" 문장은 계속 "at 10 min"(저장 후에야 8). 확인창은 영향 서비스만 나열, 전→후 값 없음. 임계값 확인창도 동일, 유지보수 확인창에는 시간대가 없음 | 스코프는 잘 알려주지만 내용 검증 수단이 없음. 호출 타이밍 오타(8 대신 80)가 4개 서비스에 그대로 저장됨 |
| P1-2 | 패널 `EDIT AT` 라디오가 1클릭으로 편집 범위를 넓힘 — 목록 하단 "The panel edits exactly the row you opened, never something wider"와 모순 | Paging → Orders API 행 → CUSTOMER 라디오 → 값 입력 → 저장: Hanbit 2개 서비스 변경. 전환 후 목록 강조 행이 사라지고 URL이 `/c/hanbit/paging`으로 바뀜 | "연 행만 고친다"는 약속을 믿은 사용자가 고객 전체를 고침. 방어선은 확인창 하나 |
| P1-3 | 키보드 우선 사용자의 저장·이동 경로 미완성 | Save까지 Tab 11회, `Ctrl+Enter`는 무안내, 저장·닫기·새로고침 후 포커스가 body로 떨어짐, 탭 이동 단축키 없음, 고객 필터 칸에서 Enter가 단일 결과를 선택 안 함 | 준호의 핵심 반복 작업(고객 바꿔가며 편집)이 매번 마우스나 긴 Tab으로 돌아감 |

### P2

| # | 문제 |
|---|---|
| P2-1 | 모바일 검색이 모호할 때 "내 고객" 결과가 항상 위 → H3의 오선택. 모바일은 전역 Jump 없음, 검색칸 자동 포커스 없음 |
| P2-2 | outside 칩이 UNMAPPED 건과 타 고객 건을 구분하지 않음. "open"이 ack 제외라는 정의 없음. 배지 `4`, `1/4`, `0/2`의 의미 설명 없음 |
| P2-3 | `DONE` 배너·토스트가 다른 탭으로 따라와 그 화면의 스코프처럼 읽힘(N3) |
| P2-4 | 초안 이탈 동작 불일치(모달 / 조용히 보관 / 조용히 닫힘) |
| P2-5 | 제품 내 링크 복사 수단 없음. 복사 토스트의 "All customers"가 실제(My customers)와 다름. 필터가 링크에 포함되는지 계약 불명확. `/c/mirae/...` URL은 고객 작업공간처럼 읽히는데 뒤 목록은 전체 고객 |
| P2-6 | "Jump to…"는 이동이 아니라 현재 화면 필터(Enter) — 이름과 동작 불일치. "han" 검색에 "Mirae Pay › Merchant"가 섞임(안내는 "starts with") |
| P2-7 | 유지보수: "STEP 1 OF 2"가 두 화면 연속 표시(실제 3단계), Reason 비워도 "Planned change"로 저장, 자정 넘는 창이 목록에서 "Mon 9 · 22:00–02:00", 같은 스코프의 진행 중 창(Checkout)과 겹침 안내 없음 |
| P2-8 | 임계값: Default thresholds 카드에 자체 기본값이 있는 고객 2곳만 나옴 → Daon 등에 고객 기본값을 처음 만드는 길이 안 보임. 입력칸 단위 없음. 14 vs 12 customers 불일치. "1 alarms" |
| P2-9 | 포털: ID 링크의 정규 경로 노출 가능성(S1). security 검토 필요 |
| P2-10 | 하은이 담당하지 않는 Daon Retail 연락처에 Reveal 버튼이 그대로 보임, 핀 칩에 비담당 고객(Hanbit, Daon)이 뜸 — 의도인지 권한 정책 확인 필요 |

## 3. 여전히 헷갈리는 점

- "필터(SHOWING)"와 "패널 스코프"가 다를 수 있다는 개념 자체. 불일치 경고("Different customer than your list filter")는 좋지만 한 화면에 고객 이름 둘이 동시에 뜸.
- CUSTOMER STEPS / OWN STEPS / inherits: 상속 중인 서비스는 Paging 목록에 행이 없어, 신입은 "Tracking › Public API는 어디서 보나"를 목록만으로 알 수 없음(팔레트 Shift+Enter나 인시던트 패널로만 진입).
- 임계값 출처 태그 `TAG / MSP / CUSTOMER / CONSOLE / CODE` 우선순위는 패널 문장을 읽어야만 알 수 있음.
- "Needs review"(Monitoring)와 "Needs action"(People)의 기준.
- "My customers"의 근거(누가 배정했는지)와 "Other customers"를 볼 수 있는 권한 범위.

## 4. 390px 이슈

| 항목 | 내용 |
|---|---|
| 가로 넘침 | 페이지 수준 가로 스크롤 없음(scrollWidth 390). 양호 |
| 잘림 | People 필터 칩 줄이 "Needs…"에서 잘림(가로 스크롤 표시 없음) — 새벽에 가장 필요한 "Needs action"이 화면 밖 |
| 겹침 | ack 토스트가 스코프 선택 시트 위에 떠서 "Hanbit Logistics" 행을 가림. 토스트가 목록 하단 카드도 가림 |
| 탭 타깃 < 44px | 호출 단계 분 입력 72×28, Slack/SMS/Call 토글 약 28px 높이, "Open People →" 88×18, Reveal 43×44(폭 부족) |
| 탭 타깃 양호 | Acknowledge 328×44, 스코프 바 366×44, 선택 시트 행 52~56px, 하단 탭 78×56, outside 칩 98×44(단 "+1 ack'd" 글자가 매우 작음) |
| 흐름 | 스코프 선택이 2단계 드릴(고객 → "Show all of it")이라 고객 필터에 3탭. 검색칸 자동 포커스 없음. 하단 탭 라벨 "Monitor", "Maint." 축약 |
| 위험 | 인시던트 → "Paging steps for …" → 모바일 전체화면 편집 시트에 "Edit Mirae Pay instead · 4 services" 버튼이 엄지 위치에 있음(새벽 3시에 고객 전체 편집으로 진입 가능, 확인창은 있음) |

## 5. 판정

**수정 후 채택(with fixes).**

- 강점: 저장 버튼·확인창·완료 문구에 항상 전체 경로가 들어감, 생성 시 스코프 사전 선택 없음, 스코프에 묶인 초안, 필터≠패널 경고, 상속 단계는 그 수준에서 편집 불가, 고객 기본값의 "Core가 아니라 고객 전체" 3중 고지, MSP 전체 설정의 미리보기+문구 입력, 포털에서 타 고객 흔적 없음. 엉뚱한 고객에 저장하는 실수는 여러 번 시도했지만 재현하지 못했음.
- 조건: P1-1(변경 내용 미리보기·전→후 표시), P1-2(EDIT AT 범위 확대의 약속 위반), P1-3(키보드 경로)을 고치고, P2-1·P2-2·P2-9를 qa-ux/security에서 재확인.
