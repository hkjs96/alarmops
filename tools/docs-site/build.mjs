// Builds one self-contained HTML page from every docs/**/*.md, for reading in a browser.
// Usage (from the repo root):
//   npm ci --ignore-scripts --prefix tools/docs-site
//   node tools/docs-site/build.mjs [out.html]        (default: tools/docs-site/out/alarmops-docs.html)
// The page has a sidebar grouped by folder, a filter box (title + text), a per-document table of contents,
// working links between documents, and light/dark themes. Raw HTML inside Markdown is escaped (only <br> is kept).
// Mermaid blocks are drawn when the page can load mermaid from the CDN; otherwise they stay as code.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const docsDir = join(root, 'docs');
const out = resolve(process.argv[2] ?? join(here, 'out', 'alarmops-docs.html'));

// Sidebar groups, in order. First matching prefix wins; paths are relative to docs/.
const GROUPS = [
  { title: '시작하기', match: (p) => ['GO-LIVE.md', 'SETUP-SUPABASE.md', 'SETUP-WINDOWS.md', 'HANDOFF.md'].includes(p) },
  { title: '결정·기준', match: (p) => p.startsWith('decisions/') || p === 'PERSONAS.md' },
  { title: '설계', match: (p) => ['API-CONTRACT.md', 'DATA-MODEL.md'].includes(p) || p.startsWith('migration/') || p.startsWith('infra-todo/') },
  { title: '동작 명세', match: (p) => p.startsWith('specs/') },
  { title: '화면', match: (p) => p.startsWith('ui/') },
  { title: '보안 검토 기록', match: (p) => p.startsWith('security/') },
  { title: 'QA 기록', match: (p) => p.startsWith('qa/') },
  { title: '기타', match: () => true },
];
// Within a group these come first, in this order; the rest follow alphabetically.
const PIN = ['GO-LIVE.md', 'SETUP-SUPABASE.md', 'SETUP-WINDOWS.md', 'HANDOFF.md', 'decisions/DECISIONS.md', 'PERSONAS.md', 'API-CONTRACT.md', 'DATA-MODEL.md', 'specs/README.md', 'ui/README.md', 'ui/IA.md', 'qa/results.md'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : name.endsWith('.md') ? [p] : [];
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugText = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
const docId = (rel) => 'doc-' + rel.replace(/\.md$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

const files = walk(docsDir).map((p) => relative(docsDir, p).split('\\').join('/'));
const order = (p) => { const i = PIN.indexOf(p); return i === -1 ? 1000 : i; };
files.sort((a, b) => order(a) - order(b) || a.localeCompare(b));

let commit = '';
try { commit = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h %cs'], { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }

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
        if (depth === 2 || depth === 3) toc.push({ depth, text: text.replace(/<a [^>]*>|<\/a>/g, ''), hid });
        return `<h${depth} id="${hid}"><a class="anchor" href="#${hid}" aria-hidden="true">#</a>${text}</h${depth}>\n`;
      },
      html({ text }) {
        // keep empty anchors (<a id="d-07"></a>) as link targets, scoped to this document like headings
        // (inline, the open and close tags arrive as two separate tokens)
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
        return `<a href="${esc(rewriteHref(rel, id, href))}"${title ? ` title="${esc(title)}"` : ''}${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
      },
      table(token) {
        // default rendering, wrapped so wide tables scroll inside the page instead of the page scrolling
        const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('');
        const body = token.rows.map((r) => '<tr>' + r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('') + '</tr>').join('\n');
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`;
      },
      code({ text, lang }) {
        if (lang === 'mermaid') return `<pre class="mermaid">${esc(text)}</pre>\n`;
        return `<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(text)}</code></pre>\n`;
      },
      checkbox({ checked }) {
        return `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
      },
    },
  });
  const html = marked.parse(src);
  const titleMatch = src.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].replace(/[`*_]/g, '').trim() : rel;
  const group = GROUPS.findIndex((g) => g.match(rel));
  const text = src.replace(/<[^>]*>/g, ' ').replace(/[#>*`|_\-[\]()]/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return { rel, id, title, html, toc, group, text };
});

// Links between documents: "../specs/x.md#anchor" → "#doc-specs-x" (and the anchor inside it when it exists).
function rewriteHref(fromRel, fromId, href) {
  if (/^[a-z]+:/i.test(href)) return href;
  if (href.startsWith('#')) return `#${fromId}--${href.slice(1)}`;
  const [path, frag] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(fromRel), path)).replace(/^docs\//, '');
  if (target.endsWith('.md')) return `#${docId(target)}${frag ? `--${frag}` : ''}`;
  // a file outside docs/ (code, workflow): point to GitHub
  const repoPath = posix.normalize(posix.join('docs', posix.dirname(fromRel), path));
  return `https://github.com/hkjs96/alarmops/blob/main/${repoPath}${frag ? '#' + frag : ''}`;
}

const nav = GROUPS.map((g, gi) => {
  const items = docs.filter((d) => d.group === gi);
  if (!items.length) return '';
  const open = gi <= 4 ? ' open' : '';
  return `<details class="group"${open}><summary>${esc(g.title)} <span class="count">${items.length}</span></summary><ul>` +
    items.map((d) => `<li><a href="#${d.id}" data-doc="${d.id}"><span class="t">${esc(d.title)}</span><span class="p">${esc(d.rel)}</span></a></li>`).join('') +
    '</ul></details>';
}).join('');

const sections = docs.map((d) => {
  const toc = d.toc.length > 2
    ? `<details class="toc" open><summary class="toc-h">목차</summary><ul>${d.toc.map((t) => `<li class="d${t.depth}"><a href="#${t.hid}">${t.text}</a></li>`).join('')}</ul></details>`
    : '';
  return `<article id="${d.id}" class="doc" hidden data-text="${esc(d.text)}">
<div class="doc-meta"><span class="crumb">${esc(GROUPS[d.group].title)}</span><a class="src" href="https://github.com/hkjs96/alarmops/blob/main/docs/${esc(d.rel)}" target="_blank" rel="noopener">docs/${esc(d.rel)}</a></div>
<div class="doc-body">${toc}<div class="md">${d.html}</div></div>
</article>`;
}).join('\n');

const page = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AlarmOps 문서</title>
<style>
:root{--bg:#fbfaf8;--panel:#f3f1ec;--text:#1f2328;--muted:#5f6670;--line:#e2ded6;--accent:#2f5fd0;--accent-bg:#e8eefc;--code-bg:#efece6;--mark:#fff1a8;--ok:#1a7f37}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15171a;--panel:#1c1f23;--text:#e6e8eb;--muted:#9aa3ad;--line:#2d3238;--accent:#7aa2ff;--accent-bg:#1f2a44;--code-bg:#22262b;--mark:#5a4b00;--ok:#4ac26b}}
:root[data-theme="dark"]{--bg:#15171a;--panel:#1c1f23;--text:#e6e8eb;--muted:#9aa3ad;--line:#2d3238;--accent:#7aa2ff;--accent-bg:#1f2a44;--code-bg:#22262b;--mark:#5a4b00;--ok:#4ac26b}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:16px/1.75 "Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,-apple-system,"Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.layout{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--line);padding:20px 14px 40px}
.brand{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 6px 14px}
.brand h1{font-size:17px;margin:0;letter-spacing:-.01em}
.brand small{display:block;color:var(--muted);font-size:12px;font-weight:400}
.theme{border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer}
.search{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);font-size:14px;margin-bottom:12px}
.search:focus{outline:2px solid var(--accent);outline-offset:1px}
.group{margin:4px 0}
.group summary{cursor:pointer;font-size:13px;font-weight:700;color:var(--muted);padding:6px;border-radius:6px;list-style:none;display:flex;justify-content:space-between}
.group summary::-webkit-details-marker{display:none}
.group summary::before{content:"▸";margin-right:6px;transition:transform .15s}
.group[open] summary::before{transform:rotate(90deg)}
.group summary{justify-content:flex-start}.count{margin-left:auto;font-weight:400}
.group ul{list-style:none;margin:0 0 6px;padding:0}
.group li a{display:block;padding:6px 10px;border-radius:8px;color:var(--text)}
.group li a:hover{background:var(--bg);text-decoration:none}
.group li a.active{background:var(--accent-bg);color:var(--accent)}
.group .t{display:block;font-size:14px;line-height:1.4}
.group .p{display:block;font-size:11.5px;color:var(--muted);font-family:ui-monospace,Consolas,monospace}
.hit-none{color:var(--muted);font-size:13px;padding:8px}
main{padding:28px 40px 80px;min-width:0}
.doc-meta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;color:var(--muted);margin-bottom:6px}
.crumb{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:1px 10px}
.src{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.doc-body{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:40px;align-items:start}
.md{max-width:860px;min-width:0;grid-column:1;grid-row:1}
.toc{grid-column:2;grid-row:1;position:sticky;top:20px;max-height:calc(100vh - 40px);overflow:auto;font-size:13px;border-left:2px solid var(--line);padding-left:14px}
.toc-h{font-weight:700;color:var(--muted);margin:0 0 6px;cursor:pointer}
.toc ul{list-style:none;margin:0;padding:0}.toc li{margin:3px 0;line-height:1.45}.toc li.d3{padding-left:12px;font-size:12.5px}
.toc a{color:var(--muted)}.toc a:hover{color:var(--accent)}
.md h1{font-size:30px;line-height:1.3;letter-spacing:-.02em;margin:4px 0 18px}
.md h2{font-size:22px;line-height:1.4;margin:44px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.md h3{font-size:18px;margin:30px 0 8px}
.md h4{font-size:16px;margin:22px 0 6px}
.md h1,.md h2,.md h3,.md h4{position:relative;scroll-margin-top:16px}
.target{display:block;scroll-margin-top:16px}
.anchor{position:absolute;left:-1em;opacity:0;color:var(--muted);font-weight:400}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:1}
.md p,.md ul,.md ol{margin:10px 0}
.md li{margin:4px 0}.md li>ul,.md li>ol{margin:4px 0}
.md li:has(> input[type=checkbox]){list-style:none;margin-left:-1.3em}
.md input[type=checkbox]{transform:translateY(1px);margin-right:4px;accent-color:var(--ok)}
.md blockquote{margin:14px 0;padding:10px 16px;background:var(--accent-bg);border-left:4px solid var(--accent);border-radius:0 10px 10px 0}
.md blockquote p{margin:4px 0}
.md code{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:.88em;background:var(--code-bg);padding:.1em .38em;border-radius:5px}
.md pre{background:var(--code-bg);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;line-height:1.55}
.md pre code{background:none;padding:0;font-size:13.5px}
.md pre.mermaid{background:var(--bg);text-align:center}
.table-wrap{overflow-x:auto;margin:14px 0;border:1px solid var(--line);border-radius:10px}
.md table{border-collapse:collapse;width:100%;font-size:14.5px;line-height:1.6}
.md th,.md td{border-bottom:1px solid var(--line);padding:8px 12px;vertical-align:top;text-align:left}
.md th{background:var(--panel);font-weight:700;white-space:nowrap}
.md tr:last-child td{border-bottom:0}
.md td:first-child{white-space:nowrap}
.md del{color:var(--muted)}
.md hr{border:0;border-top:1px solid var(--line);margin:28px 0}
mark{background:var(--mark);color:inherit;border-radius:3px}
.menu{display:none}
@media (max-width:1180px){.doc-body{grid-template-columns:minmax(0,1fr)}.toc{position:static;grid-column:1;grid-row:auto;border-left:0;border:1px solid var(--line);border-radius:10px;padding:10px 14px;max-height:none;order:-1}.md{grid-row:auto}}
@media (max-width:820px){
 .layout{grid-template-columns:1fr}
 .side{position:fixed;inset:0 auto 0 0;width:86vw;max-width:340px;z-index:10;transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 40px rgba(0,0,0,.25)}
 body.nav-open .side{transform:none}
 .menu{display:inline-flex;position:sticky;top:0;z-index:5;width:100%;align-items:center;gap:10px;padding:10px 16px;background:var(--panel);border:0;border-bottom:1px solid var(--line);color:var(--text);font-size:15px;cursor:pointer}
 main{padding:16px 16px 60px}
 .md h1{font-size:24px}.md h2{font-size:19px}
 .anchor{display:none}
}
</style>
</head>
<body>
<button class="menu" type="button" aria-controls="side" aria-expanded="false">☰ <span id="cur">문서 목록</span></button>
<div class="layout">
<aside class="side" id="side">
 <div class="brand"><h1>AlarmOps 문서<small>${docs.length}개 문서${commit ? ' · ' + esc(commit) : ''}</small></h1><button class="theme" type="button" title="테마 바꾸기">테마</button></div>
 <input class="search" type="search" placeholder="제목·내용 검색 (예: SES, D-43)" aria-label="문서 검색">
 <nav id="nav">${nav}</nav>
 <p class="hit-none" hidden>찾는 문서가 없다.</p>
</aside>
<main id="main">
${sections}
</main>
</div>
<script>
(function(){
 var docs=[].slice.call(document.querySelectorAll('article.doc'));
 var links=[].slice.call(document.querySelectorAll('#nav a[data-doc]'));
 var cur=document.getElementById('cur'),menu=document.querySelector('.menu');
 var first=docs[0]&&docs[0].id;
 function show(hash){
  var h=decodeURIComponent((hash||'').replace(/^#/,''));
  var id=h.split('--')[0]||first;
  var art=document.getElementById(id);
  if(!art||!art.classList.contains('doc')){id=first;art=document.getElementById(first);}
  docs.forEach(function(d){d.hidden=d!==art;});
  links.forEach(function(a){var on=a.dataset.doc===id;a.classList.toggle('active',on);if(on){var g=a.closest('details');if(g)g.open=true;cur.textContent=a.querySelector('.t').textContent;}});
  document.title=cur.textContent+' · AlarmOps 문서';
  document.body.classList.remove('nav-open');menu.setAttribute('aria-expanded','false');
  var target=h.indexOf('--')>0?document.getElementById(h):null;
  if(target)target.scrollIntoView();else window.scrollTo(0,0);
 }
 window.addEventListener('hashchange',function(){show(location.hash);});
 show(location.hash);
 menu.addEventListener('click',function(){var o=document.body.classList.toggle('nav-open');menu.setAttribute('aria-expanded',String(o));});
 var q=document.querySelector('.search'),none=document.querySelector('.hit-none');
 q.addEventListener('input',function(){
  var v=q.value.trim().toLowerCase(),any=false;
  links.forEach(function(a){
   var art=document.getElementById(a.dataset.doc);
   var hit=!v||a.textContent.toLowerCase().indexOf(v)>=0||art.dataset.text.indexOf(v)>=0;
   a.parentNode.hidden=!hit;any=any||hit;
  });
  document.querySelectorAll('#nav details').forEach(function(g){var vis=g.querySelectorAll('li:not([hidden])').length;g.hidden=!vis;if(v&&vis)g.open=true;});
  none.hidden=any;
 });
 var root=document.documentElement,key='alarmops-docs-theme';
 try{var t=localStorage.getItem(key);if(t)root.dataset.theme=t;}catch(e){}
 document.querySelector('.theme').addEventListener('click',function(){
  var dark=root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme=dark?'light':'dark';try{localStorage.setItem(key,root.dataset.theme);}catch(e){}
 });
 if(matchMedia('(max-width:1180px)').matches)document.querySelectorAll('details.toc').forEach(function(t){t.open=false;});
 if(document.querySelector('pre.mermaid')){
  var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
  s.onload=function(){try{var dark=root.dataset.theme==='dark'||(!root.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);mermaid.initialize({startOnLoad:false,theme:dark?'dark':'default',securityLevel:'strict'});mermaid.run({querySelector:'pre.mermaid'});}catch(e){}};
  document.head.appendChild(s);
 }
})();
</script>
</body>
</html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`wrote ${relative(process.cwd(), out) || out} (${docs.length} documents, ${(page.length / 1024).toFixed(0)} KiB)`);
