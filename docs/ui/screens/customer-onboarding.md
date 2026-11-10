# Customer onboarding wizard

| 항목 | 내용 |
|---|---|
| 경로 | `/customers/new` (단계별 저장, 중간 이탈 후 이어하기) |
| 목적 | 새 고객사를 왕복 없이 5분 안에: 고객사 → 조직 → AWS 계정·IAM 역할 → On-call(Responders·순서) → 확인 |
| 페르소나 | 준호 P2-1, P2-2 / 민재 P4-1 |


## 셸·범위 (D-33, `shell-scope.md`)
- 마법사는 트리 필터를 쓰지 않는다. 진행 중에는 트리가 띠로 접힌다. 범위는 1단계에서 만드는 고객 하나로 고정이고 모든 단계 머리에 고객 이름이 있다.
- 생성 흐름이므로 읽기 화면 없이 바로 입력한다. 단계마다 저장 버튼에 고객 이름(`Save organization for <고객>`).
- 완료하면 트리의 `My customers`에 새 고객이 생기고 Call order가 그 고객으로 좁혀진 채 열린다.
- 새 셸 시안은 아직 없다(`mockups/index.html`의 화면 내용이 기준).

## 단계
| # | 단계 | 입력 | API |
|---|---|---|---|
| 1 | Customer | 이름, 로그인 도메인(포털) | POST `/customers` |
| 2 | Organization | 프로젝트 → 서비스(인라인 추가) | POST `/customers/{id}/projects`, `/projects/{id}/services` |
| 3 | AWS account & roles | 12자리 계정, Env, 리전. **필수** Reader · EventForwarder(끌 수 없음). **선택** AlarmWriter · TagWriter(`Monitoring` 키만, S3·Route53 제외) · Remediator(D-15 기본 꺼짐). ExternalId 자동 발급, CloudFormation 실행 링크, Check connection | POST `/customers/{id}/accounts`, POST `/accounts/{id}/check`, GET `/accounts/{id}/status` |
| 3b | (선택) Prometheus/Grafana | 웹훅 소스 생성, 토큰 1회 | POST `/customers/{id}/integrations` |
| 4 | Call order (D-30·D-31 개정) | ① MSP 직원 템플릿(선택: No template / Infra core / Data desk / Night backup, 멤버 이름 표시, 템플릿 변경 시 함께 바뀜 안내) ② <고객> 사람 추가 + 역할(Pageable (calls, SMS) / Notify only) ③ Who is paged first: All at once / Customer rotation(멤버 순서, 직원·고객 섞임) / Shared MSP rotation(선택, 사용 고객 수·지금 당번) / Custom steps(단계 편집기) ④ Timing: Standard/Urgent/Quiet(시작 템플릿). 실명 문장 미리보기 "Slack on shift in MSP night desk (Haeun now) now → … → call everyone in Responders (4: Haeun, Junho, Minjae, Minseo) at 12 min". 나중에 그 고객의 호출 순서 패널(Call order)에서 수정·덮어쓰기 | POST `/customers/{id}/responders`, PUT `/customers/{id}/paging` |
| 5 | Review | 체크리스트: 역할별 상태, 첫 이벤트, 채널 확인, 기본값 출처. 미완료 항목은 "Finish later"로 고객 상세 Setup checklist에 남음 | GET `/accounts/{id}/status` |

## 역할 카드 (3단계)
| 역할 | 기본 | 켜면 가능한 것 | 끄면 |
|---|---|---|---|
| Reader | 필수 | 리소스 발견, 알람 상태 확인, RCA(읽기 전용) | — |
| EventForwarder | 필수 | 알람 상태 이벤트·CloudTrail 변경을 중앙 버스로 | — |
| AlarmWriter | 선택, 켬 권장 | 알람 생성·임계치 변경 | 임계치 편집 비활성 |
| TagWriter | 선택 | 콘솔에서 `Monitoring=on` 붙이기 | Re-tag 비활성, 고객이 태그 |
| Remediator | 선택, 꺼짐 | 무단 변경 시 EC2·RDS 중지, ELB 삭제(Slack 승인) | 알림만 |

## 상태
| 상태 | 표시 |
|---|---|
| 점검 중 | 역할 행 "Checking…" (202 commandId 후 폴링, 완료 시 중지) |
| 실패 | DENIED → "Trust policy rejects our role — check ExternalId" |
| 중복 | 409 ALREADY_EXISTS → 기존 고객사 링크 |

## 미결
- 선택 역할을 나중에 켤 때 스택 업데이트 흐름(ROLE_UPDATE_REQUIRED)
- 마법사 단계 저장 위치(초안 상태 컬럼 없음)
