# Resource detail

| 항목 | 내용 |
|---|---|
| 경로 | `/monitoring/resources/{base64url id}` (9-4) |
| 목적 | 지표별 임계치와 출처 4층(D-19) 확인, 바꾸기 전 영향 미리보기, 드리프트 복원/수용, 이력 |
| 페르소나 | 민재 P4-3, P4-5 |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 히어로 | 이름, 타입, ARN(복사), customer › account › region, Monitoring 상태(Needs review면 노란 배너 + 동작) |
| Thresholds 표 | Metric · Effective value · Source 배지 · 층 보기(CODE → MSP → CUSTOMER → CONSOLE/TAG, 이긴 층 굵게, 진 층 취소선) · M/N + 출처 · Sev · Edit |
| 잠금 | 출처 TAG면 Edit 비활성 + "Set by resource tag `Threshold_CPU=85`. Change the tag in your IaC." (409 TAG_WINS) |
| 편집 드로어 | 새 값, M/N(1 ≤ M ≤ N ≤ 10, SEV-1·period≥3600은 잠김), 이유, 미리보기 결과 → Apply |
| Alarms | ManagedAlarm 행: 이름, 상태, Drift(Expected vs Actual, 바꾼 주체) + Restore / Accept |
| Tags | 마지막으로 읽은 태그 사본(읽기 전용, D-08) |
| History | ThresholdChange: 시각 · 누가(USER/SYSTEM/EXTERNAL) · 필드 · old → new · 적용 상태(PENDING/APPLIED/FAILED/SKIPPED_TAG_WINS) |

## 상태
| 상태 | 표시 |
|---|---|
| 로딩 | 표 스켈레톤 |
| 적용 대기 | 행에 "Applying…" (PENDING), 완료 시 APPLIED |
| 오류 | AlarmWriter 없음 → Edit 비활성 + 이유. FAILED → 오류 메시지 + Retry |

## 동작 → API
| 동작 | API |
|---|---|
| 상세 | GET `/resources/{id}` |
| 값·층 | GET `/resources/{id}/thresholds` (`layers`, `editable`, `lockedReason`) |
| 미리보기 / 적용 | POST `/thresholds/preview` / `/thresholds/apply` |
| 드리프트 | POST `/managed-alarms/{id}/drift` |
| 이력 | GET `/threshold-changes?resourceId=` |
| 감시 상태 | POST `/resources/{id}/monitoring` |

## 미결
- 디스크 경로별 지표의 MSP·고객 층 표시(Q-DM-11)
- 콘솔 값 저장 형식(Q-DM-12)은 화면에 영향 없음
