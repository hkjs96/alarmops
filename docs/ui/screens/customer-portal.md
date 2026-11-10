# Customer portal

| 항목 | 내용 |
|---|---|
| 경로 | `portal.<host>/…` — 콘솔과 **같은 셸을 한 고객에 잠근 것**(D-33). 주소에 `/c/<customer>`가 없다: 목록 `/<screen>?project=<slug>&service=<slug>`, 패널 `/<project>/<service>/<screen>`(인시던트는 `/<project>/<service>/incident/<id>`) |
| 목적 | 고객사 담당자가 자기 회사 상태를 쉬운 말로 확인. 다른 고객사의 이름·사람·알림이 어디에도 없음 |
| 페르소나 | 소연 P3-1, P3-2, P3-3 |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 트리 | 그 고객 하나(루트·`My customers` 묶음·`Only with problems` 없음). 프로젝트 › 서비스만 고른다. 시트는 2단계부터 |
| 필터 줄 | 고객은 잠김: `Showing: › Commerce × › All services`. `Outside this view`는 자기 고객 안에서만 센다 |
| 표식 | 열린 인시던트 수, `OWN STEPS`만. 호출 문제 표식(MSP 내부)은 없다 |
| 패널 | 읽기 화면만. `Edit`·`Save`·넓히기 없음, "Managed by your MSP. You can see this, and your MSP changes it." |
| 쓰기 | grant가 있는 것만: Maintenance `New window`(silences, 범위는 프로젝트·서비스부터), 자기 회사 연락처(contacts) |
| 연락처 | 자기 고객 사람의 값만. MSP 직원은 이름만("Reach them through your MSP") |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | 로고 + "<고객> portal", 메뉴 Incidents · Monitoring · Call order · People · Maintenance(grant 없는 것은 숨김), "Signed in as …" |
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
| 오류 | 없는 ID와 남의 고객 ID는 **글자 하나 다르지 않은 "Not found"**. 주소는 친 그대로 남는다. API도 본문·상태 코드가 같다(API-CONTRACT §2) |

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
