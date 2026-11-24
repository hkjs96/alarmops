export const meta = {
  name: 'dev-process',
  description: 'D-60 단계별 개발: 계획→테스트→개발→코드 검수→기능 검증→PR 감사, 단계마다 다른 에이전트가 검수',
  whenToUse: '권한·IAM·DB·워크플로·새 기능처럼 D-60의 전체 단계가 필요한 이슈. 작은 PR은 허브가 직접 진행한다.',
  phases: [
    { title: 'Plan', detail: '계획과 검사 가능한 수용 기준, 독립 검수(최대 2회 반려)' },
    { title: 'Tests', detail: '수용 기준에서 테스트 작성(worktree), 독립 검수' },
    { title: 'Implement', detail: '테스트 브랜치에서 시작해 구현(worktree), 테스트 파일 수정 금지' },
    { title: 'Review', detail: '코드 검수 + 보안 검토, diff만 받음' },
    { title: 'Verify', detail: '구현을 모르는 verifier가 실제 실행으로 확인' },
    { title: 'Audit', detail: '기준↔테스트↔CI↔증거 대조' },
  ],
}
// args: { issue: 123, area: 'backend'|'console'|'infra', branch: 'agent/123-short-name', task: '이슈 요약' }
const A = args || {}
if (!A.issue || !A.area || !A.branch || !A.task) throw new Error('args: issue, area, branch, task 필요')
const TEST_BRANCH = `${A.branch}-tests`
const MAX_ROUNDS = 2

const PLAN = { type: 'object', required: ['plan', 'criteria'], properties: {
  plan: { type: 'string' },
  criteria: { type: 'array', items: { type: 'string' }, description: '검사 가능한 문장. 무엇을 하면 무엇이 관찰되는가' } } }
const REVIEW = { type: 'object', required: ['blocking', 'notes'], properties: {
  blocking: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } } } }
const BRANCH = { type: 'object', required: ['branch', 'commit'], properties: {
  branch: { type: 'string' }, commit: { type: 'string' }, summary: { type: 'string' } } }
const VERIFY = { type: 'object', required: ['results'], properties: {
  results: { type: 'array', items: { type: 'object', required: ['criterion', 'status', 'evidence'], properties: {
    criterion: { type: 'string' }, status: { enum: ['PASS', 'FAIL', 'UNVERIFIABLE'] }, evidence: { type: 'string' } } } },
  extraDefects: { type: 'array', items: { type: 'string' } } } }
const AUDIT = { type: 'object', required: ['verdict', 'blocking'], properties: {
  verdict: { enum: ['READY', 'BLOCKED'] }, blocking: { type: 'array', items: { type: 'string' } }, table: { type: 'string' } } }

// 만든 쪽 → 검수 → 반려 시 고쳐서 다시, 최대 MAX_ROUNDS. 넘으면 멈추고 사람에게.
async function produceAndReview(phaseName, produce, review) {
  let out = await produce(null)
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await review(out)
    if (!r || r.blocking.length === 0) return { out, review: r }
    log(`${phaseName}: 반려 ${round}회 — ${r.blocking.length}건`)
    if (round === MAX_ROUNDS) throw new Error(`${phaseName}: ${MAX_ROUNDS}회 반려, 사용자 보고 필요\n- ` + r.blocking.join('\n- '))
    out = await produce(r.blocking)
  }
}

phase('Plan')
const planned = await produceAndReview('Plan',
  fix => agent(`이슈 #${A.issue}: ${A.task}\n담당 영역: ${A.area}. docs/specs·DECISIONS.md를 읽고 계획과 수용 기준을 써라. ` +
    `수용 기준은 검사 가능한 문장으로(무엇을 하면 무엇이 관찰되는가). 권한·격리·실패·되돌리기 경우를 빠뜨리지 마라.` +
    (fix ? `\n이전 계획의 반려 사유를 고쳐라:\n- ${fix.join('\n- ')}` : ''), { phase: 'Plan', schema: PLAN }),
  p => agent(`다른 에이전트가 쓴 계획이다. 틀렸다고 가정하고 검수하라. 명세(docs/specs)·결정(D-xx)과 어긋나는 점, ` +
    `빠진 경우, 검사할 수 없는 수용 기준을 [차단]으로 적어라.\n계획:\n${p.plan}\n수용 기준:\n- ${p.criteria.join('\n- ')}`,
    { phase: 'Plan', schema: REVIEW, agentType: 'Plan' }))
const criteria = planned.out.criteria

phase('Tests')
const tests = await produceAndReview('Tests',
  fix => agent(`origin/main에서 브랜치 ${TEST_BRANCH}를 만들어 아래 수용 기준의 테스트만 작성하라. 기능 코드는 건드리지 마라. ` +
    `구현의 출력을 기대값으로 쓰지 마라(기준에서 기대값을 끌어내라). 테스트만 커밋하고 push하라.\n수용 기준:\n- ${criteria.join('\n- ')}` +
    (fix ? `\n검수 반려 사유를 고쳐라:\n- ${fix.join('\n- ')}` : ''),
    { phase: 'Tests', schema: BRANCH, agentType: A.area, isolation: 'worktree' }),
  b => agent(`브랜치 ${b.branch}(커밋 ${b.commit})의 테스트를 검수하라. 다른 에이전트가 썼고 틀렸다고 가정하라. ` +
    `git fetch 후 diff만 읽어라. [차단]: 수용 기준 중 테스트가 없는 것, 동어반복(구현 출력을 기대값으로 씀), 과도한 mock, 중복.` +
    `\n수용 기준:\n- ${criteria.join('\n- ')}`, { phase: 'Tests', schema: REVIEW, agentType: 'qa-ux' }))

phase('Implement')
const impl = await agent(`브랜치 ${tests.out.branch}(테스트 커밋 ${tests.out.commit})에서 시작해 ${A.branch}를 만들고 구현하라. ` +
  `주의: worktree는 main에서 갈라지므로 반드시 git fetch origin ${tests.out.branch} 후 그 커밋에서 브랜치를 만들어라. ` +
  `테스트 파일은 수정하지 마라. 테스트가 틀렸다고 판단되면 구현하지 말고 그 이유만 summary에 적어라. 테스트·타입 검사를 통과시킨 뒤 push하라.` +
  `\n계획:\n${planned.out.plan}`, { phase: 'Implement', schema: BRANCH, agentType: A.area, isolation: 'worktree' })
if (!impl) throw new Error('Implement: 결과 없음')

phase('Review')
const [code, sec] = await parallel([
  () => agent(`브랜치 ${impl.branch}의 diff(origin/main 대비)만 보고 코드를 검수하라. 작성자의 설명은 없다. 틀렸다고 가정하라. ` +
    `정확성·실패 처리·테넌트 조건·D-xx 위반을 [차단]으로.`, { phase: 'Review', schema: REVIEW }),
  () => agent(`브랜치 ${impl.branch}의 diff(origin/main 대비)를 보안 검토하라.`, { phase: 'Review', schema: REVIEW, agentType: 'security' }),
])

phase('Verify')
const verified = await agent(`검증할 브랜치: ${impl.branch}\n수용 기준:\n- ${criteria.join('\n- ')}`,
  { phase: 'Verify', schema: VERIFY, agentType: 'verifier' })

phase('Audit')
const audit = await agent(`PR 감사. 브랜치 ${impl.branch}, 테스트 브랜치 ${tests.out.branch}(커밋 ${tests.out.commit}).\n` +
  `수용 기준:\n- ${criteria.join('\n- ')}\n검수 결과(자기 보고가 아니라 각 검수자의 출력):\n` +
  JSON.stringify({ testReview: tests.review, codeReview: code, security: sec, verify: verified }),
  { phase: 'Audit', schema: AUDIT, agentType: 'pr-auditor' })

return { issue: A.issue, branch: impl.branch, criteria, codeReview: code, security: sec, verify: verified, audit }
