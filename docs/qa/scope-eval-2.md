# 스코프 변형 A/B/C/D 독립 UX 평가 (2차)

- 대상: `/home/claude/wt-scope/docs/ui/mockups/scope-variants.html` (A 글로벌 스코프 바 · B 스코프 필수 · C 고객 워크스페이스 · D 하이브리드 목록+패널)
- 방법: Playwright(Chromium 1440×900)로 변형마다 새로 로드 → **34 고객 토글 ON** → 과업 실행, 스크린샷을 직접 보고 판정. 설계 문서는 읽지 않음.
- 페르소나: 준호(운영 리드, 12개 고객 담당, 키보드 위주) / 민재(알람 운영자, 임계치 작업)
- 증거 스크린샷: `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/ev/` (`A1_edit.png`, `D2_core_panel.png`, `A7_d_back.png` 등)
- 목업 한계(판정에서 분리): "Preview change"는 토스트만 뜨고 실제 미리보기 목록 없음 / 폰트 CDN 차단으로 대체 폰트 렌더 / 클립보드 권한 없음(토스트 문구로 확인).

## 0. 한 줄 결론

| 순위 | 준호 | 민재 |
|---|---|---|
| 1 | **C** (고객별 색·이니셜 헤더, 경로형 URL) | **D** (교차 고객 목록 + 패널이 적용 범위를 이름으로 표시, 인터럽트에 가장 안전) |
| 2 | **D** (아침 점검·인터럽트 최고, 단 키보드로 행을 못 엶) | **B** (전체 범위에서는 기본값 편집 카드 자체가 없음) |
| 3 | A | C |
| 4 | B | A |

**어느 변형도 그대로는 출시 불가.** 네 변형 공통으로 (1) 저장 안 한 편집이 스코프 전환 시 경고 없이 사라지고, (2) 전환 후 포커스가 `body`로 떨어지며, (3) A·B·C는 인터럽트 후 "Paging"으로 돌아오면 **다른 고객의 편집 화면**이 같은 레이아웃으로 뜬다.

## 1. 공통 결함 (4개 변형 전부)

| # | 결함 | 근거(실측) | 심각도 |
|---|---|---|---|
| G1 | **더티 가드 없음** | Mirae에서 10→13 입력 후 Ctrl K→daon→Enter: 확인창 없이 전환, 다시 Mirae로 가면 10. D는 Esc로 패널 닫아도 동일하게 소실 | 높음 |
| G2 | 전환 후 포커스가 `BODY` | `document.activeElement` = BODY. 첫 분 입력칸까지 Tab 4~5회, Save까지 +2회. 입력칸에서 Enter는 저장 안 됨 | 높음(준호) |
| G3 | 검색이 부분 문자열 매칭 + 담당 외 고객 포함 | `ha` → Hanbit, Haneul, **Vita P·ha·rm**, Haru, "Merc·ha·nt" 프로젝트(21건). `da` → Daon, Dasol, **Iru·da**, Dodam. `mi` 2번째가 담당 아닌 Mindle Books | 중 |
| G4 | 저장 토스트 수치가 화면 설명과 모순 | APPLIES TO는 "Data platform 제외"인데 토스트는 "applies to Mirae Pay (3 projects, 5 services)" | 중 |
| G5 | Incidents 배지가 스코프를 안 따라감 | Orders API 스코프에서 목록 0건인데 탭 배지는 4. C의 Mirae 워크스페이스 탭도 "Incidents 4"(실제 1건) | 중 |
| G6 | "Jump to…"가 이동이 아니라 스코프 설정 | Orders API 선택 시 화면은 그대로(Incidents), 빈 목록에 도착 | 중 |
| G7 | 임계치 문제 필터 없음 | NEEDS REVIEW/OWN VALUE 타일 클릭 불가, 필터는 TYPE·SOURCE뿐 → 34개 고객이면 눈으로 스캔 | 중(민재) |
| G8 | 내부 결정 번호가 UI에 노출 | "Thresholds have no project or service layer (D-19)" | 낮음 |
| G9 | 임계치 버튼에 범위 이름 없음 | Paging은 "Save for Mirae Pay"인데 임계치는 전부 "Preview change" | 중(민재) |
| G10 | A·B·C 데스크톱 목록에서 Acknowledge 불가 | 버튼이 모바일 전용 클래스. D만 패널에 Acknowledge 있음 | 중 |

## 2. 변형 × 과업 결과

조작 수 표기: K=키 입력, C=클릭. 확신도 1(불안)~5(확신).

### 과업 1 (준호) Mirae Pay → Daon Retail → Hanbit Logistics 호출 타이밍 연속 변경

| 변형 | 성공 | 전환 1회당 조작 | 잘못된 스코프 위험(구체적 실수) | 확신도 |
|---|---|---|---|---|
| A | 성공 | Ctrl K + 2~5자 + Enter = 4~7K. 이후 Tab 4 → 값 → Tab 2 → Enter(총 약 12~16K). Mirae는 핀 칩 1C | 13 입력 후 Save 안 누르고 전환 → Mirae 변경 조용히 소실(저장됐다고 믿음). 화살표 한 칸 실수로 Haneul Air 진입 시 레이아웃 동일, 단서는 스코프 바 글자와 버튼 문구뿐 | 3 |
| B | 성공 | A와 동일 + Tab 1회 더(5). 스코프 줄이 본문 안에 크게 있음 | A와 동일. 상단 CUSTOMER 셀렉트와 본문 SCOPE 줄, 두 군데가 같은 일을 함 | 3 |
| C | 성공 | 4~7K + Tab 4. 워크스페이스 안에서는 "Switch customer" 1C | 소실 위험 동일. 잘못 들어가도 헤더 색·이니셜(MP 파랑/DR 초록/HL 갈색)이 바뀌어 가장 빨리 알아챔 | 4 |
| D | 마우스로만 성공 | 스위처로 칩 전환(4~7K) 후 **행 클릭 필수**(행에 tabindex 없음) → 패널. 또는 전체 목록에서 Esc + 다음 행 클릭 = 2조작 | 패널 열린 채 Ctrl K→다른 고객: 패널이 말없이 닫히고 편집 소실. 스위처 문구는 "adds a scope chip"인데 실제로는 **교체** | 3(마우스) / 2(키보드) |

**"잘못된 고객에 저장"이 가능한가:** 입력값이 다음 고객으로 넘어가지는 않으므로(전환 시 리셋) 직접 이월 저장은 불가. 실제 위험은 ① 저장 누락을 모르는 것(G1), ② 검색 오선택 후 같은 모양 화면에 값 입력. 마지막 방어선은 "Save for {고객}" 버튼 문구 하나.

### 과업 2 (준호) "Mirae Pay › Core 호출 설정" 링크 공유

| 변형 | 성공 | 조작 | URL / 딥링크 | 동료 도착 스코프·위험 | 확신도 |
|---|---|---|---|---|---|
| A | 성공 | Ctrl K "mirae core" Enter + Copy 1C | `/paging?customer=mirae&project=core` | 동일 스코프로 도착(새 로드 확인). 스코프 바 + "Showing Mirae Pay › Core" 2중 표시 | 4 |
| B | 성공 | 동일 | `/paging?customer=mirae&project=core` | 동일 도착. 본문 SCOPE 줄이 가장 큼. 단 상단 셀렉트는 "Mirae Pay"만 보여 Core 누락 | 4 |
| C | 성공 | 동일 | `/c/mirae/paging?project=core` (고객이 경로에) | 동일 도착. **Core는 작은 드롭다운 한 곳에만** 표시, "Mirae Pay › Core" 문구가 헤더에 없음 | 4 |
| D | 부분 성공 | 칩 설정 후 행 클릭 → 패널 하단 트리에서 Core 클릭 = 추가 2C + 스크롤 | `/paging?scope=mirae/core&open=paging:mirae/core` (스코프가 2개) | 칩만 건 링크는 **Core 설정이 아니라 Mirae Pay 고객 행 1줄**만 보임. 그 행을 열면 "Save for Mirae Pay". `scope`와 `open`이 서로 다른 값을 가질 수 있음 | 2 |

### 과업 3 (준호) 34개 고객 아침 점검 (열린 인시던트 · 진행 중 점검창 · 조치 필요한 사람)

| 변형 | 성공 | 조작 | 문제 | 확신도 |
|---|---|---|---|---|
| A | 부분 | 2C (Maintenance, People) | People은 MSP 직원 8명만. "17 customer people are hidden" → 고객 측 미검증 연락처는 고객을 골라야 보임 | 3 |
| B | 실패에 가까움 | 4C 이상 | Maintenance·People·Paging이 "SCOPE REQUIRED" 벽. "Show them read-only"/"Open the staff directory"는 누르면 **화면 아래(y≈916px)에 표가 생기고 스크롤 안 됨 → 아무 일도 안 일어난 것처럼 보임**. Paging의 "On-call › Now"는 링크도 메뉴도 없음 | 1 |
| C | 부분 | 2C | A와 동일(직원만). 읽기 전용임을 명시한 점은 좋음. 홈 칩에 "Mirae Pay"가 2번 나옴 | 3 |
| D | 성공 | 2C | 직원+고객 인원 한 목록, 고객 열 있음. 단 "조치 필요" 필터·정렬 없어 실제 규모에서는 수백 행 스캔 | 4 |

### 과업 4 (준호) Ctrl K로 "Orders API" 이동

| 변형 | 성공 | 조작 | 결과 스코프 | 이후 표시 | 확신도 |
|---|---|---|---|---|---|
| A | 동작 | Ctrl K + "orders" + Enter = 8K | Hanbit › Fulfilment › Orders API | 스코프 바 3단 + 부제. 가장 명확. "4 open outside this scope" 표시 | 4 |
| B | 동작 | 8K | 동일 | 상단은 "Hanbit Logistics"만, 전체 경로는 본문 필터 칩에만 → 표시가 둘로 갈림 | 3 |
| C | 동작 | 8K | Hanbit 워크스페이스 진입 + 드롭다운 "Fulfilment › Orders API" | 색 헤더로 고객은 분명, 서비스는 드롭다운 한 곳 | 4 |
| D | 동작 | 8K | 칩 3개(Hanbit / Fulfilment / Orders API) | 칩은 본문 안에만, 화면 상단 고정 표시 없음. 칩이 다른 화면으로도 따라감 | 3 |

공통: 2번째 결과가 "Bora Foods › Main › Orders"라 화살표 실수 시 다른 고객. 도착 화면은 빈 인시던트 목록(G6).

### 과업 5 (민재) 교차 고객 임계치 문제 찾기 → Mirae Pay만 기본값 수정

| 변형 | 성공 | 조작 | 화면이 말하는 적용 범위 | 의도보다 넓게 적용될 위험 | 확신도 |
|---|---|---|---|---|---|
| A | 성공 | 목록 스캔 + 고객명 1C + 입력 + Preview | "Mirae Pay — every resource of this customer that has no value of its own (4 of 6)" | **전체 스코프에서도 같은 자리·같은 모양의 "MSP DEFAULT THRESHOLDS" 편집 카드**(34개 고객 적용). 차이는 카드 제목과 작은 태그뿐. Clear를 누른 뒤 수정하면 32개 고객에 적용 | 2 |
| B | 성공 | 동일 | 동일 문구 | 전체 스코프에는 편집 카드가 없고 "Choose a customer to edit default thresholds" → **가장 안전**. 단 "Settings › MSP defaults"는 존재하지 않는 메뉴 | 4 |
| C | 성공 | 동일 | 동일 문구 + 색 헤더 | All 홈에서 Paging·Maintenance는 읽기 전용인데 **가장 위험한 MSP 기본값만 편집 가능** → 일관성 깨짐 | 3 |
| D | 성공 | 목록(고객·프로젝트 열 분리) + "Mirae Pay own defaults →" 1C + 패널 | 패널 제목 "SCOPE · CUSTOMER DEFAULT THRESHOLDS / Mirae Pay" | Mirae 칩이 걸린 상태에서도 **"MSP defaults all 34 customers →"가 바로 윗줄**에 있음. 한 줄 잘못 누르면 34개 고객 패널, 뒤의 칩은 여전히 Mirae Pay › Core | 3 |

### 과업 6 (민재) 프로젝트 "Core" 선택 후 임계치 기본값 변경 — Core인가 고객 전체인가

| 변형 | 명확한가 | 화면 문구 | 남는 위험 | 확신도 |
|---|---|---|---|---|
| A | 대체로 예 | SCOPE NOTE: "Core only filters the list; a change here still reaches all of Mirae Pay" | 스코프 바는 "Mirae Pay › Core"로 강조, 왼쪽 목록도 Core 5건만 → 시각 신호는 Core, 정정은 4번째 줄 작은 글씨. 버튼에 범위 없음 | 3 |
| B | 대체로 예 | 동일 | 동일 | 3 |
| C | 대체로 예 | 동일 | 동일. Core 표시가 작아 오히려 덜 속음 | 3 |
| D | 반반 | 패널 제목 "Mirae Pay" (명확). 그러나 **"Core only filters the list" 문장이 빠짐** | 호출 설정에서는 더 심각: 칩이 "Mirae Pay › Core"인데 목록의 유일한 행을 열면 고객 전체 패널 + "Save for Mirae Pay" → Core만 바꾼다고 믿고 고객 전체 저장 | 2 |

참고(호출 설정, A·B·C): Core에서는 노란 박스 "IF YOU EDIT: Saving creates own steps for Mirae Pay › Core … Mirae Pay … is not changed" + 버튼 "Create own steps for Core" → 이 부분은 4개 변형 중 가장 잘 된 문구.

### 과업 7 (공통) 인터럽트: 고객 X 편집 중 고객 Y 인시던트 처리 후 복귀

시나리오: Mirae Paging에서 10→13 입력(미저장) → Daon 인시던트 확인 → "Paging"으로 복귀.

| 변형 | 인시던트 인지 | 복귀 시 상태(실측) | Y에서 편집을 끝낼 가능성 | 확신도 |
|---|---|---|---|---|
| A | "3 open outside this scope" 1C (누르면 **스코프가 All로 초기화**) → Daon 이름 클릭 | `/paging?customer=daon`, 입력칸 2/7/12, "Save for Daon Retail". Mirae 편집 소실, 안내 없음 | **높음.** 같은 레이아웃, 다른 점은 스코프 바 글자와 버튼 문구. 13을 다시 넣고 저장하면 Daon에 저장됨 | 2 |
| B | **표시 없음.** Incidents로 가도 Mirae로 고정되어 1건만 보임, Daon 인시던트 안 보임 → Clear 1C 필요 | Clear 후 Daon 클릭 → `/paging?customer=daon`, "Save for Daon Retail" | 높음 + 인시던트 자체를 놓칠 수 있음 | 1 |
| C | "3 open in other customers" 1C → All 홈 → Daon 클릭 = 워크스페이스 진입 | `/c/daon/paging`, "Save for Daon Retail". 헤더가 초록 "DR Daon Retail"로 바뀜 | 중간. 색·이니셜이 유일하게 강한 경고. 편집 소실은 동일 | 3 |
| D | 탭 배지뿐. 패널이 모달이라 **내비게이션 클릭 불가** → Esc(편집 소실) 후 이동 | 행 클릭 → 인시던트 패널에서 Acknowledge → 닫기 → Paging은 **전체 목록, 패널 닫힘**. Mirae 행을 직접 다시 골라야 함 | **낮음.** 스코프가 바뀌지 않고, 편집 재개에 고객 행 선택이 필요. 단 인시던트 패널의 "Open paging for this scope"를 누르면 Daon 패널이 열림 | 4 |

브라우저 뒤로가기 3회는 4개 변형 모두 Mirae Paging으로 복귀하지만 입력값은 10(소실).

## 3. 변형별 요약

### A · 글로벌 스코프 바
| 구분 | 내용 |
|---|---|
| 문제 1 | 인터럽트 복귀 시 Paging이 Daon으로 바뀐 채 같은 모양 (과업 7) |
| 문제 2 | 전체 스코프에 34개 고객용 MSP 기본값 편집 카드가 고객 카드와 같은 자리·모양 (과업 5) |
| 문제 3 | "N open outside this scope"를 누르면 스코프가 통째로 초기화 → 작업 맥락 파괴 |
| 강점 1 | 3단 스코프 바 + 부제 + URL이 항상 일치, Ctrl K 결과가 가장 잘 보임 |
| 강점 2 | 핀 칩 1클릭 전환, "스코프 밖 N건" 표시 |
| 34 고객 | Paging 표 34행(위험 행 상단 정렬), "My customers 12" 필터 동작. 스위처 기본 목록은 핀/최근/담당 12개, 나머지 22개는 입력해야 나옴 |

### B · 스코프 필수
| 구분 | 내용 |
|---|---|
| 문제 1 | 아침 점검 불가: 3개 화면이 벽, 우회 링크는 화면 아래에 내용을 붙여 무반응처럼 보이거나 아예 없는 메뉴를 가리킴 |
| 문제 2 | 고객 고정 상태에서 다른 고객 인시던트가 안 보이고 경고도 없음 (과업 7) |
| 문제 3 | 스코프 조작 지점이 3곳(상단 셀렉트, 본문 SCOPE 줄, 목록 필터 칩), 상단은 프로젝트·서비스를 숨김 |
| 강점 1 | 전체 범위에서 기본값 편집 자체가 불가 → 34개 고객 오적용 차단 |
| 강점 2 | 본문 SCOPE 줄이 크고 편집 카드 바로 위에 있음 |
| 34 고객 | 벽 화면에 담당 12개 카드 + "OTHER CUSTOMERS · 22" 접힘, 인라인 검색은 즉시 필터. 선택 화면으로서는 좋으나 매일 첫 화면이 벽 |

### C · 고객 워크스페이스
| 구분 | 내용 |
|---|---|
| 문제 1 | 프로젝트/서비스 스코프가 작은 드롭다운 한 곳뿐 → "Core만 보는 중"을 놓치기 쉬움 |
| 문제 2 | All 홈: Paging·Maintenance는 읽기 전용인데 MSP 임계치 기본값만 편집 가능 |
| 문제 3 | 인터럽트 복귀 시 같은 탭이 다른 고객 워크스페이스로 열림(색은 바뀌나 편집 소실). 탭 배지 "Incidents 4"는 전체 수치 |
| 강점 1 | 고객별 색 띠·이니셜·"CUSTOMER WORKSPACE" 라벨 = 4개 중 가장 강한 "지금 어디" 신호 |
| 강점 2 | `/c/mirae/...` 경로형 URL, All 홈과 고객 안의 구분이 명확 |
| 34 고객 | 홈 표 34행 + 필터. 진입 칩은 3개뿐(중복 1개), 나머지는 "Enter a customer…" 검색. 색이 34개로 늘면 구분력 저하 예상 |

### D · 하이브리드 목록 + 패널
| 구분 | 내용 |
|---|---|
| 문제 1 | **칩 스코프와 패널 스코프 불일치**: 칩 "Mirae Pay › Core"에서 행을 열면 고객 전체 패널. URL도 `scope`+`open` 이중 |
| 문제 2 | 키보드로 행을 못 엶(tabindex 없음), 패널이 모달이라 내비 차단, Esc가 경고 없이 편집 폐기. 모니터링 행 클릭은 패널이 아니라 스코프 좁히기(화면마다 다름) |
| 문제 3 | 상속만 하는 프로젝트(Core)는 목록에 행이 없어 패널 하단 트리까지 내려가야 도달. "adds a scope chip" 문구와 달리 칩은 교체됨 |
| 강점 1 | 고객을 고르지 않고 전체 목록에서 바로 열고 처리 → 아침 점검·인터럽트에 최적, 스코프가 뒤에서 바뀌지 않음 |
| 강점 2 | 패널 머리글 "SCOPE · {종류} / {이름}"이 편집 대상 범위를 직접 명시, 인시던트 패널에 Acknowledge·호출 순서·점검창이 한곳에 |
| 34 고객 | Paging 36행(고객+자체 단계 행), People 25행(실제로는 수백). 정렬·"문제만" 필터 없이는 한계. "My customers 12" 필터는 동작 |

## 4. 무엇을 합칠 것인가

| 가져올 것 | 출처 | 이유 |
|---|---|---|
| 교차 고객 목록을 기본 화면으로, 편집·인시던트 처리는 패널에서 | D | 과업 3·7에서 유일하게 안전하고 빠름 |
| 패널/편집 영역 머리에 고객 색 띠 + 이니셜 | C | 잘못된 고객을 1초 안에 알아채는 유일한 비문자 신호 |
| 경로형 URL `/c/{고객}/...` + 패널은 단일 파라미터 | C | D의 scope/open 이중 스코프 제거 |
| 전체 범위에서는 MSP 기본값 편집을 화면에서 분리(별도 진입 + 확인) | B | 과업 5의 34개 고객 오적용 차단 |
| 3단 브레드크럼 표시 + 핀 + "스코프 밖 N건"(단, 눌러도 스코프 유지하고 패널로 열기) | A | 과업 4 가시성, 인터럽트 인지 |
| "Save for {범위}" / "Create own steps for Core" 문구를 임계치 버튼에도 | A·B·C Paging | G9 해소 |

반드시 고칠 것(조합과 무관):
1. 미저장 편집이 있을 때 스코프 전환·패널 닫기·화면 이동 시 확인 또는 고객별 초안 보존(G1).
2. 전환 직후 첫 편집 칸에 포커스, 입력칸 Enter/Ctrl+Enter 저장, 목록 행 키보드 열기(G2).
3. 패널이 여는 범위가 칩과 다르면 패널 상단에 "칩은 Core, 이 편집은 Mirae Pay 전체" 경고. 상속만 하는 프로젝트도 칩으로 좁혔을 때 행으로 노출.
4. 검색은 접두어 우선 + 담당 고객 우선, 담당 외 고객은 구분 표시(G3).
5. 토스트 수치를 실제 적용 범위와 일치(G4), 배지를 스코프와 일치(G5), "D-19" 제거(G8).
6. B의 우회 링크는 결과 위치로 스크롤하거나 별도 화면으로.
