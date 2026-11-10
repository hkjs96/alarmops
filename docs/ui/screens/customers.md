# Customers list / detail

| 항목 | 내용 |
|---|---|
| 경로 | `/customers`, `/customers/{id}` |
| 목적 | 고객사 등록 정보 관리: 상태 한눈에(열린 인시던트, 연결, 커버리지), 상세에서 조직·담당·계정·연동·자동 조치·포털 권한. 운영 화면(Incidents·Monitoring·Call order·People·Maintenance)은 트리에서 그 고객을 골라 본다 |
| 페르소나 | 준호 P2-1, P2-3, P2-4 |


## 셸·범위 (D-33, `shell-scope.md`)
| 항목 | 내용 |
|---|---|
| 메뉴 위치 | `Customers`(확인 필요: E 시안에 없는 배치안, `IA.md` §1) |
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
| ~~Responders & paging~~ (없어짐, D-26 개정) | → "Open Call order for <고객> →"(`/call-order?filter=<customer>`), "Open People for <고객> →" | — |
| AWS accounts | Integrations의 계정 표 | `/customers/{id}/accounts` |
| Integrations | `integrations.md` | `/customers/{id}/integrations` |
| ~~Monitoring~~ (없어짐, D-26 개정) | → "Open Monitoring for <고객> →"(`/monitoring?filter=<customer>`) | — |
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
