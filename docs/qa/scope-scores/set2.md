# 범위 전환 시안 평가 — set2-ops

페르소나: 준호(MSP 운영 리드, 34곳 중 12곳 담당, 1440·1280, 키보드 위주), 민재(알람 운영자, 1440, 임계값). 목업에 민재 전환이 없어 T5·T6은 준호 계정으로 수행했다. 휴대폰(390)은 간단히만 확인했다.

## 순위

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| 개념 | E-tree | E-1 | E-3 | D | C | A | B |
| 현재 목업 | E-tree | E-1 | E-3 | C | A | D | B |

## 점수 (개념 / 현재 목업)

| 기준 | A | B | C | D | E-1 | E-3 | E-tree |
|---|---|---|---|---|---|---|---|
| c1 위치 인지 | 4 / 4 | 3 / 3 | 5 / 4 | 4 / 3 | 5 / 4 | 4 / 4 | 4 / 4 |
| c2 오범위 안전 | 3 / 2 | 4 / 3 | 4 / 3 | 4 / 2 | 5 / 5 | 5 / 4 | 5 / 5 |
| c3 찾기 | 3 / 3 | 3 / 3 | 3 / 3 | 3 / 3 | 4 / 4 | 3 / 3 | 5 / 5 |
| c4 숙련 속도 | 4 / 2 | 3 / 2 | 3 / 2 | 4 / 2 | 4 / 4 | 4 / 4 | 5 / 4 |
| c5 휴대폰 | 3 / 2 | 3 / 2 | 4 / 3 | 4 / 3 | 5 / 5 | 4 / 4 | 5 / 5 |
| c6 규모 | 3 / 3 | 2 / 2 | 3 / 3 | 4 / 3 | 4 / 4 | 4 / 4 | 5 / 5 |
| c7 단순함 | 4 / 4 | 3 / 3 | 3 / 3 | 4 / 4 | 3 / 3 | 4 / 3 | 3 / 2 |
| **합계** | **24 / 20** | **21 / 18** | **25 / 21** | **27 / 20** | **30 / 29** | **28 / 26** | **32 / 30** |

## 과제 결과

### T1 edit call-order timing Mirae, Daon, Hanbit in a row; try wrong-customer save

| 시안 | 결과 |
|---|---|
| A | partial - 5 keys + 19 Tab per switch (mouse 3 clicks); save Tab,Tab,Enter; wrong-customer save impossible but unsaved value dropped silently |
| B | partial - 5 keys + 20 Tab; same silent drop |
| C | partial - 5 keys + 19 Tab; same silent drop |
| D | fail (keyboard) - rows not focusable in 120 Tabs; mouse 3 clicks (Close, row, field); scrim click drops edit |
| E-1 | pass - 2-3 keys (Esc/Tab/Enter) or 7 via Ctrl+K; mouse 1 click; save Ctrl+Enter x2; guard blocks wrong customer |
| E-3 | pass - same 2-3 / 7 keys; mouse 1 click; guard blocks |
| E-tree | pass - same keys; mouse 1 click on row or tree; guard blocks |

### T2 start Mirae edit, leave for Daon incident, come back

| 시안 | 결과 |
|---|---|
| A | fail - edit lost on switch, no warning |
| B | fail - edit lost, no warning |
| C | fail - edit lost, no warning |
| D | fail - edit lost when Ctrl+K opens or scrim clicked |
| E-1 | pass - dialog (Save/Keep draft/Discard/Cancel), draft banner + Resume, survives reload, Daon panel shows Daon values |
| E-3 | pass - same |
| E-tree | pass - same; 'Different customer than your list filter' warning on resume |

### T3 morning check across 34: open incidents, problem customers, active maintenance

| 시안 | 결과 |
|---|---|
| A | pass - 3 screens; 4 of 34 affected tile; no per-customer problem list |
| B | fail - maintenance and paging show nothing until one customer chosen |
| C | partial - home lists read-only, must enter workspace to act |
| D | pass - 3 screens, customer columns; no problem-customer filter |
| E-1 | pass - lists + badges inside dropdown (1 click to see) |
| E-3 | partial - lists only; picker shows no problem signals |
| E-tree | pass - 'Only with problems' cuts 34 to 5 in 1 click on any screen |

### T4 deep link Mirae Pay > Core call order; reload; back/forward

| 시안 | 결과 |
|---|---|
| A | pass - ?customer=mirae&project=core; reload/back/forward keep state |
| B | pass - same |
| C | pass - /c/mirae/paging?project=core |
| D | partial - Core filter lists only the customer row and opens customer-level editor; Core reachable only via in-panel tree |
| E-1 | pass - /c/mirae/core/paging?filter=...; reload/back/forward OK; URL carries two scopes |
| E-3 | pass - same |
| E-tree | pass - same |

### T5 find threshold problems across customers, change default for Mirae only

| 시안 | 결과 |
|---|---|
| A | partial - Needs review tile, no filter; inline card says 'Mirae Pay, 4 of 6 alarms'; preview is a toast |
| B | partial - same card; toast preview |
| C | partial - same card inside workspace; toast preview |
| D | partial - panel names Mirae; toast preview |
| E-1 | pass - Needs review chip; live diff names alarms; confirm lists 2 changed, 1 kept |
| E-3 | pass - same panel; finding relies on list chips only |
| E-tree | pass - REVIEW badges in tree lead straight to customers; same panel |

### T6 with project Core selected, change defaults: is customer-wide effect clear

| 시안 | 결과 |
|---|---|
| A | partial - 'Scope note' is 4th line of a blue box, cites D-19; form still editable inline |
| B | partial - same note |
| C | partial - same note |
| D | partial - note says no project layer but not that Core chip is only a filter |
| E-1 | pass - headline 'This changes all of Mirae Pay, not only Core.' and repeated in confirm |
| E-3 | pass - same |
| E-tree | pass - same |

### T7 at 1280 with edit open: is the list usable

| 시안 | 결과 |
|---|---|
| A | partial - editor replaces the list; no list while editing |
| B | partial - no list while editing |
| C | partial - no list while editing |
| D | fail - list dimmed, 3 of 6 columns covered, rows not clickable |
| E-1 | pass - 630px list, 3 columns, rows clickable |
| E-3 | pass - 630px list, 3 columns, rows clickable |
| E-tree | pass - tree auto-collapses to rail, 597px list, rows clickable |

## 점수 근거

| 시안 | 기준 | 근거 |
|---|---|---|
| A | c1 | Scope bar plus 'Save for Mirae Pay' label; always visible, far from form |
| A | c2 | Sticky scope; MSP defaults editable inline at All; unsaved edit silently dropped |
| A | c3 | Ctrl+K palette and cascading segments; no problem badges to browse by |
| A | c4 | 5 keys to switch, then focus lost: 19 Tabs; no save shortcut |
| A | c5 | Bar collapses to one row; 28-34px targets |
| A | c6 | All-customer lists work; flat 34-item palette; overview sorts problems first |
| A | c7 | One concept: a global bar; pins add little |
| B | c1 | Customer select top-right plus scope box plus chip: three places to read |
| B | c2 | Gate blocks unscoped edits; no outside-scope warning; edits silently dropped |
| B | c3 | Gate cards browse well but carry no problem signals |
| B | c4 | Gate adds a step when unscoped; 20 Tabs after switching |
| B | c5 | Card gate fits phone; small targets |
| B | c6 | Maintenance and call order hidden until one customer chosen; no cross-customer view |
| B | c7 | Some screens gated, some not; rule is not obvious |
| C | c1 | Coloured workspace band, monogram, /c/mirae URL; project level is a small dropdown |
| C | c2 | Workspace isolates; 'open in other customers' shown; no dirty guard, silent discard |
| C | c3 | Enter via palette or pins; home lists help; no badges |
| C | c4 | Mode switch for cross-customer work; 19 Tabs after Ctrl+K switch |
| C | c5 | Workspace header reads well at 390; small targets |
| C | c6 | Read-only home lists cover 34; no problem-customer shortcut |
| C | c7 | Two modes with different nav labels (On-call now vs Paging) |
| D | c1 | Rows name customer; panel title names scope but small, covers chrome |
| D | c2 | Core filter shows only customer row; scrim click discards edit; no outside warning |
| D | c3 | Every customer visible as rows; scope chip via Ctrl+K |
| D | c4 | Row to editor in one click; rows not keyboard-focusable; modal panel |
| D | c5 | Full-screen panel works; small chips |
| D | c6 | Lists scale with chips; long ungrouped 34+ rows; modal blocks list |
| D | c7 | List, chips, panel: few concepts |
| E-1 | c1 | Three labelled levels always shown; panel band names edited level; filter vs panel differ |
| E-1 | c2 | Dirty guard, per-scope drafts, before/after confirm, mismatch warning, MSP in Settings |
| E-1 | c3 | Dropdowns with search and problem badges; browse step by step |
| E-1 | c4 | Row-to-row 2-3 keys, Ctrl+Enter twice; deep scope needs three dropdowns |
| E-1 | c5 | Stepped sheet, 44px targets, badges, full-screen editor |
| E-1 | c6 | My/Other groups and badges, but only after opening the dropdown |
| E-1 | c7 | Filter vs panel scope, drafts, outside-view line, two-scope URL |
| E-3 | c1 | Single segment until scoped; panel band carries level |
| E-3 | c2 | Same guards as E; Enter-on-first-match slip; levels hidden while unscoped |
| E-3 | c3 | Search needs names; flat list without problem badges |
| E-3 | c4 | Ctrl+K 3 chars Enter Tab Enter = 7 keys; row-to-row 2-3 |
| E-3 | c5 | Search sheet with 44px rows; typing on phone, no badges |
| E-3 | c6 | Lists and My-customers chip scale; picker gives no problem overview |
| E-3 | c7 | Fewest picker parts in E; still drafts and two-scope URL |
| E-tree | c1 | Tree highlight plus bar plus panel band; tree collapses at 1280 with panel |
| E-tree | c2 | Same guards; tree shows level and own-settings before you open anything |
| E-tree | c3 | Persistent tree, find-by-name, only-with-problems; browse without names |
| E-tree | c4 | One-click or 2-3 key switch; list squeezed to 530px at 1440 with panel |
| E-tree | c5 | Falls back to stepped sheet; 44px targets |
| E-tree | c6 | My 12 / Other 22 groups, problems-only 34 to 5, badges on every screen |
| E-tree | c7 | Tree, five badge types, legend, bar, panel, drafts: dense first sight |

## 페르소나별 최적

- 준호: E-tree. 키보드만 쓰면 E-3도 거의 같다.
- 민재: E-tree. 트리의 REVIEW 표시가 문제 고객으로 바로 이어진다.

## 핵심 관찰

- A~D는 저장하지 않은 편집을 고객 전환 시 경고 없이 버린다. E만 확인 창과 범위별 임시 저장이 있다.
- A~C는 Ctrl+K 전환 뒤 포커스가 본문으로 떨어져 입력란까지 Tab 19~20회가 필요하다. D는 목록 행에 키보드로 갈 수 없다.
- B는 고객을 고르기 전까지 유지보수·호출 순서 화면이 비어 34곳 아침 점검이 안 된다.
- D는 Core로 좁혀도 고객 행만 나오고, 그 행을 열면 고객 전체를 편집한다.
- E는 저장마다 Ctrl+Enter를 두 번 눌러야 하고, URL에 범위가 두 개(패널 경로와 ?filter=) 들어간다.
- E-tree는 1440에서 패널을 열면 목록이 530px로 줄고, 1280에서는 트리가 접힌다.
