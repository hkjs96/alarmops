# 정보 구조 (IA)

이 문서는 콘솔의 셸(메뉴·트리·필터 줄·패널), 메뉴별 화면, 주소, 반응형, 화면별 목적과 공통 규칙을 요약한다. 셸 규칙의 세부는 `screens/shell-scope.md`가 기준이다.

상태: 확정 셸 반영 (D-26 개정, D-33·D-34·D-35 · 11/10). 콘솔 문구는 영어(D-01).

- 셸 규칙(트리, 필터 줄, 패널, 읽기 먼저, 저장, 주소, 반응형)의 기준 문서: `screens/shell-scope.md`. 이 문서는 요약과 화면 목록이다.
- 화면 명세: `screens/*.md`.
- 시안
  - `mockups/scope-variants.html` 변형 E(셸 + 5개 화면)
  - `mockups/index.html`(셸은 옛것, 화면 내용은 유효)

## 1. 셸

```
AlarmOps   Incidents ④   Monitoring   Call order   People   Maintenance   Customers        [Filter to… Ctrl K] [Settings] [JP]
SHOWING:  Mirae Pay × › Core × › All services                 Outside this view: 3 open (1 from an unmapped account) · 2 acknowledged
┌ 트리 ─────────┬ 목록 ──────────────────────────────┬ 패널 ─────────────┐
│ Customer      │ 행마다 고객 › 프로젝트 › 서비스       │ 전체 경로          │
│  › Project    │                                    │ 읽기 → Edit → Save │
│   › Service   │                                    │                   │
└───────────────┴────────────────────────────────────┴───────────────────┘
```

요소별 한 줄 규칙과 근거:

- **메뉴** (D-26 개정)
  - Incidents / Monitoring / Call order / People / Maintenance / Customers + Settings.
  - **우상단 고객 선택기는 없다**
- **트리** (D-33)
  - Customer › Project › Service. 범위를 고르는 유일한 장치.
  - 본문을 덮지 않고 밀어낸다.
  - 휴대폰은 단계 시트
- **필터 줄** (D-33, D-34)
  - `Showing: …` 글 한 줄 + 필터가 걸렸을 때 `Outside this view: …`
- **목록** (D-34)
  - 기본 보기는 All customers. 편집 칸 없음
- **패널** (D-33)
  - 범위가 정해진 패널 하나.
  - 읽기 전용으로 열리고 `Edit`를 눌러야 편집.
  - 저장 버튼에 전체 경로

### 메뉴와 화면

| 메뉴 | 목록 주소 |
|---|---|
| **Incidents** | `/incidents` |
| **Monitoring** | `/monitoring` |
| **Call order** (구 On-call) | `/call-order`, `/call-order/rotations`, `/call-order/templates` |
| **People** | `/people` |
| **Maintenance** | `/maintenance` |
| **Customers** | `/customers`, `/customers/{id}`, `/customers/new` |
| **Settings** (오른쪽) | `/settings/*` |
| 고객 포털 | `portal.…/…` |

메뉴별 하위(탭·칩)와 화면 명세:

- **Incidents**
  - 하위: Open · Acknowledged · Resolved (상태 칩)
  - 명세: `incidents-list.md`, 패널·상세 `incident-detail.md`
- **Monitoring**
  - 하위: Alarms · Resources · Coverage gaps · Needs review · Sync runs
  - 명세: `monitoring.md`, `resource-detail.md`
- **Call order** (구 On-call)
  - 하위: **Call order**(고객별 호출 순서 = 구 Now + 구 Customer › Responders & paging의 단계) · Rotations · Templates
  - 명세: `oncall-now.md`, `customer-responders.md`, `oncall-rotations.md`, `oncall-templates.md`
- **People**
  - 하위: 표 하나(Kind 열: Staff / Customer) · Needs action
  - 명세: `oncall-people.md`, `contacts.md`
- **Maintenance**
  - 하위: Active · Scheduled · Ended
  - 명세: `maintenance-windows.md`
- **Customers**
  - 하위: 목록 → 고객 관리(Overview · Org & owners · AWS accounts · Integrations · Remediation · Portal access), New customer
  - 명세: `customers.md`, `integrations.md`, `customer-onboarding.md`
- **Settings** (오른쪽)
  - 하위: MSP defaults · Severity mapping · Suppression · Integrations(전체) · Users · Audit log
  - 명세: `settings.md`
- **고객 포털**
  - 하위: 같은 셸을 한 고객에 잠금: Incidents · Monitoring · Call order · People · Maintenance (읽기, grant가 있는 것만 쓰기)
  - 명세: `customer-portal.md`

배치 메모:

- **배치 확정(11/10, D-26):** `Customers`는 상단 메뉴로 남는다. Rotations·Templates는 `Call order`의 탭이다.
  > **참고** E 시안의 메뉴에는 Customers와 이 탭들이 그려져 있지 않다. 화면은 새 셸로 아직 다시 그리지 않았다.
- 고객 상세의 `Monitoring`, `Responders & paging` 탭은 없어졌다.
  - 같은 내용은 트리에서 그 고객을 고른 Monitoring · Call order · People이다.
  - 고객 상세에는 "Open Call order for Mirae Pay →" 같은 링크만 둔다.
- 고객사 담당자(VIEWER 강제, org-tenant R4-3)는 포털로만 들어온다.

## 2. 주소

- **목록 + 필터**
  - 형식: `/<screen>?customer=<slug>[&project=<slug>[&service=<slug>]]`, `?mine=1`
  - 예: `/incidents?customer=mirae&project=core`
- **범위가 있는 패널**
  - 형식: `/c/<customer>[/<project>[/<service>]]/<screen>[/<id>]` (+ 목록 필터 쿼리). 인시던트 패널은 단수 `incident`
  - 예: `/c/mirae/core/checkout/call-order`, `/c/mirae/thresholds`, `/c/mirae/people/yuna-seo`, `/c/mirae/core/payments-api/incident/<id>`
- **생성**
  - 형식: `/c/<customer>[/…]/maintenance/new`, `/c/<customer>[/…]/people/new`
  - 범위를 고르기 전: `/maintenance/new`
- **미매핑 인시던트**
  - 형식: `/c/-/incident/<id>`
  - 고객이 없으므로 고객 자리에 `-`(예약 slug)
- **관리 화면**
  - 형식: `/customers…`, `/settings/…`, `/call-order/rotations`, `/call-order/templates`
  - 트리 필터를 쓰지 않는 화면(§4)

주소 규칙:

- 경로 = 패널의 범위, 쿼리(`customer` · `project` · `service` · `mine`) = 목록 필터.
- `Copy link`는 목록 필터 쿼리를 뺀다.
- 편집 상태는 주소에 없다.
- 세부: `screens/shell-scope.md` §7.

## 3. 반응형

| 폭 | 트리 | 패널 | 목록 |
|---|---|---|---|
| ≥ 1408px | 펼친 채 패널 옆에 남는다 | 옆 패널 600px | 패널을 여닫아도 왼쪽 끝이 움직이지 않는다 |
| 1101~1407px | 기본 펼침, 패널을 열면 띠로 자동 접힘 | 600 → 440px | 열 숨김 → 카드 |
| 761~1100px | 기본 띠(45px) | 440px 또는 전체 화면 + `← Back to the list` | 열 숨김 → 카드 |
| ≤ 760px | 없음 → 단계 시트 | 전체 화면 | 카드 (아래) |

- ≤ 760px 목록: 카드. 하단 5칸 바(Incidents가 첫 칸), Customers·Settings는 사용자 메뉴

### 열 우선순위

| 화면 | 끝까지 남는 것 | 1차로 숨김 | 2차로 숨김 | 카드로 바뀜 |
|---|---|---|---|---|
| Incidents | Sev, Status, 경로, Incident, `Acknowledge` | Paged | Age | 690px 미만 |
| Monitoring | Resource · metric, 경로, Sev, State | `Default thresholds` 카드가 표 아래로 | Threshold | 560px 미만 |
| Call order | 경로, Paged first, Steps | Then | Reach 열 → 고객 이름 옆 표식 | 500px 미만 |
| People | Person, 경로(Notified for), Channels needing action | Role, Contact | Kind | 500px 미만 |
| Maintenance | Status, 경로, Window | By, Muted | Reason | 500px 미만 |

숨기는 폭 값과 순서의 설명은 `screens/shell-scope.md` §8.

## 4. 화면별 목적 · 주 페르소나 · 범위 동작

| # | 화면 | 주 페르소나 |
|---|---|---|
| 1 | Incidents | 하은(P1-1, P1-3) |
| 2 | Incident detail | 하은(P1-2, P1-4, P1-5), 소연(P3-2) |
| 3 | Monitoring | 민재(P4-2, P4-3) |
| 4 | Resource detail | 민재(P4-3, P4-5) |
| 5 | Call order | 하은(휴대폰), 준호(P2-2, P2-4) |
| 5b | Call order › Rotations / Templates | 준호, 하은 |
| 6 | People | 준호 |
| 7 | Maintenance | 준호, 민재, 소연(grant) |
| 8 | Customers / 고객 관리 | 준호(P2-1, P2-3) |
| 9 | Customer onboarding | 준호(P2-1), 민재(P4-1) |
| 10 | Integrations | 준호, 민재(P4-1) |
| 11 | Settings | 준호(ADMIN), 민재 |
| 12 | Customer portal | 소연(P3-1~3) |

화면마다 목적, 트리 필터, 패널:

1. **Incidents**
   - 목적: 지금 울리는 것, 가장 심각한 것, 담당자를 스크롤 없이
   - 트리 필터: 적용. 기본 All customers(D-34)
   - 패널: 인시던트(읽기 + Acknowledge)
2. **Incident detail**
   - 목적: 무엇이 왜 터졌나 → Ack → Resolve. RCA 자리(D-14), 자동 조치 상태(D-15)
   - 트리 필터: — (패널·전체 화면)
   - 패널: 그 자체
3. **Monitoring**
   - 목적: 알람·리소스·빈틈·확인 필요(D-16)·임계치 출처(D-19)
   - 트리 필터: 적용
   - 패널: 알람 임계치(리소스 하나), 기본 임계치(고객 단계)
4. **Resource detail**
   - 목적: 지표별 값과 출처 층, 변경 미리보기, 드리프트, 이력
   - 트리 필터: —
   - 패널: 그 자체(읽기 먼저)
5. **Call order**
   - 목적: 지금 무언가 터지면 누가 어떤 순서로 호출되는지, 고객·프로젝트·서비스별 단계
   - 트리 필터: 적용
   - 패널: 호출 순서(읽기 먼저 → Edit, 넓히기는 별도 단계)

   **5b. Call order › Rotations / Templates**
   - 목적: 공용 MSP 로테이션, Responder 템플릿
   - 트리 필터: 적용 안 함(MSP 공용). 영향 고객은 미리보기로
   - 패널: 편집은 영향 미리보기 + 확인(D-33 ⑧)
6. **People**
   - 목적: 직원·고객 사람 한 표. 범위를 고르면 그 범위에서 호출·알림 받는 사람
   - 트리 필터: 적용
   - 패널: 사람(읽기 먼저), `Add person`(범위 먼저)
7. **Maintenance**
   - 목적: 점검 창 생성·해제. SEV-1은 통과(D-17)
   - 트리 필터: 적용
   - 패널: 창 보기·Revoke, `New window`(범위 먼저)
8. **Customers / 고객 관리**
   - 목적: 고객사 등록 정보: 조직, 계정, 연동, 자동 조치, 포털 권한
   - 트리 필터: 적용 안 함(목록 자체가 고객)
   - 패널: 탭 화면
9. **Customer onboarding**
   - 목적: 고객사 → 조직 → AWS 계정 + IAM 역할 → 호출 순서 → 확인
   - 트리 필터: 적용 안 함
   - 패널: 마법사
10. **Integrations**
    - 목적: CloudWatch / Prometheus / Grafana 연동, 토큰 1회 표시
    - 트리 필터: 적용 안 함
    - 패널: —
11. **Settings**
    - 목적: MSP 전체 변경은 여기에만(미리보기 + 확인 1회)
    - 트리 필터: 적용 안 함
    - 패널: —
12. **Customer portal**
    - 목적: 고객사 하나의 상태. 다른 고객 흔적 없음
    - 트리 필터: 그 고객에 잠김
    - 패널: 읽기만

## 5. 공통 규칙

항목마다 규칙과 (근거).

- **심각도 표기** (ui/README)
  - 도형 + 색 + 라벨: SEV-1 ● · SEV-2 ▲ · SEV-3 ◆ · SEV-4 ○ · SEV-5 –
- **상태 표기** (alert-hub tokens)
  - Triggered ● 빨강 · Escalated ▲ 주황 · Acknowledged ○ 슬레이트 · Resolved ✓ 초록 · Muted – 회색
- **트리 표식** (shell-scope §2.2)
  - 3종: 열린 인시던트 수 · 호출 문제(`UNREACHABLE` / `AT RISK`) · `OWN STEPS`.
  - 점·세모는 쓰지 않는다
- **출처 배지** (D-19)
  - `TAG` `CONSOLE` `CUSTOMER` `MSP` `CODE` — 모든 임계치 값 옆
- **주 버튼** (ui/README)
  - 화면당 하나, 액센트 파랑.
  - 읽기 화면의 `Edit`는 보조 버튼, 편집 화면의 `Save for <경로>`가 주 버튼.
  - 위험 동작은 보조 + 빨강 글자 + 확인
- **저장** (D-33)
  - 버튼·알림·확인창에 고객을 포함한 전체 경로.
  - 확인은 서비스 둘 이상이거나 넓힌 저장만, 나머지는 바로 + `Undo`
- **스탯 타일** (known-bugs 9-5, D-34)
  - 현재 필터 기준 수치(합 = 목록 수).
  - 메뉴의 Incidents 배지만 필터와 무관
- **범위 밖** (API §2)
  - "Not found" 하나(존재를 드러내지 않음).
  - 포털은 본문·상태 코드까지 같다
- **연락처** (D-35)
  - 가린 값이 기본.
  - 전체 값은 그 고객의 Responder만.
  - MSP ADMIN은 사유를 적는 비상 열람만.
  - 모든 열람 기록, 비상 열람은 검토 목록 + 주 Responder 알림
- **시간** (DATA-MODEL §0)
  - KST 표시, 상대 시각 + 절대 시각 툴팁
- **다크 모드** (ui/README)
  - 시스템 설정 따름 + 수동 토글
