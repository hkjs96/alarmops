# Customers list / detail

| 항목 | 내용 |
|---|---|
| 경로 | `/customers`, `/customers/{id}` |
| 목적 | 고객사 등록 정보 관리: 상태 한눈에(열린 인시던트, 연결, 커버리지), 상세에서 조직·담당·계정·연동·자동 조치·포털 권한. 운영 화면(Incidents·Monitoring·Call order·People·Maintenance)은 트리에서 그 고객을 골라 본다 |
| 페르소나 | 준호 P2-1, P2-3, P2-4 |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 메뉴 위치 | 상단 메뉴 `Customers`(확정, D-26). 휴대폰은 사용자 메뉴 |
| 트리 | 이 화면에서는 필터로 쓰지 않는다(목록 자체가 고객). 트리에서 고객을 누르면 그 고객 상세로 간다. Org & owners 탭이 트리의 프로젝트·서비스를 만든다(slug 규칙: `shell-scope.md` §7) |
| 읽기 먼저 | 상세 탭은 읽기 전용으로 열리고 탭마다 `Edit`. 저장 버튼에 고객 이름(`Save portal access for Mirae Pay`) |
| 한 고객의 변경 | 계정·연동·자동 조치·포털 권한은 그 고객 하나에만 닿는다 → 위험 동작(삭제, Remediator 켜기)만 확인 |
| 새 셸 시안 | 아직 없다(`mockups/index.html`의 화면 내용이 기준) |

## 목록
| 열 | 내용 |
|---|---|
| Customer | 이름, 로그인 도메인 |
| Open incidents | Sev별 마크 + 수 |
| Sources | CloudWatch n accounts · Prometheus · Grafana 아이콘 |
| Connection | 역할 이상 계정 수(▲) |
| Coverage | monitored / total, Needs review n |
| Setup | 체크리스트 진행(예: 4/6) |
| Paging | 순서 방식 · 시작 플랜 배지("Custom steps · Urgent (edited)") + "first: <지금 먼저 호출되는 이름>" (D-30 개정) |
| Responders | Responders 수 + 고객 사람 할 일 배지(미확인·만료) → Responders & paging 탭 |

목록 위 카드 **"Customer people needing action" (n)**: 3명 미리보기 + 고객별 수 + Needs action 정의, **Open list · send links** → 통합 Needs action 목록(Customer 필터). 일괄 발송은 그 목록 한 곳에서만. API: GET `/contacts/needs-action?kind=CUSTOMER`.

390px: 표가 카드(라벨: 값)로 바뀐다.

### Overview의 Call order 카드
순서 배지, 짧은 실명 문장, MSP 직원 수·Pageable/Notify only 고객 사람 수, "Open →"(그 고객의 호출 순서 패널, 읽기 화면).

## 상세 탭
| 탭 | 내용 | API |
|---|---|---|
| Overview | 열린 인시던트, Setup checklist, 지금 담당 | GET `/customers/{id}`, `/incidents?customerId=`, `/oncall/now?customerId=` |
| Org & owners | 트리(Customer › Project › Service), 단계별 담당 + 상속 표시("Inherited from Project Web") | `/customers/{id}/projects`, `/assignments` |
| ~~Responders & paging~~ (없어짐, D-26 개정) | → "Open Call order for <고객> →"(`/call-order?customer=<slug>`), "Open People for <고객> →" | — |
| AWS accounts | Integrations의 계정 표 | `/customers/{id}/accounts` |
| Integrations | `integrations.md` | `/customers/{id}/integrations` |
| ~~Monitoring~~ (없어짐, D-26 개정) | → "Open Monitoring for <고객> →"(`/monitoring?customer=<slug>`) | — |
| Remediation | enabled(기본 off), mode(Notify only / Approval required), 허용 동작, 최근 요청 | GET/PUT `/customers/{id}/remediation-policy`, GET `/remediation-requests` |
| Portal access | 로그인 도메인, grants(contacts·silences·channels) | PATCH `/customers/{id}` |

## Responders & paging 탭 (없어짐)
호출 순서는 Call order(`customer-responders.md`), 사람은 People(`oncall-people.md`)에서 트리로 그 고객을 골라 다룬다.

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | "No customers yet" + New customer |
| 오류 | 삭제 시 계정·인시던트 있으면 차단 문구 |

## 미결
- 고객 담당자 수신 채널별 시간대(야간 SMS 제외 등)
- 고객사 삭제 vs 보관(soft delete)
- 목록 집계(coverage, setup) 엔드포인트 없음 — `/customers` 응답에 요약 필드 추가 필요

## v4 점검 반영 (2026-11-09)
- "Paging health" 열 + 필터 칩 "Paging problems (N)" (`#customers?f=prob`). 정의는 oncall-now.md와 동일.
- 샘플 문제 고객: Kumho Clinic(호출 가능자 0), Lumen Bank(로테이션 멤버 미검증·Notify only).

## 상태 변경·오프보딩 (D-43, D-45) — 콘솔 구현 메모
| 항목 | 내용 |
|---|---|
| 경로 | `/customers`(고객별 카드: 이름·상태 배지·열린 인시던트), `/customers/{slug}`(헤더 상태 배지, Status 카드, 해지 고객이면 Offboarding checklist) |
| 상태 배지 | `Active`(✓) · `Suspended`(─, amber) · `Terminated`(◆, ink2). 색 + 도형 + 글자. 트리·시트에는 `Suspended`/`Terminated` 태그(ACTIVE는 태그 없음) |
| Change status | ADMIN만. 다른 역할은 비활성 + 이유("…needs the Admin role. You are signed in as Operator."). TERMINATED는 누구에게나 비활성(되돌릴 수 없음) |
| Suspend | 사유 필수. "Alarms from this customer are recorded but nobody is paged (customer contacts and MSP staff). A business-hours summary is sent instead." |
| Resume | 사유 필수. 정지 중 생긴 인시던트는 호출하지 않고 "Not paged"로 남는다는 안내 |
| Terminate | 사유 필수 + 고객 이름을 똑같이 입력해야 확인 버튼이 켜진다. 되돌릴 수 없음, 호출 중단·AlarmOps 관리 알람 삭제·고객의 연결 스택 삭제 필요·30일 뒤 연락처/상세 삭제(D-45) 안내. 503 `COMMANDS_UNAVAILABLE`은 "상태는 바뀌지 않았다"로 말하고 창을 유지, 409 `VERSION_CONFLICT`는 Reload |
| 인시던트 | `pagingSuppressed`가 있으면 목록 행과 상세에 "Not paged (customer suspended/terminated)" 표시(도형 + 글자) |
| Offboarding checklist | 5단계 DONE/PENDING/MANUAL + detail. ADMIN이 MANUAL 단계를 "Mark done…"(ALARMS_DELETED는 메모 필수, UI에서 강제). 남은 이벤트가 있으면 "Cleanup needed" 알림(건수·마지막 시각) |
| 열린 문제 | `GET /scope-tree`와 고객 목록이 `status`를 주지 않는다. 콘솔은 `customers[].status?`가 있으면 태그를 그리고(목은 채워 준다), 없으면 그리지 않는다. ADMIN이 아닌 직원은 `GET /customers/{id}/status`(ADMIN 전용)를 못 읽으므로 이 필드가 있어야 배지를 본다 → API-CONTRACT §8.0 scope-tree에 `status` 추가 필요(backend 이슈) |
