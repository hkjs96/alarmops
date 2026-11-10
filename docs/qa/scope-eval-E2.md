# 범위(Scope) 변형 E 독립 평가 — UX·안전성

- 대상: `/home/claude/wt-scope/docs/ui/mockups/scope-variants.html` 탭 **E · Combined** (C, D는 비교용으로만 확인)
- 방법: Playwright(Chromium)로 직접 조작. 1440×900 / 390×844, 라이트·다크. 스크린샷 약 90장을 눈으로 확인하고, 상태값·문구·카운트는 스크립트로 대조.
- 읽지 않은 것: `docs/ui/scope-variants.md`, `docs/qa/scope-eval-*.md`, DECISIONS (지시대로). 저장소는 읽기 전용으로만 접근.
- 증거 위치: `/tmp/claude-0/-home-claude/d5229855-9d3c-5c86-9780-6232f0edde7b/scratchpad/e2/` (스크린샷 `*.png`, 재현 스크립트 `shots.py`, `adv.py` ~ `adv6.py`)
- 한계: 목업이라 서버 권한·동시 편집·실제 저장은 검증 불가. 포털 격리는 "화면에 무엇이 그려지는가"까지만 확인.

## 0. 결론

**조건부 채택.** 범위 안전성의 핵심(패널이 여는 범위 = 저장되는 범위, 필터와 패널 불일치 경고, 생성 시 사전 선택 없음, 동명 서비스 자동 선택 금지, 초안의 범위 간 누출 없음)은 적대적으로 눌러도 깨지지 않았다. 다만 아래 P1 3건은 "보이는 범위가 실제와 다르다"는 종류라 구현 전에 명세에서 고쳐야 하고, E는 3~5인 팀 PoC에 비해 장치가 많아 6절의 삭제 목록을 적용할 것을 권한다.

| 구분 | 건수 | 요약 |
|---|---|---|
| P1 | 3 | People 필터가 호출 대상자를 누락 / "My customers" 기본값의 사각지대 / 포털 404 문구로 존재 여부 노출 |
| P2 | 17 | 확인 문구·카운트 부정확, MSP 확인 상태 잔존, 새로고침·깨진 링크, 폰 터치 영역·레이아웃, 밀도 등 |
| 깨지지 않은 것 | 12 | 2절 표 참조 |

## 1. 5초 테스트 (이미지만 보고 판단)

판정: **즉시** / **찾아야 함** / **틀림** / **알 수 없음**. 필터 예시는 고객 = Mirae Pay, 서비스 = Mirae Pay › Core › Payments API. "패널" 열은 서비스 필터 상태에서 편집 패널을 연 경우이며, 일부는 일부러 필터와 다른 고객의 패널을 열었다.

### 1440×900

| 화면 | 필터 없음 | 고객 필터 | 서비스 필터 | 패널 열림: 무엇이 보이나 | 패널 열림: Save가 무엇을 바꾸나 |
|---|---|---|---|---|---|
| Incidents | 즉시 ("My customers · 12" + 행마다 전체 경로) | 즉시 | 즉시 | 즉시 (띠에 Hanbit Logistics › Tracking › Public API, "Different customer than your list filter" 배너) | 즉시 (Save 없음, Acknowledge만. 대상은 띠의 인시던트) |
| Monitoring | 즉시 | 즉시 | 즉시 (단, 옆 카드의 호박색 경고가 목록보다 눈에 띔) | 즉시 | 즉시 범위는 보임 ("Save defaults for Mirae Pay" + "This changes all of Mirae Pay, not only Payments API"). **어떤 값이 바뀌는지는 찾아야 함** |
| Paging | 즉시 | 즉시 | 즉시 ("SERVICE · YOUR FILTER" 칩) | 즉시 | 즉시 (상속 상태면 Save 자체가 없고 "Create own steps for …"가 주 버튼) |
| People | 즉시 (MSP 직원 행의 "Covers 12 customers"는 찾아야 함) | 즉시 | **틀림** — 목록은 "8 people in … Checkout"이라 하지만 호출 대상 1명이 빠져 있음 (P1-1) | 즉시 (Daon Retail 띠 + 다른 고객 배너) | 즉시 ("Save Taehee Oh for Daon Retail") |
| Maintenance | 즉시 | 즉시 | 즉시 | 즉시 ("No scope chosen yet") | 즉시 (범위를 고르기 전에는 저장 버튼 없음) |

### 390×844

| 화면 | 필터 없음 | 고객 필터 | 서비스 필터 | 패널 열림: 무엇이 보이나 | 패널 열림: Save가 무엇을 바꾸나 |
|---|---|---|---|---|---|
| Incidents | 즉시 | 즉시 | 즉시 (경로가 2줄로 접힘) | 즉시 | 즉시 (Acknowledge) |
| Monitoring | 즉시 | 즉시 | 즉시. 빈 결과일 때는 **찾아야 함** (빈 상태 문구가 세로로 깨짐, P2-9) | 즉시 | 즉시 (하단 고정 버튼에 고객명) |
| Paging | 즉시 | 즉시 | 즉시 ("YOUR FILTER" 칩이 빈 상자처럼 늘어남) | 즉시 | 즉시. 다만 패널 길이 1,966px로 2.3화면 |
| People | 즉시 | 즉시 | 틀림 (P1-1 동일) | 즉시 | 즉시 |
| Maintenance | 즉시 | 즉시 | **찾아야 함** (빈 상태 문구 깨짐, "Payments AP"에서 잘림) | 즉시 | 즉시 |

폰에서 패널은 전체 화면이라 목록 필터는 보이지 않는다(알 수 없음). 필터와 패널이 다르면 배너가 문장으로 알려 주므로 안전 문제는 아니다.

다크 모드: 5개 화면의 필터 없음·패널 상태를 확인했고 판정은 라이트와 같다. 대비·띠 구분 문제 없음.

## 2. 범위 안전성 적대적 테스트

### 깨지지 않은 것

| # | 시도 | 결과 |
|---|---|---|
| 1 | 필터 Mirae › Core › Checkout 상태에서 Daon › Commerce › Checkout 알람 패널 열기 (동명 서비스) | 띠·저장 버튼·배너 모두 Daon. 저장 토스트도 "Daon Retail › Commerce › Checkout › checkout-redis · 1 resource" |
| 2 | 패널에 미저장 값이 있는 채로 필터를 핀 칩으로 변경 | 패널·초안 유지, 배너만 새 필터 기준으로 갱신. 필터가 패널 범위를 바꾸지 않음 |
| 3 | 레벨 선택기에서 서비스 → 고객으로 전환 | URL·띠·버튼이 "Mirae Pay"로 바뀌고 "Wider than your list filter" 배너. 저장 확인창에 4개 서비스 나열, Data platform 제외 명시 (실제 계산과 일치) |
| 4 | 서비스 레벨에서 값 수정 후 레벨 전환 | 가드 대화상자. 초안 유지 후 고객 레벨 값은 원래 값(2) — 초안이 다른 레벨로 새지 않음 |
| 5 | 미저장 상태에서 Esc / 메뉴 이동 / 다른 행 클릭 | 세 경우 모두 "Unsaved changes for <전체 경로>" 대화상자 |
| 6 | 미저장 상태에서 브라우저 뒤로 | 대화상자 없이 닫히지만 초안이 남고 목록 위에 "Draft for Daon Retail … Resume / Discard" 표시. 앞으로 가면 값 복원 |
| 7 | 미저장 상태에서 새로고침 | 값(99)과 "Unsaved" 표시 복원 |
| 8 | 새 유지보수 창: 필터가 고객·서비스일 때 | 아무것도 미리 선택되지 않음. 필터는 "Use exactly this" 카드로만 제안되고 레벨·규모가 적힘 |
| 9 | 새 창 2단계에서 사유 입력 후 "Change scope"로 더 넓은 범위 선택 | 가드 후 새 범위의 사유 칸은 비어 있음 — 초안이 넓은 범위로 넘어가지 않음 |
| 10 | 스위처에서 `checkout`, `orders`, `web`, `core` 입력 후 Enter (Junho, Haeun 각각) | "N customers have a match … Nothing is selected" 경고, Enter 무동작. `mirae check`처럼 고객을 같이 치면 바로 선택 |
| 11 | "outside this view" 카운트: 사용자 2명 × 14/34 고객 × 필터 5종 = 20조합 | 화면 숫자와 배지가 계산값과 전부 일치 (정의 자체의 문제는 P1-2) |
| 12 | 포털 모드: 29개 URL 변조 (다른 고객 필터, 타 고객 패널, 스택 패널, 설정, 생성, 34고객·전체 보기) | 다른 고객명·담당자명이 화면에 한 번도 나오지 않음. Ctrl K 무동작, Settings·추가 버튼 없음, 저장 버튼 없음 |

### P1

| ID | 문제 | 재현 | 영향 | 제안 |
|---|---|---|---|---|
| P1-1 | People 목록이 서비스 필터에서 실제 호출 대상을 빠뜨림 | People에서 필터를 Mirae Pay › Core › Checkout으로 설정 → "8 people in …" 목록에 Yuna Seo 없음. Paging에서 같은 서비스 패널을 열면 "Call Yuna Seo (Mirae Pay) at 10 min" | 새벽에 "이 서비스로 누가 연락받나"를 People에서 확인하면 틀린 답을 얻음. Yuna의 패널 스스로 "Pageable: … for all of Mirae Pay, whatever Notified for says"라고 적고 있어 화면끼리 모순 | Pageable 역할은 고객 전체 범위로 취급해 항상 포함하고 "pageable for all of <고객>"로 표기. 또는 열 이름을 "Notified for"에 맞춰 목록 설명에서 "paged"와 구분 |
| P1-2 | 기본값 "My customers"가 담당 밖 인시던트를 숨기고, 그 수를 어디에도 세지 않음 | 상단 "AS JUNHO"를 눌러 Haeun으로 전환 → Incidents 배지 2, 목록 3건. All customers로 바꾸면 열린 건 4건 (Hanbit SEV-2 Escalated, Daon SEV-2 Triggered가 빠져 있었음). Haeun이 직접 Ack한 Hanbit batch-worker-3도 기본 목록에 없음. Mirae 필터에서 "1 open incident outside this view"라고 하지만 실제 바깥에는 3건 | 3~5인 팀에서는 서로 백업하는데, 기본 화면이 "지금 조용하다"고 잘못 말함. "outside this view"라는 문구는 My customers 한정이라는 사실을 패널 제목까지 들어가야 알 수 있음 | (a) PoC는 기본값을 All customers로 하고 My customers는 칩으로, 또는 (b) "My"에 내가 호출·Ack한 건을 포함하고 "+N open in customers you don't cover"를 항상 표시 |
| P1-3 | 포털에서 "권한 없음"과 "없음"의 본문이 다름 | 포털 모드에서 `o=paging:mirae||` → "Nothing here belongs to Daon Retail." / `o=paging:zzzz||` → "The link points to something that no longer exists." 같은 차이가 `person:p:ys` vs `p:zz`, `alarm:0` vs `99`, `mw:0` vs `99`에서도 발생 | 포털 사용자가 다른 고객 ID·담당자 ID·알람 번호의 존재 여부를 문구로 구분 가능. 목업 수준이지만 그대로 명세가 되면 격리 위반 | 포털은 두 경우 모두 동일한 404 본문·상태 코드. security 검토 항목으로 명시 |

### P2

| ID | 문제 | 재현·증거 | 제안 |
|---|---|---|---|
| P2-1 | 저장 확인창에 "무엇이 어떻게 바뀌는지"가 없음 | Paging 고객 레벨에서 2단계 10→3분 수정 후 저장: 확인창은 서비스 4개만 나열. 임계값도 동일 | 확인창에 변경 전 → 후 한 줄 추가 (MSP 설정 미리보기는 이미 그렇게 함) |
| P2-2 | 임계값 확인 카운트가 지표와 무관 | Mirae 기본값에서 RDS FreeStorageSpace만 15로 변경 → "4 of 6 alarms listed use these defaults". 해당 지표의 유일한 알람은 TAG라 실제 변경은 0건 | 바꾼 지표 기준으로 계산하거나 "최대 N건"으로 표현 |
| P2-3 | MSP 전체 적용의 입력 확인 상태가 화면 이동 후에도 남음 | Settings에서 값 수정 → Preview → 확인 문구 입력 → Incidents로 이동(가드 없음) → Settings 복귀: 3단계 그대로, Apply 버튼 활성. 한 번 클릭으로 전 고객 적용 | 화면을 떠나면 1단계로 초기화 |
| P2-4 | MSP 확인 문구가 "My customers"와 혼동될 수 있고 화면 내 숫자가 엇갈림 | EC2 CPU 변경 시 입력 문구 "all 12 customers", 같은 화면 상단은 "all 14 customers", Junho의 My customers도 12 | "12 of 14 customers"로 통일. 역할 제한 여부도 화면에 없음 (Haeun도 동일하게 적용 가능) |
| P2-5 | "Create own steps" 도중 새로고침하면 상태가 어긋남 | `paging:mirae|Core|Checkout` → Create own steps → 새로고침: 패널은 다시 "Inherited" 읽기 전용, 저장 버튼 없음. 그런데 Esc를 누르면 "Unsaved changes" 대화상자 | 생성 중 상태를 초안과 함께 저장하거나, 새로고침 시 초안 폐기 |
| P2-6 | 없는 프로젝트·서비스가 든 링크가 편집 패널로 열림 | `o=paging:mirae|Nope|` → "Mirae Pay › Nope · editing at project level" 패널 표시 (없는 고객은 Not found 정상) | 프로젝트·서비스도 존재 확인 후 Not found. 이름 변경 후 옛 링크 대비 |
| P2-7 | Undo가 한 칸뿐이고 타이머가 멈춰 있음 | Incidents에서 i1 Ack → i2 Ack: 배너는 i2만. Undo 후 i1은 Ack 상태로 남고 Undo 수단 사라짐. "undo for 5:00"은 줄지 않음 | 6절 참조 (Undo 범위 축소) |
| P2-8 | 폰 터치 영역 미달 | 패널 하단 주 버튼 Save/Create 358×38px, Paging 분 입력 72×28px, Reveal 43×44px, Settings 좌측 메뉴 높이 34px | 주 버튼·입력 44px 이상 |
| P2-9 | 폰 빈 상태 문구 깨짐 | 390px, Maintenance 필터 Mirae › Core › Payments API, Monitoring 필터 Settlement + "In alarm": 문구가 좁은 세로 열로 접히고 경로가 잘림 | 빈 상태 셀을 한 블록으로 |
| P2-10 | 폰 "SERVICE · YOUR FILTER" 칩이 큰 빈 상자로 늘어남 | 390px, Paging 서비스 필터 | 칩 줄바꿈 처리 |
| P2-11 | 1440에서 패널이 열리면 People 마지막 열 잘림 | "CHANNELS NEEDING AC", "SMS · link expired" 칩이 패널 경계에 닿음 | 패널 열림 시 열 숨김 |
| P2-12 | 겹친 패널에서 범위가 3개가 됨 | 필터 Daon → 인시던트 → Paging steps → "outside" → Mirae 인시던트: 편집 패널이 완전히 가려지고, 위 패널에는 "다른 고객" 배너가 생략됨. 상단 띠 한 줄만 아래 패널을 알림 | 6절 참조 (겹침 제거) |
| P2-13 | 확인 규칙이 화면마다 다름 | 임계값 기본값: 항상 확인 / Paging·유지보수: 서비스 2개 이상일 때만 / 알람·사람: 확인 없음. 저장 후 Paging·임계값은 패널 유지, 생성은 닫힘 | "서비스 2개 이상에 닿으면 확인" 한 규칙으로 |
| P2-14 | 배지 "1/4"의 뜻을 화면만으로 알 수 없음 | 툴팁에만 설명. 폰에서는 툴팁 없음 | 숫자 하나로 (6절) |
| P2-15 | Monitoring의 호박색 경고가 목록 옆 카드와 패널에 같은 내용으로 두 번 | 서비스 필터 + `thr:mirae` | 패널에만 유지 |
| P2-16 | 데스크톱 스위처는 검색 전에는 담당 밖 고객을 보여 주지 않음 | 34고객, Ctrl K: Pinned·Recent·My customers 12만. Mirae Pay가 3번 중복 | "Other customers · 22" 접힌 그룹 추가, 중복 제거 |
| P2-17 | 생성 폼 검증 없음 (목업 한계일 수 있음) | Add person을 이름 없이 저장 → "New person added to Daon Retail". 새 창 종료일이 목록에서 사라짐 ("Mon 9 · 22:00–02:00") | 명세에 필수값·날짜 표기 명시 |

참고(문제 아님, 확인 필요): 포털 사용자(Soyeon)에게 Acknowledge 버튼이 보인다. Soyeon은 Pageable이라 타당할 수 있으나, Portal 역할만 가진 사람에게도 보이는지는 목업으로 판단 불가.

## 3. 휴리스틱 점수 (1~5)

| 항목 | 점수 | 근거 |
|---|---|---|
| 범위 가시성 | 5 | 필터 바가 한 곳에 고정, 모든 행에 고객 굵게 + 전체 경로, 패널 띠·저장 버튼·토스트·확인창에 전체 경로. 5초 테스트 40칸 중 틀림은 People 2칸뿐 |
| 오류 예방 | 4 | 2절의 12개 시도 방어. 감점: P1-1, P1-2, 확인창에 변경 내용 없음(P2-1, 2), MSP 확인 잔존(P2-3) |
| 화면 간 일관성 | 4 | 띠·배너·저장 문구 형식은 5개 화면 동일. 감점: 확인 규칙·저장 후 동작 불일치(P2-13), 레벨 선택기가 Paging에서만 실제 선택지이고 임계값·알람에서는 장식 |
| 12고객 전문가 효율 | 4 | Ctrl K, 핀, Shift+Enter로 바로 편집, 행 전환 시 패널 유지. 감점: 흔한 단어(`web`, `core`)마다 모호성 차단, 임계값 저장마다 확인 |
| 초보자 학습성 | 3 | "1/4" 배지, "outside this view", own/inherited steps, "Edit at" 선택기를 한꺼번에 익혀야 함. 문장 자체는 친절함 |
| 폰 인체공학 | 3 | 가로 넘침 없음(전 화면 390/390), 스위처 드릴다운 양호. 감점: P2-8, 9, 10, Paging 패널 2.3화면, 핀 없음 |
| 34고객 확장성 | 4 | 전체 보기 Paging 36행·1,922px로 무난, 생성 게이트는 My/Other 분리, 모노그램 34개 중복 없음. 감점: 색상 10개 반복, P2-16, 모호성 경고에 고객명이 9개 이상 나열 |
| 딥링크·뒤로 가기 | 4 | URL에는 패널 범위 하나만, 링크 복사 시 필터 제거, 뒤로 한 번에 패널 한 겹씩 닫힘(확인: 스택 → 편집 → 목록). 감점: P2-5, P2-6 |
| 정보 밀도 | 3 | 아래 표. Monitoring + 패널에서 범위 표시 장치가 11종 |

### 화면당 범위 표시 장치 수 (1440, 서비스 필터, 종류 기준)

| 화면 | 목록만 | 패널 열림 | 내역 |
|---|---|---|---|
| Incidents | 6 | 7 | 필터 바, outside 버튼, 핀 칩, 배지, 제목 아래 문장, 행 경로 / + 띠 |
| Monitoring | 7 | 11 | 위 6 + 옆 카드 경고 / + 띠, 불일치 배너, Edit at, Applies to, 저장 문구 (URL 주석 제외) |
| Paging | 7 | 10 | 위 6 + 레벨 칩 / + 띠, 상속 안내, Edit at |
| People | 6 | 10 | 위 6 / + 띠, 불일치 배너, Belongs to, 저장 문구 |
| Maintenance | 5~6 | 8 | 위 5~6 / + 띠, Applies to, 저장 문구 |

비교: D는 같은 상황(필터 Payments API, 고객 레벨 행 열기)에서 경고 없이 패널이 열리고 스크림이 필터를 가려 E보다 위험하다. C는 장치가 4종 정도로 가볍지만 고객 간 목록이 없다. E의 방향은 맞고, 양이 과하다.

## 4. 과설계 — 삭제·보류 목록 (3~5인 팀 PoC 기준)

| # | 항목 | 권고 | 이유 |
|---|---|---|---|
| 1 | 패널 2겹 스택(`o2`)과 겹별 히스토리 계산 | 삭제 | 범위 3개 동시 표시(P2-12)의 원인. 편집 중 인시던트는 새 탭이나 가드로 충분 |
| 2 | 초안 sessionStorage 보존 + "Draft for…" 배너 + Resume | 보류 | "저장 안 됨, 버릴까요?" 가드만 남김. 폼이 3~4칸이라 초안 복구 가치가 낮고 P2-5 같은 상태 불일치를 만듦 |
| 3 | 설정 저장에 대한 5분 Undo 배너 | 보류 | 백엔드 버전 관리가 필요하고 한 칸뿐이라 오해 소지(P2-7). Ack 토스트 Undo만 유지 |
| 4 | MSP 기본값 3단계 마법사 + 문구 입력 | 축소 | PoC에서는 콘솔에서 읽기 전용(설정 파일로 변경) 또는 미리보기 + 확인 1회 |
| 5 | "Outside this view" 전용 패널과 그 안의 Ack | 축소 | 카운터는 유지하되 클릭 시 Incidents 전체 목록으로 이동 |
| 6 | 필터 바의 Pinned·Recent 칩, 스위처의 핀 버튼 | 삭제 | 12고객이면 스위처 최근 목록으로 충분. 바에서 4칸 차지 |
| 7 | 배지 이중 숫자 "보기/전체" | 삭제 | 숫자 하나(P1-2 해결안 기준) |
| 8 | 스위처 행의 "Edit steps" 버튼, Shift+Enter | 보류 | 전문가 단축 경로. 파일럿 후 요구 있으면 추가 |
| 9 | 고객별 색상 띠 | 삭제 | 34고객에서 10색 반복이라 식별 수단이 못 됨. 모노그램 + 굵은 이름 유지 |
| 10 | 임계값·알람 패널의 "Edit at" 가짜 선택기(비활성 Project/Service 행) | 삭제 | 선택지가 없음. 한 문장으로 대체 |
| 11 | Monitoring 목록 옆 카드의 중복 경고 | 삭제 | 패널에 같은 내용(P2-15) |
| 12 | 연락처 마스킹·Reveal 기록 | 보류 | 범위 문제와 무관. security 요구가 있으면 별도 이슈 |
| 13 | 폰 전용 드릴다운 스위처 | 보류 | 검색 + 고객 목록으로 시작 |

**남겨야 하는 것**: 한 곳에 고정된 필터 바, 행마다 고객 굵게 + 전체 경로, 패널 띠, 저장 버튼의 전체 경로, 필터와 패널 불일치 배너, 사전 선택 없는 생성 게이트, 서비스 나열 확인창, 동명 자동 선택 금지, 포털 고객 잠금, 미저장 가드.

## 5. 판정

| 질문 | 답 |
|---|---|
| E로 진행해도 되는가 | 예, 조건부 |
| 구현 전 필수 | P1-1 (People의 Pageable 처리), P1-2 (My customers 기본값·카운터 정의), P1-3 (포털 404 동일화) |
| 구현 범위 | 4절 삭제 목록 적용 후의 E. 패널당 범위 표시 장치 6~7종으로 축소 |
| 첫 구현 때 같이 | P2-1, P2-2 (확인창에 변경 내용), P2-6 (링크 존재 확인), P2-8, P2-9 (폰) |
| 사용자 결정 필요 | P1-2의 기본값: (a) All customers 기본 + My 칩 — 추천, 3~5인 팀에 맞고 사각지대 없음 / (b) My 유지 + 담당 밖 카운터 상시 표시 / (c) 현행 유지 |
