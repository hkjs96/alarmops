# Maintenance windows

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/maintenance` (포털 `/portal/maintenance`) |
| 목적 | 점검 창 생성·해제. 모든 소스 같은 규칙: SEV-1은 울림, SEV-2 이하 묵음(D-17) |
| 페르소나 | 준호, 민재, 소연(grant `silences`) |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 고정 안내 | "SEV-1 alerts always page, even during maintenance. SEV-2 to SEV-5 are muted (still recorded)." — 끌 수 없음, "Include SEV-1" 옵션 없음 |
| 탭 | Active · Scheduled · Ended |
| 표 | Scope(Customer › Service / Account / Resource type / Alert) · Window(KST, 길이) · Reason · Created by · Muted so far n · Revoke |
| 생성 드로어 | Scope 선택, 시작·끝(최대 30일, 과거 거절), 이유(200자), 영향 미리보기(현재 열린 인시던트 중 묵음 대상 수) |

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | "No active maintenance windows." |
| 오류 | 400(30일 초과, 과거) → 필드 아래 문구 |

## 동작 → API
| 동작 | API |
|---|---|
| 목록 / 생성 | GET/POST `/maintenance-windows` |
| 해제 | POST `/maintenance-windows/{id}/revoke` |

## 미결
- 범위 축(Q-DM-07): 계정·리소스 타입·알림 단위 포함 여부
- 영향 미리보기 엔드포인트 없음
- 점검 종료 후 묵음된 알림 요약 표시 위치
