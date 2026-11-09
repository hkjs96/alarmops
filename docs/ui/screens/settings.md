# Settings

| 항목 | 내용 |
|---|---|
| 경로 | `/settings/*` (ADMIN) |
| 목적 | MSP 전역 기본값과 표 하나짜리 규칙 관리 |
| 페르소나 | 준호(ADMIN), 민재(읽기) |

## 탭
| 탭 | 내용 | API |
|---|---|---|
| MSP defaults (D-19) | Resource type × metric 표: Code default(읽기) · MSP default(편집) · 고객 덮어쓰기 수 · Off. 편집 전 영향 미리보기("affects 214 alarms in 6 customers; 12 locked by tag") | GET/PUT `/threshold-defaults?level=MSP`, POST `/thresholds/preview` |
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
