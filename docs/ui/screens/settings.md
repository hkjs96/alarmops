# Settings

| 항목 | 내용 |
|---|---|
| 경로 | `/settings/*` (ADMIN) |
| 목적 | MSP 전역 기본값과 표 하나짜리 규칙 관리 |
| 페르소나 | 준호(ADMIN), 민재(읽기) |


## 셸·범위 (D-33, `shell-scope.md`)
- **MSP 전체에 닿는 변경은 이 화면에만 있다**(D-33 ⑧). 다른 화면의 패널에서는 MSP 값을 고칠 수 없고 "Settings →" 링크만 있다.
- 트리 필터를 쓰지 않는다(전 고객 대상). 진입은 오른쪽 위 `Settings`.
- 틀: 값 편집 → 같은 화면 미리보기(영향 고객 `12 of 14 customers`, 제외 고객과 이유) → 확인창 1회 → 감사 기록. 고객 수 표기는 "all 14 customers"(전체)와 "12 of 14 customers"(영향)로 통일. Undo 없음.
- 저장 안 한 편집에서 나가면 같은 가드 창(첫 버튼 `Review and apply…`).
- 주소 `/settings/msp-defaults`, `/settings/severity-mapping`, `/settings/suppression`, `/settings/integrations`, `/settings/users`, `/settings/audit-log`.

## 탭
| 탭 | 내용 | API |
|---|---|---|
| MSP defaults (D-19) | Resource type × metric 표: Code default(읽기) · MSP default(편집) · 고객 덮어쓰기 수 · Off. 같은 화면에 영향 미리보기(`12 of 14 customers`, 제외 고객, 바뀌는 알람, "12 locked by tag") → `Review and apply…` → 확인창 1회 | GET/PUT `/threshold-defaults?level=MSP`, POST `/thresholds/preview` |
| Severity mapping (D-18, D-25) | 표 하나: External value → SEV. 고정 안내 "`sev-1`…`sev-5` are read directly. One table for all sources and customers." `critical` → SEV-2 고정 표시(D-25). 매칭 실패 기본 등급 | GET/PUT `/settings/severity-mapping` |
| Suppression | flapping 창·임계, dedup 창, re-notify 간격 | GET/PUT `/settings/suppression` |
| Integrations | 고객사 횡단 소스 목록 | (미결) |
| Users | 가입 승인, 역할 | GET/PATCH `/users` |
| Audit log | | GET `/audit-logs` |

## 상태
| 상태 | 표시 |
|---|---|
| 검증 | 범위 밖 값 400 → 필드 문구 |
| 충돌 | 409 VERSION_CONFLICT → Reload |

## 미결
- 매핑 실패 기본 등급 SEV-3 vs SEV-5 (Q-DM-08 잔여)
- 억제 정책 고객사별 덮어쓰기(Q-DM-06)
- 역할 체계(Q-DM-02) — Users 탭 구성
