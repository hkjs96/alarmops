# Customer portal

| 항목 | 내용 |
|---|---|
| 경로 | `/portal` (별도 셸, 콘솔 메뉴 없음) |
| 목적 | 고객사 담당자가 자기 회사 상태를 쉬운 말로 확인. 다른 고객사의 이름·사람·알림이 어디에도 없음 |
| 페르소나 | 소연 P3-1, P3-2, P3-3 |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | 고객사 이름(선택기 없음), "Operated by {MSP}", 사용자 메뉴 |
| 상태 요약 | 한 문장: "1 issue is being handled. Haeun from your MSP acknowledged it 4 minutes ago." |
| 진행 중 | 인시던트 카드: 쉬운 제목, 영향 서비스, 단계(Detected → Acknowledged → Resolved), 담당(MSP 쪽은 이름만), 통지 여부("We notified you by email at 03:14") |
| 최근 30일 | 해소된 목록, 평균 확인 시간 |
| Contacts (grant) | 우리 회사 연락처·확인 상태 |
| Maintenance (grant) | 점검 창 생성(D-17 안내 동일) |

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | "All systems normal. No open issues." |
| 권한 없음 | grant 없는 메뉴는 숨김(비활성 아님) |
| 오류 | 범위 밖 = "Not found" |

## 동작 → API
| 동작 | API |
|---|---|
| 목록 / 상세 | GET `/incidents` / `/incidents/{id}` (서버가 세션 customerId 강제) |
| 통지 이력 | GET `/incidents/{id}/notifications` (고객 쪽 수신만) |
| 연락처 | GET/POST `/contacts`, POST `/contacts/{id}/verify` (P contacts) |
| 점검 창 | GET/POST `/maintenance-windows`, `/revoke` (P silences) |

## 미결
- 포털 API 경로 분리(Q-API-07)
- "쉬운 말" 제목 생성 규칙(리소스 이름 → 서비스 이름 매핑)
- MSP 담당자 이름 노출 범위(이름만 vs 팀명)
- 포털에서 Ack 불가(R4-3) — 버튼 자체를 두지 않음
