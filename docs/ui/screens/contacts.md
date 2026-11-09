# Contacts (MSP staff) — D-29

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/contacts` |
| 목적 | MSP 직원(페이징 대상)만, 팀별로 묶어 채널(Slack·Email·SMS·Voice) 확인 상태를 보고 링크 발송·수동 확인 |
| 페르소나 | 준호(온보딩 4단계 포함), 하은 |
| 범위 밖 | 고객 담당자 → Customer 상세 › People(`customers.md`). 고객 횡단 할 일은 Customers 목록 카드 |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | "Send links to all unverified (n)"(일괄), 주 버튼 "Add staff" |
| 고객 연락처 배너 | "7 customer contacts need action across 3 customers" → Customers 목록 카드로 이동 |
| 필터 | 기본 **Needs action**(미확인·만료·미설정이 하나라도 있는 사람) + 수, 보조 **All** + 수. 이름 검색(입력 시 All로 전환). 요약 "26 of 32 channels verified" |
| 팀 그룹 | 팀마다 접을 수 있는 카드(Infra team 6, Data team 2). 헤더에 인원·"n need action". Needs action일 때 확인 끝난 사람은 "3 fully verified people hidden · Show all"로 접힘 |
| 사람 행 | 이름·직무, 소속 팀 배지(여러 팀이면 각 팀 그룹에 반복 표시), 채널 4개 칩: ✓ Verified / ○ Unverified / ○ Link sent(파랑, 만료 시각) / ▲ Expired / – Not set, 동작(Send link · Resend · Mark verified… · Look up in Slack · Test) |
| 안내 | "Unverified channels still receive pages."(Q-DM-16 결정 전) |

## 규모(50명+)
- 팀 그룹 + 접기 + 검색으로 충분, 기본 페이지네이션 없음. 기본 필터가 Needs action이라 평소엔 몇 줄만 보인다.

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
| 목록 | GET `/contacts?kind=INTERNAL&groupBy=team&needsAction=true` |
| 추가 / 수정 | POST `/contacts` `{kind:"INTERNAL"}`, PATCH `/contacts/{id}` |
| 링크 / 수동 | POST `/contacts/{id}/verify` `{channel, method: link|manual, note}` |
| 일괄 링크 | POST `/contacts/verify-bulk` `{kind:"INTERNAL", filter:"unverified"}` |
| 수신자 확인 | GET `/verify/{token}` (세션 없음) |

## 미결
- 미확인 채널 발송 차단 여부(Q-DM-16)
- 연락처 단위 테스트 발송 엔드포인트(현재 채널 테스트만)
