# D-60 개발 프로세스 파일

실제 파일은 `.claude/`에 있다. `.claude/`는 에이전트가 쓸 수 없게 막혀 있어(자기 규칙을 고치지 못하게), 바꿀 때는 허브가 초안을 PR로 올리고 사람이 `.claude/`로 옮긴다.

| 파일 | 역할 |
|---|---|
| `.claude/agents/verifier.md` | 5단계 기능 검증. 구현을 모르는 상태로 실제 실행 |
| `.claude/agents/pr-auditor.md` | 6단계 PR 감사. 기준↔테스트↔CI↔증거 대조 |
| `.claude/hooks/readonly-bash.mjs` | 두 에이전트의 Bash를 읽기·실행 명령으로 제한(`audit`/`verify`) |
| `.claude/workflows/dev-process.js` | 1~6단계 워크플로. 인자 `{issue, area, branch, task}` |

워크플로는 전체 단계가 필요한 PR(권한·IAM·DB·워크플로·새 기능)에만 쓴다.

## 형식 근거 (Claude Code 공식 문서 sub-agents, 11/24 확인)
- 파일 = YAML frontmatter + 본문(시스템 프롬프트). 필수는 `name`, `description`뿐이다.
- `description`은 "언제 맡길지"를 짧게. 모든 설명의 합이 15,000 토큰을 넘으면 경고가 난다.
- 도구는 필요한 것만 준다. "읽기 전용"은 본문 지시로 강제되지 않아 frontmatter `hooks.PreToolUse`로 Bash를 검사한다.
- `isolation: worktree`는 기본 브랜치에서 갈라진다.
- 모르는 필드는 오류 없이 무시된다. 필드 이름(camelCase)을 정확히 맞춘다.
- 출처: https://code.claude.com/docs/en/sub-agents
