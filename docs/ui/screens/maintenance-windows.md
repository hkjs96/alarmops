# Maintenance windows

| 항목 | 내용 |
|---|---|
| 경로 | `/maintenance` (메뉴, D-26 개정), 필터 `?customer=&project=&service=` · `?mine=1`. 창 패널 `/c/<c>[/<p>[/<s>]]/maintenance/<id>`, 생성 `/c/<c>[/<p>[/<s>]]/maintenance/new` |
| 목적 | 점검 창 생성·해제. 모든 소스 같은 규칙: SEV-1은 울림, SEV-2 이하 묵음(D-17) |
| 페르소나 | 준호, 민재, 소연(grant `silences`) |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 트리 필터 | 적용. 필터 범위와 겹치는 창(상위·하위 포함)을 보여 준다 |
| 창 패널 | 읽기: Applies to(전체 경로 + 서비스 수, "Nothing outside it"), Mutes, Window, Created by, Muted so far. 동작은 `Revoke window for <전체 경로>…` + 확인 |
| 저장 | `Create window for <전체 경로>`. 서비스 둘 이상을 묵음하면 확인창(시간대·사유·대상 서비스 목록), 서비스 하나면 바로 + `Undo` |
| 범위 축 | 시안의 범위는 고객 › 프로젝트 › 서비스다. 계정·리소스 타입·알림 단위(Q-DM-07)는 미결 그대로 |
| 열 우선순위 | Status, 경로, Window는 끝까지. By·Muted → Reason 순으로 숨김, 500px 미만 카드 |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 고정 안내 | "SEV-1 alerts always page, even during maintenance. SEV-2 to SEV-5 are muted (still recorded)." — 끌 수 없음, "Include SEV-1" 옵션 없음 |
| 탭 | Active · Scheduled · Ended |
| 표 | Status · `고객 › 프로젝트 › 서비스` · Window(KST, 길이) · Reason · Created by · Muted so far n · Revoke |
| 생성 패널 (`New window`) | **범위 먼저**: 1 고객 → 2 범위(고객 전체 / 프로젝트 / 서비스, 미리 선택 없음; 목록 필터는 "Use exactly this · go to step 3" 제안) → 3 시작·끝(최대 30일, 과거 거절), 이유(필수, 200자), `Applies to` · `When` · `Mutes`(지금 묵음될 열린 인시던트 수, SEV-1은 계속 호출) · `Already here`(같은 범위의 기존 창) |

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
