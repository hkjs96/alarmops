# Incident detail

| 항목 | 내용 |
|---|---|
| 경로 | `/incidents/{id}` |
| 목적 | 무엇이 왜 터졌는지 읽고 Ack → 원인 → Resolve. 에스컬레이션 이유가 타임라인만으로 읽힘 |
| 페르소나 | 하은 P1-2, P1-4, P1-5 / 소연 P3-2(포털에서 읽기 전용 축약판) |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 히어로 | Sev + Status, 제목, org chain, 지문 수, 열린 시각. 주 버튼 **Acknowledge**(Triggered) → Resolve(Acknowledged) |
| 왜 울렸나 | 대표 알림: 지표, 현재값 vs 임계치(출처 배지 D-19), M/N, 사유 문구, 스파크라인, "Open resource" |
| 담당·에스컬레이션 | 스냅샷 순서(1순위 마크), 현재 단계 n/m, 반복 r/repeatCount(D-20), 다음 단계 예정 시각, 점검 창 묵음이면 "Muted by maintenance (SEV-2)" |
| 탭 | Alerts(구성 알림, 상태별) · Timeline(IncidentEvent) · Notifications(NotificationLog 채널별 결과) · Suppression(억제 판정 이유) |
| RCA 자리 (D-14) | 점선 카드 "Root cause analysis — available after PoC". 높이 고정, 데이터 없음 |
| 자동 조치 패널 (D-15) | RemediationRequest가 있을 때만. 동작(EC2 stop 등), 대상, 트리거(CloudTrail 요약), 상태 단계(Notified → Pending approval → Approved → Executing → Succeeded), 승인자·만료. **콘솔에 승인 버튼 없음**: "Approve in Slack" 안내 + Slack 스레드 링크. 정책이 NOTIFY_ONLY면 "Notify-only mode — no action will run" |

## 상태
| 상태 | 표시 |
|---|---|
| 로딩 | 히어로 스켈레톤, 버튼 비활성 |
| 오류 | 404 → "Not found"(범위 밖과 동일). 409 VERSION_CONFLICT → "Someone else updated this incident" + Reload, 상태 재조회 |
| 빈 | 타임라인·통지 없음 → "No events yet" |

## 동작 → API
| 동작 | API |
|---|---|
| 상세 | GET `/incidents/{id}` |
| 타임라인 / 통지 | GET `/incidents/{id}/timeline`, `/incidents/{id}/notifications` |
| Ack (인시던트 단위만, D-24) | POST `/incidents/{id}/ack` If-Match |
| Resolve + 분류 | POST `/incidents/{id}/resolve` `{kind, note}` |
| Escalate now | POST `/incidents/{id}/escalate` |
| Mute 1h | POST `/maintenance-windows` (scope ALERT) |
| 알림 상세 | GET `/alerts/{id}` |
| 자동 조치 상태 | GET `/remediation-requests?customerId=` (인시던트 리소스로 필터) |

## 미결
- RemediationRequest를 인시던트에 직접 연결하는 FK가 없음(DATA-MODEL). 리소스 + 시간으로 찾을지, `incidentId` 컬럼 추가할지
- Resolve 시 분류(kind) 필수 여부
- 승인 요청 만료 시간(Q-DM-13) 표시 문구

## On-call 표시 (D-30·D-31 개정)
- 목업 샘플은 같은 데이터 객체 `D`에서 렌더링: payments-db-1 (Mirae Pay › Core › Payments API), Mirae Pay 단계 = Custom steps · Urgent (edited): Slack + call on shift in MSP night desk (Haeun) → 10분 call Yuna Seo (Mirae Pay, Pageable) → 15분 call everyone in Responders (5).
- Paged 줄: "Slack + call Haeun 03:12 ✓ → call Yuna 03:22 → call everyone in Responders (5) 03:27" (Incident) / 분 단위 문장(Resource). 링크는 Customer › Responders & paging.
- Escalation 패널: 단계마다 대상(사람 / 로테이션 당번 / 전원)·채널·시각, 다음 단계 남은 시간, **Edit Mirae Pay's paging** 링크.
- 타임라인: "Paging steps at open: Haeun → Yuna → everyone in Responders (5)". Notify only 고객 사람 메일 이벤트 포함(Seojun Bae, Hana Noh, Hyejin Lim).
- Auto-fix 카드: "Only people with the Auto-fix approver role for Payments API can approve: Yuna Seo (Mirae Pay)."
