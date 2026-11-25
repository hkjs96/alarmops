export const meta = {
  name: 'dev-process',
  description: 'D-60 v3: 계획→테스트→구현→검수·수정→변형 검사→기능 검증. PR·CI·감사는 허브가 이어서 한다',
  whenToUse: '권한·IAM·DB·워크플로·새 기능처럼 D-60의 전체 단계가 필요한 이슈. 작은 PR은 허브가 직접 진행한다.',
  phases: [
    { title: 'Plan', detail: '계획과 수용 기준(태그: test/audit/deploy), 독립 검수(최대 2회)' },
    { title: 'Tests', detail: '[test] 기준만 테스트로, 구현 전 red가 정상' },
    { title: 'Implement', detail: '테스트 브랜치에서 구현(worktree), 테스트 파일 수정 금지' },
    { title: 'Review', detail: '코드 검수 + 보안, [차단]이면 구현자가 고치고 좁힌 재검수(최대 2회)' },
    { title: 'Mutate', detail: '다른 에이전트가 핵심 조건을 일부러 망가뜨려 테스트가 잡는지 확인' },
    { title: 'Verify', detail: '구현을 모르는 verifier가 실제 실행으로 확인' },
  ],
}
// args: { issue, area: 'backend'|'console'|'infra', branch, task,
//         plan?, criteria?, planNotes?      허브가 확정한 계획이면 Plan 건너뜀
//         testsBranch?, testsCommit?, testNotes?  허브가 테스트를 통과로 판정했으면 Tests 건너뜀
//         hints?, testHints?                허브 판정(반려 사유에 대한)
//         env?: ['ALARM_ENGINE_TEST_PG_URL=...']  에이전트에게 줄 시험 환경(로컬 DB 등) }
// 기준 태그: 문장 앞에 [test] [audit] [deploy]. 태그가 없으면 [test].
//   [test]   테스트로 확인(Tests 단계 대상)
//   [audit]  커밋 순서·diff 범위·권한 추가분처럼 git으로 확인(허브의 PR 감사 대상, 테스트로 만들지 않음)
//   [deploy] 실제 AWS·배포 후에만 확인(verifier는 UNVERIFIABLE + 확인 방법)
// 이 워크플로는 PR을 열지 않는다. 끝나면 허브가 PR을 열고 CI를 기다린 뒤 pr-auditor로 감사한다(CI 증거 포함).
const A = args || {}
if (!A.issue || !A.area || !A.branch || !A.task) throw new Error('args: issue, area, branch, task 필요')
const TEST_BRANCH = `${A.branch}-tests`
const MAX_ROUNDS = 2
const ENV = (A.env && A.env.length) ? `\n시험 환경(실데이터 없음, 자유롭게 써도 됨):\n- ${A.env.join('\n- ')}\n` : ''

const PLAN = { type: 'object', required: ['plan', 'criteria'], properties: {
  plan: { type: 'string' },
  criteria: { type: 'array', items: { type: 'string' }, description: '[test]/[audit]/[deploy] 태그로 시작하는 검사 가능한 문장' } } }
const REVIEW = { type: 'object', required: ['blocking', 'notes'], properties: {
  blocking: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } } } }
const BRANCH = { type: 'object', required: ['branch', 'commit'], properties: {
  branch: { type: 'string' }, commit: { type: 'string' }, summary: { type: 'string' } } }
const MUTATE = { type: 'object', required: ['results'], properties: {
  results: { type: 'array', items: { type: 'object', required: ['mutation', 'caught'], properties: {
    mutation: { type: 'string' }, caught: { type: 'boolean' }, failingTests: { type: 'array', items: { type: 'string' } } } } } } }
const VERIFY = { type: 'object', required: ['results'], properties: {
  results: { type: 'array', items: { type: 'object', required: ['criterion', 'status', 'evidence'], properties: {
    criterion: { type: 'string' }, status: { enum: ['PASS', 'FAIL', 'UNVERIFIABLE', 'NOT_CHECKED'] }, evidence: { type: 'string' } } } },
  extraDefects: { type: 'array', items: { type: 'string' } } } }

const tagOf = c => (c.match(/^\s*\[(test|audit|deploy)\]/i) || [null, 'test'])[1].toLowerCase()
const NARROW = prev => `재검수다. [차단]은 두 가지만 낸다: (1) 아래 이전 [차단] 중 해결 안 된 것, (2) 새로 생긴 보안 결함·명세 위반·` +
  `결함을 못 잡는 테스트(거짓 통과). 그 밖은 notes([권고])로만. 이전 [차단]:\n- ${prev.join('\n- ')}\n`
const EVIDENCE = '[차단]마다 원문 파일:줄 근거를 붙여라(근거 없는 [차단]은 무효). '

// 만든 쪽 → 검수 → 반려 시 고쳐서 다시(좁힌 재검수), 최대 MAX_ROUNDS. 넘으면 멈추고 허브에게.
async function produceAndReview(phaseName, produce, review) {
  let out = await produce(null)
  let prev = null
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await review(out, prev)
    if (!r || r.blocking.length === 0) return { out, review: r }
    log(`${phaseName}: 반려 ${round}회 - ${r.blocking.length}건`)
    if (round === MAX_ROUNDS) throw new Error(`${phaseName}: ${MAX_ROUNDS}회 반려, 허브 판정 필요\n- ` + r.blocking.join('\n- '))
    prev = r.blocking
    out = await produce(r.blocking)
  }
}

phase('Plan')
const planned = (A.plan && A.criteria) ? (log('허브가 확정한 계획 사용 (Plan 건너뜀)'),
  { out: { plan: A.plan, criteria: A.criteria }, review: { blocking: [], notes: A.planNotes || [] } }) : await produceAndReview('Plan',
  fix => agent(`이슈 #${A.issue}: ${A.task}\n담당 영역: ${A.area}. docs/specs·DECISIONS.md를 읽고 계획과 수용 기준을 써라. ` +
    `수용 기준은 검사 가능한 문장으로 쓰고 앞에 태그를 붙인다: [test] 테스트로 확인, [audit] git diff·log로 확인(커밋 순서·권한 추가분·하드코딩 등), ` +
    `[deploy] 실제 배포 후에만 확인. 권한·격리·실패·되돌리기 경우를 빠뜨리지 마라.` +
    (A.hints ? `\n허브 판정(반드시 반영):\n- ${A.hints.join('\n- ')}` : '') +
    (fix ? `\n검수자의 반려 사유다. 검수자도 틀릴 수 있다. 원문을 직접 확인해 맞으면 고치고, 틀리면 고치지 말고 plan 끝에 '반박:'으로 근거를 적어라:\n- ${fix.join('\n- ')}` : ''),
    { phase: 'Plan', schema: PLAN }),
  (p, prev) => agent((prev ? NARROW(prev) : '') + `다른 에이전트가 쓴 계획이다. 틀렸다고 가정하고 검수하라. ${EVIDENCE}` +
    `명세(docs/specs)·결정(D-xx)과 어긋나는 점, 빠진 경우, 검사할 수 없는 기준, 태그가 틀린 기준을 [차단]으로. ` +
    `계획의 '반박:'이 원문으로 맞으면 그 지적은 다시 내지 마라.\n계획:\n${p.plan}\n수용 기준:\n- ${p.criteria.join('\n- ')}`,
    { phase: 'Plan', schema: REVIEW, agentType: 'Plan' }))
const criteria = planned.out.criteria
const testCriteria = criteria.filter(c => tagOf(c) === 'test')
const planNotes = (planned.review && planned.review.notes) || []

phase('Tests')
const tests = (A.testsBranch && A.testsCommit) ? (log('허브가 테스트를 통과로 판정 (Tests 건너뜀)'),
  { out: { branch: A.testsBranch, commit: A.testsCommit }, review: { blocking: [], notes: A.testNotes || [] } }) : await produceAndReview('Tests',
  fix => agent((A.testHints ? `허브 판정(반드시 반영):\n- ${A.testHints.join('\n- ')}\n` : '') + ENV +
    `origin/main에서 브랜치 ${TEST_BRANCH}를 만들어(이미 있으면 그 위에서) 아래 [test] 기준의 테스트만 작성하라. 기능 코드는 건드리지 마라. ` +
    `구현의 출력을 기대값으로 쓰지 마라(기준에서 기대값을 끌어내라). CI가 실제로 실행하는 형식·위치로 써라. 테스트만 커밋하고 push하라.` +
    `\n[test] 기준:\n- ${testCriteria.join('\n- ')}` + (fix ? `\n검수 반려 사유를 고쳐라:\n- ${fix.join('\n- ')}` : ''),
    { phase: 'Tests', schema: BRANCH, agentType: A.area, isolation: 'worktree' }),
  (b, prev) => agent((prev ? NARROW(prev) : '') + `브랜치 ${b.branch}(커밋 ${b.commit})의 테스트를 검수하라. 다른 에이전트가 썼고 틀렸다고 가정하라. ${EVIDENCE}` +
    `git fetch 후 diff만 읽어라. 주의: 아직 구현 전이므로 **테스트가 실패하는 것은 정상**이다(실패 이유가 문법 오류가 아니라 단언·구현 부재여야 한다). ` +
    `[차단]: [test] 기준 중 테스트가 없는 것, 동어반복(구현 출력을 기대값으로 씀), 과도한 mock, 결함을 못 잡는 단언, CI에서 실행되지 않는 위치·형식. ` +
    `[audit]·[deploy] 기준은 이 단계 대상이 아니다.\n[test] 기준:\n- ${testCriteria.join('\n- ')}`,
    { phase: 'Tests', schema: REVIEW, agentType: 'qa-ux' }))

phase('Implement')
const implPrompt = fix => ENV + `브랜치 ${tests.out.branch}(테스트 커밋 ${tests.out.commit})에서 시작해 ${A.branch}를 만들고(이미 있으면 git fetch 후 그 위에서) 구현하라. ` +
  `worktree는 main에서 갈라지므로 반드시 git fetch origin ${tests.out.branch} 후 그 커밋에서 시작하라. ` +
  (planNotes.length ? `계획 검수의 [권고](가능하면 반영):\n- ${planNotes.join('\n- ')}\n` : '') +
  `테스트 파일은 수정하지 마라. 테스트가 틀렸다고 판단되면 고치지 말고 summary에 이유를 적어라. 테스트·린트·타입 검사를 실제로 돌려 통과시킨 뒤 push하라. ` +
  `summary에는 실행한 명령과 결과 끝 몇 줄을 원문으로 적어라.\n계획:\n${planned.out.plan}` +
  (fix ? `\n코드 검수 [차단]을 고쳐라(각 [차단]을 잡는 테스트를 추가해도 된다 — 그 테스트는 재검수를 받는다):\n- ${fix.join('\n- ')}` : '')
const reviewed = await produceAndReview('Review',
  fix => agent(implPrompt(fix), { phase: fix ? 'Review' : 'Implement', schema: BRANCH, agentType: A.area, isolation: 'worktree' }),
  async (b, prev) => {
    const [code, sec] = await parallel([
      () => agent((prev ? NARROW(prev) : '') + `브랜치 ${b.branch}(커밋 ${b.commit})의 diff(origin/main 대비)만 보고 검수하라. 작성자의 설명은 없다. 틀렸다고 가정하라. ${EVIDENCE}` +
        `정확성·실패 처리·테넌트 조건·D-xx 위반·결함을 못 잡는 새 테스트를 [차단]으로.`, { phase: 'Review', schema: REVIEW }),
      () => agent((prev ? NARROW(prev) : '') + `브랜치 ${b.branch}(커밋 ${b.commit})의 diff(origin/main 대비)를 보안 검토하라. ${EVIDENCE}`,
        { phase: 'Review', schema: REVIEW, agentType: 'security' }),
    ])
    const ok = x => x || { blocking: [], notes: ['검수 결과 없음'] }
    return { blocking: [...ok(code).blocking, ...ok(sec).blocking], notes: [...ok(code).notes, ...ok(sec).notes] }
  })
const impl = reviewed.out

phase('Mutate')
const mutated = await agent(ENV + `브랜치 ${impl.branch}(커밋 ${impl.commit})를 새로 체크아웃해 변형 검사를 하라. 구현한 에이전트가 아니다. ` +
  `아래 [test] 기준이 지키려는 **핵심 조건**(권한·격리·필터·실패 처리) 3~5곳을 골라, 한 곳씩 일부러 망가뜨리고(조건 삭제·반전·범위 확대) 관련 테스트를 돌려라. ` +
  `각 변형마다 caught(테스트가 실패했는가)와 실패한 테스트 이름을 적고, 반드시 원복하라. 커밋·push하지 마라.\n[test] 기준:\n- ${testCriteria.join('\n- ')}`,
  { phase: 'Mutate', schema: MUTATE })
const uncaught = ((mutated && mutated.results) || []).filter(r => !r.caught)
if (uncaught.length) log(`변형 검사: 잡히지 않은 변형 ${uncaught.length}건 - 허브가 테스트 보강 여부를 판단`)

phase('Verify')
const verified = await agent(ENV + `검증할 브랜치: ${impl.branch}(커밋 ${impl.commit})\n` +
  `턴이 제한돼 있다. 직접 실행이 필요한 기준부터 확인하고, CI 테스트로 충분히 덮이는 기준은 해당 테스트를 돌려 PASS(test)로 적어라. 못 본 것은 NOT_CHECKED. ` +
  `[audit] 기준은 건너뛰고(허브 감사 대상), [deploy] 기준은 UNVERIFIABLE + 배포 후 확인 방법.\n수용 기준:\n- ${criteria.join('\n- ')}`,
  { phase: 'Verify', schema: VERIFY, agentType: 'verifier' })

return { issue: A.issue, branch: impl.branch, commit: impl.commit, testsBranch: tests.out.branch, testsCommit: tests.out.commit,
  criteria, review: reviewed.review, mutation: mutated, uncaughtMutations: uncaught, verify: verified,
  next: '허브: PR 열기(gate:needs-ci) → CI 대기 → pr-auditor(기준↔테스트↔CI↔검증, [audit] 기준은 git으로) → 판정 근거 댓글 → gate:ready 또는 gate:blocked/needs-human-step → 사용자 병합 승인' }
