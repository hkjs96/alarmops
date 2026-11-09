# Escalation policy editor

| 항목 | 내용 |
|---|---|
| 경로 | `/oncall/escalation-policies/{id}` |
| 목적 | 단계(대기·대상·채널)와 반복 횟수(D-20)를 편집하고, 실제 시간축을 미리 본다 |
| 페르소나 | 준호 / 하은 P1-4(이해) |

## 레이아웃
| 영역 | 내용 |
|---|---|
| 헤더 | 이름, 고객사(없으면 MSP default), Default 표시, Save(If-Match) |
| 단계 목록 | Step n · Wait(min, 직전 통지 기준) · Target(Next in snapshot / All / Contact / Team / Schedule) · Channels(Slack channel, Slack DM, SMS, Voice, Email 토글) · Advance if all channels fail |
| 반복 | "Repeat ladder [1] more time(s)" (0 = no repeat, 기본 1) |
| 재알림 | Re-notify after ack (min, 비우면 suppression 정책 값) |
| 미리보기 | 시간축: 0′ Slack → 5′ SMS → 10′ Voice → 15′ next → (repeat 1) 30′ … → stop. 점검 창 안내: "SEV-2 and below are muted during maintenance; SEV-1 always escalates." |
| 사용처 | 이 정책을 쓰는 고객사·서비스 |

## 상태
| 상태 | 표시 |
|---|---|
| 오류 | 409 VERSION_CONFLICT → 차이 보기 + Reload |
| 검증 | 단계 0개 저장 불가, Wait 음수 불가 |

## 동작 → API
| 동작 | API |
|---|---|
| 목록 / 생성 | GET/POST `/escalation-policies` |
| 조회 / 저장 / 삭제 | GET/PUT/DELETE `/escalation-policies/{id}` (If-Match) |

## 미결
- 뮤트 종료 직후 밀린 단계 즉시 발송(Q-DM-15) — 미리보기 문구에 영향
