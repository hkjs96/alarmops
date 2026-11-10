# 스코프 표시/선택 4개 시안 UX 평가 (평가자 1)

- 대상: `/home/claude/wt-scope/docs/ui/mockups/scope-variants.html` 시안 A(Global scope bar) · B(Scope required) · C(Customer workspace) · D(Hybrid lists + panel)
- 방법: Playwright로 직접 조작하고 스크린샷을 눈으로 확인. 과제마다 시안별로 새로 로드해서 시작. 설계 문서는 읽지 않았고 화면만 보고 판단.
- 페르소나: 하은(390px 폰, 새벽 3시, 고객 7곳 담당) — 목업 상단 토글을 `AS HAEUN`으로 두고 실행. 신입(1440px, 2일차) — 기본 사용자로 실행.
- 한계: "망설임(초)"은 사람 측정이 아니라 화면에서 읽고 판단해야 하는 양을 근거로 한 추정치. 클릭 수는 실제로 밟은 최단 정답 경로 기준(타이핑은 클릭에 넣지 않고 따로 표기).
- 스크린샷: `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/shots/`

## 0. 결론 먼저

| | 하은(폰·온콜) | 신입(데스크톱) |
|---|---|---|
| 1위 | **D** | **C** |
| 2위 | C | D |
| 3위 | A | A |
| 4위 | **B** | **B** |

- B는 두 페르소나 모두에게 꼴찌. "스코프 필수"라면서 실제로는 A처럼 스코프가 화면 간에 조용히 따라다니는데, A/C에 있는 "다른 고객 N건" 경고는 없다. 과제 2에서 유일하게 **다른 고객 장애를 놓칠 수 있는 시안**.
- 4개 시안 공통 치명 결함 1건: 스코프 검색에 `checkout`을 치면 **Mirae Pay › Core › Checkout이 첫 줄에 선택된 상태**로 나오고, Enter(폰 키보드 "이동")를 누르면 Daon이 아니라 Mirae Pay로 들어간다(실제로 재현함).
- 권장 조합: **D의 목록·패널 + A/C의 "밖에 N건" 경고 + C의 고객 색 띠(편집 화면 한정)**. 상세는 5장.

## 1. 과제별 결과

### 과제 1 — (하은, 390) Mirae Pay payments 알림을 찾아 고객/프로젝트/서비스와 다음 호출 대상 말하기
정답: Mirae Pay › Core › Payments API, 현재 Haeun Kim 호출 중, 다음은 10분에 Yuna Seo 전화.

| 시안 | 성공 | 탭 | 망설임 | 잘못된 스코프 위험 | 확신 |
|---|---|---|---|---|---|
| A | 예 | 0 (첫 카드에 다 있음) | 3초 | 낮음. 단 스코프 줄이 카드에서 가장 작고 흐린 글씨(12px 회색, 대비 4.74:1). 제목을 눌러도 아무 일도 안 일어나는데, 그 바로 아래 15px 높이 고객명 링크를 스치면 목록이 그 고객으로 좁혀짐 | 4 |
| B | 예 | 0 | 3초 | A와 동일 | 4 |
| C | 예 | 0 | 3초 | A와 동일. 상단 "ALL · 14 customers" 띠가 60px 더 차지 | 4 |
| D | 예 | 0 (읽기) / 1 (상세) | 2초 | 가장 낮음. 카드에 `CUSTOMER Mirae Pay` / `PROJECT Core › Payments API`가 라벨 붙은 13px 검정 글씨. 행을 누르면 제목이 스코프인 전체 화면 시트가 열리고 호출 순서 전체(Haeun → 10분 Yuna Seo → 15분 Responders 5명)와 "Inherited from Mirae Pay"가 보임 | 5 |

- A/B/C에서는 "열기"가 불가능하다. 카드 제목은 눌러도 반응이 없고, 전체 호출 순서를 보려면 고객으로 좁혀야만 하단에 나온다. 좁히는 순간 과제 2의 위험이 시작된다.
- D의 흠: `PROJECT` 라벨 아래에 프로젝트와 서비스가 같이 들어 있음(서비스 라벨 없음).

### 과제 2 — (하은, 390) 아까 Mirae Pay를 보고 있었다. 내가 맡은 다른 고객에 열린 장애가 있나?
사전 상태: 각 시안에서 가장 자연스러운 방법으로 Mirae Pay를 본 뒤 다른 화면에 갔다가 Incidents로 복귀.
정답(하은 기준 My customers 7): Bora Foods SEV-4(확인됨) 1건 + 미매핑 계정 SEV-3 1건. Hanbit·Daon 건은 하은 담당이 아님.

| 시안 | 성공 | 탭 | 망설임 | 잘못된 스코프 위험 | 확신 |
|---|---|---|---|---|---|
| A | 예 | 2 (`3 elsewhere` → `My customers 7`) | 6초 | 낮음~중간. 스코프 바가 스크롤해도 상단에 붙어 있고 빨간 `▲ 3 elsewhere`가 항상 보임. 그러나 **"3"은 14개 전체 고객 기준**이라 하은 담당이 아닌 Hanbit·Daon이 포함되고, 하은 담당인 Bora Foods(확인됨)는 빠짐. 누르면 My customers가 아니라 All customers(14)로 감 | 4 |
| B | **부분** | 2 (`Clear` → `My customers 7`) | 15초 이상 | **높음.** 복귀 화면은 Triggered 1 / Escalated 0 / "In this scope 1"만 보이고 다른 고객에 대한 표시가 전혀 없음. 스코프 표시는 KPI 타일 아래 `Customer: Mirae Pay ▼` 칩 하나뿐이고 스크롤하면 사라짐. 유일한 단서는 하단 탭 배지 "4"가 목록 1건과 안 맞는다는 것. 새벽 3시에 "1건뿐이네"로 읽고 끝낼 수 있음 | 2 |
| C | 예 | 2 (`3 elsewhere` → `My customers 7`) | 5초 | 낮음. 고객색 띠 + `CUSTOMER WORKSPACE Mirae Pay` + `3 elsewhere` + `← All`이 고정. 대신 워크스페이스 안에서는 행에 고객명이 빠져서 띠가 유일한 근거. "3"의 의미 문제는 A와 같음. 워크스페이스 안인데도 하단 Incidents 배지는 전체 수치 "4" | 4 |
| D | 예 | 0~1 (`My customers 7`) | 3초 | 자연 경로에서는 없음 — 시트를 열고 닫기만 했으므로 목록은 계속 All customers. 단 시트의 `Filter the list to this scope`를 눌렀다면: 시트가 그대로 덮고 있어 **눌렸는지 알 수 없고**, 닫으면 칩 `Mirae Pay ✕ Core ✕ Payme…`(3번째 칩 잘림)만 남고 "밖에 N건" 표시는 없음. 이 경우 위험 중간~높음 | 4 |

- A/B/C 공통: 고객으로 좁히면 `My customers` 칩이 사라져서 "내 담당만 보기"로 바로 갈 수 없다.
- `My customers 7` 결과에 미매핑 계정(UNMAPPED) 건이 섞여 나온다. 고객이 아닌데 "내 고객"에 포함되는 이유가 화면에 없다.

### 과제 3 — (하은, 390) Daon Retail의 Checkout 서비스 담당자/연락처 확인
정답: MSP 2명(Junho Park, Minjae Lee) + Daon 3명(Soyeon Choi·호출 가능, Taehee Oh·Checkout 전용 알림, Jaewon Shin·알림만).

| 시안 | 성공 | 탭 | 망설임 | 잘못된 스코프 위험 | 확신 |
|---|---|---|---|---|---|
| A | 예 | 3 + 타이핑 (People → 스코프 바 → `checkout` 입력 → 2번째 결과) | 10초 | **높음.** 결과 2건 중 Mirae Pay › Core › Checkout이 첫 줄·선택 상태. Enter 치면 Mirae Pay People로 들어가고 화면 구조가 똑같아 눈치채기 어려움(재현). 폰에서는 스코프 바를 다시 눌러도 프로젝트/서비스 단계 선택이 없어 타이핑 없이는 서비스까지 못 내려감 | 3 |
| B | 예 | 4 (People → Recent의 Daon Retail → `All projects ▼` → `› Checkout`) | 12초 | 낮음~중간. 고객을 먼저 고르게 하므로 동명 서비스 함정을 피함. 그러나 관문의 입력창에 `checkout`을 치면 **모든 그룹이 빈 채로 아무 안내 없이 끝남**(placeholder는 "customer, project or service"). `Search all`로 가면 A와 같은 함정 | 4 |
| C | 예 | 3 + 타이핑 (Staff → `Enter a customer…` → `checkout` → 2번째 결과) | 12초 | 중간. 함정은 같지만 들어가면 고객색(Mirae 파랑 / Daon 초록)과 큰 고객명으로 바로 드러남. 전체 화면에서는 탭 이름이 People이 아니라 **Staff**라서 "고객 담당자는 어디?"에서 멈춤 | 4 |
| D | 예 | 3 + 타이핑 (People → `+ Scope` → `checkout` → 2번째 결과) | 12초 | 중간. 함정 동일. 결과 화면에서 칩이 `Daon Retail ✕ Commerce ✕`까지만 보이고 **Checkout 칩은 화면 밖**. MSP 직원 행은 "12 customers / every customer they cover"로만 나와 Daon 담당인지 행만 봐서는 모름. A/B/C에 있는 "상속됨 — 고객 전체를 덮어서 Checkout에 도달" 설명이 없음 | 3 |

- 4개 시안 모두 **전화번호·이메일 주소 같은 실제 연락처가 없다.** 채널 검증 상태(SMS not verified 등)만 있다. "연락처 확인"이라는 과제는 어느 시안에서도 절반만 된다.
- A/B/C는 People 하단에 값이 채워진 "Add Daon Retail person" 폼과 `Add to Daon Retail` 버튼이 항상 열려 있다. 스크롤 끝에서 잘못 누를 수 있다.
- 선택기 하단의 `↑↓ move / Enter / Esc` 안내와 `Ctrl K` 표시는 폰에서 의미가 없다.

### 과제 4 — (신입, 1440) Hanbit Logistics › Fulfilment › Orders API의 호출 순서, 자체/상속 여부
정답: 즉시 Hyunwoo Ahn(Hanbit) 전화 → 5분에 Hanbit on-call 근무자(Junho) 전화 → 1회 반복. **자체 단계(Own steps)**, Hanbit에서 상속 없음.

| 시안 | 성공 | 클릭 | 망설임 | 잘못된 스코프 위험 | 확신 |
|---|---|---|---|---|---|
| A | 예 | 3 (Paging → Hanbit 행의 `ORDERS API` 태그 → 트리의 Orders API) | 15초 | 중간. `ORDERS API` 태그를 눌렀는데 **Hanbit 고객 단위 4단계 화면**에 도착함. 스코프 바는 "Hanbit Logistics › All projects". 신입은 여기 보이는 순서(Junho 근무자 Slack→SMS→전화…)를 Orders API 것으로 보고할 수 있음. `APPLIES TO … except Fulfilment › Orders API (own steps)` 문구가 유일한 방어 | 4 |
| B | 예 | 4 (Paging → Hanbit 카드 → `All projects ▼` → `› Orders API`) | 20초 | 낮음. 다만 관문 화면에서는 Orders API에 자체 단계가 있다는 사실을 알 길이 없음. 입력창에 `orders`를 치면 빈 화면. 안내문의 "On-call › Now"는 링크도 메뉴도 아님 | 4 |
| C | 예 | 3 (On-call now → `ORDERS API` 태그 → 트리의 Orders API) | 15초 | 중간. A와 같은 오도착. 마지막 클릭 후 자동 스크롤되면서 **고정 헤더가 `APPLIES TO` 줄을 가림**. 탭 이름이 Paging이 아니라 "On-call now"라 처음에 멈칫 | 4 |
| D | 예 | 1 (읽기) / 2 (상세) | 4초 | 낮음. Paging 목록에 `Hanbit Logistics | Fulfilment › Orders API | Hyunwoo Ahn | 5 min call | OWN STEPS` 행이 따로 있어 한 번에 답이 나옴. 행을 누르면 제목이 스코프인 패널에 전체 순서와 "Inherits: Nothing…" | 5 |

- 최종 화면의 설명 상자(APPLIES TO / INHERITS / RESPONDERS)는 4개 시안 모두 좋다.
- 공통 흠: 빨간 `Use inherited steps` 버튼이 `Save for Orders API` 바로 옆에 있다. D 목록의 자체 단계 행은 REACH 칸이 "—"라 도달 가능 여부를 알 수 없다.

### 과제 5 — (신입, 1440) "오늘 밤 Mirae Pay Core에 점검 창 추가"
4개 시안 모두 최종 화면이 말하는 적용 범위는 동일:
> **APPLIES TO** Mirae Pay › Core — 3 services: Payments API, Settlement, Checkout. Includes every service below it, also ones added later.
> **MUTES** SEV-2 to SEV-5 alerts in this scope (still recorded). SEV-1 always pages (D-17).
> **NOT AFFECTED** Other projects of Mirae Pay and other customers.
> 토스트: "Window created · mutes SEV-2–5 for Mirae Pay › Core"

| 시안 | 성공 | 클릭 | 망설임 | 잘못된 스코프 위험 | 확신 |
|---|---|---|---|---|---|
| A | 예 | 5 (Maintenance → `Mirae Pay` → `Narrow…` → `Core` → `Create for Core`) | 10초 | 중간. `Mirae Pay`를 누르자마자 **고객 전체(3 프로젝트·5 서비스)로 채워진 폼과 `Create for Mirae Pay` 버튼**이 뜸. 한 번 더 누르면 고객 전체가 음소거됨. 폼에서 좁히면 전역 스코프 바도 같이 바뀜(부작용) | 4 |
| B | 예 | 5 (Maintenance → Mirae Pay 카드 → `All projects ▼` → `Core` → Create) | 12초 | 중간. 기본값 문제 동일. 좁히는 컨트롤이 3개(우상단 CUSTOMER, 스코프 상자의 드롭다운, 폼의 `Narrow…`)로 중복 | 4 |
| C | 예 | 5 (Maintenance → `Mirae Pay` → `Narrow…` → `Core` → Create) | 10초 | 고객 오인은 사실상 없음(색 띠 + 큰 고객명). 프로젝트 단위 기본값 문제는 동일. 전체 화면이 "read-only"라고 명시돼 있어 어디서 만드는지 분명 | 5 |
| D | 예 | 6 (Maintenance → `New window` → `Mirae Pay` → `Narrow…` → `Core` → Create) | 12초 | 중간. `New window` 버튼은 가장 찾기 쉬움. 그러나 스코프 카드 4장이 전부 "pinned / recent"라고만 적혀 있고 그중 `Mirae Pay › Core › Payments API`가 "Mirae Pay Core"처럼 보여 **서비스 하나에만 거는 실수** 가능. 패널에서 고른 스코프가 **뒤 목록 필터로 몰래 새어 나감**(칩 `Mirae Pay ✕ Core ✕` 생성). 생성 후 패널이 안 닫히고 버튼이 그대로 살아 있음 | 4 |

- 공통: 버튼이 `Create for Core`로 고객명을 뺀다. 목록에 이미 ACTIVE인 "Mirae Pay › Core › Checkout" 창이 있어 신입이 "이미 있네"로 오해할 수 있다. "(D-17)" 같은 내부 결정 번호가 사용자 문구에 노출된다.

### 과제 6 — (신입, 1440) 과제 5 직후 Monitoring으로 이동. 지금 어느 고객을 보고 있나, 확신은?
4개 시안 모두 답은 Mirae Pay(Core로 좁혀진 상태). 스코프가 Maintenance에서 그대로 따라온다.

| 시안 | 성공 | 클릭 | 망설임 | 잘못된 스코프 위험 | 확신 |
|---|---|---|---|---|---|
| A | 예 | 1 | 3초 | 낮음. 스코프 바 `Mirae Pay › Core › All services` + 빨간 `3 open outside this scope` + 부제 + 행마다 경로. 임계값 편집기는 고객 단위인데 바는 Core라 "Core만 바뀐다"고 오해할 수 있으나 SCOPE NOTE가 "Core는 목록만 거른다, 변경은 Mirae Pay 전체에 적용"이라고 밝힘 | 5 |
| B | 예 | 1 | 6초 | 중간. 표시가 3곳인데 서로 다름: 우상단 `CUSTOMER Mirae Pay`(Core 없음), 부제, 칩 `Customer: Mirae Pay › Core`(라벨은 Customer인데 프로젝트 포함). 강조된 것이 하나도 없고, "스코프 필수"인데 다시 묻지 않고 조용히 이어짐 | 4 |
| C | 예 | 1 | 2초 | 낮음. 색 띠 + `CUSTOMER WORKSPACE Mirae Pay [Core ▼]`. 단 행에는 고객명이 없고, `Incidents 4` 탭 배지는 전체 수치(Mirae Pay는 1건) | 5 |
| D | 예 | 2 (패널 닫기 → Monitoring) | 6초 | 중간. 칩 + 부제 + **행마다 CUSTOMER 열**이 있어 읽기는 확실. 그러나 신입은 목록을 거른 적이 없는데 걸러져 있음(과제 5의 패널에서 샘). `MSP defaults — all 14 customers →`가 `Mirae Pay own defaults →` 바로 위에 붙어 있음 | 4 |

## 2. 시안별 문제 3 / 강점 2

### A · Global scope bar
문제
1. 스코프 검색에서 동명 서비스 첫 줄이 자동 선택됨 → Enter 한 번에 다른 고객. 고객명(구분되는 부분)은 흐리게, 서비스명(같은 부분)은 굵게 표시. (선택기는 4개 시안 공용이지만 A는 폰에서 서비스까지 가는 길이 이것뿐)
2. 목록의 `ORDERS API`, `Mirae Pay` 같은 링크를 누르면 기대한 서비스가 아니라 고객 단위로 좁혀지거나, 점검 창 폼이 고객 전체로 미리 채워짐 — 한 단계 넓은 스코프가 기본값.
3. `N elsewhere`의 N이 전체 고객 기준이고 확인된 건은 빼서, "내 담당 중 다른 곳"이라는 온콜의 질문과 어긋남. 좁히면 `My customers` 칩도 사라짐.

강점
1. 스코프 바가 모든 화면·스크롤 위치에서 같은 자리에 있고 빨간 경고가 붙어 있음.
2. 데스크톱에서 고객 › 프로젝트 › 서비스 3칸 분할이 현재 깊이를 정확히 보여 줌.

### B · Scope required
문제
1. 좁힌 상태에서 다른 고객 장애를 알리는 표시가 없음. 스코프 칩은 KPI 아래에 있고 고정도 안 됨(과제 2 위험 최고).
2. 이름과 다르게 스코프가 화면 간에 조용히 이어짐. 표시는 최대 3곳에 서로 다른 형식.
3. 관문 입력창이 서비스·프로젝트 검색을 못 함(빈 화면, 안내 없음). "On-call › Now"는 존재하지 않는 메뉴.

강점
1. People/Paging/Maintenance 첫 진입 시 "고객마다 다르므로 고객을 먼저 고르라"는 이유 설명이 신입에게 명확.
2. 고객 먼저 → 프로젝트/서비스 드롭다운 순서라 동명 서비스 함정을 구조적으로 피함. 폰에서도 타이핑 없이 서비스까지 내려갈 수 있는 유일한 경로.

### C · Customer workspace
문제
1. 전체 화면과 워크스페이스에서 탭 이름이 바뀜(On-call ↔ Paging, Staff ↔ People). 같은 자리 다른 이름.
2. 워크스페이스 안에서 행의 고객명이 빠지고, Incidents 배지는 전체 수치 → 헤더 하나에 전부 의존, 숫자는 헤더와 모순.
3. 폰에서 헤더가 2~3줄(115~150px, 화면의 14~18%)을 고정 점유. 데스크톱에서는 자동 스크롤 시 헤더가 `APPLIES TO` 줄을 가림.

강점
1. "지금 어느 고객인가"가 4개 중 가장 확실(고객별 색 + 이니셜 + 큰 이름 + URL `/c/mirae/`).
2. 전체 화면은 읽기 전용, 변경은 워크스페이스 안에서만이라는 규칙이 화면에 적혀 있어 신입이 다른 고객을 건드릴 여지가 작음.

### D · Hybrid lists + panel
문제
1. 패널 안에서 고른 스코프가 목록 필터로 몰래 새어 나가고 다음 화면까지 따라감. `Filter the list to this scope`는 폰에서 눌러도 피드백이 없음. 필터가 걸려도 "밖에 N건" 경고 없음.
2. 390px에서 스코프 칩 줄이 잘림(내용 626px / 화면 390px). 세 번째 칩(서비스)과 `+ Scope`가 화면 밖.
3. People 전체 목록이 폰에서 5,500px. MSP 직원 행은 스코프를 걸어도 "N customers"로만 표시. 새 점검 창 카드가 전부 "pinned / recent"로만 표기.

강점
1. 목록을 좁히지 않고도 일이 끝남: 고객·프로젝트 열이 항상 있고, 자체 단계가 있는 서비스가 별도 행으로 나옴(과제 4 클릭 1회, 과제 2 위험 없음).
2. 행을 열면 제목이 스코프인 패널/시트 — 무엇에 대한 내용인지와 상속 출처가 한 화면에 있음. `New window` 같은 주 행동 버튼이 뚜렷.

## 3. 390px에서 읽기 어렵거나 깨지는 것

| 위치 | 시안 | 내용 |
|---|---|---|
| 장애 카드의 고객 › 프로젝트 › 서비스 줄 | A, B, C | 12px 회색(대비 4.74:1), 링크 높이 15px. 카드에서 가장 중요한 정보가 가장 작음 |
| 스코프 칩 줄 | D | 3단계 스코프에서 세 번째 칩과 `+ Scope`가 화면 밖(가로 스크롤 단서 없음) |
| 스코프 바 | A | "Daon / Retail › Commerce › Checkout"으로 고객명 중간에서 줄바꿈 |
| 워크스페이스 헤더 | C | 서비스 스코프일 때 3줄, 약 150px 고정 |
| 스코프 칩 | B | 고정되지 않아 스크롤하면 스코프 표시가 화면에서 완전히 사라짐 |
| 누르는 영역 | 전체 | Acknowledge 99×26, `3 elsewhere` 108×26, Clear 55×28, 칩 28px, 스코프 바 34px — 전부 44px 미만 |
| 선택기 하단 | 전체 | `↑↓ move`, `Enter`, `Esc`, `Ctrl K` 키보드 안내가 폰에 그대로 노출 |
| 선택기 목록 | 전체 | 하은에게는 My customers 7곳만 나오고 나머지 7곳은 타이핑해야만 나옴. 현재 스코프 표시 없이 항상 "All customers"가 선택된 채 열림 |
| 장애 시트 제목 | D | "Mirae Pay › Core › Payments / API" 3줄로 접힘 |
| 하단 탭 라벨 | 전체 | 11px |

## 4. 페르소나별 순위와 이유

**하은: D > C > A > B**
- D: 트리아지 중 목록을 좁힐 일이 없어서 "좁혀 둔 채 잊음" 사고가 구조적으로 안 생김. 카드의 고객 표기가 가장 큼. 폰 칩 줄 잘림과 필터 피드백 부재는 고쳐야 함.
- C: 위치 인식은 최고지만 고객을 볼 때마다 들어갔다 나와야 하고 헤더가 화면을 많이 씀.
- A: 경고 배지는 좋으나 폰에서 서비스 단계로 내려가려면 타이핑이 필수.
- B: 과제 2에서 다른 고객 장애를 가리는 유일한 시안.

**신입: C > D > A > B**
- C: 고객을 모르는 사람에게 "지금 Mirae Pay 안"이 색과 크기로 전달됨. 변경 가능한 곳이 워크스페이스로 한정.
- D: 과제 4가 압도적으로 빠르고 목록 자체가 구조를 가르쳐 줌. 스코프 누수와 카드 표기 때문에 2위.
- A: 정확하지만 한 단계 넓은 기본값(태그 클릭 → 고객 단위, 폼 → 고객 전체)이 신입에게 위험.
- B: 클릭이 가장 많고, 관문 검색이 막다른 길.

## 5. 조합 제안

1. **뼈대는 D.** 모든 목록에 고객 열 + 프로젝트 › 서비스 열, 자체 설정이 있는 하위 스코프는 별도 행, 행 클릭 → 스코프가 제목인 패널.
2. **A/C의 "밖에 N건" 경고를 D에 추가.** 필터가 하나라도 걸리면 항상 표시하고 고정. N은 "내 담당 고객 중 미확인 N건"처럼 기준을 문구에 넣고, 누르면 My customers로 이동.
3. **C의 고객 색 띠는 변경 화면에만.** 패널/폼이 한 고객을 대상으로 할 때 패널 상단에 색·이니셜·고객명. 탭 이름은 절대 바꾸지 않음.
4. **B의 관문은 생성 흐름에만.** D의 "Choose a scope first" 패널이 이미 그 역할. 카드에는 pinned/recent 대신 단위(고객/프로젝트/서비스)를 표기.
5. **스코프 선택기 수정(전 시안 공통, 최우선).** 동명 결과가 여러 고객에 걸치면 자동 선택 금지, 고객명을 굵게, 고객별로 묶기. 폰에서는 고객 → 프로젝트 → 서비스 단계 선택 제공.
6. **기본값은 넓히지 않기.** 서비스 태그를 누르면 그 서비스로. 점검 창 폼은 스코프 미정 상태에서 생성 버튼 비활성. 버튼은 `Create for Mirae Pay › Core`처럼 전체 경로.
7. **패널 스코프와 목록 필터 분리.** 패널에서 고른 스코프는 패널에만. 목록 필터는 사용자가 명시적으로 걸 때만, 걸리면 토스트로 알림.
8. 폰: 스코프 칩은 한 개로 합쳐 줄임 없이 표시(`Daon Retail › … › Checkout ✕`), 누르는 영역 44px, 카드의 스코프 줄을 D처럼 라벨 + 13px 이상 본문색으로.

## 6. 시안과 무관하게 발견한 것

- People에 실제 연락처(전화·이메일)가 없음 — 온콜이 "누구에게 전화하나"를 여기서 끝낼 수 없음.
- `My customers` 결과에 UNMAPPED 계정 건이 포함됨.
- 사용자 문구에 "(D-17)", "(D-19)" 내부 번호 노출.
- 생성 후 폼/패널이 그대로 남고 버튼이 살아 있어 중복 생성 가능(목업 한계일 수 있음). 토스트가 화면 이동 후에도 남음.
- `Use inherited steps`(빨강)가 Save 옆에 붙어 있음.
