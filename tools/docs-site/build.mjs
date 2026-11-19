// Builds the AlarmOps docs portal: one self-contained HTML page from every docs/**/*.md.
// Usage (from the repo root):
//   npm ci --ignore-scripts --prefix tools/docs-site
//   node tools/docs-site/build.mjs [out.html]        (default: tools/docs-site/out/alarmops-docs.html)
//
// What the page has:
// - a home view with the go-live roadmap and three diagrams (architecture, alarm → Ack flow, customer roles),
//   drawn in figures.mjs from the decisions and templates;
// - every document with its folder group, last change date (git), reading time, table of contents and prev/next;
// - full-text search with snippets, light/dark themes, a phone layout.
// Raw HTML inside Markdown is escaped (only <br> and empty <a id> anchors are kept).
// Mermaid blocks are drawn when the page can load mermaid from the CDN; otherwise they stay as code.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Marked } from 'marked';
import { architecture, incidentFlow, customerRoles, signIn, dbAccounts, roadmap, ROADMAP } from './figures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const docsDir = join(root, 'docs');
const out = resolve(process.argv[2] ?? join(here, 'out', 'alarmops-docs.html'));

// Sidebar groups, in order. First matching rule wins; paths are relative to docs/.
const GROUPS = [
  { key: 'start', title: '시작하기', blurb: '실운영까지의 순서와 설정 가이드', match: (p) => ['GO-LIVE.md', 'SETUP-SUPABASE.md', 'SETUP-PROD-DB.md', 'SETUP-GOOGLE-SSO.md', 'SETUP-VERCEL.md', 'SETUP-WINDOWS.md', 'HANDOFF.md'].includes(p) },
  { key: 'decide', title: '결정·기준', blurb: '확정된 결정 D-01~ 과 검증 페르소나', match: (p) => p.startsWith('decisions/') || p === 'PERSONAS.md' },
  { key: 'design', title: '설계', blurb: 'API 계약, 데이터 모델, 이전 계획', match: (p) => ['API-CONTRACT.md', 'DATA-MODEL.md'].includes(p) || p.startsWith('migration/') || p.startsWith('infra-todo/') },
  { key: 'spec', title: '동작 명세', blurb: '기존 두 저장소에서 뽑은 규칙', match: (p) => p.startsWith('specs/') },
  { key: 'ui', title: '화면', blurb: '메뉴 구성과 화면 명세', match: (p) => p.startsWith('ui/') },
  { key: 'sec', title: '보안 검토 기록', blurb: 'PR별 security 검토 결과', match: (p) => p.startsWith('security/') },
  { key: 'qa', title: 'QA 기록', blurb: '페르소나 점검과 화면 평가', match: (p) => p.startsWith('qa/') },
  { key: 'etc', title: '기타', blurb: '', match: () => true },
];
const PIN = ['GO-LIVE.md', 'SETUP-SUPABASE.md', 'SETUP-PROD-DB.md', 'SETUP-GOOGLE-SSO.md', 'SETUP-VERCEL.md', 'SETUP-WINDOWS.md', 'HANDOFF.md', 'decisions/DECISIONS.md', 'PERSONAS.md', 'API-CONTRACT.md', 'DATA-MODEL.md', 'specs/README.md', 'ui/README.md', 'ui/IA.md', 'qa/results.md'];
// Figures shown at the top of a document, full width above the text.
const INSERT = {
  'GO-LIVE.md': ['roadmap', 'architecture'],
  'SETUP-GOOGLE-SSO.md': ['signin'],
  'SETUP-PROD-DB.md': ['dbaccounts'],
  'specs/org-tenant.md': ['signin'],
  'specs/oncall-escalation.md': ['flow'],
  'specs/grouping-incident.md': ['flow'],
  'specs/suppression.md': ['flow'],
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.endsWith('.md') ? [p] : [];
  });
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugText = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const INCLUDE = /^<!--\s*include:\s*docs\/([A-Za-z0-9/_.-]+\.md)\s+(\d+)(?:~(\d+))?\s*-->$/;
const docId = (rel) => 'doc-' + rel.replace(/\.md$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
const git = (args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(); } catch { return ''; } };

const files = walk(docsDir).map((p) => relative(docsDir, p).split('\\').join('/'));
const order = (p) => { const i = PIN.indexOf(p); return i === -1 ? 1000 : i; };
files.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
const commit = git(['log', '-1', '--format=%h · %cs']);

const docs = files.map((rel) => {
  const src = readFileSync(join(docsDir, rel), 'utf8');
  const id = docId(rel);
  const toc = [];
  const used = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        let s = slugText(text) || 'section';
        const n = used.get(s) ?? 0; used.set(s, n + 1);
        if (n) s += '-' + n;
        const hid = `${id}--${s}`;
        const plain = text.replace(/<[^>]+>/g, '');
        if (depth === 2 || depth === 3) toc.push({ depth, text: plain, hid });
        // D-xx headings get a badge so the decision ID stands out
        const body = text.replace(/^(D-\d{2})(\s)/, '<span class="did">$1</span>$2');
        return `<h${depth} id="${hid}"><a class="anchor" href="#${hid}" aria-label="이 제목 링크">#</a>${body}</h${depth}>\n`;
      },
      html({ text }) {
        // <!-- include: docs/X.md N~M --> : expanded later (see "includes" below), invisible on GitHub
        const inc = text.trim().match(INCLUDE);
        if (inc) return `<div class="include-slot" data-rel="${esc(inc[1])}" data-from="${inc[2]}" data-to="${inc[3] ?? inc[2]}"></div>\n`;
        const lone = text.trim().match(/^<a\s+(?:id|name)="([A-Za-z0-9_-]+)"\s*>$/);
        if (lone) return `<span class="target" id="${id}--${lone[1]}"></span>`;
        if (/^<\/a>$/.test(text.trim())) return '';
        const anchors = [];
        text = text.replace(/<a\s+(?:id|name)="([A-Za-z0-9_-]+)"\s*>\s*<\/a>/g, (_, a) => { anchors.push(a); return '\u0000A' + (anchors.length - 1) + '\u0000'; });
        return text.replace(/<br\s*\/?>/gi, '\u0000BR\u0000').replace(/[&<>"]/g, (c) => esc(c)).replace(/\u0000BR\u0000/g, '<br>')
          .replace(/\u0000A(\d+)\u0000/g, (_, i) => `<span class="target" id="${id}--${anchors[Number(i)]}"></span>`);
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const ext = /^https?:/.test(href);
        return `<a href="${esc(rewriteHref(rel, id, href))}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' target="_blank" rel="noopener" class="ext"' : ''}>${text}</a>`;
      },
      table(token) {
        const cell = (c, tag) => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = token.header.map((c) => cell(c, 'th')).join('');
        const body = token.rows.map((r) => '<tr>' + r.map((c) => cell(c, 'td')).join('') + '</tr>').join('\n');
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`;
      },
      code({ text, lang }) {
        if (lang === 'mermaid') return `<pre class="mermaid">${esc(text)}</pre>\n`;
        const label = lang ? `<span class="lang">${esc(lang)}</span>` : '';
        return `<div class="code">${label}<pre><code>${esc(text)}</code></pre></div>\n`;
      },
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        const kind = /^<p><strong>(주의|경고)/.test(inner) ? 'warn' : /^<p><strong>(참고|팁)/.test(inner) ? 'note' : 'plain';
        return `<blockquote class="bq-${kind}">${inner}</blockquote>\n`;
      },
      checkbox({ checked }) {
        return `<span class="cb${checked ? ' on' : ''}" role="img" aria-label="${checked ? '완료' : '할 일'}"></span>`;
      },
      codespan({ text }) {
        const sev = text.match(/^SEV-([1-5])$/);
        return sev ? `<code class="sev sev${sev[1]}">${text}</code>` : `<code>${esc(text)}</code>`;
      },
    },
  });
  let html = marked.parse(src);
  const titleMatch = src.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].replace(/[`*_]/g, '').trim() : rel;
  // drop the document's own h1: the page header shows the title
  html = html.replace(/^<h1[^>]*>[\s\S]*?<\/h1>\n?/, '');
  const group = GROUPS.findIndex((g) => g.match(rel));
  const text = src.replace(/<[^>]*>/g, ' ').replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, ' ')).replace(/[#>*`|_[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  const updated = git(['log', '-1', '--format=%cs', '--', `docs/${rel}`]);
  const minutes = Math.max(1, Math.round(text.length / 700));
  return { rel, id, title, html, toc, group, text, updated, minutes };
});

function rewriteHref(fromRel, fromId, href) {
  if (/^[a-z]+:/i.test(href)) return href;
  if (href.startsWith('#')) return `#${fromId}--${href.slice(1)}`;
  const [path, frag] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(fromRel), path)).replace(/^docs\//, '');
  if (target.endsWith('.md')) return `#${docId(target)}${frag ? `--${frag}` : ''}`;
  const repoPath = posix.normalize(posix.join('docs', posix.dirname(fromRel), path));
  return `https://github.com/hkjs96/alarmops/blob/main/${repoPath}${frag ? '#' + frag : ''}`;
}

// ---- figures and home -------------------------------------------------------------------------------------------
const golive = docs.find((d) => d.rel === 'GO-LIVE.md');
const goliveLink = (prefix) => {
  const t = golive?.toc.find((x) => x.text.startsWith(prefix));
  return t ? `#${t.hid}` : `#${golive?.id ?? ''}`;
};
const FIG = { roadmap: () => roadmap(goliveLink), architecture, flow: incidentFlow, roles: customerRoles, signin: signIn, dbaccounts: dbAccounts };
for (const d of docs) {
  const figs = INSERT[d.rel];
  if (!figs) continue;
  d.figs = `<div class="inserted">${figs.map((f) => FIG[f]()).join('')}</div>`;
}

// ---- cross-document references -----------------------------------------------------------------------------------
// `docs/X.md` becomes a link to that document. `docs/X.md` N단계 / N~M단계 links to that numbered section, and when the
// reference sits in a callout (> **참고** …), the referenced sections are also shown right there, folded, so a reader
// following one guide never has to leave it.
const byRel = new Map(docs.map((d) => [d.rel, d]));
function sectionsOf(doc) {
  // numbered ## sections: "## 3. …", "## 3단계 — …"; each runs to the next <h2
  const out = new Map();
  const re = /<h2 id="([^"]+)">(?:<a [^>]*>#<\/a>)?([\s\S]*?)<\/h2>/g;
  const heads = [...doc.html.matchAll(re)];
  heads.forEach((m, i) => {
    const num = m[2].replace(/<[^>]+>/g, '').trim().match(/^(\d+)(?:\.|단계)/);
    if (!num) return;
    const end = i + 1 < heads.length ? heads[i + 1].index : doc.html.length;
    out.set(Number(num[1]), { hid: m[1], title: m[2].replace(/<[^>]+>/g, '').trim(), html: doc.html.slice(m.index, end) });
  });
  return out;
}
const sectionCache = new Map();
const docSections = (doc) => sectionCache.get(doc.rel) ?? (sectionCache.set(doc.rel, sectionsOf(doc)), sectionCache.get(doc.rel));
// a copy for embedding: no duplicate ids, headings one level down
const embedCopy = (html) => html.replace(/ id="[^"]*"/g, '').replace(/<a class="anchor"[^>]*>#<\/a>/g, '')
  .replace(/<(\/?)h([2-4])/g, (_, s, n) => `<${s}h${Math.min(Number(n) + 1, 6)}`);
const REF = /<code>docs\/([A-Za-z0-9/_.-]+\.md)<\/code>(\s*(\d+)(?:~(\d+))?단계)?/g;
for (const d of docs) {
  d.html = d.html.replace(/<blockquote class="bq-(\w+)">([\s\S]*?)<\/blockquote>/g, (whole, kind, inner, at, all) => {
    // a callout followed right away by an include of the same reference shows the steps expanded, not folded
    const next = all.slice(at + whole.length).match(/^\s*<div class="include-slot" data-rel="([^"]+)" data-from="(\d+)" data-to="(\d+)">/);
    const embeds = [];
    const linked = inner.replace(REF, (m, rel, tail, a, b) => {
      const target = byRel.get(rel);
      if (!target) return m;
      if (!a) return `<a href="#${target.id}"><code>docs/${rel}</code></a>`;
      const from = Number(a), to = Number(b ?? a);
      const secs = [...docSections(target)].filter(([n]) => n >= from && n <= to).map(([, s]) => s);
      const included = next && next[1] === rel && Number(next[2]) === from && Number(next[3]) === to;
      if (secs.length && !included) embeds.push({ target, from, to, secs });
      const href = secs[0] ? `#${secs[0].hid}` : `#${target.id}`;
      return `<a href="${href}"><code>docs/${rel}</code>${tail}</a>`;
    });
    const folded = embeds.map(({ target, from, to, secs }) =>
      `<details class="embed"><summary><span class="embed-k">화면별 순서 펼치기</span><span class="embed-t">${esc(target.title)} · ${from === to ? `${from}단계` : `${from}~${to}단계`}</span></summary>` +
      `<div class="embed-b">${secs.map((s) => embedCopy(s.html)).join('')}<p class="embed-src"><a href="#${secs[0].hid}">원문 문서에서 보기 →</a></p></div></details>`).join('');
    return `<blockquote class="bq-${kind}">${linked}</blockquote>${folded}`;
  });
  // plain mentions outside callouts: link only
  d.html = d.html.replace(/(<(?:p|li|td)[^>]*>[\s\S]*?<\/(?:p|li|td)>)/g, (block) => block.includes('<a href="#doc-') && block.includes('<code>docs/') ? block : block.replace(REF, (m, rel, tail, a) => {
    const target = byRel.get(rel);
    if (!target) return m;
    const sec = a ? docSections(target).get(Number(a)) : null;
    return `<a href="#${sec ? sec.hid : target.id}"><code>docs/${rel}</code>${tail ?? ''}</a>`;
  }));
}

// ---- includes ----------------------------------------------------------------------------------------------------
// <!-- include: docs/X.md N~M --> puts those numbered ## sections of X right here, expanded: headings sit one level
// under the host heading, every id gets a host prefix (the page holds all documents, so ids must stay unique) and links
// that pointed into the copied sections follow the copy. The host's outline keeps only its own headings.
const relSlug = (rel) => rel.replace(/\.md$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
for (const d of docs) {
  d.html = d.html.replace(/<div class="include-slot" data-rel="([^"]+)" data-from="(\d+)" data-to="(\d+)"><\/div>\n?/g, (m, rel, a, b, at, all) => {
    const target = byRel.get(rel);
    const from = Number(a), to = Number(b);
    const secs = target ? [...sectionsOf(target)].filter(([n]) => n >= from && n <= to) : [];
    if (!secs.length) throw new Error(`${d.rel}: include docs/${rel} ${a}~${b} matches no numbered section`);
    const host = [...all.slice(0, at).matchAll(/<h([1-6]) /g)].pop();
    const shift = (host ? Number(host[1]) : 2) - 1;
    const ids = new Map();
    let body = secs.map(([n, s]) => s.html.replace(/ id="([^"]+)"/g, (_, old) => {
      const nid = `${d.id}--inc-${relSlug(rel)}-${n}-${old.replace(`${target.id}--`, '')}`;
      ids.set(old, nid);
      return ` id="${nid}"`;
    })).join('');
    body = body.replace(/href="#([^"]+)"/g, (h, old) => (ids.has(old) ? `href="#${ids.get(old)}"` : h))
      .replace(/<(\/?)h([1-6])\b/g, (_, sl, n) => `<${sl}h${Math.min(Number(n) + shift, 6)}`)
      .replace(/<div class="include-slot"[^>]*><\/div>\n?/g, '');
    const range = from === to ? `${from}단계` : `${from}~${to}단계`;
    const src = `#${secs[0][1].hid}`;
    return `<div class="include"><p class="include-h">아래 순서는 <a href="${src}"><code>docs/${esc(rel)}</code> ${range}</a>와 같다 · <a href="${src}">원문 보기 →</a></p>${body}</div>\n`;
  });
}

const decisionsDoc = docs.find((d) => d.rel === 'decisions/DECISIONS.md');
const decisionCount = decisionsDoc ? (decisionsDoc.html.match(/<h3 [^>]*>.*?<span class="did">D-\d+/g) || []).length : 0;
const link = (rel) => `#${docId(rel)}`;
const READ = [
  { who: '처음 왔다면', what: '파일럿까지 무엇이 남았는지, 누가 하는지', rel: 'GO-LIVE.md' },
  { who: '직접 설정할 사람', what: '개발 DB와 회사 PC, 그다음 운영 DB', rel: 'SETUP-SUPABASE.md', rel2: 'SETUP-PROD-DB.md' },
  { who: '로그인을 붙일 사람', what: 'Google 클라이언트, 허용 도메인, 첫 ADMIN', rel: 'SETUP-GOOGLE-SSO.md' },
  { who: '결정을 찾을 때', what: `확정된 결정 ${decisionCount}개, 주제별 색인`, rel: 'decisions/DECISIONS.md' },
  { who: '화면을 만들 때', what: '메뉴 구성, 화면 명세, 페르소나', rel: 'ui/README.md', rel2: 'PERSONAS.md' },
  { who: '백엔드를 만들 때', what: '콘솔과 백엔드의 경계, 테이블', rel: 'API-CONTRACT.md', rel2: 'DATA-MODEL.md' },
  { who: '규칙이 헷갈릴 때', what: '억제·그룹·에스컬레이션 동작 명세', rel: 'specs/README.md' },
];
const titleOf = (rel) => docs.find((d) => d.rel === rel)?.title ?? rel;
const doneCount = ROADMAP.filter((s) => s.state === 'done').length;
const home = `<article id="home" class="view home">
<header class="hero">
 <p class="eyebrow">AlarmOps PoC · 서울 리전 · 파일럿 1곳</p>
 <h1>알람이 오면, 사람을 정해진 순서로 깨운다</h1>
 <p class="lede">고객 AWS 계정의 알람이 들어오면 사람이 손대지 않아도 인시던트가 열리고, 고객마다 정한 호출 순서대로 담당자에게 연락하고, Ack와 해결까지 콘솔에서 끝난다. 이 페이지는 그 시스템의 문서 ${docs.length}개를 모은 곳이다.</p>
 <dl class="stats">
  <div><dt>문서</dt><dd>${docs.length}</dd></div>
  <div><dt>확정 결정</dt><dd>${decisionCount}</dd></div>
  <div><dt>파일럿까지</dt><dd>${doneCount}<small>/7 단계 완료</small></dd></div>
 </dl>
</header>
<section class="band">
 <div class="band-h"><h2>파일럿까지 7단계</h2><a href="${link('GO-LIVE.md')}">실제 연동 순서 열기 →</a></div>
 ${roadmap(goliveLink)}
</section>
<section class="band">${architecture()}</section>
<section class="band two">${incidentFlow()}${customerRoles()}</section>
<section class="band two">${signIn()}${dbAccounts()}</section>
<section class="band">
 <div class="band-h"><h2>어디서부터 읽을까</h2></div>
 <ul class="read">${READ.map((r) => `<li><p class="rw-who">${esc(r.who)}</p><p class="rw-what">${esc(r.what)}</p><p class="rw-links"><a href="${link(r.rel)}">${esc(titleOf(r.rel))}</a>${r.rel2 ? `<a href="${link(r.rel2)}">${esc(titleOf(r.rel2))}</a>` : ''}</p></li>`).join('')}</ul>
</section>
<section class="band">
 <div class="band-h"><h2>모든 문서</h2></div>
 <div class="groups">${GROUPS.map((g, gi) => {
  const items = docs.filter((d) => d.group === gi);
  if (!items.length) return '';
  return `<div class="gcard"><p class="g-t">${esc(g.title)} <span>${items.length}</span></p>${g.blurb ? `<p class="g-b">${esc(g.blurb)}</p>` : ''}<ul>${items.slice(0, 6).map((d) => `<li><a href="#${d.id}">${esc(d.title)}</a></li>`).join('')}${items.length > 6 ? `<li class="more">외 ${items.length - 6}개는 왼쪽 목록에</li>` : ''}</ul></div>`;
 }).join('')}</div>
</section>
</article>`;

// ---- documents --------------------------------------------------------------------------------------------------
const nav = GROUPS.map((g, gi) => {
  const items = docs.filter((d) => d.group === gi);
  if (!items.length) return '';
  const open = gi <= 4 ? ' open' : '';
  return `<details class="group"${open}><summary>${esc(g.title)}<span class="count">${items.length}</span></summary><ul>` +
    items.map((d) => `<li><a href="#${d.id}" data-doc="${d.id}">${esc(d.title)}</a></li>`).join('') + '</ul></details>';
}).join('');

const sections = docs.map((d) => {
  const siblings = docs.filter((x) => x.group === d.group);
  const i = siblings.indexOf(d);
  const prev = siblings[i - 1], next = siblings[i + 1];
  const toc = d.toc.length > 2
    ? `<aside class="toc"><details open><summary>이 문서에서</summary><ul>${d.toc.map((t) => `<li class="d${t.depth}"><a href="#${t.hid}">${esc(t.text)}</a></li>`).join('')}</ul></details></aside>`
    : '';
  return `<article id="${d.id}" class="view doc" hidden>
<header class="doc-h">
 <p class="eyebrow">${esc(GROUPS[d.group].title)}</p>
 <h1>${esc(d.title)}</h1>
 <p class="meta"><a class="src" href="https://github.com/hkjs96/alarmops/blob/main/docs/${esc(d.rel)}" target="_blank" rel="noopener">docs/${esc(d.rel)}</a>${d.updated ? `<span>수정 ${esc(d.updated)}</span>` : ''}<span>약 ${d.minutes}분</span></p>
</header>
${d.figs ?? ''}<div class="doc-grid"><div class="md">${d.html}</div>${toc}</div>
<nav class="pager" aria-label="같은 묶음의 앞뒤 문서">${prev ? `<a class="prev" href="#${prev.id}"><small>이전</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="#${next.id}"><small>다음</small>${esc(next.title)}</a>` : '<span></span>'}</nav>
</article>`;
}).join('\n');

const searchIndex = JSON.stringify(docs.map((d) => ({ id: d.id, t: d.title, g: GROUPS[d.group].title, x: d.text }))).replace(/</g, '\\u003c');

const page = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>AlarmOps 문서</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Space+Grotesk:wght@500;700&display=swap">
<style>
/* Layout: sticky top bar; left rail of documents; reading column ~68ch with a right-hand outline.
   Home is a stack of bands: roadmap, then diagrams. One accent (signal orange) is reserved for "the alarm path". */
:root{
 --bg:#f4f6f9; --surface:#ffffff; --sunk:#eaeef4; --line:#d9dfe8; --line-2:#c4ccd8;
 --ink:#162033; --ink-2:#47536a; --ink-3:#6b768b;
 --accent:#1f4fd1; --accent-ink:#ffffff; --accent-soft:#e6edfd;
 --signal:#e0620d; --signal-soft:#fdeee3;
 --ok:#1b8a4b; --ok-soft:#e3f4ea; --warn:#b26a00; --warn-soft:#fff4dc; --wait:#7a8599; --wait-soft:#edf0f5;
 --code-bg:#eef1f6;
 --f-body:"IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
 --f-disp:"Space Grotesk","IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
 --f-mono:"JetBrains Mono",ui-monospace,"Cascadia Code",Consolas,monospace;
 --bar:56px;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
 --bg:#0e131b; --surface:#151c27; --sunk:#1b2433; --line:#263245; --line-2:#34435b;
 --ink:#e7ecf4; --ink-2:#aeb9cb; --ink-3:#8592a8;
 --accent:#7ea2ff; --accent-ink:#0e131b; --accent-soft:#1c2a4a;
 --signal:#ff8a3d; --signal-soft:#3a2416;
 --ok:#4cc483; --ok-soft:#15301f; --warn:#f0b04a; --warn-soft:#352812; --wait:#8b97ab; --wait-soft:#1f2836;
 --code-bg:#1b2433; color-scheme:dark}}
:root[data-theme="dark"]{
 --bg:#0e131b; --surface:#151c27; --sunk:#1b2433; --line:#263245; --line-2:#34435b;
 --ink:#e7ecf4; --ink-2:#aeb9cb; --ink-3:#8592a8;
 --accent:#7ea2ff; --accent-ink:#0e131b; --accent-soft:#1c2a4a;
 --signal:#ff8a3d; --signal-soft:#3a2416;
 --ok:#4cc483; --ok-soft:#15301f; --warn:#f0b04a; --warn-soft:#352812; --wait:#8b97ab; --wait-soft:#1f2836;
 --code-bg:#1b2433; color-scheme:dark}
*{box-sizing:border-box}
html{scroll-padding-top:calc(var(--bar) + 16px)}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 var(--f-body);word-break:keep-all;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
[hidden]{display:none!important}

/* top bar */
.bar{position:sticky;top:0;z-index:20;height:var(--bar);display:flex;align-items:center;gap:12px;
 padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));
 background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);font:700 17px/1 var(--f-disp);letter-spacing:-.01em;white-space:nowrap}
.brand:hover{text-decoration:none}
.mark{width:26px;height:26px;flex:none}
.brand small{font:500 12px var(--f-body);color:var(--ink-3);letter-spacing:0}
.search{position:relative;flex:1;max-width:520px;margin-left:auto}
.search input{width:100%;height:38px;padding:0 12px 0 36px;border:1px solid var(--line);border-radius:10px;background:var(--sunk);color:var(--ink);font:15px var(--f-body)}
.search input:focus{outline:2px solid var(--accent);outline-offset:0;background:var(--surface)}
.search svg{position:absolute;left:11px;top:11px;width:16px;height:16px;color:var(--ink-3)}
.kbd{position:absolute;right:10px;top:9px;font:12px var(--f-mono);color:var(--ink-3);border:1px solid var(--line);border-radius:5px;padding:0 5px}
.results{position:absolute;left:0;right:0;top:44px;max-height:min(70vh,560px);overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 40px rgba(10,20,40,.18);padding:6px}
.results a{display:block;padding:10px 12px;border-radius:8px;color:var(--ink)}
.results a:hover,.results a.sel{background:var(--accent-soft);text-decoration:none}
.results .r-t{font-weight:600}.results .r-g{font-size:12px;color:var(--ink-3);margin-left:6px}
.results .r-s{display:block;font-size:13.5px;color:var(--ink-2);line-height:1.55;margin-top:2px}
.results mark{background:var(--signal-soft);color:var(--ink);border-radius:3px;padding:0 1px}
.results .none{padding:14px;color:var(--ink-3);font-size:14px}
.iconbtn{flex:none;width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink-2);cursor:pointer}
.iconbtn svg{width:18px;height:18px}
.menu{display:none}

/* frame */
.frame{display:grid;grid-template-columns:272px minmax(0,1fr)}
.rail{position:sticky;top:var(--bar);height:calc(100vh - var(--bar));overflow:auto;border-right:1px solid var(--line);padding:18px 12px 48px;background:var(--bg)}
.rail .home-link{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;color:var(--ink);font-weight:600;margin-bottom:8px}
.rail .home-link.active{background:var(--accent-soft);color:var(--accent)}
.group{margin:2px 0 6px}
.group summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;padding:6px 10px;font:600 12px var(--f-body);letter-spacing:.06em;color:var(--ink-3);text-transform:uppercase;border-radius:6px}
.group summary::-webkit-details-marker{display:none}
.group summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s;margin-right:2px}
.group[open] summary::before{transform:rotate(45deg)}
.count{margin-left:auto;font:500 11px var(--f-mono);letter-spacing:0}
.group ul{list-style:none;margin:0;padding:0 0 0 6px}
.group a{display:block;padding:5px 10px;border-radius:7px;color:var(--ink-2);font-size:14px;line-height:1.45;border-left:2px solid transparent}
.group a:hover{color:var(--ink);background:var(--sunk);text-decoration:none}
.group a.active{color:var(--accent);background:var(--accent-soft);border-left-color:var(--accent);font-weight:600}
main{min-width:0;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}

/* home */
.home{max-width:1120px;margin:0 auto;padding-block:40px 80px}
.eyebrow{margin:0 0 8px;font:600 12.5px var(--f-body);letter-spacing:.08em;color:var(--ink-3);text-transform:uppercase}
.hero h1{margin:0;font:700 clamp(28px,4.2vw,44px)/1.22 var(--f-body);letter-spacing:-.025em;text-wrap:balance;max-width:20ch}
.lede{margin:16px 0 0;max-width:62ch;font-size:17.5px;color:var(--ink-2)}
.stats{display:flex;flex-wrap:wrap;gap:12px 40px;margin:28px 0 0;padding:0}
.stats div{display:flex;flex-direction:column-reverse}
.stats dt{font-size:13px;color:var(--ink-3)}
.stats dd{margin:0;font:700 34px/1.1 var(--f-disp);font-variant-numeric:tabular-nums}
.stats small{font:500 14px var(--f-body);color:var(--ink-3);margin-left:4px}
.band{margin-top:48px}
.band-h{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:14px}
.band-h h2,.fig-h{margin:0;font:700 21px/1.35 var(--f-body);letter-spacing:-.01em}
.band.two{display:grid;grid-template-columns:minmax(0,1fr);gap:48px}
.fig{min-width:0}

/* roadmap */
.roadmap ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:0;counter-reset:s}
.roadmap li{position:relative}
.roadmap li a{display:flex;flex-direction:column;gap:6px;height:100%;padding:16px 14px 18px;color:var(--ink);border:1px solid var(--line);border-left-width:0;background:var(--surface)}
.roadmap li:first-child a{border-left-width:1px;border-radius:12px 0 0 12px}
.roadmap li:last-child a{border-radius:0 12px 12px 0}
.roadmap li a:hover{text-decoration:none;background:var(--sunk)}
.roadmap li::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:var(--wait-soft)}
.roadmap li:first-child::before{border-radius:12px 0 0 0}.roadmap li:last-child::before{border-radius:0 12px 0 0}
.roadmap .st-done::before{background:var(--ok)}
.roadmap .st-human::before{background:var(--accent)}
.roadmap .st-blocked::before{background:var(--warn)}
.rn{font:700 26px/1 var(--f-disp);color:var(--ink-3);font-variant-numeric:tabular-nums}
.rt{font-weight:700;font-size:15.5px;line-height:1.35}
.pill{align-self:flex-start;font:600 12px/1 var(--f-body);padding:5px 8px;border-radius:999px;background:var(--wait-soft);color:var(--wait)}
.st-done .pill{background:var(--ok-soft);color:var(--ok)}
.st-human .pill{background:var(--accent-soft);color:var(--accent)}
.st-blocked .pill{background:var(--warn-soft);color:var(--warn)}
.st-done .rn{color:var(--ok)}
.rw{font-size:12.5px;color:var(--ink-3)}
.rd{font-size:13.5px;line-height:1.5;color:var(--ink-2)}

/* figures */
.fig{margin:0;padding:22px 22px 18px;background:var(--surface);border:1px solid var(--line);border-radius:16px}
.fig-scroll{overflow-x:auto;margin:14px -6px 0;padding:0 6px}
.fig-svg{display:block;width:100%;height:auto;min-width:720px;font-family:var(--f-body)}
.fig-cap{margin:12px 0 0;font-size:14px;line-height:1.65;color:var(--ink-2);max-width:90ch}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;list-style:none;margin:10px 0 0;padding:0;font-size:13px;color:var(--ink-2)}
.legend li{display:flex;align-items:center;gap:7px}
.sw{display:inline-block;width:22px;height:3px;border-radius:2px;background:var(--ink-3)}
.sw.hot{background:var(--signal)}.sw.q{height:12px;width:16px;border-radius:4px;background:var(--accent-soft);border:1.5px solid var(--accent)}
.zone rect{fill:var(--bg);stroke:var(--line-2);stroke-width:1;stroke-dasharray:5 4}
.zone.z-aws rect{fill:color-mix(in srgb,var(--signal-soft) 45%,var(--bg))}
.zone.z-host rect{fill:color-mix(in srgb,var(--accent-soft) 55%,var(--bg))}
.zt{font-size:13px;font-weight:700;fill:var(--ink-2);letter-spacing:.02em}
.node rect{fill:var(--surface);stroke:var(--line-2);stroke-width:1.2}
.nt{font-size:13.5px;font-weight:700;fill:var(--ink)}
.ns{font-size:11.5px;fill:var(--ink-3)}
.node.queue rect{fill:var(--accent-soft);stroke:var(--accent)}
.node.store rect{fill:var(--surface);stroke:var(--ink-2);stroke-width:1.6}
.node.out rect{fill:var(--signal-soft);stroke:var(--signal)}
.node.ok rect{fill:var(--ok-soft);stroke:var(--ok)}
.node.muted rect{fill:var(--sunk);stroke:var(--line-2);stroke-dasharray:4 3}
.node.role rect{fill:var(--surface);stroke:var(--ink-2)}
.node.role.opt rect{stroke-dasharray:5 3}
.edge path{fill:none;stroke:var(--ink-3);stroke-width:1.6}
.edge.hot path{stroke:var(--signal);stroke-width:2.2}
.edge.dashed path{stroke-dasharray:5 4}
.ahb{fill:var(--ink-3)}.ahh{fill:var(--signal)}.ahc{fill:var(--accent)}
.al{font-size:12px;fill:var(--ink-2);paint-order:stroke;stroke:var(--surface);stroke-width:4px;stroke-linejoin:round}
.al.left{text-anchor:start}
.al.strong{font-weight:700;fill:var(--signal)}
.home .zone rect{fill-opacity:1}

/* read cards and groups */
.read{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.read li{padding:16px 18px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.read p{margin:0}
.rw-who{font-weight:700}
.rw-what{font-size:14px;color:var(--ink-2);margin-top:2px!important}
.rw-links{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px!important;font-size:14.5px;font-weight:600}
.groups{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.gcard{padding:14px 16px;border-top:3px solid var(--line-2);background:var(--surface);border-radius:0 0 10px 10px}
.g-t{margin:0;font-weight:700}.g-t span{font:500 12px var(--f-mono);color:var(--ink-3);margin-left:4px}
.g-b{margin:2px 0 8px;font-size:13px;color:var(--ink-3);line-height:1.5}
.gcard ul{list-style:none;margin:0;padding:0;font-size:14px;line-height:1.5}
.gcard li{padding:3px 0}.gcard .more{color:var(--ink-3);font-size:13px}

/* document */
.doc{max-width:1180px;margin:0 auto;padding-block:36px 72px}
.doc-h{max-width:76ch;padding-bottom:18px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.doc-h h1{margin:0;font:700 clamp(26px,3.4vw,36px)/1.3 var(--f-body);letter-spacing:-.02em;text-wrap:balance}
.meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:12px 0 0;font-size:13px;color:var(--ink-3)}
.meta .src{font:12.5px var(--f-mono)}
.doc-grid{display:grid;grid-template-columns:minmax(0,76ch) minmax(0,240px);gap:56px;align-items:start;justify-content:space-between}
.toc{position:sticky;top:calc(var(--bar) + 24px);max-height:calc(100vh - var(--bar) - 48px);overflow:auto;padding-top:24px;font-size:13.5px}
.toc summary{cursor:pointer;list-style:none;font:600 12px var(--f-body);letter-spacing:.08em;color:var(--ink-3);text-transform:uppercase;margin-bottom:8px}
.toc summary::-webkit-details-marker{display:none}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}
.toc li a{display:block;padding:4px 0 4px 14px;margin-left:-1px;border-left:2px solid transparent;color:var(--ink-3);line-height:1.45}
.toc li.d3 a{padding-left:26px;font-size:13px}
.toc li a:hover{color:var(--ink);text-decoration:none}
.toc li a.on{color:var(--accent);border-left-color:var(--accent)}

.md{min-width:0;font-size:16.5px}
.md>*:first-child{margin-top:24px}
.md h2{margin:56px 0 14px;font:700 24px/1.4 var(--f-body);letter-spacing:-.015em;text-wrap:balance}
.md h3{margin:36px 0 10px;font:700 19px/1.45 var(--f-body);text-wrap:balance}
.md h4{margin:26px 0 8px;font:700 16.5px/1.5 var(--f-body)}
.md h2,.md h3,.md h4{position:relative}
.anchor{position:absolute;left:-1.1em;padding-right:.3em;color:var(--ink-3);font-weight:400;opacity:0}
.md h2:hover .anchor,.md h3:hover .anchor,.md h4:hover .anchor,.anchor:focus{opacity:1;text-decoration:none}
.did{display:inline-block;font:700 .82em/1.6 var(--f-mono);padding:0 .45em;margin-right:.25em;border-radius:6px;background:var(--accent-soft);color:var(--accent);vertical-align:.08em}
.target{display:block;height:0}
.md p{margin:12px 0}
.md ul,.md ol{margin:12px 0;padding-left:1.4em}
.md li{margin:5px 0}
.md li::marker{color:var(--ink-3)}
.md li>ul,.md li>ol{margin:4px 0}
.md strong{font-weight:700;color:var(--ink)}
.md li:has(> .cb:first-child){list-style:none;margin-left:-1.4em;padding-left:1.7em;position:relative}
.cb{position:absolute;left:0;top:.42em;width:16px;height:16px;border:1.6px solid var(--line-2);border-radius:5px;background:var(--surface)}
.cb.on{background:var(--ok);border-color:var(--ok)}
.cb.on::after{content:"";position:absolute;left:4.5px;top:1px;width:4px;height:8px;border:solid var(--surface);border-width:0 2px 2px 0;transform:rotate(45deg)}
.md blockquote{margin:18px 0;padding:12px 18px;border-radius:10px;background:var(--sunk);border:1px solid var(--line)}
.md blockquote p{margin:6px 0}
.md .bq-warn{background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 35%,transparent)}
.md .bq-warn strong:first-child{color:var(--warn)}
.md .bq-note{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.md .bq-note strong:first-child{color:var(--accent)}
.md code{font:.86em var(--f-mono);background:var(--code-bg);padding:.12em .4em;border-radius:5px}
.md .sev{font-weight:600}
.sev1{background:#d92d20!important;color:#fff}.sev2{background:#e0620d!important;color:#fff}.sev3{background:#b26a00!important;color:#fff}
.sev4{background:var(--accent-soft)!important;color:var(--accent)}.sev5{background:var(--sunk)!important;color:var(--ink-2)}
.code{position:relative;margin:16px 0}
.code pre{margin:0;padding:16px 18px;background:var(--code-bg);border:1px solid var(--line);border-radius:10px;overflow:auto;line-height:1.6}
.code pre code{background:none;padding:0;font-size:13.5px}
.lang{position:absolute;right:10px;top:8px;font:11px var(--f-mono);color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.md pre.mermaid{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px;overflow:auto;text-align:center}
.table-wrap{overflow-x:auto;margin:18px 0;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
.md table{border-collapse:collapse;width:100%;font-size:14.5px;line-height:1.6}
.md th,.md td{padding:10px 14px;vertical-align:top;text-align:left;border-bottom:1px solid var(--line)}
.md th{background:var(--sunk);font-weight:700;font-size:13px;letter-spacing:.02em;color:var(--ink-2);white-space:nowrap}
.md tbody tr:last-child td{border-bottom:0}
.md tbody tr:hover td{background:color-mix(in srgb,var(--accent-soft) 40%,transparent)}
.md td:first-child{white-space:nowrap;font-weight:600}
.md del{color:var(--ink-3)}
.md hr{border:0;border-top:1px solid var(--line);margin:36px 0}
.md a.ext::after{content:"↗";font-size:.8em;margin-left:2px}
.inserted{display:grid;gap:20px;margin:28px 0 0}
.embed{margin:-6px 0 22px;border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:0 0 12px 12px;background:var(--surface)}
.embed>summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:12px 16px;min-height:44px}
.embed>summary::-webkit-details-marker{display:none}
.embed>summary::before{content:"";width:7px;height:7px;border-right:2px solid var(--accent);border-bottom:2px solid var(--accent);transform:rotate(-45deg);transition:transform .15s}
.embed[open]>summary::before{transform:rotate(45deg)}
.embed-k{font-weight:700;color:var(--accent)}
.embed-t{font-size:13.5px;color:var(--ink-3)}
.embed[open]>summary{border-bottom:1px solid var(--line)}
.embed-b{padding:4px 20px 16px}
.embed-b h3{font-size:18px;margin:26px 0 8px}.embed-b h4{font-size:16px;margin:20px 0 6px}
.embed-b>h3:first-child{margin-top:16px}
.include{margin:8px 0 24px;padding:2px 0 4px 18px;border-left:3px solid color-mix(in srgb,var(--accent) 35%,transparent)}
.include-h{font-size:13.5px;color:var(--ink-3);margin:0 0 4px!important}
.include h4{font-size:18px;margin:26px 0 8px}.include h5{font-size:16px;margin:20px 0 6px}.include h6{font-size:15px;margin:16px 0 6px}
.include>.include-h+h4,.include>.include-h+h3{margin-top:12px}
.embed-src{font-size:13.5px;margin-top:18px!important}
.inserted .fig-svg{min-width:640px}

.pager{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:76ch;margin-top:56px}
.pager a{display:block;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font-weight:600;line-height:1.45}
.pager a:hover{border-color:var(--accent);text-decoration:none}
.pager small{display:block;font-weight:500;font-size:12px;color:var(--ink-3)}
.pager .next{text-align:right}

@media (max-width:1180px){
 .doc-grid{grid-template-columns:minmax(0,1fr);gap:0}
 .toc summary{margin:0;display:flex;justify-content:space-between}
 .toc summary::after{content:"펼치기";font-weight:500;letter-spacing:0;text-transform:none;color:var(--accent)}
 .toc details[open] summary{margin-bottom:8px}
 .toc details[open] summary::after{content:"접기"}
 .toc{position:static;max-height:none;order:-1;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);margin-top:20px}
 .toc ul{border-left:0}.toc li a{border-left:0;padding-left:0}.toc li.d3 a{padding-left:14px}
 .groups{grid-template-columns:repeat(2,minmax(0,1fr))}
 .roadmap ol{grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
 .roadmap li a,.roadmap li:first-child a,.roadmap li:last-child a{border-left-width:1px;border-radius:12px;overflow:hidden}
 .roadmap li::before,.roadmap li:first-child::before,.roadmap li:last-child::before{border-radius:12px 12px 0 0}
}
@media (max-width:900px){
 .frame{grid-template-columns:minmax(0,1fr)}
 .menu{display:grid}
 .rail{position:fixed;z-index:30;top:var(--bar);left:0;bottom:0;height:auto;width:min(86vw,320px);transform:translateX(-102%);transition:transform .2s ease;background:var(--surface);box-shadow:0 0 40px rgba(10,20,40,.25);padding-left:max(12px,env(safe-area-inset-left,0px))}
 body.nav-open .rail{transform:none}
 .read{grid-template-columns:1fr 1fr}
 .brand small{display:none}
 .kbd{display:none}
}
@media (max-width:560px){
 .roadmap ol{grid-template-columns:1fr}
 .roadmap li a{display:grid;grid-template-columns:auto 1fr auto;column-gap:12px;row-gap:2px;align-items:center}
 .roadmap .rn{grid-row:1/3}.roadmap .rd{grid-column:2/4}.roadmap .rw{display:none}
 .read,.groups{grid-template-columns:1fr}
 .fig{padding:16px 14px 14px}
 .home{padding-block:24px 56px}.doc{padding-block:20px 56px}
 .anchor{display:none}
 .md{font-size:16px}
 .md h2{font-size:21px;margin-top:44px}
 .pager{grid-template-columns:1fr}.pager .next{text-align:left}
 .brand .word{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style>
</head>
<body>
<header class="bar">
 <button class="iconbtn menu" type="button" aria-controls="rail" aria-expanded="false" aria-label="문서 목록 열기"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h14M3 10h14M3 15h14"/></svg></button>
 <a class="brand" href="#home"><svg class="mark" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="7" fill="var(--ink)"/><path d="M5 15h4l2-6 3 10 2-6h5" fill="none" stroke="var(--signal)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="word">AlarmOps 문서</span><small>${esc(commit)}</small></a>
 <div class="search" role="search">
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="m11 11 3.5 3.5"/></svg>
  <input id="q" type="search" placeholder="문서 검색 — SES, D-43, ExternalId" aria-label="문서 검색" autocomplete="off">
  <span class="kbd">/</span>
  <div class="results" id="results" hidden></div>
 </div>
 <button class="iconbtn theme" type="button" aria-label="밝은·어두운 테마 바꾸기"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 0 0 13z" fill="currentColor"/></svg></button>
</header>
<div class="frame">
<nav class="rail" id="rail" aria-label="문서 목록">
 <a class="home-link" href="#home" data-doc="home"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 7.5 8 3l5.5 4.5V13H2.5z"/></svg>개요</a>
 ${nav}
</nav>
<main id="main">
${home}
${sections}
</main>
</div>
<script>
(function(){
 var INDEX=${searchIndex};
 var views=[].slice.call(document.querySelectorAll('.view'));
 var links=[].slice.call(document.querySelectorAll('[data-doc]'));
 var menu=document.querySelector('.menu');
 function closeNav(){document.body.classList.remove('nav-open');menu.setAttribute('aria-expanded','false');}
 function show(hash){
  var h=decodeURIComponent((hash||'').replace(/^#/,''));
  var id=h.split('--')[0]||'home';
  var v=document.getElementById(id);
  if(!v||!v.classList.contains('view')){id='home';v=document.getElementById('home');}
  views.forEach(function(x){x.hidden=x!==v;});
  links.forEach(function(a){var on=a.dataset.doc===id;a.classList.toggle('active',on);if(on){var g=a.closest('details');if(g)g.open=true;}});
  var t=v.querySelector('h1');document.title=(id==='home'?'AlarmOps 문서':t.textContent+' · AlarmOps 문서');
  closeNav();
  var target=h.indexOf('--')>0?document.getElementById(h):null;
  if(target)target.scrollIntoView();else window.scrollTo(0,0);
  watchToc(v);
 }
 window.addEventListener('hashchange',function(){show(location.hash);});
 menu.addEventListener('click',function(){var o=document.body.classList.toggle('nav-open');menu.setAttribute('aria-expanded',String(o));});
 document.querySelector('main').addEventListener('click',closeNav);

 // outline: highlight the section being read
 var obs=null;
 function watchToc(v){
  if(obs)obs.disconnect();
  var tl=[].slice.call(v.querySelectorAll('.toc a'));if(!tl.length||!('IntersectionObserver' in window))return;
  var map={};tl.forEach(function(a){map[a.getAttribute('href').slice(1)]=a;});
  obs=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting&&map[e.target.id]){tl.forEach(function(a){a.classList.remove('on');});map[e.target.id].classList.add('on');}});},{rootMargin:'-70px 0px -70% 0px'});
  v.querySelectorAll('.md h2[id],.md h3[id]').forEach(function(h){obs.observe(h);});
 }
 if(matchMedia('(max-width:1180px)').matches)document.querySelectorAll('.toc details').forEach(function(d){d.open=false;});

 // search
 var q=document.getElementById('q'),box=document.getElementById('results'),sel=-1;
 function escH(s){return s.replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
 function hl(s,terms){var out=escH(s);terms.forEach(function(t){if(!t)return;var re=new RegExp(t.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&'),'gi');out=out.replace(re,function(m){return '<mark>'+m+'</mark>';});});return out;}
 function run(){
  var v=q.value.trim();sel=-1;
  if(!v){box.hidden=true;return;}
  var terms=v.toLowerCase().split(/\\s+/).filter(Boolean);
  var hits=[];
  INDEX.forEach(function(d){
   var tl=d.t.toLowerCase(),xl=d.x.toLowerCase(),score=0,pos=-1;
   for(var i=0;i<terms.length;i++){var t=terms[i],inT=tl.indexOf(t)>=0,p=xl.indexOf(t);if(!inT&&p<0)return;score+=(inT?10:0)+(p>=0?1:0);if(pos<0&&p>=0)pos=p;}
   hits.push({d:d,score:score,pos:pos});
  });
  hits.sort(function(a,b){return b.score-a.score;});
  if(!hits.length){box.innerHTML='<p class="none">"'+escH(v)+'"가 들어간 문서가 없다.</p>';box.hidden=false;return;}
  box.innerHTML=hits.slice(0,12).map(function(h){
   var s='';if(h.pos>=0){var a=Math.max(0,h.pos-40);s=(a?'…':'')+h.d.x.slice(a,h.pos+90)+'…';}
   return '<a href="#'+h.d.id+'"><span class="r-t">'+hl(h.d.t,terms)+'</span><span class="r-g">'+escH(h.d.g)+'</span>'+(s?'<span class="r-s">'+hl(s,terms)+'</span>':'')+'</a>';
  }).join('');
  box.hidden=false;
 }
 q.addEventListener('input',run);
 q.addEventListener('focus',function(){if(q.value)run();});
 q.addEventListener('keydown',function(e){
  var items=[].slice.call(box.querySelectorAll('a'));
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!items.length)return;sel=(sel+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items.forEach(function(a,i){a.classList.toggle('sel',i===sel);});items[sel].scrollIntoView({block:'nearest'});}
  else if(e.key==='Enter'){var a=items[sel>=0?sel:0];if(a){location.hash=a.getAttribute('href');box.hidden=true;q.blur();}}
  else if(e.key==='Escape'){box.hidden=true;q.blur();}
 });
 box.addEventListener('click',function(e){if(e.target.closest('a')){box.hidden=true;}});
 document.addEventListener('click',function(e){if(!e.target.closest('.search'))box.hidden=true;});
 document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==q&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)){e.preventDefault();q.focus();}});

 // theme
 var rootEl=document.documentElement,key='alarmops-docs-theme';
 try{var t=localStorage.getItem(key);if(t)rootEl.dataset.theme=t;}catch(e){}
 document.querySelector('.theme').addEventListener('click',function(){
  var dark=rootEl.dataset.theme?rootEl.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
  rootEl.dataset.theme=dark?'light':'dark';try{localStorage.setItem(key,rootEl.dataset.theme);}catch(e){}
 });
 show(location.hash);

 if(document.querySelector('pre.mermaid')){
  var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
  s.onload=function(){try{var dark=rootEl.dataset.theme==='dark'||(!rootEl.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);mermaid.initialize({startOnLoad:false,theme:dark?'dark':'neutral',securityLevel:'strict'});mermaid.run({querySelector:'pre.mermaid'});}catch(e){}};
  document.head.appendChild(s);
 }
})();
</script>
</body>
</html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`wrote ${relative(process.cwd(), out) || out} (${docs.length} documents, ${decisionCount} decisions, ${(page.length / 1024).toFixed(0)} KiB)`);
