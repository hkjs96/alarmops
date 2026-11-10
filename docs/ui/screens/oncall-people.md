# People (구 On-call › People + 고객 사람)

| 항목 | 내용 |
|---|---|
| 경로 | `/people` (메뉴), 필터 `?customer=&project=&service=` · `?mine=1`. 사람 패널: 고객 사람 `/c/<customer>/people/<slug>`, 직원 `/people/<slug>`. 일괄 `/people?b=leave\|add` |
| 목적 | 직원과 고객 사람을 표 하나로(D-29 개정). 범위를 고르면 그 범위에서 호출·알림 받는 사람. 직원 한 명 기준으로: 담당 고객, 지금 어디 당번인지, 다음 당번, 채널 확인 상태. 30+ 고객에서 사람 단위 일괄 작업(D-31 개정). 구 Contacts(직원) 화면을 대체 |
| 페르소나 | 준호(P2-2, P2-4), 하은 |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 트리 필터 | 적용. 필터가 없으면 전 직원 + 전 고객 사람. 고객·프로젝트·서비스를 고르면 **그 범위에서 호출되거나 알림 받는 사람 전부**(직원 포함). 상위에서 물려받은 사람은 `from Mirae Pay`. 호출 순서 패널의 `Paged · Also notified`와 같은 계산 |
| 사람 패널 | **읽기 먼저**: 역할, Belongs to(고객 사람은 그 고객에만), Notified for, Paging 설명, Contact(가린 값), 채널 칩. 버튼 `Edit <이름> for <고객>` → 편집 → `Save <이름> for <고객>`: 바로 적용 + `Undo` |
| 직원 패널 | 읽기만: "Belongs to the MSP, not one customer", Responder for · n(고객 목록 → 그 고객의 호출 순서 패널) |
| 연락처 열람 (D-35) | 가린 값이 기본. `Reveal`은 그 고객의 Responder에게만 보이고, 누르면 값 + "logged". Responder가 아닌 MSP ADMIN에게는 `Reveal (emergency)…` → 사유 입력(필수) → 값 + "Emergency reveal · logged · <주 Responder> notified". 그 밖의 직원은 버튼 없음. POST `/contacts/{id}/reveal` `{channel, reason?}`, 사유 없으면 422 `EMERGENCY_REASON_REQUIRED`. 세부: `shell-scope.md` §4 |
| `Add person` | 범위 먼저: 1 고객 → 2 범위(고객 전체 / 프로젝트 / 서비스) → 3 내용(이름 필수). 버튼 `Add person to <전체 경로>` |
| 일괄 작업 | Leave & replace, Add to customers는 여러 고객에 닿는다 → 영향 미리보기 → 확인 → 감사 기록(D-33 ⑧과 같은 틀). 트리 필터와 무관하게 전 고객 대상 |
| 열 우선순위 | Person, 경로, Channels needing action은 끝까지. Role·Contact → Kind 순으로 숨김, 500px 미만 카드 |

## 구성
| 영역 | 내용 |
|---|---|
| 사람 표 (하나) | Person(휴가 중이면 "leave Nov 20–24") · **Kind**(Staff / Customer) · Role · `고객 › 프로젝트 › 서비스`(Notified for; 직원은 담당 고객 수) · 호출·알림 이유(`Paged · step 2 at 10 min · from Mirae Pay`) · Contact(가린 값) · Channels needing action. 필터가 없으면 직원 행에 On shift now · Next shift. 검색. "Channels needing action" → Needs action |
| 사람 상세 | On shift now(paged first for N customers), Upcoming shifts 3주(대체 표시), Customers covered · how(템플릿 경유 / 직접 추가 / 로테이션 멤버 / 단계에 이름) + 고객 배지 |
| Leave & replace… | 누가 · 기간 · 대체자 → 미리보기: 요약(고객 수, 이름이 지정된 단계, "everyone" 단계, 로테이션 시프트), 로테이션별 시프트, 고객별 변경 목록("step 2: call Junho → Minjae", "everyone — Junho left out, Minjae already a responder"). Apply → 모든 고객·로테이션에 기간 한정 적용, 감사 기록, 대체자에게 Slack 목록 |
| Add to customers… | 직원 선택, 고객 체크(이미 Responders면 비활성, "Select customers using Infra core"), 고객별 효과("Joins Responders → paged in everyone at 12 min"). 로테이션·지정 단계는 바꾸지 않음 |
| Bulk changes · audit | 누가 언제 어떤 일괄 변경을 몇 고객에 적용했는지 |

## API
GET `/staff?q=` → `{id,name,customerCount,onShift[],nextShift,channels}`; GET `/staff/{id}/coverage`; POST `/staff/{id}/leave/preview` `{from,to,replacementId}` → `{customers[{id,effects[]}], rotations[{id,shifts[]}], totals}`; POST `/staff/{id}/leave` (같은 본문 + `previewHash`, 미리보기 이후 바뀌었으면 409 `PREVIEW_STALE`); DELETE `/leaves/{id}`; POST `/staff/{id}/customers` `{customerIds[]}` (preview 동일 패턴).

## 상태
- 대체자 = 본인이면 Apply 비활성. 영향 0이면 "No step reaches Junho on these dates".

## v4 점검 반영 (2026-11-09)
- Leave & replace: 입력은 첫/마지막 휴가일, 대체는 교대 경계(09:00 인계)로 계산. 예: Fri 20–Tue 24 → Thu 19 09:00 → Wed 25 09:00. 넘겨받는 교대를 정확한 시각으로 나열, 주간 로테이션은 부분 구간과 복귀 시각 표시.
- 경고: everyone 인원 축소(N → N-1, 대체자가 이미 Responder), 단계가 유일한 호출 가능자를 잃음(대체자에게 해당 채널 미검증 또는 everyone에 검증 채널 0).
- 직원 상세의 Customers covered 목록은 스크롤 없이 전부 표시("12 listed"), 헤더 수와 일치.
