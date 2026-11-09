# Contacts (MSP staff) — D-29

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/contacts` |
| 목적 | MSP 직원(페이징 대상)만, 팀별로 묶어 채널(Slack·Email·SMS·Voice) 확인 상태를 보고 링크 발송·수동 확인 |
| 페르소나 | 준호(온보딩 4단계 포함), 하은 |
| 범위 밖 | 고객 담당자 → Customer 상세 › People(`customers.md`). 고객 횡단 할 일은 Customers 목록 카드 |

## Needs action 정의 (모든 화면 공통)
- 사람 단위로 센다: 확인 안 된 채널(not verified · link sent · link expired · not set)이 **하나라도 있는 사람**.
- 샘플: 직원 4(Junho, Sora, Dohyun, Eunji) + 고객 7(Mirae Pay 2 · Daon Retail 3 · Hanbit Logistics 2) = 11. Contacts 탭 배지 4, Customers 카드 7, Mirae Pay People 배지 2가 모두 같은 정의.
- **not set**은 링크로 못 고침 → 동작 "Ask to add <채널>"(직원: Slack에서 찾기 / 고객: 추가 요청 메일). 일괄 링크 수에서 제외.

## 레이아웃
| 영역 | 내용 |
|---|---|
| 배너 | "11 people need action: 4 staff (below) and 7 customer contacts (…)" + 정의 + **Open the full list** → Needs action |
| 도구줄 | 상태 칩 Needs action n / All staff n, 팀 선택, 채널 선택, 이름 검색 |
| 목록 | 한 목록(팀 카드 없음): 체크박스 · 이름·직무 · Staff + 팀 이름(여러 팀이면 쉼표) · 채널 칩 · 동작. 위에 일괄 바: 전체 선택, "Send n links to selected", "Ask to add n missing" |
| 안내 | "Unverified channels still receive pages."(Q-DM-16 결정 전) |

## Needs action 화면 (`/oncall/contacts/needs-action`)
- 직원·고객 통합, 칩 All/Staff/Customer, 채널·고객 필터, 검색, 일괄 선택. 고객 행의 범위는 Customer › People 해당 노드로 링크.
- 진입: Contacts 배너, Customers 목록 카드("Open list · send links", Customer 필터로 열림).

## 규모(50명+)
- 검색 + 팀/채널/상태 필터 + 일괄 선택. 기본 필터 Needs action.

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | 직원 없음 → "Add staff" |
| 할 일 없음 | Needs action 0 → "All channels verified" 한 줄 + All 보기 |
| 발송 후 | 칩 "SMS link sent · expires in 24h" |
| 오류 | 발송 실패 → 칩 ▲ + 사유 |

## 동작 → API
| 동작 | API |
|---|---|
| 목록 | GET `/contacts?kind=INTERNAL&needsAction=true&teamId=&channel=&q=` |
| 추가 / 수정 | POST `/contacts` `{kind:"INTERNAL"}`, PATCH `/contacts/{id}` |
| 링크 / 수동 | POST `/contacts/{id}/verify` `{channel, method: link|manual, note}` |
| 일괄 링크 | POST `/contacts/verify-bulk` `{contactIds[]}` → `{sent, notSet[]}` · 통합 목록 GET `/contacts/needs-action` |
| 수신자 확인 | GET `/verify/{token}` (세션 없음) |

## 미결
- 미확인 채널 발송 차단 여부(Q-DM-16)
- 연락처 단위 테스트 발송 엔드포인트(현재 채널 테스트만)
