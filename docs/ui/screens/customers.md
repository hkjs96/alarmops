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

## 상세 탭
| 탭 | 내용 | API |
|---|---|---|
| Overview | 열린 인시던트, Setup checklist, 지금 담당 | GET `/customers/{id}`, `/incidents?customerId=`, `/oncall/now?customerId=` |
| Org & owners | 트리(Customer › Project › Service), 단계별 담당 + 상속 표시("Inherited from Project Web") | `/customers/{id}/projects`, `/assignments` |
| AWS accounts | Integrations의 계정 표 | `/customers/{id}/accounts` |
| Integrations | `integrations.md` | `/customers/{id}/integrations` |
| Monitoring | `monitoring.md` 같은 화면, 고객 잠금 | `/resources?customerId=` |
| Remediation | enabled(기본 off), mode(Notify only / Approval required), 허용 동작, 최근 요청 | GET/PUT `/customers/{id}/remediation-policy`, GET `/remediation-requests` |
| Portal access | 로그인 도메인, grants(contacts·silences·channels) | PATCH `/customers/{id}` |

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | "No customers yet" + New customer |
| 오류 | 삭제 시 계정·인시던트 있으면 차단 문구 |

## 미결
- 고객사 삭제 vs 보관(soft delete)
- 목록 집계(coverage, setup) 엔드포인트 없음 — `/customers` 응답에 요약 필드 추가 필요
