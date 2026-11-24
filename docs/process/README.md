# D-60 개발 프로세스 파일

`.claude/`는 에이전트가 쓸 수 없게 막혀 있다(자기 규칙을 고치지 못하게). 그래서 초안을 여기에 두고 사람이 옮긴다.

| 초안 | 옮길 곳 |
|---|---|
| `claude-agents/verifier.md` | `.claude/agents/verifier.md` |
| `claude-agents/pr-auditor.md` | `.claude/agents/pr-auditor.md` |
| `claude-hooks/readonly-bash.mjs` | `.claude/hooks/readonly-bash.mjs` |
| `dev-process.workflow.js` | `.claude/workflows/dev-process.js` |

옮긴 뒤에는 이 폴더의 초안을 지운다(두 벌이 어긋나지 않게).

워크플로 실행: 허브에게 "이슈 #N을 dev-process로" 라고 하면 `{issue, area, branch, task}`를 넣어 돌린다. 전체 단계가 필요한 PR(권한·IAM·DB·워크플로·새 기능)에만 쓴다.

## 형식 근거 (Claude Code 공식 문서 sub-agents, 11/24 확인)
- 파일 = YAML frontmatter + 본문(시스템 프롬프트). 필수는 `name`, `description`뿐이다.
- `description`은 "언제 맡길지"를 짧게 쓴다. 모든 에이전트 설명의 합이 15,000 토큰을 넘으면 경고가 난다. 자세한 내용은 본문으로 옮긴다.
- 도구는 필요한 것만 준다(`tools` 허용 목록). "읽기 전용"을 본문에 적는 것만으로는 강제되지 않는다. 그래서 frontmatter의 `hooks.PreToolUse`로 Bash 명령을 검사한다(문서의 db-reader 예시와 같은 방식).
- `isolation: worktree`는 기본 브랜치에서 갈라진다. verifier는 그 안에서 PR 브랜치를 체크아웃한다.
- 모르는 필드는 오류 없이 무시된다. 필드 이름은 camelCase를 정확히 맞춘다(`maxTurns`, `disallowedTools`).
- 출처: https://code.claude.com/docs/en/sub-agents
