# 범위 선택 UI 평가 — set3-outsiders

페르소나: 신입 운영자(2일차, 1440, 고객사 이름 모름) · 소연(Daon Retail IT 담당, 포털) · 보안 검토자(저장 시점의 대상·레벨, 범위가 몰래 바뀌는지)

## 순위

- 개념(concept): E-tree > E-1 > E-3 > C > A > D > B
- 현재 목업(as-built): E-1 > E-tree > E-3 > A > D > C > B

## 점수 (개념 / 현재 목업)

| 기준 | A | B | C | D | E-1 | E-3 | E-tree |
|---|---|---|---|---|---|---|---|
| c1 where_am_i | 4 / 4 | 2 / 2 | 4 / 3 | 3 / 2 | 5 / 5 | 4 / 4 | 5 / 4 |
| c2 wrong_scope_safety | 2 / 2 | 3 / 2 | 4 / 3 | 3 / 2 | 5 / 5 | 5 / 5 | 5 / 5 |
| c3 findability | 3 / 2 | 3 / 3 | 3 / 2 | 3 / 3 | 4 / 4 | 3 / 4 | 5 / 5 |
| c4 expert_speed | 4 / 4 | 3 / 3 | 3 / 3 | 4 / 4 | 3 / 3 | 5 / 4 | 4 / 4 |
| c5 phone | 3 / 3 | 2 / 2 | 3 / 2 | 2 / 2 | 4 / 4 | 3 / 3 | 4 / 3 |
| c6 scale | 3 / 2 | 2 / 2 | 3 / 2 | 4 / 3 | 4 / 4 | 4 / 3 | 5 / 4 |
| c7 simplicity | 4 / 4 | 3 / 2 | 4 / 3 | 3 / 3 | 4 / 3 | 4 / 4 | 3 / 2 |
| **합계** | **23 / 21** | **18 / 16** | **24 / 18** | **22 / 19** | **29 / 28** | **28 / 27** | **31 / 27** |

## 과제 결과

### T1 browse: customers, which have problems, Mirae Pay projects/services (1440, no names)

| 후보 | 결과 |
|---|---|
| A | partial: 3 clicks; palette lists only my 12, no problem marks; problems only via Incidents list |
| B | partial: 2 clicks; gate lists all 14 with counts, no problem marks |
| C | partial: 3 clicks; same palette as A; must enter workspace to see projects |
| D | partial: 2 clicks; lists show customer columns, palette hides others, projects by typing |
| E-1 | pass: 2 clicks; dropdown shows 14 with counts and open/problem badges; projects need customer commit (+2) |
| E-3 | partial: 1 click; all 14 with counts, no problem marks; projects need typing |
| E-tree | pass: 1 click expands Mirae Pay in place, filter unchanged; badges + 'Only with problems 5' |

### T2 call order for Hanbit > Fulfilment > Orders API, own or inherited

| 후보 | 결과 |
|---|---|
| A | pass: 3 clicks (Paging, Hanbit row, tree node); 'own' stated as 'Inherits: nothing ... while these own steps exist' |
| B | pass: 3 clicks (Paging, gate card, tree node); same wording |
| C | pass: 3 clicks (On-call now, row, tree node); same wording |
| D | pass: 1 click to see OWN STEPS row, 2 for panel |
| E-1 | pass: 1 click to see OWN STEPS row, 2 for panel 'Editing at service level - own steps' |
| E-3 | pass: 1 click list row, 2 for panel; same as E-1 |
| E-tree | pass: 1 click list row, 2 for panel; tree also marks OWN STEPS |

### T3 create maintenance window for Mirae Pay > Core; scope the screen states

| 후보 | 결과 |
|---|---|
| A | pass: 5 clicks; 'Applies to Mirae Pay > Core - 3 services: Payments API, Settlement, Checkout...'; button 'Create for Core'; no confirm; nothing persisted (toast only) |
| B | pass: 5 clicks; same form and wording as A |
| C | pass: 5 clicks; same form; workspace band names Mirae Pay |
| D | pass: 6 clicks; panel header 'Scope - New maintenance window / Mirae Pay > Core'; same form |
| E-1 | pass: 6 clicks; 'Applies to Mirae Pay > Core - 3 services ... Nothing outside it'; button and confirm name full path; row appears in list |
| E-3 | pass: 6 clicks; identical flow to E-1 |
| E-tree | pass: 6 clicks; identical flow to E-1 |

### T4 5-second test, 5 screens x 1440/390, service scope active

| 후보 | 결과 |
|---|---|
| A | instant 10/10 |
| B | partial: instant 6/10, must search 4/10 (Incidents, Monitoring: only subtitle/filter chip; top pill customer-only); wrong 0 |
| C | instant 10/10 (customer instant; project/service in small dropdown) |
| D | partial: instant 5/10 (1440), must search 5/10 (390: service chip clipped, subtitle only); wrong 0 |
| E-1 | instant 10/10 |
| E-3 | instant 10/10 |
| E-tree | instant 10/10 |

### T5 three ways to make displayed and saved scope differ (Ctrl+K/picker mid-edit, Back/URL edit, change level then save)

| 후보 | 결과 |
|---|---|
| A | fail: mismatch 0/3 but silent retarget 3/3; form jumps to other customer, typed reason reset, no warning |
| B | fail: mismatch 0/3, silent retarget 3/3 |
| C | fail: mismatch 0/3, silent retarget 3/3 (workspace swapped under the form) |
| D | fail: mismatch 0/3, silent retarget 3/3 (Ctrl+K works behind the open panel) |
| E-1 | pass: mismatch 0/3, silent retarget 0/3; scope-named unsaved dialog, URL edit opens fresh empty form |
| E-3 | pass: 0/3, 0/3; plus ambiguous search selects nothing |
| E-tree | pass: 0/3, 0/3; tree click behind panel raises the same dialog |

### T6 Soyeon portal: other customer's name, count or incident

| 후보 | 결과 |
|---|---|
| A | fail (no portal mode; judged): 4 leak points if locked - outside-scope count, pinned strip, palette, 'of 14' tile |
| B | fail (no portal mode; judged): 3 leak points - gate list, palette, 'of 14' tile |
| C | partial (no portal mode; judged): structure fits a locked customer; 3 controls to strip - other-customers count, Switch, All customers |
| D | fail (no portal mode; judged): 4 leak points - removable customer chip, customer columns, palette, My customers count |
| E-1 | pass: 0 leaks on 5 screens + picker; 7 URL attempts all 'Not found' |
| E-3 | pass: 0 leaks; 7 URL attempts 'Not found' |
| E-tree | pass: 0 leaks at 1440 and 390; tree shows only Daon Retail; 7 URL attempts 'Not found' |

## 페르소나별 최적

| 페르소나 | 후보 |
|---|---|
| 신입 운영자 | E-tree |
| 소연 | E-tree (portal identical across E pickers; among A-D only C's structure fits) |
| 보안 검토자 | E-1 (same guards as all E, plus labelled levels) |

## 근거 5줄

1. E 계열만 편집 범위를 목록 필터와 분리했다. 새 창은 아무것도 미리 선택되지 않은 3단계로 고르고, 저장 전에 대상 서비스 목록을 확인받는다.
2. A~D는 저장 폼이 전역 범위를 그대로 따라간다. 폼을 연 채 Ctrl+K·뒤로가기·URL 수정을 하면 경고 없이 다른 고객사로 대상이 바뀐다(3/3 재현).
3. 이름을 모르는 신입에게는 E-tree가 유일하게 필터를 바꾸지 않고 펼쳐 볼 수 있고, 문제 있는 고객사만 보기(5곳)가 있다. A·C·D의 검색창은 34곳 중 내 담당 12곳만 나열한다.
4. 포털은 E에서 5개 화면·선택기·URL 7종 모두 다른 고객사 이름·건수·장애가 0건이었다. A~D는 포털 모드가 없어 구조로만 판단했고, C만 잠금에 맞는다.
5. E-tree는 개념 1위지만 범례 6종·배지·배너로 가장 복잡하고 390px에서 범례가 시트를 가린다. 현재 목업 기준으로는 E-1이 1점 앞선다.

## 한계

- A~D의 저장은 토스트뿐이고 목록에 반영되지 않아, 저장된 범위는 토스트 문구로 판단했다.
- E-1·E-3·E-tree는 셸·패널·가드·포털이 같아 c2 동점은 실제 동점이다.
- 390px의 편집 패널은 간단히만 확인했다. E-2 Tree는 채점 대상이 아니다.
