# Customers list / detail

| 항목 | 내용 |
|---|---|
| 경로 | `/customers`, `/customers/{id}` |
| 목적 | 고객사 상태 한눈에(열린 인시던트, 연결, 커버리지), 상세에서 조직·담당·계정·연동·Monitoring(D-26)·자동 조치·포털 권한 |
| 페르소나 | 준호 P2-1, P2-3, P2-4 |

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

### 상세 Monitoring 탭의 Responders & paging 카드
순서 배지, 짧은 실명 문장, MSP 직원 수·Pageable/Notify only 고객 사람 수, "Open →" (Responders & paging 탭).

## 상세 탭
| 탭 | 내용 | API |
|---|---|---|
| Overview | 열린 인시던트, Setup checklist, 지금 담당 | GET `/customers/{id}`, `/incidents?customerId=`, `/oncall/now?customerId=` |
| Org & owners | 트리(Customer › Project › Service), 단계별 담당 + 상속 표시("Inherited from Project Web") | `/customers/{id}/projects`, `/assignments` |
| Responders & paging (D-30·D-31) | `customer-responders.md` | GET `/customers/{id}/responders`, `/customers/{id}/paging` |
| AWS accounts | Integrations의 계정 표 | `/customers/{id}/accounts` |
| Integrations | `integrations.md` | `/customers/{id}/integrations` |
| Monitoring | `monitoring.md` 같은 화면, 고객 잠금 | `/resources?customerId=` |
| Remediation | enabled(기본 off), mode(Notify only / Approval required), 허용 동작, 최근 요청 | GET/PUT `/customers/{id}/remediation-policy`, GET `/remediation-requests` |
| Portal access | 로그인 도메인, grants(contacts·silences·channels) | PATCH `/customers/{id}` |

## Responders & paging 탭
구 People 탭은 이 탭에 합쳐졌다. 고객 사람은 역할 Pageable(호출·로테이션 가능) 또는 Notify only. 상세는 `customer-responders.md`.

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
