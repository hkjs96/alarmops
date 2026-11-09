---
name: spec-check
description: 구현이 docs/specs/의 확정 명세와 docs/decisions/DECISIONS.md를 지키는지 대조한다. backend·console PR 머지 전, 또는 "명세와 맞는지 봐줘" 요청 시 사용.
---

# spec-check

1. PR 변경 파일을 보고 관련 명세(`docs/specs/*.md`, 상태가 "확정"인 것만)와 결정(D-xx)을 고른다.
2. 명세의 규칙 번호마다 구현 위치(파일:줄)와 테스트를 찾는다.
3. 표로 보고한다: 규칙 | 구현 위치 | 테스트 | 판정(일치 / 불일치 / 테스트 없음 / 해당 없음)
4. `docs/specs/known-bugs.md`의 과거 버그 중 이 변경과 관련된 것이 재발하지 않는지 확인한다.
5. 불일치나 테스트 없음이 있으면 허브에 수정 이슈를 제안한다. 명세가 틀렸다고 판단되면 명세를 고치지 말고 사용자에게 묻는다.
