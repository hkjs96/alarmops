# 검증 결과

| 날짜 | 시나리오 | 버전(커밋) | 페르소나 | 측정값 | 판정 | 캡처 |
|---|---|---|---|---|---|---|

## On-call 비교 (v1 vs v2)

평가: 독립 UX 평가(화면만 보고 판단, 명세·결정 문서 미열람). 2026-11-09. v1=`docs/ui/mockups/archive/index-v1.html`, v2=`docs/ui/mockups/index.html`. 1440·390px 캡처.

| 과제 | 버전 | 성공 | 단계/클릭 | 망설인 곳 | 잘못 내릴 수 있는 결론 | 확신(1-5) |
|---|---|---|---|---|---|---|
| T1 하은·390px 목요일 근무 민재에게 넘기기 | v1 | 부분 | 4~6+ (Add override → 폼 화면 미노출, 추정) | 주간 타임라인이 390px에서 가로로 잘려 Junho/Minjae 칸이 안 보임. "override"가 스왑인지 대타인지 모호. Save 버튼이 무엇을 저장하는지 불명 | Thu 12에 이미 "Minjae · override"가 있어 이미 처리된 걸로 착각 | 2 |
| T1 | v2 | 예 | 3 (상단 Cover or swap → 스크롤 → Who 민재 → Send request) | 상단 버튼이 폼으로 이동하지 않고 폼은 2화면 아래. "Or pick part of a shift"가 클릭 가능한지 불명 | 요청 보내면 바로 바뀐다고 착각할 여지는 낮음(PENDING·"You stay on call" 명시, 좋음) | 4 |
| T2 "Mirae Pay payments-db 지금 고장나면 누가·어떻게·언제?" | v1 | 부분 | 3 탭 이동(Schedules→Escalation→Now) | "Next in owner snapshot", "Everyone in snapshot" 용어. 순서가 두 개(On call now: 하은→준호→민재 / Team default order: 준호→하은→민재) | 2단계 SMS를 "Same person"이 아닌 다음 사람으로 오해. 서비스→정책 연결이 안 보여 payments-db가 이 정책인지 확인 불가 | 2 |
| T2 | v2 | 부분 | 1 화면(스크롤) | Mirae Pay는 URGENT 배지인데 화면의 문장은 Standard 기준("Slack Haeun now…"). Urgent는 "Call right away"뿐 — 누구에게, 그다음은? payments-db가 목록에 없음(payments-api, settlement, checkout만) | Standard 문장을 Mirae Pay에 적용해 "Slack 먼저, 2분 뒤 SMS"라고 틀리게 답함 | 2 |
| T3 준호 신규 고객 온콜 설정 | v1 | 부분 | 3단계 진입 후 "Contacts & order"까지 미확인(5단계 위저드) | 위저드가 AWS 단계에서 길고 온콜 단계는 화면에 없음. 정책 편집은 별도 탭 | 정책을 고객마다 새로 만들어야 한다고 생각 | 2 |
| T3 | v2 | 예 | 2 선택 + Continue (팀 1, 프리셋 1) | "+ New team" 이후 흐름 미노출. Urgent/Quiet 선택 시 문장이 바뀌는지 불명 | 서비스별로 다른 팀(checkout→Data team) 지정이 여기서 안 되므로 고객 전체 단일 팀이라고 오해 | 4 |
| T4 민재 지금 당번 확인 + Slack→전화 시간 변경 | v1 | 예 | 당번 0클릭(On call now), 시간 변경 2~3 (Escalation 탭 → 3단계 wait 5 수정 → Save changes) | 전화가 3단계(누적 7분)인데 입력값은 5 — 누적인지 간격인지 하단 각주를 읽어야 이해 | 5를 누적 시간으로 오해해 2분 줄이려다 잘못 수정 | 3 |
| T4 | v2 | 부분 | 당번 0클릭, 시간 변경은 "Advanced: edit steps" 접힘 안 → 최소 2~3 + 미노출 | 시간 변경 입구가 접힌 "Advanced"뿐. 팀 기본을 바꾸면 3고객 모두 바뀌는지, Mirae Pay(Urgent)엔 무관한지 경고 없음 | 팀 기본 편집이 한 고객만 바꾼다고 착각 | 2 |

### v2에 남은 문제 (심각도순)
| # | 문제 | 근거(화면) |
|---|---|---|
| 1 | 고객별 프리셋이 다를 때 "누가·언제" 문장이 Standard만 보여줌. Urgent는 "Call right away" 한 줄뿐, 대상·후속 단계 없음 | How we get alerted / Who uses this team(Mirae Pay URGENT) |
| 2 | 서비스·리소스 → 팀 매핑이 불완전. payments-db 같은 리소스로 검색·확인할 방법 없음, "checkout uses Data team" 각주로만 예외 표기 | Who uses this team |
| 3 | 현재 당번 모순: 월 03:16인데 "Haeun · On shift until 09:00"이고 Mon 9 행이 Haeun NOW. 순환(H→J→M, 24h, 09:00 교대)이면 일요일 8일 당번은 Minjae여야 함 | If something breaks now / Shifts |
| 4 | 단계·시간 편집이 "Advanced" 접힘 안에 숨고, 팀 기본 변경이 여러 고객에 미치는 영향 범위 표시 없음 | Advanced: edit steps, team default |
| 5 | 390px: "Cover or swap a shift" 버튼과 실제 폼이 2화면 떨어짐(앵커 없음), 상단 모크 탭·GNB가 잘려 On-call 메뉴가 화면 밖. 다음 주 행은 이니셜(JP/ML)만이라 야간 판독 어려움 | 390 캡처 |
| 6 | 기타: Remind/Cancel이 누가 기준인지 모호, "Or pick part of a shift: 18:00–23:00" 상호작용 여부 불명, 재알림(ack 후)·반복 횟수 설정 사라짐, 오버라이드 사유(sick leave) 기록 없음 | |

### v1이 더 나았던 점 (v2에서 잃은 것)
- 고객별 정책(Mirae Pay — Critical)이 단계·채널·대기·반복·ack 후 재알림까지 한 화면에 명시 + 누적 시간 프리뷰(0′·2′·7′·12′…24′ stop).
- 버전·편집자 표시("version 7, edited by Junho Park on Nov 6") — 변경 추적.
- 기존 오버라이드 목록과 사유, 시간 단위 타임라인(부분 시간대 대타가 시각적으로 보임).

판정: v2가 하은(T1)·준호(T3)에는 확실히 개선(쉬운 말, 한 화면, PENDING 상태). 그러나 T2(“지금 이게 터지면 누가?”)는 두 버전 모두 화면만으로 정답 불가이며 v2는 틀린 답을 자신 있게 유도함. 문제 1~3 해결 전 파일럿 불가(P1).
