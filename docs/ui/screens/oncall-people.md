# On-call › People (MSP staff)

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/people?p=&b=leave|add` |
| 목적 | 직원 한 명 기준으로: 담당 고객, 지금 어디 당번인지, 다음 당번, 채널 확인 상태. 30+ 고객에서 사람 단위 일괄 작업(D-31 개정). 구 Contacts(직원) 화면을 대체 |
| 페르소나 | 준호(P2-2, P2-4), 하은 |

## 구성
| 영역 | 내용 |
|---|---|
| 직원 표 | Person(휴가 중이면 "leave Nov 20–24") · Customers 수 · On shift now(로테이션) · Next shift · Channels(문제 있는 칩만, 아니면 "all verified"). 검색. "Channels needing action" → Needs action |
| 사람 상세 | On shift now(paged first for N customers), Upcoming shifts 3주(대체 표시), Customers covered · how(템플릿 경유 / 직접 추가 / 로테이션 멤버 / 단계에 이름) + 고객 배지 |
| Leave & replace… | 누가 · 기간 · 대체자 → 미리보기: 요약(고객 수, 이름이 지정된 단계, "everyone" 단계, 로테이션 시프트), 로테이션별 시프트, 고객별 변경 목록("step 2: call Junho → Minjae", "everyone — Junho left out, Minjae already a responder"). Apply → 모든 고객·로테이션에 기간 한정 적용, 감사 기록, 대체자에게 Slack 목록 |
| Add to customers… | 직원 선택, 고객 체크(이미 Responders면 비활성, "Select customers using Infra core"), 고객별 효과("Joins Responders → paged in everyone at 12 min"). 로테이션·지정 단계는 바꾸지 않음 |
| Bulk changes · audit | 누가 언제 어떤 일괄 변경을 몇 고객에 적용했는지 |

## API
GET `/staff?q=` → `{id,name,customerCount,onShift[],nextShift,channels}`; GET `/staff/{id}/coverage`; POST `/staff/{id}/leave/preview` `{from,to,replacementId}` → `{customers[{id,effects[]}], rotations[{id,shifts[]}], totals}`; POST `/staff/{id}/leave` (같은 본문 + `previewHash`, 미리보기 이후 바뀌었으면 409 `PREVIEW_STALE`); DELETE `/leaves/{id}`; POST `/staff/{id}/customers` `{customerIds[]}` (preview 동일 패턴).

## 상태
- 대체자 = 본인이면 Apply 비활성. 영향 0이면 "No step reaches Junho on these dates".
