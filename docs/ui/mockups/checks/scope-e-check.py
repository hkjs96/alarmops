"""Regression checks and task walks for scope variant E (default picker) in ../scope-variants.html.

Run:  python scope-e-check.py          (needs: pip install playwright && playwright install chromium)
Exit code 1 when a check fails. Written after evaluation E3 (docs/qa/scope-eval-E3.md).

Part 1 is the P1-1 regression: a click or tap on an input or on an empty area inside ANY panel type must leave the panel open.
Part 6b is the docked-tree layout (owner feedback after E3: the tree must push the content, never cover it): 7 widths x 5 screens x {list, panel} x {rail, tree}.
"""
import os, sys
from playwright.sync_api import sync_playwright
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'scope-variants.html')).replace('\\', '/')
res, errs, info = [], [], []
pw = sync_playwright().start(); br = pw.chromium.launch()
def chk(n, c): res.append(('PASS ' if c else 'FAIL ') + n); print(res[-1], flush=True)
def pg(w, h=900, touch=False, motion=False):
    ctx = br.new_context(viewport={'width': w, 'height': h}, is_mobile=w < 500, has_touch=touch, reduced_motion='no-preference' if motion else 'reduce')
    p = ctx.new_page(); p.set_default_timeout(5000)
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'net::' not in m.text else None)
    return p
def go(p, h):
    p.goto('about:blank'); p.goto(URL + '#' + h); p.wait_for_timeout(100)
    p.evaluate('sessionStorage.clear()'); p.goto('about:blank'); p.goto(URL + '#' + h); p.wait_for_timeout(150)
def st(p): return p.evaluate('[S.c,S.p,S.svc,S.m].join("/")')
def N(k): return '.e-tree.plus .e-tn[data-a="%s"] .x' % k
class K:
    def __init__(s, p, tap=False): s.p = p; s.n = 0; s.tap = tap
    def c(s, sel):
        l = s.p.locator(sel).locator('visible=true').first
        (l.tap() if s.tap else l.click()); s.n += 1; s.p.wait_for_timeout(80)

# ---------------- 1. P1-1: clicks and taps inside panels ----------------
PANELS = [('paging own', 's=paging&o=paging:hanbit|Fulfilment|Orders API'), ('paging customer', 's=paging&c=mirae&o=paging:mirae||'),
          ('paging inherited', 's=paging&o=paging:mirae|Core|Checkout'), ('thresholds', 's=monitoring&o=thr:mirae'), ('alarm', 's=monitoring&o=alarm:3'),
          ('incident', 's=incidents&o=inc:i1'), ('person customer', 's=people&o=person:p:sc'), ('person staff', 's=people&o=person:jp'),
          ('window', 's=maintenance&o=mw:0'), ('new window 1', 's=maintenance&o=mwnew:'), ('new window 2', 's=maintenance&o=mwnew:~mirae'),
          ('new window 3', 's=maintenance&o=mwnew:mirae|Core|'), ('new person 3', 's=people&o=personnew:daon||'), ('not found', 's=incidents&o=inc:nope')]
# points inside the panel that are not on a control. For touch, also not within 16px of one: Chromium snaps a tap to a nearby tappable element.
EMPTY = '''(pad) => {const p=document.querySelector('.e-panel'),r=p.getBoundingClientRect(),o=[];
  const ctl='[data-e],[data-s],[data-sc],[data-open],[data-act],[data-pop],a,button,input,select,summary,label,details';
  const free=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&p.contains(el)&&!el.closest(ctl)?el:null;};
  for(let y=r.top+18;y<Math.min(r.bottom,innerHeight)-18;y+=37)for(let x=r.left+18;x<r.right-18;x+=83){
    const el=free(x,y);if(!el)continue;
    if(pad&&![[-pad,0],[pad,0],[0,-pad],[0,pad],[-pad,-pad],[pad,pad],[-pad,pad],[pad,-pad]].every(d=>free(x+d[0],y+d[1])))continue;
    o.push([Math.round(x),Math.round(y),el.className||el.tagName]);}
  return o;}'''
def panel_clicks(w, h, touch):
    p = pg(w, h, touch); tag = '%d %s' % (w, 'touch' if touch else 'mouse'); bad = []; n_in = n_em = 0
    for name, hs in PANELS:
        go(p, hs); o0 = p.evaluate('S.o')
        if p.locator('.e-panel').count() != 1: bad.append(name + ': panel did not open'); continue
        ins = p.locator('.e-panel input:not([disabled])')
        for i in range(ins.count()):
            el = ins.nth(i); el.scroll_into_view_if_needed()
            (el.tap() if touch else el.click()); p.wait_for_timeout(40); n_in += 1
            ok = p.locator('.e-panel').count() == 1 and p.evaluate('S.o') == o0 and el.evaluate('e=>e===document.activeElement')
            if not ok: bad.append('%s: input %d' % (name, i))
            if p.locator('.e-panel').count() != 1: go(p, hs)
        pts = p.evaluate(EMPTY, 16 if touch else 0); step = max(1, len(pts) // 8)
        for x, y, cls in pts[::step]:
            (p.touchscreen.tap(x, y) if touch else p.mouse.click(x, y)); p.wait_for_timeout(40); n_em += 1
            if p.locator('.e-panel').count() != 1 or p.evaluate('S.o') != o0:
                bad.append('%s: empty area %s at %d,%d' % (name, cls, x, y)); go(p, hs)
    chk('P1-1 %s: %d input + %d empty-area clicks in %d panel types keep the panel open %s' % (tag, n_in, n_em, len(PANELS), bad or ''), not bad)
    # a dirty edit survives a click in the next field
    go(p, 's=paging&c=mirae&o=paging:mirae||'); a = p.locator('#ep1 [data-f=at1]'); a.fill('12')
    b_ = p.locator('#ep1 [data-f=at2]'); (b_.tap() if touch else b_.click()); p.wait_for_timeout(60)
    chk('P1-1 %s: dirty edit, click next field: panel open, value kept, no dialog' % tag, p.locator('.e-panel').count() == 1 and a.input_value() == '12' and p.locator('.e-dlg').count() == 0)
    p.context.close()
panel_clicks(1440, 900, False); panel_clicks(1024, 768, False); panel_clicks(1440, 900, True); panel_clicks(390, 844, True)

p = pg(1440)
go(p, 's=incidents'); p.click('.e-tree.plus .e-tq'); p.keyboard.type('pay'); p.wait_for_timeout(60)
chk('P1-1 tree "Find by name": click keeps focus and typing lands', p.evaluate('document.activeElement.classList.contains("e-tq")') and p.input_value('.e-tree.plus .e-tq') == 'pay')
go(p, 's=settings'); p.click('[data-f=msp0]'); p.keyboard.press('End'); p.keyboard.type('5')
chk('P1-1 settings input: click + type', p.input_value('[data-f=msp0]') == '805' and p.evaluate('S.s') == 'settings')
go(p, 's=paging&c=mirae'); h0 = p.evaluate('location.hash'); p.mouse.click(900, 700); p.mouse.click(300, 600)
chk('P1-1 click on empty page / tree area changes nothing', p.evaluate('location.hash') == h0)
go(p, 's=paging'); p.keyboard.press('Control+k'); p.wait_for_timeout(80); p.click('#eq'); p.keyboard.type('dao'); p.wait_for_timeout(60)
chk('P1-1 Ctrl+K input: click keeps it open', p.locator('#eq').count() == 1 and p.input_value('#eq') == 'dao'); p.keyboard.press('Escape')
p.click('.mk-bar [data-v="D"]'); chk('variant switcher still switches', p.evaluate('S.v') == 'D')
p.click('.mk-bar [data-v="E"]'); chk('and back to E', p.evaluate('S.v') == 'E')
for pk in ('c', 't', 's'):
    go(p, 'pk=%s&s=paging&o=paging:mirae||' % pk); p.click('#ep1 [data-f=at1]'); chk('P1-1 picker %s: input click keeps panel' % pk, p.locator('.e-panel').count() == 1)
ph = pg(390, 844, True)
go(ph, 's=incidents'); ph.tap('.e-barm .sb'); ph.wait_for_timeout(80); ph.tap('#ddq'); ph.keyboard.type('da'); ph.wait_for_timeout(60)
chk('P1-1 phone sheet search: tap keeps focus, typing filters', ph.locator('.e-sheet').count() == 1 and ph.input_value('#ddq') == 'da' and ph.locator('.e-sheet .e-opt').count() >= 1)

# ---------------- 2. P1-2: sheet footer applies exactly what it says ----------------
go(ph, 's=incidents&c=daon&p=Commerce&svc=Checkout'); ph.tap('.e-barm .sb'); ph.wait_for_timeout(80)
t = ph.locator('.e-shf .btn').inner_text(); ph.tap('.e-shf .btn'); ph.wait_for_timeout(80)
chk('P1-2 "%s" from Checkout -> %s' % (t, st(ph)), t == 'Use Daon Retail › Commerce only' and st(ph) == 'daon/Commerce//' and ph.locator('.e-sheet').count() == 0)
go(ph, 's=incidents&c=daon&p=Commerce&svc=Checkout'); ph.tap('.e-barm .sb'); ph.tap('.e-shs button >> nth=1'); ph.wait_for_timeout(80)
t = ph.locator('.e-shf .btn').inner_text(); ph.tap('.e-shf .btn'); ph.wait_for_timeout(80)
chk('P1-2 "%s" from step 2 -> %s' % (t, st(ph)), t == 'Use Daon Retail only' and st(ph) == 'daon///')
go(ph, 's=incidents&c=daon&p=Commerce&svc=Checkout'); ph.tap('.e-barm .sb'); ph.tap('.e-shh [data-e=ddclose]'); ph.wait_for_timeout(60)
chk('P1-2 Close keeps the filter', st(ph) == 'daon/Commerce/Checkout/')

# ---------------- 3. P2-1: changing the filter while a panel is open ----------------
def dirty(p):
    p.locator('#ep1 [data-f=at1]').fill('12'); p.wait_for_timeout(40)
def foc(p): return p.evaluate('(()=>{const a=document.activeElement;return a?a.tagName:""})()')
go(p, 's=paging&c=mirae&o=paging:mirae||'); p.click(N('daon||')); p.wait_for_timeout(120)
chk('P2-1 clean + tree: panel closes, filter changes, focus on heading', p.locator('.e-panel').count() == 0 and st(p) == 'daon///' and foc(p) == 'H1' and p.locator('.e-dlg').count() == 0)
go(p, 's=paging&c=mirae&o=paging:mirae||'); p.keyboard.press('Control+k'); p.keyboard.type('dao'); p.keyboard.press('Enter'); p.wait_for_timeout(120)
chk('P2-1 clean + Ctrl+K: panel closes, focus on heading', p.locator('.e-panel').count() == 0 and st(p) == 'daon///' and foc(p) == 'H1')
go(p, 's=paging&c=mirae&o=paging:mirae||'); p.click('.e-bar .e-px[data-a=c]'); p.wait_for_timeout(120)
chk('P2-1 clean + x in the bar: panel closes', p.locator('.e-panel').count() == 0 and st(p) == '///')
for how in ('tree', 'ctrlk', 'bar'):
    go(p, 's=paging&c=mirae&o=paging:mirae||'); dirty(p)
    if how == 'tree': p.click(N('daon||'))
    elif how == 'ctrlk': p.keyboard.press('Control+k'); p.keyboard.type('dao'); p.keyboard.press('Enter')
    else: p.click('.e-bar .e-px[data-a=c]')
    p.wait_for_timeout(120); btns = [x.strip() for x in p.locator('.e-dlg .btn').all_inner_texts()]
    chk('P2-1 dirty + %s: Save / Keep draft / Discard dialog, nothing changed yet %s' % (how, btns), len(btns) == 4 and btns[0].startswith('Save for Mirae Pay') and btns[1].startswith('Keep draft') and btns[2].startswith('Discard') and st(p) == 'mirae///' and p.locator('.e-panel').count() == 1)
    if how == 'tree':
        p.click('.e-dlg .btn >> nth=3'); p.wait_for_timeout(80)
        chk('P2-1 Cancel: still Mirae Pay, panel + value kept, focus in panel', st(p) == 'mirae///' and p.locator('#ep1 [data-f=at1]').input_value() == '12' and p.evaluate('!!document.activeElement.closest(".e-panel")'))
        p.click(N('daon||')); p.wait_for_timeout(100); p.click('.e-dlg .btn >> nth=1'); p.wait_for_timeout(350)
        chk('P2-1 Keep draft: panel closed, filter Daon, draft banner for Mirae Pay, focus heading', p.locator('.e-panel').count() == 0 and st(p) == 'daon///' and 'Draft for Mirae Pay' in p.locator('.e-note').first.inner_text() and foc(p) == 'H1')
    elif how == 'ctrlk':
        p.click('.e-dlg .btn >> nth=2'); p.wait_for_timeout(200)
        chk('P2-1 Discard: panel closed, filter Daon, no draft', p.locator('.e-panel').count() == 0 and st(p) == 'daon///' and p.locator('.e-note').count() == 0 and p.evaluate('C("mirae").steps[1].at') == 10)
    else:
        p.click('.e-dlg .btn >> nth=0'); p.wait_for_timeout(120)
        if p.locator('.e-dlg').count(): p.click('.e-dlg .btn.pri'); p.wait_for_timeout(250)
        chk('P2-1 Save: saved for Mirae Pay (10 -> 12), then filter cleared, panel closed', p.evaluate('C("mirae").steps[1].at') == 12 and st(p) == '///' and p.locator('.e-panel').count() == 0)
go(p, 's=paging&c=mirae&o=paging:mirae||'); p.click(N('mirae||')); p.wait_for_timeout(80)
chk('P2-1 picking the filter that is already set keeps the panel', p.locator('.e-panel').count() == 1)

# ---------------- 4. tree markers, legend, own steps, search ----------------
go(p, 's=paging&n=34')
chk('P2-2 no dot / triangle marks in the tree or its legend', p.locator('.e-tree .mk.dot,.e-tree .mk.tri').count() == 0)
p.click('.e-tree.plus [data-e=xtog][data-a="~ot"]'); p.wait_for_timeout(60)
chk('P2-2 call health is a text tag', p.locator('.e-tn[data-a="kumho||"] .e-tg.unr').inner_text().upper() == 'UNREACHABLE' and p.locator('.e-tn[data-a="lumen||"] .e-tg.ar').inner_text().upper() == 'AT RISK')
chk('P2-2 Call order list uses the same tag', p.locator('tr[data-a="paging:kumho||"] .e-tg.unr').count() >= 1)
chk('P2-2 legend visible at the bottom of the tree', p.locator('.e-tree .e-legl .it').count() == 6)
p.click('.e-legt'); chk('P2-2 legend collapses', p.locator('.e-tree .e-legl').count() == 0 and p.locator('.e-legt').get_attribute('aria-expanded') == 'false')
p.click('.e-legt'); chk('P2-2 legend opens again', p.locator('.e-tree .e-legl').count() == 1)
chk('P2-2 no OWN on customers (Mirae Pay, Iruda Edu)', p.locator('.e-tn.d0 .e-own').count() == 0)
chk('P2-2 collapsed Hanbit shows the "contains own steps" mark', p.locator('.e-tn[data-a="hanbit||"] .e-inown').count() == 1 and p.locator('.e-tn[data-a="daon||"] .e-inown').count() == 0)
p.click('.e-tree.plus [data-e=xtog][data-a="hanbit||"]'); p.wait_for_timeout(50)
chk('P2-2 expanded Hanbit: mark moves down to collapsed Fulfilment', p.locator('.e-tn[data-a="hanbit||"] .e-inown').count() == 0 and p.locator('.e-tn[data-a="hanbit|Fulfilment|"] .e-inown').count() == 1)
p.click('.e-tree.plus [data-e=xtog][data-a="hanbit|Fulfilment|"]'); p.wait_for_timeout(50)
own_t = p.locator('.e-tn[data-a="hanbit|Fulfilment|Orders API"] .e-own').inner_text(); own_l = p.locator('tr[data-a="paging:hanbit|Fulfilment|Orders API"] .pill.cz').inner_text()
chk('P2-2 tree wording = list wording: "%s" / "%s"' % (own_t, own_l), own_t.lower() == own_l.lower() == 'own steps')
go(p, 's=incidents&c=mirae&p=Core&svc=Checkout'); p.click('.e-tree.plus [data-e=xtog][data-a="mirae||"]'); p.wait_for_timeout(60)
chk('P2-10 collapsed selected customer says the filter is inside', p.locator('.e-tn.oni[data-a="mirae||"]').count() == 1 and st(p) == 'mirae/Core/Checkout/')
go(p, 's=monitoring'); p.fill('.e-tree.plus .e-tq', 'mirae check'); p.wait_for_timeout(60)
chk('P2-9 "mirae check" finds Mirae Pay > Core > Checkout only', p.locator(N('mirae|Core|Checkout')).count() == 1 and p.locator(N('daon||')).count() == 0 and p.locator('.e-trq').inner_text().startswith('1 match'))
p.fill('.e-tree.plus .e-tq', 'check'); p.wait_for_timeout(60); p.press('.e-tree.plus .e-tq', 'Enter'); p.keyboard.press('Enter'); p.keyboard.press('Enter'); p.wait_for_timeout(60)
chk('P2-9 Enter, Enter, Enter on 2 same-named matches selects nothing', st(p) == '///' and 'nothing selected' in p.locator('.e-trq').inner_text())
p.keyboard.press('ArrowDown'); a = p.evaluate('TX.cur'); p.keyboard.press('ArrowDown'); b_ = p.evaluate('TX.cur')
chk('P2-9 arrows step from match to match (%s -> %s)' % (a, b_), a == 'mirae|Core|Checkout' and b_ == 'daon|Commerce|Checkout')
p.keyboard.press('Enter'); p.wait_for_timeout(100)
chk('P2-9 a pick clears the search and shows the whole tree', st(p) == 'daon/Commerce/Checkout/' and p.input_value('.e-tree.plus .e-tq') == '' and p.locator(N('hanbit||')).count() == 1)
p.keyboard.press('Control+k'); p.keyboard.type('checkout'); p.wait_for_timeout(100)
chk('P2-9 Ctrl+K lists same-named matches in tree order (Mirae Pay first)', p.locator('.e-swi').first.inner_text().replace('\n', ' ').find('Mirae Pay') >= 0); p.keyboard.press('Escape')

# ---------------- 5. numbers outside the view ----------------
for hs in ('s=incidents&c=mirae', 's=incidents&c=daon&p=Commerce&svc=Checkout', 's=incidents&m=1&u=hk'):
    go(p, hs); v = p.evaluate('(()=>{const o=eOut();return [o.open,INC.filter(i=>eInView(i)&&eOpenSt(i)).length,eBadgeN()]})()')
    chk('P2-7 outside open %d + listed open %d = badge %d (%s)' % (v[0], v[1], v[2], hs), v[0] + v[1] == v[2])
go(p, 's=incidents&c=daon&p=Commerce&svc=Checkout'); t = p.locator('.e-bar .e-out').inner_text()
chk('P2-7 text: ' + t, t.startswith('Outside this view: 4 open (1 from an unmapped account) · 2 acknowledged'))
go(p, 's=incidents&m=1'); t = p.locator('.e-bar .e-out').inner_text(); chk('P2-7 nothing outside: "%s"' % t, t == 'Outside this view: no incidents')
go(p, 's=monitoring&c=mirae&p=Core'); t = p.locator('.chips .e-out').inner_text()
chk('P2-8 Monitoring: ' + t, t.startswith('Outside this view: 2 need review'))
p.click('.chips .e-out'); p.wait_for_timeout(120); chk('P2-8 link removes the filter and shows Needs review', st(p) == '///' and p.evaluate('S.q') == 'review' and p.locator('.page tbody tr').count() == 2)
go(p, 's=incidents'); n0 = p.locator('.e-trp .n').inner_text(); p.click('.e-trp'); p.wait_for_timeout(60)
chk('P2-8 "Only with problems" counts thresholds to review (%s customers, tag shown)' % n0, p.locator('.e-tn[data-a="mirae||"] .e-tg.rv').count() == 1)
go(p, 's=paging&c=mirae&p=Core&o=paging:mirae||'); u = p.locator('#mk-url').inner_text()
chk('P2-11 address keeps the list filter with a panel open: ' + u.split(' ')[0], u.startswith('console.alarmops.example/c/mirae/paging?filter=mirae/core'))
p.reload(); p.wait_for_timeout(150); chk('P2-11 reload keeps filter and panel', st(p) == 'mirae/Core//' and p.locator('.e-panel').count() == 1)

# ---------------- 6. layout: 1440 shift, 1024, phone ----------------
def left(p): return p.evaluate('document.querySelector(".page .t").getBoundingClientRect().left')
def width(p): return p.evaluate('document.querySelector(".page .t").getBoundingClientRect().width')
for w in (1440, 1920):
    q = pg(w, 900); worst = 0
    for s_, row in (('paging', 'paging:hanbit||'), ('incidents', 'inc:i1'), ('monitoring', 'alarm:0'), ('people', 'person:p:ys'), ('maintenance', 'mw:0')):
        go(q, 's=' + s_); x0 = left(q); h10 = q.evaluate('document.querySelector(".page h1").getBoundingClientRect().left')
        q.click('.page [data-e=open][data-a="%s"]' % row); q.wait_for_timeout(150); x1 = left(q); wl = width(q)
        ov = q.evaluate('(()=>{const t=document.querySelector(".page .tw");return t.scrollWidth-t.clientWidth})()')
        q.click('#ep1 [data-e=close]'); q.wait_for_timeout(150); x2 = left(q); worst = max(worst, abs(x1 - x0), abs(x2 - x1))
        info.append('%d %s: list left %g -> %g -> %g px (open, close), list width with panel %g, h-scroll inside list %g' % (w, s_, x0, x1, x2, wl, ov))
        if w == 1440: chk('P2-4 1440 %s: list with panel is not clipped (inner overflow %g)' % (s_, ov), ov <= 0)
    chk('P2-4 %d: list left edge moves %gpx when a panel opens / closes (target <= 16)' % (w, worst), worst <= 16)
    if w == 1440:
        go(q, 's=paging'); q.click('.page [data-e=open][data-a="paging:hanbit||"]'); q.wait_for_timeout(120)
        chk('P2-4 1440: tree stays docked beside the panel, no rail', q.locator('.e-tree.plus:not(.rail)').count() == 1 and q.locator('.e-rail').count() == 0)
    q.context.close()
# ---------------- 6b. docked tree: push, never overlay ----------------
# GEO returns, for the current state: cover = main-content elements whose box intersects the tree (or list elements under a side panel), hov = page h-overflow,
# clip = boxes that scroll sideways / stick out of the viewport, the panel or their table cell / overlapping cells, keep = always-visible list fields that are missing.
GEO = r'''() => {
  const q=(s,r)=>[...(r||document).querySelectorAll(s)], R=e=>e.getBoundingClientRect(), vis=e=>{const r=R(e);return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const tree=document.querySelector('.e-tree.plus'), tr=tree?R(tree):null, panel=document.querySelector('.e-panel'), pr=panel?R(panel):null, page=document.querySelector('main.page');
  const full=document.body.classList.contains('e-pfull'), vw=document.documentElement.clientWidth, o={cover:[],clip:[],keep:[]};
  const name=e=>e.tagName.toLowerCase()+(typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\s+/).join('.'):'')+' "'+(e.innerText||'').trim().slice(0,20)+'"';
  const hit=(a,b)=>a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5;
  const main=(full?[]:q('*',page)).concat(panel?[panel].concat(q('*',panel)):[]).filter(vis).filter(e=>!e.closest('.only-m,.sr'));
  if(tr)main.forEach(e=>{if(hit(R(e),tr))o.cover.push('tree x '+name(e));});
  if(pr&&!full)q('*',page).filter(vis).forEach(e=>{if(hit(R(e),pr))o.cover.push('panel x '+name(e));});
  o.hov=document.documentElement.scrollWidth-vw;
  main.forEach(e=>{const c=getComputedStyle(e);if(c.display==='inline')return;
    if(e.scrollWidth-e.clientWidth>1&&c.overflowX!=='visible')o.clip.push('scrolls sideways '+(e.scrollWidth-e.clientWidth)+' '+name(e));
    if(R(e).right>(pr&&panel.contains(e)?pr.right:vw)+0.5)o.clip.push('sticks out '+name(e));});
  // no text over other text: children of any flex / grid box must not intersect each other
  main.forEach(e=>{const d=getComputedStyle(e).display;if(!/flex|grid/.test(d))return;const ks=[...e.children].filter(vis).filter(k=>!/absolute|fixed|sticky/.test(getComputedStyle(k).position));
    ks.forEach((k,i)=>ks.slice(i+1).forEach(k2=>{if(hit(R(k),R(k2)))o.clip.push('overlap '+name(k)+' / '+name(k2));}));});
  const rows=full?[]:q('.page .t tbody tr').filter(vis);
  rows.forEach(row=>{const tds=q('td',row).filter(vis);
    tds.forEach((td,i)=>{const a=R(td);q('*',td).filter(vis).forEach(ch=>{const b=R(ch);if(!ch.closest('.mk')&&(b.right>a.right+1||b.left<a.left-1))o.clip.push('out of its cell '+name(ch));});
      tds.slice(i+1).forEach(t2=>{if(hit(a,R(t2)))o.clip.push('cells overlap '+name(td));});});});
  // always visible in every list row: the customer > project > service path, status / severity, and the primary action
  const s=S.s, need={incidents:['td:nth-child(1)','td:nth-child(2)','.e-sc,.e-sctd'],monitoring:['.e-sc','td[data-l="Sev"]','td[data-l="State"]'],paging:['.e-sc','td[data-l="Steps"]'],
    people:['td:nth-child(1)','.e-sctd','td[data-l^="Channels"],td:last-child'],maintenance:['td:nth-child(1)','.e-sc','td[data-l="Window"]']}[s]||[];
  rows.forEach((row,i)=>{need.forEach(n=>{if(!q(n,row).some(vis))o.keep.push(s+' row '+i+' lost '+n);});
    if(s==='incidents'&&q('[data-e=ack]',row).length&&!q('[data-e=ack]',row).some(vis))o.keep.push('row '+i+' lost Acknowledge');
    if(s==='paging'&&q('.e-tg.unr,.e-tg.ar',row).length&&!q('.e-tg.unr,.e-tg.ar',row).some(vis))o.keep.push('row '+i+' lost its call-health tag');});
  const t=document.querySelector('.page .t'), tb=t?R(t):{left:0,width:0}, rb=document.querySelector('.e-rail');
  o.tree=tr?tr.width:0; o.listL=tb.left; o.listW=tb.width; o.panelW=pr?pr.width:0; o.panelL=pr?pr.left:0; o.vw=vw; o.full=full; o.tier=XLAY.tier; o.rail=rb?R(rb).width:0;
  o.back=!!panel&&q('.e-x .e-xt',panel).some(vis); o.rowH=Math.max(0,...rows.map(r=>r.offsetHeight)); o.float=q('.e-trov,[data-e=xpin],[data-e=xov]').length;
  return o;}'''
ROW = {'paging': 'paging:hanbit||', 'incidents': 'inc:i1', 'monitoring': 'alarm:0', 'people': 'person:p:ys', 'maintenance': 'mw:0'}
MODE = ['all columns', 'columns -1', 'columns -2', 'cards']
def state(p, hs, panel, tree, row=None):
    """load hs, open a panel or not, then put the tree in the wanted state by clicking the rail / the collapse button, as a user would"""
    go(p, hs)
    if panel: p.click('.page [data-e=open][data-a="%s"]' % row); p.wait_for_timeout(60)
    is_rail = p.locator('.e-tree.plus.rail').count() == 1
    if tree and is_rail: p.click('.e-rail')
    if not tree and not is_rail: p.click('.e-tree.plus [data-e=xcol]')
    p.wait_for_timeout(60); return p.evaluate(GEO)
def bad_of(g, panel, tree):
    b = []
    if g['cover']: b.append('covered: %s' % g['cover'][:3])
    if g['hov'] > 0: b.append('page scrolls sideways by %d' % g['hov'])
    if g['clip']: b.append('clipped: %s' % g['clip'][:3])
    if g['keep']: b.append('missing: %s' % g['keep'][:3])
    if g['float']: b.append('floating tree / Pin still there')
    if round(g['tree']) != (272 if tree else 45): b.append('tree is %g wide' % g['tree'])
    if not tree and g['rail'] < 44: b.append('rail target %g < 44' % g['rail'])
    if panel and g['full']:
        if abs(g['panelL'] - g['tree']) > 0.5 or abs(g['panelL'] + g['panelW'] - g['vw']) > 0.5: b.append('full panel does not start at the tree edge')
        if not g['back']: b.append('full panel without "Back to the list"')
    elif panel:
        if g['panelW'] < 440 or g['panelW'] > 600: b.append('panel %g wide' % g['panelW'])
        if g['back']: b.append('side panel says "Back to the list"')
        if g['listW'] < 320: b.append('list %g < 320' % g['listW'])
        if g['tier'] != 3 and g['listW'] < 320 + 100: b.append('table in %g px' % g['listW'])
    if not (panel and g['full']) and abs(g['listL'] - g['tree'] - 25) > 1: b.append('list starts at %g, tree ends at %g' % (g['listL'], g['tree']))
    return b
table = []
for w in (1920, 1440, 1280, 1100, 1024, 900, 800):
    q = pg(w, 900); geo = {}
    for panel in (0, 1):
        for tree in (0, 1):
            bad = []; cell = None
            for s_, row in ROW.items():
                g = state(q, 's=' + s_, panel, tree, row); geo[(s_, panel, tree)] = g
                bad += ['%s: %s' % (s_, x) for x in bad_of(g, panel, tree)]
                if s_ == 'paging': cell = g
            modes = sorted(set(('panel is the view' if g_['full'] else MODE[g_['tier']]) for (s2, p2, t2), g_ in geo.items() if p2 == panel and t2 == tree))
            chk('DOCK %d %s + %s: tree covers nothing, no sideways scroll, nothing clipped, key fields stay (5 screens) %s' % (w, 'panel' if panel else 'list', 'tree' if tree else 'rail', bad or ''), not bad)
            table.append((w, 'panel' if panel else 'list', 'tree' if tree else 'rail', cell, modes))
    # list left edge: rail -> tree is a push by exactly the width the tree gained; the panel never moves it by itself at >= 1408
    d = [geo[(s_, 0, 1)]['listL'] - geo[(s_, 0, 0)]['listL'] for s_ in ROW]
    chk('DOCK %d: expanding the rail pushes the list right by %s px (= 272 - 45), on every screen' % (w, sorted(set(d))), all(abs(x - 227) <= 1 for x in d))
    q.context.close()
info.append('DOCK measured (Call order; list = table left edge / width, panel width):')
for w, a, b_, g, modes in table:
    info.append('  %4d %-5s %-4s | tree %3d | %-28s | panel %-15s | %s' % (w, a, b_, round(g['tree']), 'list under the panel' if g['full'] else 'list at %d, %d wide' % (round(g['listL']), round(g['listW'])),
        ('%d, from x=%d' % (round(g['panelW']), round(g['panelL']))) if g['full'] else (str(round(g['panelW'])) if a == 'panel' else '-'), ' / '.join(modes)))

q = pg(1024, 768); go(q, 's=paging')
r = q.evaluate('(()=>{const b=document.querySelector(".e-rail"),r=b.getBoundingClientRect();return [r.width,r.height,b.getAttribute("aria-expanded")]})()')
chk('DOCK 1024 starts as a rail; click target %gx%g px (>= 44 wide)' % (r[0], r[1]), r[0] >= 44 and r[1] >= 44 and r[2] == 'false')
k = K(q); k.c('.e-rail'); x1 = left(q)
chk('DOCK rail click docks the tree in place: no floating layer, no Pin, focus in the tree', q.locator('.e-tree.plus:not(.rail)').count() == 1 and q.locator('.e-trov,[data-e=xpin]').count() == 0 and q.evaluate('document.activeElement.classList.contains("e-tr")') and x1 == 297)
k.c(N('daon||')); k.c(N('daon|Commerce|')); k.c(N('daon|Commerce|Checkout'))
chk('J3 1024: rail -> tree 1 click, then service in 3 clicks; the tree stays docked the whole time (%d clicks)' % k.n, st(q) == 'daon/Commerce/Checkout/' and q.locator('.e-tree.plus:not(.rail)').count() == 1 and k.n == 4)
q.mouse.move(700, 500); q.wait_for_timeout(600); chk('DOCK the tree does not close by itself when the pointer leaves', q.locator('.e-tree.plus:not(.rail)').count() == 1)
q.reload(); q.wait_for_timeout(150); chk('DOCK expanded is remembered after reload (1024)', q.locator('.e-tree.plus:not(.rail)').count() == 1)
q.click('.e-tree.plus [data-e=xcol]'); q.wait_for_timeout(60)
chk('DOCK collapse returns to the rail, focus on the rail, list back at 70px', q.locator('.e-tree.plus.rail').count() == 1 and q.evaluate('document.activeElement.classList.contains("e-rail")') and left(q) == 70)
q.reload(); q.wait_for_timeout(150); chk('DOCK collapsed is remembered after reload', q.locator('.e-tree.plus.rail').count() == 1)
go(q, 's=paging'); q.click('.e-rail'); q.wait_for_timeout(60)
hs = q.evaluate('[...document.querySelectorAll(".page tbody tr")].map(r=>r.offsetHeight)'); chk('P2-3 1024 tree expanded: Call order rows max %dpx' % max(hs), max(hs) <= 66)
q.focus('.e-tree.plus .e-trz')
for _ in range(6): q.keyboard.press('ArrowRight')
g = q.evaluate(GEO); chk('DOCK 1024 tree widened to %g px with the keyboard: list follows (%s), nothing covered or clipped' % (g['tree'], MODE[g['tier']]), g['tree'] == 360 and not g['cover'] and not g['clip'] and g['hov'] <= 0 and abs(g['listL'] - 385) <= 1)
q.click('.page [data-e=open][data-a="paging:hanbit||"]'); q.wait_for_timeout(100)
chk('DOCK 1024: opening a panel tucks the tree into the rail (auto, below 1408)', q.locator('.e-tree.plus.rail').count() == 1 and q.locator('.e-panel').count() == 1)
q.click('.e-rail'); q.wait_for_timeout(80); g = q.evaluate(GEO)
chk('DOCK 1024: the user re-expands beside the panel: panel is the view from the tree edge (%g + %g = %g), still open' % (g['panelL'], g['panelW'], g['vw']), g['full'] and g['panelL'] == 360 and not g['cover'] and q.locator('.e-panel').count() == 1)
q.click('.e-x'); q.wait_for_timeout(100); chk('P2-3 "Back to the list" returns to the list, focus on the row, tree back as remembered', q.locator('.e-panel').count() == 0 and q.evaluate('document.activeElement.getAttribute("data-a")') == 'paging:hanbit||' and q.locator('.e-tree.plus:not(.rail)').count() == 1)
q.context.close()
for w, want in ((1407, 1), (1408, 0)):
    q = pg(w, 900); go(q, 's=paging'); x0 = left(q); q.click('.page [data-e=open][data-a="paging:hanbit||"]'); q.wait_for_timeout(100); x1 = left(q)
    chk('DOCK %d: panel open -> tree %s (list left %g -> %g)' % (w, 'collapses to the rail' if want else 'stays', x0, x1), q.locator('.e-tree.plus.rail').count() == want)
    if want:
        q.click('#ep1 [data-e=close]'); q.wait_for_timeout(100)
        chk('DOCK %d: panel closed -> tree comes back (auto-collapse is not remembered), list left %g' % (w, left(q)), q.locator('.e-tree.plus:not(.rail)').count() == 1 and left(q) == x0)
    q.context.close()
q = pg(1440, 900)
for hs in ('s=people&c=mirae', 's=people&c=daon&p=Commerce', 's=incidents&c=mirae', 's=monitoring&c=mirae', 's=paging&n=34', 's=maintenance&c=daon&p=Commerce'):
    go(q, hs); g = q.evaluate(GEO); chk('DOCK 1440 %s: filtered rows still fit (%s) %s' % (hs, MODE[g['tier']], g['clip'][:2] or ''), not g['clip'] and not g['cover'] and g['hov'] <= 0)
q.context.close()
q = pg(1024, 768, motion=True); go(q, 's=paging'); q.click('.e-rail')
an = q.evaluate('(()=>{const a=document.querySelector(".e-tree.plus").getAnimations();return a.length?[a[0].effect.getTiming().duration,document.querySelector(".e-tree.plus").getBoundingClientRect().width]:null})()')
q.wait_for_timeout(350); w1 = q.evaluate('document.querySelector(".e-tree.plus").getBoundingClientRect().width')
chk('DOCK width transition: %s ms, mid-way width %s, ends at %g' % (an and an[0], an and round(an[1]), w1), bool(an) and 150 <= an[0] <= 200 and 45 <= an[1] < 272 and w1 == 272 and q.evaluate('!document.body.classList.contains("e-anim")'))
q.context.close()
q = pg(1024, 768); go(q, 's=paging'); q.click('.e-rail')
chk('DOCK prefers-reduced-motion: no animation', q.evaluate('document.querySelector(".e-tree.plus").getAnimations().length') == 0 and q.evaluate('document.querySelector(".e-tree.plus").getBoundingClientRect().width') == 272)
go(q, 'pk=c&s=paging&o=paging:hanbit||'); r = q.evaluate('(()=>{const r=document.querySelector(".e-panel").getBoundingClientRect();return [r.left,r.width]})()')
chk('comparison picker E-1 at 1024 keeps its full-width panel %s' % r, r == [0, 1024] and q.locator('.e-x .e-xt').is_visible())
q.context.close()
chk('phone: no desktop layout classes at 390', ph.evaluate('!/e-c1|e-c2|e-cards|e-pfull|e-pnar/.test(document.body.className)') and not ph.locator('.e-tree').first.is_visible())

go(ph, 's=paging&c=daon')
chk('P2-6 phone Call order card names who is called: ' + ph.locator('tr[data-a="paging:daon||"] td[data-l="Paged first"]').inner_text().replace('\n', ' / '), 'Junho, Minjae, Soyeon' in ph.locator('tr[data-a="paging:daon||"]').inner_text())
SMALL = '''() => [...document.querySelectorAll('a[data-s],a[data-e],button,.chip,[role=button],[role=link],input,.e-opt')].filter(e=>e.offsetParent&&!e.disabled&&!e.closest('.mk-wrap,.e-pkm')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.height<44||r.width<44)}).map(e=>(e.innerText||e.className).trim().slice(0,24)+' '+Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height))'''
for hs in ('s=incidents', 's=incidents&c=daon', 's=monitoring', 's=monitoring&c=mirae&p=Core', 's=paging', 's=paging&o=paging:mirae||', 's=paging&o=paging:hanbit|Fulfilment|Orders API', 's=people', 's=maintenance', 's=maintenance&o=mwnew:mirae|Core|', 's=incidents&o=inc:i1', 's=monitoring&o=thr:mirae'):
    go(ph, hs); sm = ph.evaluate(SMALL); chk('P2-12 390 tap targets >= 44px on %s %s' % (hs, sm or ''), not sm)
go(ph, 's=incidents'); ph.tap('.e-barm .sb'); ph.wait_for_timeout(80); sm = ph.evaluate(SMALL); chk('P2-12 390 sheet tap targets %s' % (sm or ''), not sm)

# ---------------- 7. task walks ----------------
go(ph, 's=incidents'); first = ph.locator('.page tbody tr').first; k = K(ph, True)
ok1 = 'Mirae Pay' in first.inner_text() and 'Payments API' in first.inner_text(); k.c('.page tbody tr >> nth=0 >> [data-e=ack]')
chk('H1 390: Mirae Pay payments incident is the first card, acknowledged in %d tap' % k.n, ok1 and 'Acknowledged in Mirae Pay › Core › Payments API' in ph.locator('.e-toast').inner_text())
go(ph, 's=incidents'); k = K(ph, True); k.c('.e-barm .sb'); k.c('.e-opt[data-a="daon||"]'); k.c('.e-opt[data-a="daon|Commerce|"]'); k.c('.e-opt[data-a="daon|Commerce|Checkout"]'); n1 = k.n
k.c('.v-bb a[data-s=paging]'); txt = ph.locator('.page tbody').inner_text()
chk('H2 390: narrow to Daon Retail > Commerce > Checkout in %d taps, who is called in %d more, names on the card' % (n1, k.n - n1), st(ph) == 'daon/Commerce/Checkout/' and 'Junho, Minjae, Soyeon' in txt and ph.locator('.e-panel').count() == 0)
ph.tap('.v-bb a[data-s=incidents]'); ph.wait_for_timeout(80); t_ = ph.locator('.e-barm .e-out').inner_text().replace('\n', ' ')
chk('H3 390: 0 taps, "%s"' % t_, '4 open' in t_)
k = K(ph, True); k.c('.e-barm .sb'); k.c('.e-shs button >> nth=0'); k.c('.e-opt[data-a="hanbit||"]'); k.c('.e-shf .btn'); n1 = k.n; ok = st(ph) == 'hanbit///'; k.c('.e-barm .e-clr')
chk('H4 390: switch to Hanbit Logistics in %d taps (footer applies it), back to all in %d' % (n1, k.n - n1), ok and st(ph) == '///')
go(p, 's=maintenance'); k = K(p); k.c(N('mirae||')); k.c(N('mirae|Core|')); k.c('.ph [data-a="mwnew:"]'); k.c('.e-panel [data-a="mwnew:mirae|Core|"]'); k.c('#emw')
p.keyboard.type('Core deploy'); k.c('#ep1 [data-e=save]'); body = p.locator('.e-dlg').inner_text(); k.c('.e-dlg .btn.pri'); p.wait_for_timeout(200)
chk('N3 1440 by mouse: window for Mirae Pay > Core created in %d clicks + typed reason' % k.n, 'Payments API' in body and 'Settlement' in body and p.evaluate('MW[0].c+"|"+MW[0].p+"|"+MW[0].why') == 'mirae|Core|Core deploy' and p.locator('.e-panel').count() == 0)
go(p, 's=paging'); keys = 0; ok = True
for q_, cid, val in (('mir', 'mirae', '12'), ('dao', 'daon', '3'), ('han', 'hanbit', '3')):
    seq = ['Control+k'] + list(q_) + ['Enter', 'Tab', 'Enter']
    for key in seq: p.keyboard.press(key); p.wait_for_timeout(60)
    keys += len(seq); f = p.evaluate('document.activeElement.getAttribute("data-f")'); band = p.locator('.e-panel .e-path').inner_text()
    ok = ok and f == 'at1' and st(p) == cid + '///' and p.evaluate('C("%s").n' % cid) in band
    p.keyboard.press('Control+a'); p.keyboard.type(val); keys += 1 + len(val); p.keyboard.press('Control+Enter'); keys += 1; p.wait_for_timeout(100)
    if p.locator('.e-dlg').count(): ok = ok and p.evaluate('C("%s").n' % cid) in p.locator('.e-dlg h3').inner_text(); p.keyboard.press('Enter'); keys += 1; p.wait_for_timeout(250)
    ok = ok and p.locator('.e-panel').count() == 0 and str(p.evaluate('resolve({c:"%s"}).steps[1].at' % cid)) == val
chk('J1 1440 keyboard only: step 2 edited for Mirae Pay, Daon Retail, Hanbit Logistics in %d keys, each saved to its own customer' % keys, ok)
go(p, 's=paging&c=mirae'); p.click('tr[data-a="paging:mirae||"]'); p.wait_for_timeout(100); p.click('#ep1 [data-f=at1]'); p.keyboard.press('Control+a'); p.keyboard.type('11')
p.keyboard.press('Control+k'); p.keyboard.type('dao'); p.keyboard.press('Enter'); p.wait_for_timeout(120)
chk('J1 wrong-customer path: dirty Mirae Pay edit + Ctrl+K "dao" Enter asks first', p.locator('.e-dlg').count() == 1 and 'Mirae Pay' in p.locator('.e-dlg h3').inner_text() and st(p) == 'mirae///')

print('\n'.join('INFO ' + i for i in info)); print('ERRS', errs)
f_ = sum(r.startswith('FAIL') for r in res); print(sum(r.startswith('PASS') for r in res), 'pass', f_, 'fail')
br.close(); pw.stop(); sys.exit(1 if f_ or errs else 0)
