# Channel verification (Contacts)

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/contacts` |
| 목적 | 연락처별 Slack·Email·SMS 확인 상태를 보고, 확인 링크 발송 또는 수동 확인 |
| 페르소나 | 준호(온보딩 4단계 포함), 소연(grant `contacts`, 포털) |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 요약 | "18 of 24 channels verified", 미확인만 보기 |
| 표 | Contact · Customer · Slack · Email · Phone(SMS/Voice). 각 셀: ✓ Verified(via, 날짜) / ○ Unverified / – Not set / ▲ Link expired |
| 셀 동작 | Send link · Mark verified(메모 필수) · Test message |
| 안내 | "Unverified channels still receive pages."(R9-3, Q-DM-16 결정 전) |

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | 연락처 없음 → "Add contact" |
| 발송 후 | 셀에 "Link sent 14:02 · expires in 24h" |
| 오류 | 발송 실패 → 셀 ▲ + 사유 |

## 동작 → API
| 동작 | API |
|---|---|
| 목록 / 수정 | GET/POST `/contacts`, PATCH `/contacts/{id}` |
| 링크 / 수동 | POST `/contacts/{id}/verify` `{channel, method: link|manual, note}` |
| 수신자 확인 | GET `/verify/{token}` (세션 없음) |
| 채널 테스트 | POST `/notification-channels/{id}/test` |

## 미결
- 미확인 채널로 문자·음성 발송을 막을지(Q-DM-16)
- 연락처 단위 테스트 발송 엔드포인트 없음(채널 테스트만 있음)
