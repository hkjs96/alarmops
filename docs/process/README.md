# D-60 개발 프로세스 파일

`.claude/`는 에이전트가 쓸 수 없게 막혀 있다(자기 규칙을 고치지 못하게). 그래서 초안을 여기에 두고 사람이 옮긴다.

| 초안 | 옮길 곳 |
|---|---|
| `claude-agents/verifier.md` | `.claude/agents/verifier.md` |
| `claude-agents/pr-auditor.md` | `.claude/agents/pr-auditor.md` |
| `dev-process.workflow.js` | `.claude/workflows/dev-process.js` |

옮긴 뒤에는 이 폴더의 초안을 지운다(두 벌이 어긋나지 않게).

워크플로 실행: 허브에게 "이슈 #N을 dev-process로" 라고 하면 `{issue, area, branch, task}`를 넣어 돌린다. 전체 단계가 필요한 PR(권한·IAM·DB·워크플로·새 기능)에만 쓴다.
