# Customer › Responders & paging

| 항목 | 내용 |
|---|---|
| 경로 | `/customers/{id}/responders` (고객 상세 탭, 구 People 탭 통합) |
| 목적 | 이 고객의 Responders(MSP 직원 + 고객 사람)와 페이징 단계·로테이션을 한 곳에서 (D-30·D-31 개정) |
| 페르소나 | 준호(P2-1, P2-3), 하은 |

## 구성
| 영역 | 내용 |
|---|---|
| Paging steps | **Who is paged first**: All at once / Customer rotation / Shared MSP rotation(로테이션 선택) / Custom steps. **Timing · start from a plan**: Standard/Urgent/Quiet — 고르면 단계를 템플릿에서 다시 만듦(편집 내용 버림 경고). 단계 편집기: At(분) · Who(로테이션 당번 / Everyone in Responders (n) / 사람 — 고객 사람은 "(customer)") · How(Slack/SMS/Call) · ✕, + Add step, Repeat. **If something breaks now** 실명 문장 미리보기. 덮어쓰기 예외 안내 |
| Rotation | 고객 로테이션이면 순서(MSP·고객 배지), 지금 당번, 4주 띠(휴가 대체 표시). 공용이면 링크 + "also used by N other customers". 없으면 이유 |
| Project & service overrides | 노드별 자기 단계 문장, "Use customer steps". 해석 순서 service › project › customer |
| Responders | MSP staff: 템플릿 이름(멤버) · Change · + Add staff, 행마다 출처(from Infra core / added directly), 지정 단계, 문제 채널. <고객> people: 역할 배지(Pageable / Notify only / Auto-fix approver / Portal), "step 2"·"in rotation" 배지, Notified for 범위, 채널 칩, 역할 선택(Pageable ↔ Notify only) |
| Add customer person (서랍) | 이름, 이메일·전화, Role(Pageable (calls, SMS) / Notify only) + Auto-fix approver·Portal 체크, Notified for 범위, **Call them at**: "Not in a named step" 또는 "New step k+1, after step k" + 분(앞뒤 단계 사이 기본값) → 미리보기 문장에 새 이름. 저장 후 확인 링크 |

역할 정의: **Pageable** = 전화·문자 가능, 단계·로테이션에 지정 가능, "everyone"에 포함. **Notify only** = 상태 메일만(범위 안 인시던트). Approver·Portal은 둘 중 어디에나 추가.

## API
GET `/customers/{id}/responders` → `{ staff[{contactId,source:TEMPLATE|DIRECT,templateId}], people[{contactId,role,extras[],scope}], templateId }`; POST/DELETE `/customers/{id}/responders`; PATCH `/customers/{id}/responders/{contactId}` (role); GET/PUT `/customers/{id}/paging` (`style, plan, sharedRotationId?, steps[], repeatCount`, If-Match); PUT/DELETE `/customers/{id}/paging-overrides/{scopeType}/{scopeId}`.

## 390px
단계 행은 번호 + (분 / 대상 / 수단) 세로. Responders 카드는 단계 카드 아래.
