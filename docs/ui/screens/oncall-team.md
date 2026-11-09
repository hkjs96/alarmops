# On-call team page (D-28)

이전 `oncall-schedule.md` + `escalation-policy.md`를 합친 화면. 3~5명 MSP 팀 기준으로 단순화.

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/teams/{id}` (On-call › Teams) |
| 목적 | "지금 터지면 누가", "내 당번은 언제", "이 날 바꿔줘", "어떻게 울리나"를 한 화면에서 |
| 페르소나 | 하은(당번, 모바일), 준호(설정) |

## 샘플 데이터 (목업과 일치)
- Infra team 6명, 로테이션 Haeun → Junho → Minjae → Jiwoo → Sora → Dohyun, 하루 1교대, **교대 09:00 KST**.
- 지금 Mon 9 03:16 → 당번은 **Sun 8 09:00 – Mon 9 09:00 시프트의 Haeun**. 09:00에 Junho 인계.
- 대기 요청: Haeun의 Sat 14 시프트를 Minjae가 대체(PENDING). Fri 13 18–23시 Dohyun→Junho 부분 대체(ACCEPTED).
- 고객: Daon Retail=Standard, Mirae Pay=Urgent(Checkout 서비스만 Data team: Taemin → Yuna), Hanbit Logistics=Quiet.

## 레이아웃 (위에서 아래, 390px에서도 같은 순서 1열)
| 영역 | 내용 |
|---|---|
| Who gets paged for… | 맨 위 검색. 서비스·리소스 입력(예 payments-db) → 경로(resource › service › project › customer), 해석된 팀과 **어느 레벨에서 상속됐는지**, 프리셋, 전체 문장 |
| 헤더 | 팀 이름, 인원·시간대·**교대 시각(매일 09:00 KST)**, 팀 전환, **Cover or swap a shift**(주 버튼, 모바일 전체 폭) — 누르면 폼을 열고 폼으로 스크롤(`#oc-form`) |
| 대기 배너 | "You asked Minjae to cover your Sat 14 shift… Waiting for Minjae to accept." Remind Minjae / Cancel my request |
| Cover or swap 폼 | 헤더 바로 아래 인라인(기본 닫힘). What · When(전체/일부 시간) · Who · Reason → Send request. **Who는 4명 이하면 버튼, 5명 이상이면 검색 드롭다운** |
| If something breaks now | 세로 순서 목록: 1번(당번) 크게, 다음 2명, 나머지는 "+3 more (Jiwoo, Sora, Dohyun)" 접힘. 각주: 알림은 프리셋 단계 수만큼만 이름으로 닿는다(Standard·Urgent 2명 후 전원, Quiet 1명 후 전원). **Change order** = N명 드래그 목록 |
| Shifts | 교대 방식 토글: 하루 1교대(09–09) / 주간 09–21·야간 21–09. 이번 주 행 목록(2교대면 두 줄씩), Now/Pending, Swap(폼으로 이동). 다음 주 7칸 띠는 **이름**, 390px에서 4+3 줄바꿈 |
| Recent changes to shifts | 최근 30일 대체·교환 목록: 날짜, 누가→누가, 종류, **사유**, 상태(Pending/Accepted/Declined) |
| How we get alerted | 프리셋 선택 → 문장이 실명·분으로 바뀜(반복 1회, 정지 시각 포함). "version 7, edited by Junho Park on Nov 6". **Advanced: edit timing** 안에: 영향 경고 "Changes apply to 3 customers: …", 단계 표(At=시작 기준 누적 분), 누적 타임라인(0′·2′·7′·12′ … 24′ stop), 반복 횟수, ack 후 재알림(분), 고객별 override(Use team timing / Keep v7), **Primary + secondary on call** 토글(기본 꺼짐) |
| Who uses this team | 고객별 프리셋 배지 + **그 고객 프리셋의 전체 문장** |

연결 화면: Incident detail·Resource detail 헤더에 한 줄 "Paged: Haeun → Junho · Urgent · Infra team" → 이 화면 링크.

## 프리셋 (문장은 지금 당번 기준으로 계산)
| 키 | 단계 | 문장 |
|---|---|---|
| STANDARD | 0분 당번 Slack → 2분 당번 SMS → 7분 다음 사람 전화 → 12분 전원, 반복 1회, 24분 정지 | Slack Haeun now → SMS Haeun at 2 min → call Junho at 7 min → alert everyone at 12 min → repeat once → stop at 24 min |
| URGENT | 0분 당번 전화 → 5분 다음 사람 전화 → 10분 전원 전화, 반복 1회, 20분 정지 | Call Haeun now → call Junho at 5 min → call everyone at 10 min → repeat once → stop at 20 min |
| QUIET | 0분 당번 Slack → 15분 전원 Slack, 반복 1회, 30분 정지 | Slack Haeun now → Slack everyone at 15 min → repeat once → stop at 30 min |
| CUSTOM | Advanced에서 편집한 경우 | 단계로 계산 |

ack되면 즉시 멈춤. 점검 창: SEV-2 이하 조용, SEV-1 항상 알림(D-17).

## 큰 팀 (7~8명)
- 순서 목록은 3명 + 접힘, 드래그 편집은 N명.
- 2교대(주간/야간) 선택 가능. Primary/secondary 레이어는 Advanced 옵션(기본 꺼짐) — 켜면 1단계가 두 사람에게 동시에.

## 쓰지 않는 말
owner snapshot, Team default order, IF ALL FAIL(Advanced 안에만).

## 상태
| 상태 | 표시 |
|---|---|
| 요청 대기 | 배너 + 해당 날 Pending, 수락 전 순서 불변 |
| 거절/만료 | 배너 "Minjae declined" + 다시 요청 |
| 저장 충돌 | 409 VERSION_CONFLICT → Reload |

## 동작 → API
| 동작 | API |
|---|---|
| 팀·순서·교대 방식·레이어 | GET/PATCH `/teams/{id}` (`members[]`, `shiftPattern`, `layers`) |
| 시프트 | GET `/schedules/{id}` |
| 대체·교환 요청 | POST `/schedules/{id}/overrides` (PENDING) → `.../{oid}/accept` · `.../decline` · `.../remind`, 취소 DELETE |
| 최근 변경 목록 | GET `/schedules/{id}/overrides?since=` |
| 프리셋/단계 | GET/PUT `/escalation-policies/{id}` (`preset`, If-Match, `affectedCustomers`) |
| 고객별 프리셋·고정 | PUT `/customers/{id}/escalation` |
| 지금 순서 | GET `/oncall/now?customerId=&serviceId=` |
| Who gets paged for… | GET `/oncall/paging-path?q=` |

## 미결
- Q-DM-14 주 단위 교대: 이 화면은 하루 1교대/2교대만 다룸
- Q-DM-15 뮤트 종료 직후 밀린 단계
