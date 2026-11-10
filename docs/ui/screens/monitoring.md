# Monitoring

| 항목 | 내용 |
|---|---|
| 경로 | `/monitoring` (독립 메뉴, 고객사 횡단), 필터 `?customer=&project=&service=` · `?mine=1`. ~~고객 상세 `Monitoring` 탭~~ → 트리에서 그 고객을 고른 같은 화면(D-26 개정) |
| 목적 | 고객사를 가로질러 알람·리소스·임계치를 보고, 커버리지 빈틈과 확인 필요(D-16)를 처리 |
| 페르소나 | 민재 P4-2(빈틈 30초), P4-3(임계치), P4-5(밖에서 바뀜) |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 트리 필터 | 적용. 기본 All customers |
| `Outside this view` | 필터가 걸리면 칩 줄에 `Outside this view: 2 need review · 3 in alarm`. 누르면 필터를 풀고 Needs review를 보여 준다(`Back to <필터>`) |
| 알람 임계치 패널 (리소스 하나) | `/c/<c>/<p>/<s>/alarms/<resource>`. **읽기 먼저**: 출처 층 표(TAG · CONSOLE · CUSTOMER · MSP · CODE, "in effect") + "Applies to <리소스> only". 버튼 `Edit threshold for <경로> › <리소스>`. 태그가 값을 정하면 버튼 없이 "Set by resource tag. Read only here." 편집 → `Save for <경로> › <리소스>`: 확인 없이 바로 + `Undo` |
| 기본 임계치 패널 (고객 단계) | `/c/<customer>/thresholds`. 목록 옆 `Default thresholds` 카드에서 연다. **읽기 먼저**: 지표 × Code · MSP · 고객 값("uses MSP"). 버튼 `Edit defaults for <고객>`. 편집: "What saving would change" 미리보기, 목록이 프로젝트로 걸러져 있으면 "This changes all of Mirae Pay, not only Core.". 저장은 서비스 둘 이상이면 확인창 |
| MSP 기본값 | 여기서 고치지 않는다 → Settings › MSP defaults |
| 열 우선순위 | Resource · metric, 경로, Sev, State는 끝까지. `Default thresholds` 카드가 표 아래로 → Threshold 숨김 → 560px 미만 카드 |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | 제목, Sync now. 고객 필터는 없다(트리) |
| 스탯 타일 | Monitored · Coverage gaps · Needs review · Drifted · Alarms in ALARM |
| 탭 | **Alarms** · **Resources** · **Coverage gaps** · **Needs review** · Sync runs |
| 필터 | Resource type(29종), Account, Region, Source(TAG/CONSOLE/…) |
| Resources 표 | Resource(name, id) · Type · Customer / account · Monitoring(state) · Alarms n · Drift · Last seen |
| Alarms 표 | Alarm(리소스 + 지표, 임계치 없음 D-08) · Threshold + **출처 배지** · M/N + 출처 · Sev · State · Drift |
| Needs review | Resource · Since · Reason(`tag_removed`) · Alarms kept n · 동작: **Re-tag**(TagWriter) / Keep monitoring / Stop monitoring(알람 삭제 확인) |
| 일괄 임계치 | 행 선택 → "Change threshold" 패널 → 미리보기(태그가 이기는 대상 회색 + 이유) → Apply. 서비스 둘 이상에 닿으면 확인창(대상 서비스 목록) |

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | AWS 계정 없음 → "Connect an AWS account" (온보딩 3단계 링크). Needs review 0 → "Nothing to review" |
| 로딩 | 표 스켈레톤, 동기화 중이면 상단 진행 줄(완료 후 폴링 중지, 9-3) |
| 오류 | 동기화 실패 → AlarmSyncRun 오류 카드. TagWriter 없음 → Re-tag 비활성 + "Enable TagWriter role" |

## 동작 → API
| 동작 | API |
|---|---|
| 리소스 / 빈틈 / 확인 필요 | GET `/resources?customerId=&customer=&project=&service=&type=&monitoringState=NEEDS_REVIEW&coverage=missing` (`outside` 포함) |
| Re-tag / Keep / Stop | POST `/resources/{id}/monitoring` `{action: tag_on|keep|stop}` (403 CAPABILITY_DISABLED) |
| 미리보기 / 적용 | POST `/thresholds/preview` → POST `/thresholds/apply` (`previewId`) |
| 지금 동기화 | (계약 없음 — 미결) |
| 드리프트 | POST `/managed-alarms/{id}/drift` `{restore|accept}` |
| 등급 | PUT `/managed-alarms/{id}/severity` |

## 미결
- `GET /managed-alarms` 목록 엔드포인트가 API-CONTRACT에 없음 → Alarms 탭에 필요
- "Sync now"(SYNC_ACCOUNT ON_DEMAND) 콘솔 엔드포인트 없음
- Sync runs 조회 엔드포인트 없음
