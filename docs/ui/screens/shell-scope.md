# 콘솔 셸과 범위 규칙 (shell · scope)

상태: 확정 (D-33, D-34, D-35 · 11/10). **셸 규칙의 기준 문서는 이 파일 하나다.** 화면 명세(`screens/*.md`)는 여기 규칙을 되풀이하지 않고 화면마다 다른 것만 적는다.

- 시안: `docs/ui/mockups/scope-variants.html` 변형 E, 기본 피커(트리 · 시트). 검사: `docs/ui/mockups/checks/scope-e-check.py`.
- 비교 기록(변형 A~E, 평가, 측정값): `docs/ui/scope-variants.md`. 괄호 안 `E1`~`E20`, `T1`~`T13`은 그 문서에서 쓰던 규칙 번호다.
- 점수: `docs/qa/scope-scores/` (평가 3조, E-tree 개념 94/105, 단순함 최저 → §11의 단순화).
- 콘솔 문구는 영어(D-01). 아래 따옴표 안 영어가 화면 문구다.

## 1. 셸 구성

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ AlarmOps  Incidents ④  Monitoring  Call order  People  Maintenance  Customers │  Filter to… Ctrl K   Settings  (JP)
├──────────────────────────────────────────────────────────────────────────────┤
│ SHOWING:  MP Mirae Pay × › Core × › All services        Outside this view: 3 open (1 from an unmapped account) · 2 acknowledged  ? │
├───────────────┬──────────────────────────────────────────┬───────────────────┤
│ 트리           │ 목록 (page)                               │ 패널 (하나)        │
│ Find by name… │ 행마다 고객 › 프로젝트 › 서비스             │ 머리: 종류 · 단계   │
│ ☐ Only with   │                                          │ 전체 경로          │
│   problems    │                                          │ 읽기 → Edit → Save │
│ All customers │                                          │                   │
│ MY CUSTOMERS  │                                          │                   │
│ OTHER …       │                                          │                   │
│ What do these │                                          │                   │
│ mean?         │                                          │                   │
└───────────────┴──────────────────────────────────────────┴───────────────────┘
```

| 영역 | 역할 | 규칙 |
|---|---|---|
| 메뉴 | 화면 이동 | Incidents 배지 = 전 고객의 열린 인시던트 수 하나. 필터와 무관(D-34) |
| 필터 줄 | 지금 목록이 무엇을 보여 주는지 | 글 한 줄. 선택기·칩·버튼 없음(각 단계의 `×`만) |
| 트리 (휴대폰: 시트) | **범위를 고르는 유일한 장치** | §2 |
| 목록 | 읽기, 행 열기, Acknowledge | 편집 칸 없음 |
| 패널 | 한 범위의 상세·편집 | 한 번에 하나. §4 |

## 2. 범위 고르기

### 2.1 트리 (데스크톱, 761px 이상)

| 규칙 | 내용 |
|---|---|
| 하나의 장치 (T1) | 범위는 트리에서만 고른다. `Ctrl/⌘K`("Filter to…")는 같은 필터를 이름으로 거는 단축 경로다. 필터 줄에 선택기는 없다 |
| 붙어서 밀어낸다 (T2) | 트리는 본문 위에 뜨지 않는다. 상태는 둘: 펼침(기본 272px, 200~360px) 또는 45px 띠(`»` + 세로로 쓴 현재 필터). 띠를 누르면 그 자리에서 펼쳐지고 본문이 남은 폭으로 다시 배치된다. `Pin` 없음. 폭 전환 180ms(`prefers-reduced-motion`이면 즉시). 펼침·접힘·폭은 기억한다 |
| 묶음 (T4) | 맨 위 `All customers`(고정) → `My customers · n` → `Other customers · n`(기본 접힘, 접힌 동안 묶음 줄에 열린 인시던트 합과 가장 나쁜 호출 표식). 고객은 기본 접힘 |
| **고른 줄까지 자동으로 펼친다** | 필터가 정해진 채 화면을 열거나(새로 고침·링크), 필터가 바뀌거나, 띠에서 트리를 펼치면 트리는 고른 고객 › 프로젝트 › 서비스까지 펼쳐서 보여 준다. 접힌 `Other customers` 안의 고객이어도 같다. 사용자가 그 가지를 직접 접으면 접힌 줄이 선택 표시를 대신 갖는다(별도 표식 없음) |
| `Only with problems` (T5) | **열린 인시던트가 있거나 호출 문제(UNREACHABLE·AT RISK)가 있는** 고객만 남긴다. 옆 숫자 = 그런 고객 수. 임계치 검토(Needs review)는 Monitoring의 일이고 여기서 세지 않는다 |
| 이름으로 찾기 (T6) | 친 단어마다 경로의 어느 단어 첫머리와 맞아야 하고 그중 하나는 그 줄 이름과 맞아야 한다(`mirae check` → Mirae Pay › Core › Checkout). 맞은 것이 둘 이상이면 Enter는 아무것도 고르지 않는다. 고르면 검색어가 지워진다 |
| 조작 (T8) | 이름 = 고르고 펼친다. 화살표 = 펼치기만. 키보드 `↑↓` `→←` `Enter` `Home/End`, 글자 = 그 글자로 시작하는 줄. 고객을 바꾸면 프로젝트·서비스는 비워진다 |

### 2.2 트리 표식 — 3종뿐

| 표식 | 뜻 | 붙는 곳 |
|---|---|---|
| 빨간 숫자 칸 `2` | 열린 인시던트 수(메뉴 배지와 같은 모양) | 고객·프로젝트·서비스, 접힌 묶음 |
| `UNREACHABLE`(빨강) 또는 `AT RISK`(호박색) | 호출 문제(D-32). Call order 목록의 표식과 같은 글자 | 고객, 접힌 묶음. 포털에는 없음 |
| `OWN STEPS` | 그 프로젝트·서비스에 자기 호출 순서가 있다. Call order 목록의 "Own steps"와 같은 말 | 프로젝트·서비스만 |

- 점·세모는 쓰지 않는다(목록에서 인시던트 상태·심각도의 모양이다).
- 없앤 것: `REVIEW` 표식, "안에 own steps가 있다" 네모, `FILTER INSIDE`.
- 범례는 기본으로 접혀 있고 트리 맨 아래 링크 한 줄이다: "What do these mean?". 누르면 위 3줄이 나온다(세션 동안 기억).

### 2.3 시트 (휴대폰, 760px 이하) (T9)

- 필터 줄 = 범위 한 줄(`Mirae Pay › Core › All services`, 길면 `›`에서 줄바꿈, 44px 이상) + `×`. 누르면 전체 높이 시트.
- 단계: 1 Customer(`All customers` · `My customers` · My customers 묶음 먼저 · 검색) → 2 Project(`All projects`) → 3 Service(`All services`). 줄 52px, `← Back`, `Close`는 아무것도 바꾸지 않는다.
- 2·3단계 아래 `Use Mirae Pay only` / `Use Mirae Pay › Core only`는 적힌 범위를 그대로 건다.
- 시트는 지금 고른 값이 있는 단계에서 열린다. 줄의 표식은 트리와 같은 3종이다.
- **범례는 시트를 덮지 않는다.** 시트를 열 때마다 접혀 있고, 목록 아래 흐름 안에 링크 한 줄(44px)로 있다. 펼쳐도 목록·머리·아래 버튼 위에 겹치지 않고 높이는 시트의 1/4 이하, 목록은 180px 이상을 지킨다.
- 휴대폰에는 트리 서랍이 없다. 시트의 검색 칸은 그 단계 목록만 거른다(단계를 가로지르는 검색은 없다).

### 2.4 `Filter to…` (Ctrl/⌘K) (E14)

검색 + 고객 목록. 단어 첫머리 일치. 같은 이름이 여러 고객에 걸치면 아무것도 미리 고르지 않고 트리와 같은 순서로 보여 준다. 고르면 같은 화면에 그 필터로 도착하고 포커스는 제목.

## 3. 필터 줄과 목록

| 규칙 | 내용 |
|---|---|
| 기본 보기 (E1, D-34) | 모든 목록의 기본은 **All customers**. `My customers`는 필터다(트리 묶음 머리, 시트 1단계) |
| 행 (E1) | 모든 행에 `고객(굵게) › 프로젝트 › 서비스`. 자기 호출 순서를 가진 프로젝트·서비스는 별도 행 |
| `Showing:` (E2, T1) | `Showing: Mirae Pay × › Core × › All services`. `×`는 그 단계만 지운다(고객 `×` = All customers) |
| `Outside this view` (E3, T12) | 필터가 걸렸을 때만. Incidents: `Outside this view: 4 open (1 from an unmapped account) · 2 acknowledged`. 목록의 open + 밖의 open = 메뉴 배지. 밖에 없으면 `Outside this view: no incidents`. 누르면 필터를 지운 Incidents로 가고 알림에 `Back to <필터>`. Monitoring: 칩 줄에 `Outside this view: 2 need review · 3 in alarm` |
| 필터와 패널 (E5) | 패널 범위와 목록 필터는 독립이다. 패널은 필터를 바꾸지 않는다 |
| 패널이 열린 채 필터 변경 (T11) | 트리·`×`·`Ctrl/⌘K` 모두 같다. 저장 안 한 수정이 있으면 §6의 창이 먼저, 없으면 패널이 닫히고 "Panel closed for X · the list now shows Y". 고객 X의 패널이 고객 Y 필터 아래에 남지 않는다 |
| Acknowledge (E17) | 행·카드·패널에 있다. 알림에 전체 경로 + `Undo` |

## 4. 패널: 읽기 먼저, 그다음 Edit

| 규칙 | 내용 |
|---|---|
| 하나의 패널 (E4) | 행은 범위가 정해진 패널 하나를 연다(데스크톱 옆 패널, 휴대폰 전체 화면). 겹치지 않는다. 머리 띠: 종류 · 단계 + 이니셜 + **전체 경로** + `Copy link` + `Close` |
| **읽기 먼저** | 호출 순서·기본 임계치·알람 임계치·고객 사람 패널은 **읽기 전용으로 열린다.** 입력 칸, Save, 넓히기·삭제 버튼이 없다. 아래 줄에 버튼 하나: `Edit call order for <전체 경로>` / `Edit defaults for <고객>` / `Edit threshold for <경로> › <리소스>` / `Edit <사람> for <고객>`. 키 `E`도 같다 |
| 호출 순서 읽기 화면 | ① "If something breaks now" — 실명 문장 ② `Paged (n)` · `Also notified (m)` 이름 + "Open them in People →" ③ Steps(분 · 대상 · 수단, 마지막 줄 "then repeat once") ④ `Comes from`(자기 단계: 경로 · own/customer steps · used by N services · 누가 언제 고침) 또는 `Inherited from`(물려준 단계의 경로 + "Open the call order of <상위> →") ⑤ "Where steps come from" 트리, Responders |
| 물려받은 단계 (E7) | 자기 단계가 없으면 읽기 화면의 버튼은 `Create own steps for <경로>…`다. 누르면 "Creating own steps for …" 상태로 편집에 들어가고, 저장 전에는 아무것도 바뀌지 않는다. 물려준 단계 자체를 고치려면 `Inherited from`의 링크로 그 단계를 연다 |
| 편집 화면 | `Edit` 뒤에만: 머리가 "… · editing at <단계> level"로 바뀌고 입력 칸, `Unsaved` 표시, `Cancel`, `Save for <전체 경로>`(`Ctrl/⌘+Enter`)가 나온다. `Cancel`은 바꾼 것이 없으면 바로 읽기 화면으로, 있으면 "Discard changes for <경로>?"(기본 포커스 `Keep editing`) |
| 넓히기는 따로 밟는 단계 (E6) | 편집 화면의 "Level you are editing"은 지금 단계만 보여 준다. 더 넓은 단계는 `Edit project X instead…` / `Edit the whole customer instead…` → 무엇이 넓어지는지(대상 서비스 목록, 원래 행이 자기 단계라 안 바뀌는지) 설명하는 창(기본 포커스 `Stay`). 좁히기(`← Back to …`)는 한 번. **읽는 중**에는 패널 안 트리·링크로 넓은 단계를 열어도 그냥 열린다(읽기 전용이므로) |
| 저장 전 미리보기 (E8) | 호출 순서: 문장이 입력하는 대로 바뀌고 옛 값은 취소선. 순서가 뒤집히는 값은 저장이 막힌다. 임계치: "What saving would change"(지표별 전 → 후, 바뀌는 알람, 자기 값을 지키는 알람) |
| **확인은 둘 이상일 때만** (E9) | 저장 확인창은 ① 서비스 **둘 이상**에 닿거나 ② 연 행보다 **넓힌** 단계에서 저장할 때만 뜬다. 창에는 전 → 후, 대상 서비스 목록, 안 바뀌는 것. 그 밖(서비스 하나, 리소스 하나, 사람 하나)은 **`Ctrl/⌘+Enter` 한 번에 바로 적용**된다 |
| 알림과 Undo (E10) | 저장하면 패널이 닫히고 알림 하나: `Saved for Hanbit Logistics › Fulfilment › Orders API · step 2 5 → 4 min · 1 service` + **`Undo`**(확인 없이 적용된 저장에만, 9초). Undo는 저장 전 값으로 되돌린다. 확인창을 거친 저장에는 Undo가 없다. 버튼·알림·확인창의 경로는 항상 고객 포함 |
| 임계치 기본값은 고객 단계 (E13) | 프로젝트·서비스 기본값은 없다. 목록이 프로젝트로 걸러진 채 편집에 들어가면 "This changes all of Mirae Pay, not only Core." |
| 사람 목록 = 호출 문장 (E16) | People을 범위로 거르면 그 범위에서 호출되거나 알림 받는 모든 사람이 나온다(상위에서 온 사람은 `from Mirae Pay`). 패널의 `Paged · Also notified`와 같은 계산 |
| 연락처 열람 (D-35) | 목록·패널은 가린 값(`010-••••-4821`). `Reveal`은 그 고객의 Responder인 직원에게만 보이고 누르면 기록된다("Shown to you · logged"). API `POST /contacts/{id}/reveal`. 시안에는 가린 값만 있고 `Reveal` 버튼은 아직 그리지 않았다 |

## 5. 생성 흐름과 MSP 전체 변경

| 규칙 | 내용 |
|---|---|
| 범위를 먼저 (E12) | `New window`, `Add person`: 1 고객 → 2 범위(고객 전체 / 프로젝트 / 서비스) → 3 내용. 미리 선택 없음. 목록 필터는 "Use exactly this · go to step 3" 제안으로만. 사유·이름은 필수. 같은 범위에 이미 있는 창은 "Already here" |
| 생성 저장 | 서비스 둘 이상을 묵음하는 창은 확인창, 서비스 하나면 바로 + `Undo` |
| MSP 전체 (E11) | 전 고객에 닿는 변경은 `Settings`에만 있다(MSP default thresholds, 심각도 매핑, 억제). 값 편집 → 같은 화면 미리보기(`12 of 14 customers`, 제외 고객, 바뀌는 알람) → 확인창 1회. 템플릿 변경·휴가 대체처럼 여러 고객에 닿는 일괄 작업도 같은 틀(영향 미리보기 → 확인 → 감사 기록) |

## 6. 저장 안 한 편집 가드 (E15)

나가는 길은 전부 같은 창: `Save for <경로>` / `Keep draft and continue` / `Discard changes` / `Cancel`. 닫기·Esc·다른 행·메뉴·필터 변경·넓히기·브라우저 뒤로 모두. 편집 중 인시던트를 열 때는 `Keep draft and open incident`. 초안은 범위별로 보관되고 "Draft for … Resume"로 돌아온다(다시 열면 편집 화면). 초안은 다른 범위에 적용되지 않는다. 보관 위치는 PoC에서 브라우저(sessionStorage)다 — API-CONTRACT §8.8.

## 7. 주소

| 대상 | 주소 | 비고 |
|---|---|---|
| 목록 | `/<screen>` + `?filter=<customer>[/<project>[/<service>]]` 또는 `?filter=mine` | screen = `incidents` `monitoring` `call-order` `people` `maintenance`. 화면 안 칩은 `&show=` |
| 패널 | `/c/<customer>[/<project>[/<service>]]/<screen>[/<id>]` + `?filter=…` | 경로 = 패널의 범위, `?filter=` = 목록 필터(새로 고쳐도 둘 다 유지) (E5, T13) |
| 예 | `/c/mirae/call-order?filter=mirae/core` · `/c/hanbit/fulfilment/orders-api/call-order` · `/c/mirae/thresholds` · `/c/mirae/core/payments-api/alarms/<resource>` · `/c/mirae/core/payments-api/incidents/<id>` · `/c/mirae/people/<slug>` · `/c/mirae/core/maintenance/new` | 미매핑 계정 인시던트는 `/incidents/<id>` |
| `Copy link` | `?filter=`를 뺀다 | 받는 사람은 자기 필터를 유지한다 |
| 편집 상태 | 주소에 없다 | 링크는 항상 읽기 화면으로 열린다 |
| 없는 것 | "Not found" 하나 | 없는 ID와 볼 수 없는 ID가 같은 화면. 주소는 친 그대로 둔다 |
| 포털 | `portal.…/<project>/<service>/<screen>` — `/c/<customer>` 없음 | §10 |

콘솔 브랜치(`feat/console-scope`)의 현재 구현은 이 표와 다르다: 목록 필터 `?customer=&project=&service=`(`?mine=1`), 패널 `/c/<customer>/<project>/<service>/incident/<id>`, 미매핑 `/c/-/incident/<id>`. 어느 쪽으로 맞출지는 정하지 않았다(API-CONTRACT Q-API-13). API는 어느 쪽이든 slug 파라미터 `customer`·`project`·`service`·`mine`을 쓴다.


프로젝트·서비스 slug는 부모 안에서 유일하고 화면 이름(`incidents` `monitoring` `call-order` `people` `maintenance` `thresholds` `alarms` `resources` `settings` `new`)과 같을 수 없다(백엔드 검증).

## 8. 반응형

| 폭 | 트리 | 패널 |
|---|---|---|
| 1408px 이상 | 펼친 채로 패널 옆에 남는다. 패널을 여닫아도 목록 왼쪽 끝이 움직이지 않는다(0px) | 옆 패널 600px |
| 1101~1407px | 기본 펼침. **패널을 열면 띠로 자동 접힘**(기억하지 않음, 패널을 닫으면 돌아온다). 사용자가 띠를 눌러 패널 옆에 다시 펼칠 수 있다 | 600px → 모자라면 440px까지 |
| 761~1100px | 기본 띠 | 위와 같음. 카드 320px도 안 나오면 패널이 전체 화면 + `← Back to the list`(트리 오른쪽 끝에서 시작) |
| 760px 이하 | 없음. 시트(§2.3) | 전체 화면 |

자리가 모자랄 때의 순서 (T3): ① 목록이 2차 열을 숨긴다 → ② 패널이 600 → 440px → ③ 목록이 한 열 카드(320px 이상) → ④ 패널이 전체 화면. 어느 단계에서도 잘림·가로 스크롤·글자 겹침은 없다.

### 열 우선순위 (목록 폭 기준)

| 화면 | 끝까지 남는 것 | 1차로 숨김 | 2차로 숨김 | 카드로 바뀜 |
|---|---|---|---|---|
| Incidents | Sev, Status, 경로, Incident, `Acknowledge` | Paged (1000px 미만) | Age (800px 미만) | 690px 미만 |
| Monitoring | Resource · metric, 경로, Sev, State | `Default thresholds` 카드가 표 아래로 (1040px 미만) | Threshold (720px 미만) | 560px 미만 |
| Call order | 경로, Paged first, Steps | Then (900px 미만) | Reach 열 → 고객 이름 옆 글 표식 (760px 미만) | 500px 미만 |
| People | Person, 경로(Notified for), Channels needing action | Role, Contact (1100px 미만) | Kind (720px 미만) | 500px 미만 |
| Maintenance | Status, 경로, Window | By, Muted (900px 미만) | Reason (700px 미만) | 500px 미만 |

폭 값은 시안 데이터 기준이다. 실제 행이 들어가지 않으면 잘리는 대신 다음 단계로 넘어간다. 콘솔 구현 때 다시 잰다.

## 9. 키보드와 휴대폰

- 키보드 (E18): 행에서 `Enter` = 패널(읽기), `E` = 편집, `Ctrl/⌘+Enter` = 저장, `Esc` = 닫기(가드). 저장·닫기 뒤 포커스는 편집한 행, 필터 변경 뒤에는 제목. 확인창은 Tab이 안에서 돈다. 텍스트 칸 안의 `e`는 글자다.
- 휴대폰 390px (E19): 누르는 영역·입력 칸 44px 이상, 칩 줄바꿈, 가로 넘침 0, 시트·확인창이 열리면 알림을 치운다. Call order 카드는 호출되는 사람 이름이 먼저다. 읽기 화면의 `Edit` 버튼은 화면 아래에 고정되고 44px 이상이다.

## 10. 포털 (E20, T10)

같은 셸을 한 고객에 잠근다. 트리는 그 고객 하나(루트·묶음·`Only with problems` 없음), 시트는 2단계부터, 범례에 호출 표식 없음. 패널은 읽기 화면만이고 `Edit`가 없다("Managed by your MSP."). **없는 ID와 남의 고객 ID는 글자 하나 다르지 않은 "Not found"**이고 주소는 친 그대로 남는다. API도 같은 본문·같은 상태 코드여야 한다(API-CONTRACT §2 "포털 404 동등").

## 11. 단순화 기록 (평가 3조 뒤, 11/10)

| | 전 | 후 |
|---|---|---|
| 트리 표식 종류 | 6 (숫자, UNREACHABLE, AT RISK, REVIEW, OWN STEPS, 네모) + FILTER INSIDE | 3 (숫자, 호출 문제 표식 하나, OWN STEPS) |
| 범례 | 항상 펼침 6줄(약 165px), 휴대폰 시트의 1/5 | 링크 한 줄, 펼치면 3줄. 시트에서는 열 때마다 접힘 |
| 패널을 열면 | 바로 편집 화면(입력 칸, 넓히기, 삭제) | 읽기 화면 → `Edit` |
| 저장 확인 | 서비스 둘 이상 + 임계치 기본값은 항상 | 서비스 둘 이상 또는 넓힌 저장만. 나머지는 바로 + `Undo` |

화면에 보이는 개념 수의 측정값은 `docs/ui/scope-variants.md` §7.8.

## 12. 아직 정하지 않은 것

- Customers 메뉴(고객 관리: 목록·온보딩·계정·연동·자동 조치·포털 권한)와 Call order 탭(Rotations·Templates)은 E 시안에 없다. 위치는 `IA.md` §1의 배치안이고 화면은 새 셸로 다시 그리지 않았다.
- 1408px 경계를 낮출지(1280에서도 트리 + 표 + 패널이 들어간다).
- 프로젝트·서비스 단계의 호출 문제 표식을 서버가 계산할지(지금은 고객 단계만, D-32).
- 저장 `Undo`의 유효 시간(시안 9초)과 서버 처리(API-CONTRACT §8.8: 이전 값을 다시 저장).
- 포털에서 Acknowledge 할 수 있는 사람(기존: 불가, R4-3).
- 독립 재평가와 `/persona-check`는 이 단순화 뒤에 다시 하지 않았다.
