# On-call team page (D-28)

이전 `oncall-schedule.md` + `escalation-policy.md`를 합친 화면. 3~5명 MSP 팀 기준으로 단순화.

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/teams/{id}` (On-call › Teams) |
| 목적 | "지금 터지면 누가", "내 당번은 언제", "이 날 바꿔줘", "어떻게 울리나"를 한 화면에서 |
| 페르소나 | 하은(당번, 모바일), 준호(설정) |

## 레이아웃 (위에서 아래, 390px에서도 같은 순서 1열)
| 영역 | 내용 |
|---|---|
| 헤더 | 팀 이름, 인원·시간대·교대 시각, 팀 전환, **Cover or swap a shift** (주 버튼, 모바일 전체 폭) |
| 대기 배너 | 대체·교환 요청 대기 중: "Minjae covers your Thu 12 shift… Waiting for Minjae to accept." Remind / Cancel |
| If something breaks now | `1. Haeun → 2. Junho → 3. Minjae`. **순서를 정하는 유일한 곳** = 로테이션 순서, 현재 당번이 맨 앞. "Change order" |
| Shifts | 이번 주: 요일별 한 줄(당번, Now/Pending 표시, Swap 링크). 다음 주: 7칸 띠. "Your next shift" |
| Cover or swap | What(Someone covers me / Swap days) · When(시프트 또는 일부 시간) · Who → Send request. 상대가 Slack에서 수락해야 반영, 그 전엔 기존 당번 유지 |
| How we get alerted | 프리셋 Standard / Urgent / Quiet + 실명·시간 문장. 반복 1회(D-20)와 점검 창 규칙(D-17) 각 한 줄. **Advanced: edit steps**(접힘) 안에 단계 편집기 — 수정하면 Custom |
| Who uses this team | 고객사·서비스 목록과 각자 프리셋(고객사별로 다른 프리셋 가능) |

## 프리셋
| 키 | 단계 |
|---|---|
| STANDARD | 0분 당번 Slack → 2분 당번 SMS → 7분 다음 사람 전화 → 12분 전원 |
| URGENT | 0분 당번 전화 → 5분 다음 사람 전화 |
| QUIET | 0분 당번 Slack |
| CUSTOM | Advanced에서 편집한 경우 |

문장 예: "Slack Haeun now, SMS Haeun at 2 min, call Junho at 7 min, then alert everyone at 12 min."

## 쓰지 않는 말
owner snapshot, Team default order, IF ALL FAIL(Advanced 안에만), Re-notify(Settings › Suppression 값 사용).

## 상태
| 상태 | 표시 |
|---|---|
| 요청 대기 | 배너 + 해당 날 Pending, 수락 전 순서 불변 |
| 거절/만료 | 배너 "Minjae declined" + 다시 요청 |
| 저장 충돌 | 409 VERSION_CONFLICT → Reload |

## 동작 → API
| 동작 | API |
|---|---|
| 팀·순서 | GET/PATCH `/teams/{id}` |
| 시프트 | GET `/schedules/{id}` |
| 대체·교환 요청 | POST `/schedules/{id}/overrides` (status PENDING) → 상대 수락 시 ACCEPTED |
| 프리셋/단계 | GET/PUT `/escalation-policies/{id}` (If-Match) |
| 지금 순서 | GET `/oncall/now?customerId=&serviceId=` |

## 미결
- Q-DM-14 주 단위 교대: 이 화면은 하루 단위 로테이션을 가정
- Q-DM-15 뮤트 종료 직후 밀린 단계
