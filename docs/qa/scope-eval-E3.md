# 스코프 변형 E (기본 피커: 데스크톱 트리 · 폰 단계형 시트) 독립 UX 평가 — E3

- 대상: `/home/claude/wt-scope/docs/ui/mockups/scope-variants.html`, 탭 E, 피커 기본값(`E-2+ Tree · sheet`)
- 방법: Playwright(Chromium)로 직접 조작. 1440×900, 1024×768, 390×844(터치). 과제마다 새로 로드하고 sessionStorage를 비움. 스크린샷을 눈으로 확인함.
- 읽지 않은 것: `docs/ui/scope-variants.md`, `docs/qa/scope-eval-*.md`, DECISIONS. 저장소는 읽기만 함.
- 스크린샷: `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/e3/shots/`
- 횟수 표기: 폰은 탭, 데스크톱은 클릭 또는 키 입력(문자 1개 = 1). 목업 상단 토글(페르소나, 34곳, 포털)은 세지 않음.

## 판정: 조건부 채택 (adopt with fixes)

스코프 표시와 저장 안전장치는 세 너비 모두에서 잘 작동한다. 다만 아래 P1 두 건은 고치기 전에는 파일럿에 못 쓴다. P1-1은 설계가 아니라 목업 구현 결함이지만, 마우스와 터치로는 편집 패널을 쓸 수 없게 만든다.

## 1. 과제 결과

| 과제 | 결과 | 횟수 | 관찰 |
|---|---|---|---|
| **H1** Mirae Pay 결제 인시던트 찾아 확인 | 통과 | 1탭 | 첫 카드에 `Mirae Pay › Core › Payments API`. 목록의 Acknowledge(328×44) 한 번으로 끝. 토스트가 "Acknowledged in Mirae Pay › Core › Payments API · paging stopped"와 Undo를 보여줌. |
| **H2** Daon Retail › Commerce › Checkout으로 좁히기(타이핑 없이), 누가 호출되는지 | 통과(불편 있음) | 좁히기 4탭 + 호출 대상 2탭 | 시트가 단계마다 즉시 필터를 적용. Call order 탭에서는 "everyone in Responders (3)"만 보이고 이름(Junho Park, Minjae Lee, Soyeon Choi)은 행을 열어야 나옴. 열리는 것이 편집 패널임(P2-6). |
| **H3** 그 필터에서 다른 열린 인시던트가 있는지 | 통과 | 0탭 | 필터 줄 아래 빨간 테두리 "Outside this view: **3 open** · 2 acknowledged · 1 unmapped account". 1탭으로 필터 해제, 토스트의 "Back to …"로 복귀. 하단 탭 배지는 4라서 숫자가 어긋나 보임(P2-7). |
| **H4** Hanbit Logistics로 전환 후 전체로 | 통과(P1-2 주의) | 4탭 + 1탭 | 시트가 현재 단계(3·Service)에서 열려 "1·Customer" 탭을 한 번 더 눌러야 함. 전체 복귀는 × 1탭. |
| **N1** 고객 목록, 문제 있는 고객, Mirae Pay의 프로젝트·서비스 | 통과 | 0~1 / 0~1 / 4클릭 | 내 고객 12곳은 바로 보임. Other customers는 접혀 있어 +1. 문제는 배지로 바로 보이거나 "Only with problems" 1클릭. ▸ 4번으로 필터를 바꾸지 않고 Mirae Pay 전체를 펼침(이름을 누르면 2클릭이지만 필터가 바뀜). |
| **N2** Hanbit › Fulfilment › Orders API 호출 순서, 자체인지 상속인지 | 통과 | 1클릭 (트리 경로 3클릭) | Call order 목록에 해당 행과 `OWN STEPS`가 바로 있음. 패널의 "Where steps come from"이 상속 관계를 전부 보여줌. 트리에서는 Hanbit과 Fulfilment를 펼치기 전까지 OWN이 안 보임(P2-2). |
| **N3** Mirae Pay › Core 유지보수 창 만들기 | 키보드로는 통과, **마우스로는 실패(P1-1)** | 7클릭 + 사유 입력 | 필터를 조용히 물려받지 않음. "Your list filter · Use exactly this"로 명시 확인. 스코프가 패널 머리, APPLIES TO("3 services: Payments API, Settlement, Checkout … Nothing outside it"), 저장 버튼, 확인 대화상자에 같은 문구로 나옴. 사유 입력칸을 클릭하면 패널이 닫힘. |
| **N4** 트리 표식 설명 | 범례 없이는 부분 통과, 범례 있으면 통과 | — | 숫자 배지는 추측 가능. ●과 ▲은 목록의 Triggered, SEV-2/Escalated와 같은 모양이라 범례 없이는 오독함. OWN은 범례를 봐도 목록의 "CUSTOMER STEPS"와 어긋남(P2-2). 범례는 트리 하단과 폰 시트에 항상 보임. |
| **J1** Mirae, Daon, Hanbit 호출 타이밍 연속 수정 | 통과 | 키 34개(12+11+11), 마우스 0 | `Ctrl+K → 3글자 → Enter → Tab → Enter`로 Step 2 입력칸에 포커스. `Ctrl+Enter`로 전/후 비교 대화상자, Enter로 저장, 패널이 닫히고 포커스가 행으로 돌아옴. 잘못된 고객에 조용히 저장되는 경로는 못 찾음. 남은 위험 경로는 P2-1. |
| **J2** 편집 패널이 열린 채 목록 사용, 레일의 스코프 표시 | 통과 | — | 1440에서 목록이 796px, 3열로 줄어 읽히고 클릭됨. 깨끗한 패널은 다른 행 클릭으로 바로 전환, 수정 중이면 Save / Keep draft / Discard / Cancel. 레일은 필터를 세로 글씨로 반복할 뿐 새 정보가 없음(P2-4). |
| **J3** 1024에서 레일, 오버레이, 핀 | 부분 통과 | 오버레이 1 + 선택 1~3 | 기본이 레일. 오버레이(272px)가 목록을 덮고 필터는 즉시 적용. 핀 하면 목록이 752px로 줄어 행이 4줄로 늘어남. 패널이 열리면 목록이 380px만 보이고 열이 줄지 않아 잘림(P2-3). |
| **J4** 34곳 중 문제 고객 전부 찾기 | 통과 | 1클릭, 키보드는 Tab 5 + Space | "Only with problems 5" → Mirae, Daon, Hanbit, Kumho Clinic(●), Lumen Bank(▲). 그룹 머리글이 "3 of 12", "2 of 22"로 바뀜. Call order 목록도 문제 고객을 맨 위에 둠. |
| **J5** Mirae 미저장 수정 → Daon 인시던트 → 복귀 | 통과 | 8동작 | 화면 이동 시 가드 대화상자. Keep draft를 고르면 모든 화면 상단에 "Draft for Mirae Pay — call order steps, not saved · Resume / Discard". Resume으로 값(12)이 그대로 복원됨. |
| **J6** 딥링크, 새로고침, 뒤로 | 통과 | — | 뒤로/앞으로가 필터 → 패널 순서를 정확히 되감음. 수정 중 새로고침은 초안 복원, 수정 중 뒤로는 가드. 없는 ID는 "Not found". 제품 URL에 목록 필터가 없어 새로고침 동작은 확인 필요(P2-11). |
| **M1** 트리에서 Mirae Pay › Core 선택 후 임계값 | 통과 | 4클릭 | 패널 제목 "Default thresholds · Customer level / Mirae Pay", 노란 상자 "This changes all of Mirae Pay, not only Core … there is no project or service default". 미리보기와 확인 대화상자가 바뀌는 알람 이름을 나열. 매우 분명함. |
| **M2** 전체 고객에서 검토 필요한 리소스 | 통과(필터 없을 때) | 2클릭 | Monitoring → "Needs review 2" 칩. 필터가 걸려 있으면 "Needs review 0"만 보이고 바깥에 더 있다는 표시가 없음(P2-8). |
| **S1** 포털에서 다른 고객이 보이는지 | 통과 | — | 1440과 390 모두 화면 글자와 DOM에 다른 고객 이름, unmapped 계정, 고객 수가 없음. 트리는 Daon Retail뿐. Ctrl+K는 열리지 않음. 다른 고객의 인시던트·호출 순서·사람 ID를 주소에 넣으면 전부 같은 "Not found". |

## 2. 일반 점검

**2초 안에 스코프 식별**

| 화면 | 1440 | 1024 | 390 |
|---|---|---|---|
| 목록 | 됨. `SHOWING:` 줄 + 트리 강조 | 됨. `SHOWING:` 줄(레일은 중복) | 됨. 2줄짜리 `SHOWING` + Outside 줄 |
| 패널 열림 | 됨. 패널 머리의 큰 경로 + "Save for X" | 됨 | 됨. 전체 화면 패널의 머리 |
| 레일 | 읽히지만 세로 글씨라 느림. 필터 줄과 같은 내용 | 같음 | 해당 없음 |

**트리, 필터 줄, 패널 머리가 서로 어긋나는 경우**

- 트리와 필터 줄은 항상 일치했다. 예외 하나: 선택된 고객을 ▾로 접으면 트리에 강조된 행이 없어지고, 접힌 고객에 "여기 선택됨" 표시가 없다(P2-10).
- 필터와 패널이 다른 고객이 되는 상태가 있다(P2-1). "Different customer than your list filter" 노란 띠로 표시는 되지만, 화면에 고객 이름이 둘 보인다.
- 필터가 패널보다 좁은 경우(예: 필터 Checkout, 패널 Daon Retail)는 "Wider than your list filter"로 잘 설명된다.

**같은 이름 서비스("checkout")**

- 트리 검색: Mirae Pay › Core › Checkout과 Daon Retail › Commerce › Checkout이 각자 부모 아래에 보이고 "2 matches in 2 customers · nothing is selected until you choose one". 좋다. 다만 Enter를 두 번 누르면 첫 번째(Mirae)가 선택된다(P2-9).
- Ctrl/⌘K: "2 customers have a match for 'checkout': Daon Retail, Mirae Pay. Nothing is selected" 안내가 뜨고 Enter가 막힌다. ↓로 골라야 한다. 좋다.
- 두 곳의 정렬이 다르다(트리는 Mirae 먼저, Ctrl+K는 Daon 먼저).

**복잡도**

- 1440 목록에서 같은 스코프가 필터 줄과 트리 강조로 두 번, 레일이 뜨면 세 번 나온다. 필터를 바꾸는 입구도 셋이다(트리, 필터 줄의 ×, Ctrl+K).
- 첫 고객 행 위에 컨트롤이 네 줄 쌓인다(검색, Only with problems, All customers, My customers 머리글). 참을 만하다.
- 포털에서는 프로젝트 2개짜리 트리가 272px를 차지하고 범례에 MSP 내부 표식이 나온다.

**390에서 44px 미만 탭 대상**

- "Open People →" 88×18 (호출 순서 패널의 Responders 머리)
- "Settings →" 51×36 (Monitoring의 MSP defaults)
- 그 외 목록, 필터 줄, 시트, 인시던트 패널, 하단 탭은 모두 44px 이상.

## 3. P1

### P1-1. 패널 안쪽이나 검색 입력칸을 클릭·탭하면 패널이 닫히거나 포커스가 사라진다 (목업 구현 결함)

- 재현 A: 1440, `#v=E&s=paging&c=mirae` → Mirae Pay 행 클릭 → 패널의 "Step 3 minutes" 입력칸을 마우스로 클릭 → 패널이 닫힘. 수정 중이었다면 가드 없이 닫히고 "Draft for Mirae Pay … Resume"만 남음(값은 보존됨).
- 재현 B: Maintenance → New window → 3단계의 Reason 입력칸 클릭 → 패널 닫힘. 마우스로는 창을 만들 수 없음.
- 재현 C: 390, 호출 순서 패널의 분 입력칸 탭 → 패널 닫힘.
- 재현 D: 1440, 트리의 "Find by name…" 클릭 → 포커스가 즉시 사라져 타이핑이 안 들어감(Tab으로 들어가면 됨). 폰 시트의 검색칸도 같음.
- 원인: `<body data-v="E">`가 1549행의 범용 핸들러 `closest(t,'[data-v]')`에 걸려, 처리되지 않은 모든 클릭이 `go({v:'E',o:''})`를 부른다.
- 영향: N3(마우스), 마우스로 하는 J1, 하은의 폰 편집, 트리 검색. 키보드 경로는 영향 없음.
- 제안: 그 핸들러를 `.mk-bar [data-v]`로 한정. 이 보고서의 마우스 경로 수치(N3 등)는 브라우저에서 이 한 가지를 임시로 막고 잰 것이다.

### P1-2. 폰 시트의 "Use … only" 버튼이 적힌 스코프를 적용하지 않는다

- 재현: 390, 필터가 `Daon Retail › Commerce › Checkout`인 상태에서 `SHOWING` 줄 탭 → 시트가 3단계에서 열리고 하단에 파란 버튼 "Use Daon Retail › Commerce only / All services of Commerce" → 탭 → 시트만 닫히고 필터는 여전히 Checkout.
- 2단계에서도 같음: "Use Daon Retail only"를 눌러도 Commerce › Checkout이 유지됨.
- 영향: 새벽 3시에 범위를 넓혔다고 믿고 Search 쪽 인시던트를 놓칠 수 있다. 필터 줄에는 Checkout이 그대로 보이지만 버튼 문구가 틀린 스코프를 말한다.
- 제안: 버튼이 실제로 그 수준으로 필터를 설정하게 하거나, 이미 더 깊이 선택된 상태에서는 문구를 "Keep Daon Retail › Commerce › Checkout"으로 바꾼다. 상단 Close와 하단 버튼이 같은 일을 하는 것도 정리 필요.

## 4. P2

1. **패널이 열린 채 필터를 다른 고객으로 바꾸면 패널이 이전 고객에 남는다.** 재현: Mirae 패널에서 Step 2를 12로 수정(미저장) → `Ctrl+K`, "dao", Enter. 필터 줄과 레일은 Daon Retail, 패널은 Mirae Pay(12 그대로)이고 포커스는 BODY로 빠진다. 다음 Tab 3번이 Mirae의 Step 2 입력칸에 닿는다. 레일의 트리와 필터 줄 ×로도 같다. 저장 버튼, 노란 띠, 확인 대화상자가 모두 Mirae라고 말하므로 조용한 오저장은 아니지만, 연속 편집 중 유일하게 남은 오저장 경로다. 제안: 깨끗한 패널은 닫고, 수정 중이면 행 클릭과 같은 가드를 띄운다.
2. **트리 표식의 뜻이 목록과 충돌한다.** 트리의 ●(호출 불가)과 ▲(호출 순서 위험)이 인시던트 목록의 ● Triggered, ▲ SEV-2/Escalated/Unmapped와 같은 모양·색이다. 트리의 OWN은 Mirae Pay와 Iruda Edu(고객 수준)에 붙지만 Call order 목록은 그 행을 다른 고객과 똑같이 "CUSTOMER STEPS"로 적고, OWN STEPS는 프로젝트·서비스 재정의에만 쓴다. Hanbit과 Fulfilment가 접혀 있으면 Orders API의 OWN이 위로 올라오지 않는다.
3. **1024에서 패널을 열면 목록이 잘린다.** 패널(600px)이 목록을 덮어 380px만 보이는데 열 수가 그대로라 REACH가 "UNREACHABL"에서 끊긴다(1440은 3열로 줄임). 트리를 핀 하면 목록 752px, Call order 행이 4줄이 되어 한 화면에 4~5행.
4. **패널을 열고 닫을 때마다 트리와 레일이 바뀌며 목록이 228px 좌우로 움직인다(1440).** 연속 편집에서 마우스 사용자는 행 위치를 매번 다시 찾아야 한다. 레일의 세로 글씨는 바로 위 필터 줄과 같은 내용이다.
5. **레일 오버레이가 서비스를 고를 때만 닫힌다.** 고객이나 프로젝트를 고르면 열린 채 남아 ×, Esc, 바깥 클릭이 한 번 더 든다.
6. **폰의 Call order 카드에 호출 대상 이름이 없다.** "everyone in Responders (3)"까지만 나오고 이름은 편집 패널을 열어야 한다. 조회만 하려는 사람에게 편집 화면이 열린다.
7. **"Outside this view" 숫자 표기.** "3 open … 1 unmapped account"인데 탭 배지는 4다(unmapped도 Triggered). 바깥에 아무것도 없을 때도 "0 open · 0 acknowledged · 0 unmapped account" 줄이 남는다(준호, My customers).
8. **Monitoring은 필터 바깥을 알려주지 않는다.** `Mirae Pay › Core` 필터에서 "Needs review 0", 실제로는 다른 곳에 2건. Outside 줄은 인시던트만 센다. 트리의 "Only with problems"도 임계값 검토는 세지 않는다.
9. **트리 검색 세부.** 노드 이름 접두어만 맞춘다("mirae check"는 결과 없음. Ctrl+K는 고객 이름을 같이 치라고 안내함). Enter 두 번이면 첫 일치 항목이 선택된다. ↓가 일치 항목 사이를 건너뛰지 않는다. 고른 뒤에도 검색어가 남아 트리가 좁혀진 채로 있다.
10. **선택된 고객을 접으면 트리에 선택 표시가 없다.**
11. **패널 URL에 목록 필터가 없다**("one scope in the URL: the panel's"). 실제 제품에서 패널을 연 채 새로고침하면 필터가 유지되는지 목업으로는 알 수 없다.
12. **44px 미만 탭 대상 2개**(위 2절).

P3: 다른 고객의 Acknowledge 토스트가 편집 패널의 "Unsaved" 표시를 덮음. 포털 트리의 범례가 고객에게 무의미함.

## 5. 아직 어색한 점과 E-1, E-3 비교

**하은 (390)**

- 기본 피커의 폰 화면은 E-1의 시트와 같은 것이고, 차이는 하단 "Use … only" 버튼과 Close/Done 문구뿐이다. H2는 둘 다 4탭, H4는 둘 다 5탭. E-1에는 그 버튼이 없어 P1-2도 없다.
- E-3는 시트에 고객만 나오고, 고객을 고른 뒤 "Narrow" 버튼으로 프로젝트·서비스 목록(행 높이 40px)을 연다. H2는 같은 4탭이지만 단계가 보이지 않고, 문제 배지가 없어 어디에 인시던트가 있는지 고르기 전에는 모른다.
- 하은에게는 기본(= E-1 시트)이 E-3보다 낫다. 남는 어색함은 시트가 현재 단계에서 열려 고객을 바꾸려면 탭이 하나 더 드는 것과 P2-6이다.

**준호 (1440, 34곳)**

- 연속 편집(J1)은 세 피커 모두 Ctrl+K 경로가 같아 키 수가 같다.
- E-1과 E-3는 트리가 없어 목록이 1360px(기본은 약 1120px), 패널을 열어도 좌우 이동과 레일이 없다. P2-4가 없다.
- 문제 고객 찾기(J4)는 기본이 가장 빠르다(1클릭, 항상 보이는 배지). E-1은 고객 드롭다운을 열어 34곳(1760px 분량)을 스크롤해야 하고 문제만 보기가 없다. E-3의 Ctrl+K에는 상태 표식이 없다.
- 준호 혼자라면 E-3로도 충분하지만, 신입의 탐색(N1, N2)과 J4는 트리가 있어야 된다. 기본 피커를 유지하되 패널이 열릴 때의 레일 전환(P2-4)과 P2-1을 고치는 쪽을 권한다.

## 6. 채택 전 고칠 것 (우선순위)

1. P1-1 클릭 핸들러 한정
2. P1-2 시트 하단 버튼
3. P2-1 패널이 열린 상태의 필터 변경 처리
4. P2-2 표식 모양과 OWN 용어 통일
5. P2-3 1024 패널 열림 시 목록 열 축소
