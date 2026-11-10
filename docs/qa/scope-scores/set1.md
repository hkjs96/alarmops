# 범위 UX 평가 — set1-oncall

페르소나: 하은(당번, 폰 390px, 새벽 3시, 담당 7곳) · 대타 당번(첫 야간 대타, 폰 390 + 노트북 1280, 고객사 이름을 잘 모름)

방법: Playwright로 390(터치)·1280 폭에서 후보 7개를 매번 새로 열어 같은 과제 6개를 수행하고 스크린샷을 확인했다. 웹폰트가 차단되어 대체 폰트로 렌더링되었다.

## 점수 (개념 / 현재 목업)

| 기준 | A | B | C | D | E-1 | E-3 | E-tree |
|---|---|---|---|---|---|---|---|
| c1 지금 어디 | 4 / 4 | 3 / 2 | 5 / 4 | 4 / 3 | 5 / 5 | 4 / 4 | 5 / 4 |
| c2 잘못된 범위 방지 | 3 / 2 | 3 / 2 | 4 / 3 | 4 / 3 | 5 / 4 | 5 / 4 | 5 / 4 |
| c3 찾기 | 3 / 2 | 3 / 3 | 3 / 3 | 4 / 3 | 4 / 4 | 4 / 3 | 5 / 4 |
| c4 숙련 속도 | 4 / 4 | 3 / 2 | 3 / 3 | 5 / 4 | 3 / 3 | 5 / 4 | 4 / 4 |
| c5 폰 390 | 4 / 3 | 3 / 2 | 4 / 3 | 3 / 3 | 4 / 3 | 4 / 4 | 4 / 4 |
| c6 규모(34곳) | 3 / 2 | 3 / 3 | 3 / 2 | 3 / 3 | 4 / 4 | 3 / 3 | 5 / 5 |
| c7 단순함 | 4 / 4 | 3 / 3 | 3 / 3 | 4 / 4 | 3 / 3 | 4 / 3 | 3 / 2 |
| **합계** | **25 / 21** | **21 / 17** | **25 / 21** | **27 / 23** | **28 / 26** | **29 / 25** | **31 / 27** |

## 순위

- 개념: E-tree > E-3 > E-1 > D > C > A > B
- 현재 목업: E-tree > E-1 > E-3 > D > C > A > B

## 과제 결과

### T1 find Mirae Pay payments incident, state customer/project/service, acknowledge (phone)

| 후보 | 결과 |
|---|---|
| A | pass 1 tap; 99x26 button, toast has no scope, row unchanged |
| B | pass 1 tap; same small button and generic toast |
| C | pass 1 tap; same small button and generic toast |
| D | pass 1 tap; customer/project as labelled fields, small button |
| E-1 | pass 1 tap; 328x44 button, toast names scope + Undo |
| E-3 | pass 1 tap; 328x44 button, toast names scope + Undo |
| E-tree | pass 1 tap; 328x44 button, toast names scope + Undo |

### T2 with Mirae Pay scope active, find whether other customers have open incidents (phone)

| 후보 | 결과 |
|---|---|
| A | pass 0 taps; red '3 elsewhere' in sticky bar |
| B | fail; no indicator, only nav badge 4 vs 1 listed, must Clear |
| C | pass 0 taps; '3 elsewhere' in band |
| D | partial 1 tap; no indicator, must remove chip |
| E-1 | pass 0 taps; 'Outside this view: 3 open (1 unmapped), 3 acknowledged' |
| E-3 | pass 0 taps; same outside line |
| E-tree | pass 0 taps; same outside line |

### T3 without typing reach Daon Retail > Commerce > Checkout and say who gets called (phone)

| 후보 | 결과 |
|---|---|
| A | partial 3 taps via Paging list only; picker cannot (my 7 only, no project level); names need scroll |
| B | partial 4 taps; gate shows Daon only under Recent/collapsed Others |
| C | pass 3 taps via On-call list then tree; names need scroll |
| D | pass 3 taps via list then panel tree; names need scroll |
| E-1 | pass 3 taps via list or 4 via sheet; names Junho, Minjae, Soyeon shown |
| E-3 | pass 3 taps via list, 4 via picker+Narrow; names shown |
| E-tree | pass 3 taps via list or 4 via sheet; names shown |

### T4 switch between three customers quickly (phone, taps per switch)

| 후보 | 결과 |
|---|---|
| A | partial 2 taps; only covered/pinned/recent customers without typing |
| B | partial 2 taps; chip scrolls away, covered customers only |
| C | partial 2 taps via Jump; covered customers only |
| D | partial 2 taps; +Scope clipped at 390 with two chips |
| E-1 | pass 4 taps (bar, Customer tab, pick, Done) |
| E-3 | pass 2 taps |
| E-tree | pass 3 taps (bar, pick, Use X only) |

### T5 laptop 1280: open call-order edit for Hanbit > Fulfilment > Orders API, say what Save affects

| 후보 | 결과 |
|---|---|
| A | partial 2 clicks; row tag first opens customer-level editor; no unsaved guard, pin click swapped editor to Mirae |
| B | partial 4 clicks through gate; Hanbit under collapsed Others |
| C | partial 2 clicks; first lands on customer-level 'Save for Hanbit Logistics' |
| D | pass 1 click; 'Applies to ... 1 service'; no unsaved guard |
| E-1 | pass 1 click; 'Level: Service, pages for 1 service', full-path Save, guard dialog |
| E-3 | pass 1 click; same panel and guard |
| E-tree | pass 1 click; same panel and guard, tree collapses to rail |

### T6 return after 10 minutes to a scrolled, scoped screen: obvious what you are looking at?

| 후보 | 결과 |
|---|---|
| A | pass; sticky scope bar with path |
| B | fail on phone; nothing sticky, only row breadcrumbs |
| C | pass; sticky coloured band, strongest |
| D | partial; sticky chips, clipped at 390 |
| E-1 | pass; sticky Showing path + outside line |
| E-3 | pass; sticky Showing path + outside line |
| E-tree | pass; sticky Showing path + outside line |

## 점수 근거

| 후보 | 기준 | 근거 |
|---|---|---|
| A | c1 | Sticky scope bar on every screen; phone collapses to one segment; Save label omits customer |
| A | c2 | Elsewhere count good; dirty edit silently swapped by pin click; row tag opens customer-level editor |
| A | c3 | Picker lists only pinned/recent/my customers; no project drill on phone without typing |
| A | c4 | Two taps per switch; pins and Ctrl K on laptop |
| A | c5 | Works at 390 but Acknowledge is 99x26, chain links 15px tall |
| A | c6 | 34 customers: picker hides non-covered ones; no problem flags |
| A | c7 | One concept, one bar; easy to learn |
| B | c1 | Scope chip sits below tiles and scrolls away on phone lists |
| B | c2 | Gate blocks unscoped edits; filtered list gives no hidden-incident warning |
| B | c3 | Gate cards browse customers; others collapsed; project via small popover |
| B | c4 | Gate adds a step; chip unreachable after scrolling |
| B | c5 | Nothing sticky; small targets; gate fills first screen |
| B | c6 | Gate grid lists all 34 but no problem indicators |
| B | c7 | Lists filter, edit screens gate: two behaviours to learn |
| C | c1 | Coloured sticky band with monogram; rows drop customer name inside workspace |
| C | c2 | Home read-only, elsewhere count; no unsaved guard; tag opens customer-level editor |
| C | c3 | Same my-customers-only picker; project/service popover works on phone |
| C | c4 | Jump plus pick is two taps; cross-customer triage needs leaving workspace |
| C | c5 | Band costs 100px yet clear; Acknowledge still 26px |
| C | c6 | Picker hides non-covered customers; no problem roll-up |
| C | c7 | Two modes; nav labels change between home and workspace |
| D | c1 | Customer/project fields on every row, panel header; chips weak and clipped at 390 |
| D | c2 | Edit bound to opened row; no outside-incident notice, no unsaved guard |
| D | c3 | All-customer lists browse well; picker still my-customers only |
| D | c4 | One click from list row straight to exact service editor |
| D | c5 | Long cards, clipped +Scope chip, 26px Acknowledge; panel fine |
| D | c6 | Flat long lists at 34; problems sorted first only |
| D | c7 | Lists plus panel; few concepts |
| E-1 | c1 | Three labelled levels always shown; panel band names level and full path |
| E-1 | c2 | Outside-view line, scoped toast with Undo, draft guard; viewer is still an editor |
| E-1 | c3 | Step-by-step browse with badges; all customers listed |
| E-1 | c4 | Phone customer switch takes four taps; laptop one dropdown per level |
| E-1 | c5 | 44px targets; sheet reopens on project step, needs Done |
| E-1 | c6 | Searchable list with open-incident badges; no problems-only filter |
| E-1 | c7 | Three selectors plus outside line, panel, drafts: many parts |
| E-3 | c1 | Sticky Showing line and panel band; levels less explicit than cascade |
| E-3 | c2 | Same guards and outside-view line; viewer is still an editor |
| E-3 | c3 | Lists all customers but flat; Narrow button obscure; favours typing |
| E-3 | c4 | Two taps per switch, Ctrl K; fastest picker |
| E-3 | c5 | Fewest taps, 44px rows; Narrow popover is small |
| E-3 | c6 | Flat 34-row list without problem badges; needs names |
| E-3 | c7 | One search box is simple; rest of E still heavy |
| E-tree | c1 | Bar path plus highlighted tree node; tree collapses to rail under panel |
| E-tree | c2 | Same guards and outside-view line; viewer is still an editor |
| E-tree | c3 | Tree browse without names; other customers collapsed by default |
| E-tree | c4 | Laptop one click on tree; phone three taps per switch |
| E-tree | c5 | Sheet opens on customer step; legend eats a fifth of sheet |
| E-tree | c6 | Only-with-problems toggle, group roll-up badges, name filter |
| E-tree | c7 | Five badge kinds, legend, rail, sheet, outside line: most to learn |

## 페르소나별 최적

- 하은: E-3 (폰에서 2탭 전환, 44px 버튼, 범위 밖 인시던트 안내). E-tree가 근소한 차이로 다음.
- 대타 당번: E-tree (이름을 몰라도 트리로 탐색, 문제 있는 고객만 보기, 편집 중 레벨 표시).

## 메모

- A~D는 같은 선택기를 쓰며 고정·최근·담당 고객만 나열한다. 담당이 아닌 고객은 입력하거나 목록 화면을 거쳐야 한다.
- A~D에는 저장 안 된 편집 보호가 없다. A에서는 고정 칩 한 번 클릭으로 편집 중이던 Orders API 화면이 Mirae Pay 편집기로 바뀌었다.
- B와 D는 필터를 건 상태에서 범위 밖 미확인 인시던트를 알려주지 않는다(하단 배지 숫자만 남음).
- E 세 가지는 목록·패널·보호 장치가 같고 선택기만 다르다. 폰에서 고객 전환은 E-3 2탭, E-tree 3탭, E-1 4탭.
- 모든 후보에서 '누가 호출되는지' 보는 화면이 곧 편집기다. 새벽 3시 폰에서는 읽기 전용 보기가 먼저여야 한다.
- 하은으로 열어도 기본값은 모든 후보에서 '전체 고객'이다.
