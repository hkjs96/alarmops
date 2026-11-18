// Hand-drawn SVG figures for the docs portal. Facts come from docs/decisions/DECISIONS.md, docs/GO-LIVE.md and
// infra/aws/central.yaml; when those change, change the figure too.
// Colors come from page CSS classes (theme tokens), so every figure works in light and dark.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- primitives -------------------------------------------------------------------------------------------------
function box({ x, y, w, h = 46, title, sub, kind = '' }) {
  const cy = sub ? y + h / 2 - 7 : y + h / 2 + 4.5;
  return `<g class="node ${kind}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>` +
    `<text x="${x + w / 2}" y="${cy}" text-anchor="middle" class="nt">${esc(title)}</text>` +
    (sub ? `<text x="${x + w / 2}" y="${cy + 17}" text-anchor="middle" class="ns">${esc(sub)}</text>` : '') + '</g>';
}
function zone({ x, y, w, h, title, kind = '' }) {
  return `<g class="zone ${kind}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/>` +
    `<text x="${x + 16}" y="${y + 24}" class="zt">${esc(title)}</text></g>`;
}
// orthogonal arrow through the given points; label sits at `at` (index of segment) with optional offset
function arrow(pts, { label, at = 0, dx = 0, dy = -7, kind = '', anchor = 'middle', dashed = false } = {}) {
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  let lab = '';
  if (label) {
    const [a, b] = [pts[at], pts[at + 1]];
    const lx = (a[0] + b[0]) / 2 + dx, ly = (a[1] + b[1]) / 2 + dy;
    lab = `<text x="${lx}" y="${ly}" text-anchor="${anchor}" class="al">${esc(label)}</text>`;
  }
  return `<g class="edge ${kind}${dashed ? ' dashed' : ''}"><path d="${d}" marker-end="url(#ah-${kind || 'base'})"/>${lab}</g>`;
}
let seq = 0;
const defsFor = (n) => `<defs>
<marker id="ah-base-${n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ahb"/></marker>
<marker id="ah-hot-${n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ahh"/></marker>
<marker id="ah-cold-${n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ahc"/></marker>
</defs>`;
const svg = (w, h, label, body) => {
  const n = ++seq;
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" class="fig-svg">${defsFor(n)}${body.replace(/url\(#ah-(\w+)\)/g, `url(#ah-$1-${n})`)}</svg>`;
};
const figure = (id, title, caption, svgMarkup, legend = '') =>
  `<figure class="fig" id="${id}"><figcaption class="fig-h">${esc(title)}</figcaption><div class="fig-scroll">${svgMarkup}</div>` +
  `${legend}<p class="fig-cap">${caption}</p></figure>`;

// ---- 1. architecture ----------------------------------------------------------------------------------------------
export function architecture() {
  const A = { x: 16, w: 226 }, nA = { x: 34, w: 190 };
  const L1 = 300, L2 = 512, LW = 180;           // central lanes
  const C = { x: 750, w: 274 }, nC = { x: 768, w: 238 };
  const r = (y) => y + 23;                      // vertical centre of a 46px node
  const body = [
    zone({ x: A.x, y: 20, w: A.w, h: 560, title: '고객 계정 · 환경' }),
    zone({ x: 282, y: 20, w: 428, h: 560, title: '중앙 AWS 계정 (서울)', kind: 'z-aws' }),
    zone({ x: C.x - 18, y: 20, w: C.w + 26, h: 560, title: 'Vercel + Supabase (서울)', kind: 'z-host' }),

    box({ ...nA, y: 64, title: 'Prometheus · Grafana', sub: '웹훅' }),
    box({ ...nA, y: 164, title: 'CloudWatch 알람', sub: '상태 변경' }),
    box({ x: nA.x + 72, w: nA.w - 72, y: 234, title: '태그 변경', sub: 'CloudTrail' }),
    box({ ...nA, y: 324, title: 'EventBridge 규칙', sub: 'AlarmOps-*' }),
    box({ ...nA, y: 404, title: 'EventForwarder 역할', sub: 'events:PutEvents 하나' }),
    box({ ...nA, y: 504, title: 'AlarmWriter · Reader', sub: '고객이 설치한 역할', kind: 'role' }),

    box({ x: L1, w: LW, y: 64, title: '웹훅 API', sub: 'Lambda' }),
    box({ x: L1, w: LW, y: 264, title: '수집 Lambda', sub: 'EventBridge 입력' }),
    box({ x: L1, w: LW, y: 404, title: '중앙 버스', sub: '허용 계정만 받음' }),
    box({ x: L2, w: LW, y: 164, title: '소비 Lambda', sub: 'DB에 기록' }),
    box({ x: L2, w: LW, y: 264, title: 'alert-events', sub: 'SQS + DLQ', kind: 'queue' }),
    box({ x: L2, w: LW, y: 404, title: 'alarm-commands', sub: '표준 SQS + DLQ', kind: 'queue' }),
    box({ x: L2, w: LW, y: 504, title: '알람 엔진 Lambda', sub: '수집기 29종' }),

    box({ ...nC, y: 164, title: 'Supabase Postgres', sub: '인시던트 · 호출 기록 · pg_cron', kind: 'store' }),
    box({ ...nC, y: 294, title: '콘솔 · API', sub: 'Next.js on Vercel' }),
    box({ ...nC, y: 424, h: 72, title: '알림 발송', sub: 'Slack · SES 이메일 · 문자/전화(보류)', kind: 'out' }),

    // alarm path (hot)
    arrow([[nA.x + 36, 210], [nA.x + 36, 324]], { kind: 'hot' }),
    arrow([[nA.x + nA.w / 2, 370], [nA.x + nA.w / 2, 404]], { kind: 'hot' }),
    arrow([[nA.x + nA.w, r(404)], [L1, r(404)]], { label: 'PutEvents', kind: 'hot' }),
    arrow([[L1 + 60, 404], [L1 + 60, 310]], { label: '알람 규칙', dx: -8, dy: 4, anchor: 'end', kind: 'hot' }),
    arrow([[L1 + LW, r(264)], [L2, r(264)]], { kind: 'hot' }),
    arrow([[L2 + LW / 2, 264], [L2 + LW / 2, 210]], { kind: 'hot' }),
    arrow([[L2 + LW, r(164)], [nC.x, r(164)]], { label: '인시던트 기록', kind: 'hot' }),
    // webhook path
    arrow([[nA.x + nA.w, r(64)], [L1, r(64)]], { label: 'HTTPS', kind: 'hot' }),
    arrow([[L1 + LW, r(64)], [L2 + 140, r(64)], [L2 + 140, 264]], { kind: 'hot' }),
    // tag path → commands → engine → customer
    arrow([[nA.x + 131, 280], [nA.x + 131, 324]], {}),
    arrow([[L1 + LW, r(404)], [L2, r(404)]], { label: '태그 규칙', }),
    arrow([[L2 + LW / 2, 450], [L2 + LW / 2, 504]], {}),
    arrow([[L2, r(504)], [nA.x + nA.w, r(504)]], { label: 'AssumeRole + ExternalId', }),
    // console ↔ db, tick, notify, offboarding command
    arrow([[nC.x + 70, 210], [nC.x + 70, 294]], { label: '1분 틱', dx: -8, dy: 4, anchor: 'end', kind: 'hot' }),
    arrow([[nC.x + 168, 294], [nC.x + 168, 210]], { label: '읽기·쓰기', dx: 8, dy: 4, anchor: 'start' }),
    arrow([[nC.x + nC.w / 2, 340], [nC.x + nC.w / 2, 424]], { label: '호출 순서대로', dx: 8, dy: 4, anchor: 'start', kind: 'hot' }),
    arrow([[nC.x, 330], [728, 330], [728, r(404)], [L2 + LW, r(404)]], { label: '해지 명령', at: 1, dx: 8, dy: 4, anchor: 'start' }),
    `<text x="736" y="${(330 + r(404)) / 2 + 20}" class="al left">OIDC</text>`,
  ].join('');
  return figure('fig-architecture', '시스템 한눈에',
    '주황 선이 알람이 사람에게 닿는 길이다. 고객 계정의 알람은 EventBridge와 중앙 버스를 거쳐 SQS에 쌓이고, 소비 Lambda가 Supabase에 인시던트로 기록한다. 1분마다 pg_cron이 콘솔의 틱을 불러 호출 순서대로 알림을 보낸다. 회색 선은 알람을 만들고 지우는 길(태그 변경, 해지 명령 → 알람 엔진 → 고객 역할)이다. (D-09, D-22, D-23, D-47, D-48, D-49)',
    svg(1040, 600, '고객 계정에서 중앙 AWS를 거쳐 Supabase와 콘솔, 알림 발송까지 이어지는 AlarmOps 구성도', body),
    `<ul class="legend"><li><span class="sw hot"></span>알람 → 사람</li><li><span class="sw base"></span>알람 관리·명령</li><li><span class="sw q"></span>SQS 큐</li></ul>`);
}

// ---- 2. alarm → ack flow -------------------------------------------------------------------------------------------
export function incidentFlow() {
  const y = 70, W = 132, G = 26;
  const xs = [16, 16 + (W + G), 16 + 2 * (W + G), 16 + 3 * (W + G), 16 + 4 * (W + G), 16 + 5 * (W + G)];
  const c = (i) => xs[i] + W / 2;
  const body = [
    box({ x: xs[0], y, w: W, h: 58, title: '알람 수신', sub: 'CloudWatch · 웹훅' }),
    box({ x: xs[1], y, w: W, h: 58, title: '억제 판단', sub: '점검 창·뮤트' }),
    box({ x: xs[2], y, w: W, h: 58, title: '인시던트로 묶기', sub: '지문 · 그룹' }),
    box({ x: xs[3], y, w: W, h: 58, title: '고객 상태', sub: 'ACTIVE만 호출' }),
    box({ x: xs[4], y, w: W, h: 58, title: '호출 단계', sub: '사람·당번·전원', kind: 'out' }),
    box({ x: xs[5], y, w: W, h: 58, title: 'Ack', sub: '에스컬레이션 정지', kind: 'ok' }),
    ...[0, 1, 2, 3, 4].map((i) => arrow([[xs[i] + W, y + 29], [xs[i + 1], y + 29]], { kind: 'hot' })),
    // escalation loop under step box
    arrow([[c(4) + 30, y + 58], [c(4) + 30, y + 112], [c(4) - 30, y + 112], [c(4) - 30, y + 58]], { label: '무응답 → 다음 단계', at: 1, dy: 18 }),
    // branches
    box({ x: xs[1], y: 220, w: W, h: 52, title: '기록만', sub: '알림 없음', kind: 'muted' }),
    box({ x: xs[3], y: 220, w: W, h: 52, title: '정지 고객', sub: '10:00 요약으로', kind: 'muted' }),
    box({ x: xs[5], y: 220, w: W, h: 52, title: '해결', sub: '기록 · 보관', kind: 'ok' }),
    arrow([[c(1), y + 58], [c(1), 220]], { label: 'SEV-2 이하', dx: 8, dy: 4, anchor: 'start', dashed: true }),
    arrow([[c(3), y + 58], [c(3), 220]], { label: 'SUSPENDED', dx: 8, dy: 4, anchor: 'start', dashed: true }),
    arrow([[c(5), y + 58], [c(5), 220]], {}),
    `<text x="${c(1)}" y="${y - 14}" text-anchor="middle" class="al strong">SEV-1은 점검 창도 통과</text>`,
    `<text x="${c(5)}" y="${y - 14}" text-anchor="middle" class="al strong">인시던트 단위 1번</text>`,
  ].join('');
  return figure('fig-flow', '알람이 울리면',
    '알람은 억제 판단을 거쳐 인시던트로 묶이고, 고객이 ACTIVE일 때만 호출 단계가 돈다. 단계마다 정해진 시간 안에 Ack가 없으면 다음 단계로 넘어가고(기본 1회 반복), Ack 한 번이면 묶인 알림 전체의 에스컬레이션이 멈춘다. 점검 창 중에는 SEV-1만 울린다. (D-17, D-20, D-24, D-30, D-43)',
    svg(1000, 300, '알람 수신부터 억제 판단, 인시던트 묶기, 고객 상태 확인, 호출 단계, Ack, 해결까지의 흐름', body));
}

// ---- 3. customer stack roles -------------------------------------------------------------------------------------
export function customerRoles() {
  const rows = [
    ['Reader', '필수', '리소스·알람 읽기 (연결 확인)'],
    ['AlarmWriter', '선택', 'ManagedBy=AlarmOps 알람만 생성·수정·삭제'],
    ['TagWriter', '선택', 'Monitoring 태그 키만'],
    ['Remediator', '선택 · 기본 꺼짐', 'EC2·RDS 중지, ELB 삭제 — Slack 승인 후'],
  ];
  const y0 = 56, rh = 58;
  const body = [
    zone({ x: 16, y: 16, w: 250, h: 340, title: '중앙 AWS 계정', kind: 'z-aws' }),
    zone({ x: 330, y: 16, w: 694, h: 340, title: '고객 AWS 계정 — 연결 스택 하나' }),
    box({ x: 40, y: 150, w: 200, h: 58, title: '중앙 역할', sub: '알람 엔진이 사용' }),
    box({ x: 40, y: 289, w: 200, h: 52, title: '중앙 버스', sub: '이벤트 받는 곳', kind: 'queue' }),
    ...rows.map(([n, req, what], i) => {
      const y = y0 + i * rh;
      return box({ x: 420, y, w: 168, h: 46, title: n, sub: req, kind: req === '필수' ? 'role' : 'role opt' }) +
        `<text x="604" y="${y + 28}" class="al left">${esc(what)}</text>`;
    }),
    ...rows.map((_, i) => arrow([[240, 179], [300, 179], [300, y0 + i * rh + 23], [420, y0 + i * rh + 23]], {})),
    `<text x="140" y="230" text-anchor="middle" class="al">AssumeRole + ExternalId →</text>`,
    box({ x: 420, y: 292, w: 168, h: 46, title: 'EventForwarder', sub: '필수', kind: 'role' }),
    `<text x="604" y="320" class="al left">고객 EventBridge가 맡음 → 중앙 버스에 PutEvents만</text>`,
    arrow([[420, 315], [240, 315]], { label: 'PutEvents', dy: -8, kind: 'hot' }),
  ].join('');
  return figure('fig-roles', '고객 계정에 설치하는 역할',
    '고객은 CloudFormation 스택 하나로 역할 다섯 개를 받는다. Reader·EventForwarder는 필수, 나머지는 고객이 고른다. 중앙 역할만 ExternalId로 역할을 맡을 수 있다. EventForwarder는 고객 계정의 EventBridge가 맡으므로 ExternalId 대신 계정·규칙 ARN으로 묶는다. (D-07, D-15, D-16, D-43, D-47)',
    svg(1040, 372, '중앙 역할이 ExternalId로 고객 계정의 Reader, AlarmWriter, TagWriter, Remediator 역할을 맡고, EventForwarder는 중앙 버스로 이벤트를 보내는 구성', body));
}

// ---- 4. go-live roadmap (HTML, not SVG) -------------------------------------------------------------------------
// state: done | human | wait | blocked
export const ROADMAP = [
  { n: 1, title: '결정', who: '사람', state: 'human', note: 'SES·도메인 확정. Slack 앱, Google SSO 시점, 파일럿 고객이 남음', anchor: '1단계' },
  { n: 2, title: 'GitHub·DB 기반', who: '사람', state: 'human', note: 'main 보호, 회사 PC .env, 실제 DB로 콘솔 확인', anchor: '2단계' },
  { n: 3, title: '콘솔 배포', who: '에이전트 → 사람', state: 'human', note: '배포 워크플로 완료(#54). Vercel 프로젝트·토큰·환경 만들기', anchor: '3단계' },
  { n: 4, title: 'AWS 중앙 계정', who: '에이전트 → 사람', state: 'human', note: '템플릿·Lambda 묶음 완료(#52·#53). OIDC·배포 역할·승인 실행', anchor: '4단계' },
  { n: 5, title: '알림 발송', who: '에이전트', state: 'blocked', note: 'Slack·SES 정보 대기(#39). 문자·전화는 보류(#10)', anchor: '5단계' },
  { n: 6, title: '알람 자동 생성', who: '에이전트', state: 'done', note: '수집기 29종, 태그 변경 즉시 동기화(#51)', anchor: '6단계' },
  { n: 7, title: '파일럿 연결', who: '사람', state: 'wait', note: '고객 스택 설치 → 시험 알람 → 전화 → Ack까지', anchor: '7단계' },
];
const STATE = { done: '완료', human: '사람 차례', wait: '앞 단계 대기', blocked: '정보 대기' };
export function roadmap(linkFor) {
  return `<section class="roadmap" aria-label="파일럿까지 7단계"><ol>` + ROADMAP.map((s) =>
    `<li class="st-${s.state}"><a href="${linkFor(s.anchor)}"><span class="rn">${s.n}</span>` +
    `<span class="rt">${esc(s.title)}</span><span class="pill">${STATE[s.state]}</span>` +
    `<span class="rw">${esc(s.who)}</span><span class="rd">${esc(s.note)}</span></a></li>`).join('') + '</ol></section>';
}
