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
| People | 고객 담당자 수 + 할 일 배지(미확인·만료) |

| On-call team | 팀 이름 + 알림 계획 배지("Mirae Pay · Urgent (customized)"). 팀은 MSP 직원 그룹이고 고객마다 만들지 않는다(D-31) |

목록 위 카드 **"Customer contacts needing action" (n)**: 3명 미리보기 + 고객별 수 + Needs action 정의, **Open list · send links** → 통합 Needs action 목록(Customer 필터). 일괄 발송은 그 목록 한 곳에서만. API: GET `/contacts/needs-action?kind=CUSTOMER`.

390px: 표가 카드(라벨: 값)로 바뀐다.

### 상세 On-call 카드 (D-30)
팀 링크, 알림 계획 선택(Standard/Urgent/Quiet), 배지, 문장. 고객 타이밍이 없으면 **Customize for <고객> only**, 있으면 **Edit <고객>'s timing** · **Use team timing**. 편집기는 "Changes <고객> only" 배너. Incident 상세의 "Edit Mirae Pay's timing" 링크가 이 편집기로 바로 연다(`?edit=1`).

## 상세 탭
| 탭 | 내용 | API |
|---|---|---|
| Overview | 열린 인시던트, Setup checklist, 지금 담당 | GET `/customers/{id}`, `/incidents?customerId=`, `/oncall/now?customerId=` |
| Org & owners | 트리(Customer › Project › Service), 단계별 담당 + 상속 표시("Inherited from Project Web") | `/customers/{id}/projects`, `/assignments` |
| People (D-29) | 아래 "People 탭" | GET `/customers/{id}/people?scopeType=&scopeId=` |
| AWS accounts | Integrations의 계정 표 | `/customers/{id}/accounts` |
| Integrations | `integrations.md` | `/customers/{id}/integrations` |
| Monitoring | `monitoring.md` 같은 화면, 고객 잠금 | `/resources?customerId=` |
| Remediation | enabled(기본 off), mode(Notify only / Approval required), 허용 동작, 최근 요청 | GET/PUT `/customers/{id}/remediation-policy`, GET `/remediation-requests` |
| Portal access | 로그인 도메인, grants(contacts·silences·channels) | PATCH `/customers/{id}` |

## People 탭 (D-29)
고객 담당자는 **알림만 받는다. 온콜 로테이션에 절대 들어가지 않는다.** 페이징은 On-call의 MSP 팀.

| 영역 | 내용 |
|---|---|
| 왼쪽 범위 트리 | Customer › Project › Service, 노드마다 붙은 인원 수 + 할 일 수(주황). 필터 입력, 접기. 모바일은 위에 쌓임 |
| 오른쪽 | 선택 노드의 경로 헤더, "Search in this scope", 주 버튼 "Add person here". 요약 "4 people are notified for incidents on Payments API: 1 attached here, 3 inherited" |
| 사람 행 | 이름·직함, **Notified for** 범위(예: "Daon Retail › Commerce (all services)"), 역할 배지(Notify only / Approver — 자동 조치 승인 D-15 / Portal user, 복수 가능), 채널 확인 칩, 동작 |
| 상속 | 위 단계에 붙은 사람은 "Inherited from Commerce" 구획에 흐린 배경으로, "Open in Commerce" 링크(여기서 수정 불가) |
| 추가 | Person(기존 고객 사람 검색 또는 새 이름), Email·phone, Role, Notified for(This service only / All of project / All of customer). 저장 후 확인 링크 발송 |

규모: 트리 + 범위 안 검색이 기본, 페이지네이션 없음.

추가(v3 재점검):
- 트리 노드 클릭 → 경로 + 칩 "Notified for <노드>" / "Everyone at <고객>" / "Needs action" / "Approvers", 이름 검색, 일괄 선택(Send links / Ask to add).
- 섹션 이름 "Added here" / "From <상위 노드>"(inherit라는 말 쓰지 않음). 상위에서 온 행은 "Open in <노드>".
- 역할 Approver = 자동 조치 승인(auto-fix approval). 승인 채널은 **Slack 또는 이메일 링크** — Incident 상세 Auto-fix 카드와 같은 문구.
- 고객 선택(목업 전용 Example 선택)으로 Daon Retail › Commerce › Checkout 등 다른 고객 트리 확인.

## 상태
| 상태 | 표시 |
|---|---|
| 빈 | "No customers yet" + New customer |
| 오류 | 삭제 시 계정·인시던트 있으면 차단 문구 |

## 미결
- 고객 담당자 수신 채널별 시간대(야간 SMS 제외 등)
- 고객사 삭제 vs 보관(soft delete)
- 목록 집계(coverage, setup) 엔드포인트 없음 — `/customers` 응답에 요약 필드 추가 필요
