# Resource detail

| 항목 | 내용 |
|---|---|
| 경로 | `/c/<customer>/<project>/<service>/resources/{base64url id}` (9-4). 서비스가 없는 리소스는 있는 단계까지 |
| 목적 | 지표별 임계치와 출처 4층(D-19) 확인, 바꾸기 전 영향 미리보기, 드리프트 복원/수용, 이력 |
| 페르소나 | 민재 P4-3, P4-5 |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 머리 | 전체 경로(고객 › 프로젝트 › 서비스) + 리소스 이름. 목록 필터와 독립 |
| 읽기 먼저 | 화면은 읽기 전용으로 열린다. 지표 하나를 고치려면 그 행의 `Edit` → 편집 패널. 저장 버튼 `Save for <경로> › <리소스>` |
| 저장 | 리소스 하나의 값이므로 확인창 없이 바로 적용 + 알림(전체 경로, 전 → 후) + `Undo`. 적용 상태(PENDING → APPLIED)는 행에 |
| 고객 기본값 | 여기서 고치지 않는다. "Open <고객> defaults →"(고객 단계 기본 임계치 패널, `monitoring.md`) |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 히어로 | 이름, 타입, ARN(복사), customer › account › region, Monitoring 상태(Needs review면 노란 배너 + 동작) |
| Thresholds 표 | Metric · Effective value · Source 배지 · 층 보기(CODE → MSP → CUSTOMER → CONSOLE/TAG, 이긴 층 굵게, 진 층 취소선) · M/N + 출처 · Sev. 읽기 전용이고 행마다 `Edit`(그 지표의 편집 패널) |
| 잠금 | 출처 TAG면 Edit 비활성 + "Set by resource tag `Threshold_CPU=85`. Change the tag in your IaC." (409 TAG_WINS) |
| 편집 패널 (`Edit` 뒤) | 새 값, M/N(1 ≤ M ≤ N ≤ 10, SEV-1·period≥3600은 잠김), 이유, 미리보기 결과 → Apply |
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

## 판단 방식 편집 (D-27)
- 표의 Evaluation 칸은 `M of N × 주기`로 표시한다(예: 2 of 3 × 5m).
- 편집 패널 필드: 임계치, 통계(Average·Maximum·Minimum·Sum·p95), 주기(1·5·15·60분), M of N. 아래에 "최근 N개 주기 중 M개 초과면 알람(총 몇 분)"을 문장으로 보여 준다.
- 기본값은 등급 정책. 잠긴 정의(SEV-1, 주기 ≥ 60분)는 M/N 편집 불가. 1분 주기는 상세 모니터링이 켜진 리소스만 고를 수 있다.
- 태그 `Threshold_{키}_Eval=M/N`이 있으면 M/N은 태그 값이 이기고 잠김 표시. 주기·통계 태그 키는 미결(Q-UI-EVAL-01).

## On-call 표시 (D-30·D-31 개정)
- 목업 샘플은 같은 데이터 객체 `D`에서 렌더링: payments-db-1 (Mirae Pay › Core › Payments API), Mirae Pay 단계 = Custom steps · Urgent (edited): Slack + call on shift in MSP night desk (Haeun) → 10분 call Yuna Seo (Mirae Pay, Pageable) → 15분 call everyone in Responders (5).
- Paged 줄: "Slack + call Haeun 03:12 ✓ → call Yuna 03:22 → call everyone in Responders (5) 03:27" (Incident) / 분 단위 문장(Resource). 링크는 그 범위의 호출 순서 패널(읽기 화면).
- Escalation 패널: 단계마다 대상(사람 / 로테이션 당번 / 전원)·채널·시각, 다음 단계 남은 시간, **Open call order** 링크.
- 타임라인: "Paging steps at open: Haeun → Yuna → everyone in Responders (5)". Notify only 고객 사람 메일 이벤트 포함(Seojun Bae, Hana Noh, Hyejin Lim).
- Auto-fix 카드: "Only people with the Auto-fix approver role for Payments API can approve: Yuna Seo (Mirae Pay)."
