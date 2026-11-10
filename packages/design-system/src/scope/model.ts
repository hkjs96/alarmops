/**
 * Scope tree model (docs/ui/scope-variants.md §7.6, rules T4–T8). Pure functions: no DOM, no React.
 * A scope is customer › project › service, addressed by slugs. "mine" = the My customers filter.
 */
export type CallHealth = "OK" | "AT_RISK" | "UNREACHABLE";

export interface ScopeServiceNode {
  id: string;
  slug: string;
  name: string;
  /** open = triggered or escalated, nobody acknowledged (same definition as the nav badge) */
  openIncidents: number;
  /** this level has its own call order ("Own steps" in the Call order list) */
  ownSteps: boolean;
}
export interface ScopeProjectNode extends ScopeServiceNode {
  services: ScopeServiceNode[];
}
export interface ScopeCustomerNode {
  id: string;
  slug: string;
  name: string;
  /** the signed-in user is a responder for this customer */
  mine: boolean;
  openIncidents: number;
  callHealth: CallHealth;
  projects: ScopeProjectNode[];
}

export interface ScopeSel {
  customer?: string;
  project?: string;
  service?: string;
  mine?: boolean;
}

export const ROOT_KEY = "*";
export const MY_KEY = "~my";
export const OTHER_KEY = "~ot";
export const TREE_MIN_WIDTH = 200;
export const TREE_MAX_WIDTH = 360;
export const TREE_DEFAULT_WIDTH = 272;
export const TREE_RAIL_WIDTH = 45;

export const clampTreeWidth = (w: number) => Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, Math.round(w)));

/** A project needs its customer, a service needs its project; a customer replaces "mine". */
export function normalizeSel(sel: ScopeSel): ScopeSel {
  if (!sel.customer) return sel.mine ? { mine: true } : {};
  const o: ScopeSel = { customer: sel.customer };
  if (sel.project) {
    o.project = sel.project;
    if (sel.service) o.service = sel.service;
  }
  return o;
}

export function selKey(sel: ScopeSel): string {
  const s = normalizeSel(sel);
  if (!s.customer) return s.mine ? MY_KEY : ROOT_KEY;
  return [s.customer, s.project, s.service].filter(Boolean).join("/");
}

export function sameSel(a: ScopeSel, b: ScopeSel): boolean {
  return selKey(a) === selKey(b);
}

export interface ResolvedScope {
  customer: ScopeCustomerNode;
  project?: ScopeProjectNode;
  service?: ScopeServiceNode;
}

/** null = no customer chosen; undefined = a slug that does not exist (callers show Not found). */
export function resolveSel(customers: ScopeCustomerNode[], sel: ScopeSel): ResolvedScope | null | undefined {
  const s = normalizeSel(sel);
  if (!s.customer) return null;
  const customer = customers.find((c) => c.slug === s.customer);
  if (!customer) return undefined;
  if (!s.project) return { customer };
  const project = customer.projects.find((p) => p.slug === s.project);
  if (!project) return undefined;
  if (!s.service) return { customer, project };
  const service = project.services.find((v) => v.slug === s.service);
  if (!service) return undefined;
  return { customer, project, service };
}

export function selLabel(customers: ScopeCustomerNode[], sel: ScopeSel): string {
  const r = resolveSel(customers, sel);
  if (!r) return sel.mine && !sel.customer ? "My customers" : "All customers";
  return [r.customer.name, r.project?.name, r.service?.name].filter(Boolean).join(" › ");
}

export type TreeRowKind = "root" | "group" | "customer" | "project" | "service";

export interface TreeRow {
  key: string;
  kind: TreeRowKind;
  label: string;
  /** indent: 0 customer (and root/group), 1 project, 2 service */
  depth: 0 | 1 | 2;
  /** aria-level */
  level: number;
  hasKids: boolean;
  expanded: boolean;
  /** this row is exactly the current filter */
  selected: boolean;
  /** collapsed, and the current filter is somewhere inside */
  filterInside: boolean;
  /** matched by the typed text */
  hit: boolean;
  /** customers in this group / in total (root, group) */
  count?: number;
  /** customers of the group left after search / problems (group only) */
  shown?: number;
  openIncidents: number;
  health: Exclude<CallHealth, "OK"> | null;
  ownSteps: boolean;
  /** levels with own steps somewhere below (shown while collapsed) */
  ownInside: number;
  /** what choosing the row applies; null = the row only expands (Other customers) */
  sel: ScopeSel | null;
}

export interface TreeView {
  rows: TreeRow[];
  /** rows matched by the typed text */
  hits: number;
  hitCustomers: number;
  /** key of the single match, when hits === 1 */
  onlyHit: string | null;
  /** customers with an open incident or a call-health problem */
  problemCount: number;
}

export interface BuildTreeOptions {
  sel: ScopeSel;
  query?: string;
  problemsOnly?: boolean;
  /** explicit expand/collapse choices by row key; anything missing uses the default */
  expanded?: Record<string, boolean>;
}

export const tokensOf = (q: string | undefined) => (q ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
const words = (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean);
const starts = (ws: string[], t: string) => ws.some((w) => w.startsWith(t));

/**
 * Every typed word starts a word of the path (customer › project › service) and at least one starts a word of the
 * node's own name: "mirae check" finds Mirae Pay › Core › Checkout only (T6).
 */
export function matchesNode(tokens: string[], ownName: string, path: string): boolean {
  if (!tokens.length) return false;
  const ow = words(ownName);
  const pw = words(path);
  return tokens.every((t) => starts(pw, t)) && tokens.some((t) => starts(ow, t));
}

export const customerHasProblem = (c: ScopeCustomerNode) => c.openIncidents > 0 || c.callHealth !== "OK";

function ownInsideOf(c: ScopeCustomerNode, p?: ScopeProjectNode): number {
  if (p) return p.services.filter((s) => s.ownSteps).length;
  return c.projects.reduce((n, q) => n + (q.ownSteps ? 1 : 0) + q.services.filter((s) => s.ownSteps).length, 0);
}

export function buildTree(customers: ScopeCustomerNode[], opts: BuildTreeOptions): TreeView {
  const sel = normalizeSel(opts.sel);
  const tk = tokensOf(opts.query);
  const q = tk.length > 0;
  const pr = Boolean(opts.problemsOnly) && !q;
  const ex = (k: string, def: boolean) => opts.expanded?.[k] ?? def;
  let hits = 0;
  let hitCustomers = 0;
  let onlyHit: string | null = null;

  function customerRows(c: ScopeCustomerNode, out: TreeRow[]) {
    const isSel = sel.customer === c.slug;
    const cm = matchesNode(tk, c.name, c.name);
    const ps = c.projects.map((p) => ({
      p,
      pm: matchesNode(tk, p.name, `${c.name} ${p.name}`),
      ss: q ? p.services.filter((s) => matchesNode(tk, s.name, `${c.name} ${p.name} ${s.name}`)) : [],
    }));
    const sub = ps.some((z) => z.pm || z.ss.length > 0);
    if (q && !cm && !sub) return;
    if (pr && !customerHasProblem(c) && !isSel) return;
    if (q) {
      const before = hits;
      if (cm) { hits++; onlyHit = c.slug; }
      for (const z of ps) {
        if (z.pm) { hits++; onlyHit = `${c.slug}/${z.p.slug}`; }
        for (const s of z.ss) { hits++; onlyHit = `${c.slug}/${z.p.slug}/${s.slug}`; }
      }
      if (hits > before) hitCustomers++;
    }
    const e = ex(c.slug, q ? sub : isSel);
    out.push({
      key: c.slug, kind: "customer", label: c.name, depth: 0, level: 2, hasKids: true, expanded: e,
      selected: isSel && !sel.project, filterInside: isSel && Boolean(sel.project) && !e, hit: cm,
      openIncidents: c.openIncidents, health: c.callHealth === "OK" ? null : c.callHealth, ownSteps: false,
      ownInside: ownInsideOf(c), sel: { customer: c.slug },
    });
    if (!e) return;
    for (const z of ps) {
      const p = z.p;
      const psel = isSel && sel.project === p.slug;
      if (q && sub && !z.pm && z.ss.length === 0) continue;
      if (pr && p.openIncidents === 0 && !psel) continue;
      const pk = `${c.slug}/${p.slug}`;
      const pe = ex(pk, q ? z.ss.length > 0 : psel);
      out.push({
        key: pk, kind: "project", label: p.name, depth: 1, level: 3, hasKids: true, expanded: pe,
        selected: psel && !sel.service, filterInside: psel && Boolean(sel.service) && !pe, hit: z.pm,
        openIncidents: p.openIncidents, health: null, ownSteps: p.ownSteps, ownInside: ownInsideOf(c, p),
        sel: { customer: c.slug, project: p.slug },
      });
      if (!pe) continue;
      for (const s of z.ss.length ? z.ss : p.services) {
        const ssel = psel && sel.service === s.slug;
        if (pr && s.openIncidents === 0 && !ssel) continue;
        out.push({
          key: `${pk}/${s.slug}`, kind: "service", label: s.name, depth: 2, level: 4, hasKids: false, expanded: false,
          selected: ssel, filterInside: false, hit: q && z.ss.length > 0,
          openIncidents: s.openIncidents, health: null, ownSteps: s.ownSteps, ownInside: 0,
          sel: { customer: c.slug, project: p.slug, service: s.slug },
        });
      }
    }
  }

  const mine = customers.filter((c) => c.mine);
  const other = customers.filter((c) => !c.mine);
  const rows: TreeRow[] = [{
    key: ROOT_KEY, kind: "root", label: "All customers", depth: 0, level: 1, hasKids: false, expanded: false,
    selected: !sel.customer && !sel.mine, filterInside: false, hit: false, count: customers.length,
    openIncidents: 0, health: null, ownSteps: false, ownInside: 0, sel: {},
  }];
  const groups: [string, string, ScopeCustomerNode[]][] = [
    [MY_KEY, "My customers", mine],
    [OTHER_KEY, mine.length ? "Other customers" : "Customers", other],
  ];
  for (const [gk, label, list] of groups) {
    if (!list.length) continue;
    const inner: TreeRow[] = [];
    for (const c of list) customerRows(c, inner);
    const shown = inner.filter((r) => r.kind === "customer").length;
    if ((q || pr) && !shown) continue;
    const has = Boolean(sel.customer) && list.some((c) => c.slug === sel.customer);
    const e = ex(gk, gk === MY_KEY || !mine.length || q || pr || has);
    const worst = list.some((c) => c.callHealth === "UNREACHABLE") ? "UNREACHABLE" : list.some((c) => c.callHealth === "AT_RISK") ? "AT_RISK" : null;
    rows.push({
      key: gk, kind: "group", label, depth: 0, level: 1, hasKids: true, expanded: e,
      selected: gk === MY_KEY && !sel.customer && Boolean(sel.mine), filterInside: has && !e, hit: false,
      count: list.length, shown: q || pr ? shown : undefined,
      openIncidents: list.reduce((n, c) => n + c.openIncidents, 0), health: worst, ownSteps: false, ownInside: 0,
      sel: gk === MY_KEY ? { mine: true } : null,
    });
    if (e) rows.push(...inner);
  }
  return { rows, hits, hitCustomers, onlyHit: hits === 1 ? onlyHit : null, problemCount: customers.filter(customerHasProblem).length };
}

export interface TreeKeyContext {
  /** text is typed in the search box */
  searching?: boolean;
  /** Enter was pressed in the search box with several matches: nothing is selected until the user moves */
  ambiguous?: boolean;
  /** type-ahead buffer so far (the caller resets it after 700 ms) */
  typeahead?: string;
  /** all customers, to jump into a collapsed group by type-ahead */
  customers?: ScopeCustomerNode[];
}

export interface TreeKeyResult {
  handled: boolean;
  /** new cursor row key */
  cur?: string;
  /** expand/collapse this row (the filter does not change) */
  toggle?: string;
  /** choose this row as the filter */
  pick?: string;
  /** open this group first, then move the cursor to `cur` */
  openGroup?: string;
  /** Enter with several matches and no choice yet: say so, select nothing */
  refuse?: boolean;
  typeahead?: string;
}

/** Keyboard model of the tree (T8): ↑ ↓ move, → expand / into, ← collapse / to parent, Enter choose, Home/End, type-ahead. */
export function treeKey(rows: TreeRow[], curKey: string | null, key: string, ctx: TreeKeyContext = {}): TreeKeyResult {
  let i = rows.findIndex((r) => r.key === curKey);
  if (i < 0) i = 0;
  const n = rows[i];
  if (!n) return { handled: false };
  const sq = Boolean(ctx.searching) && rows.some((r) => r.hit);
  const move = (j: number): TreeKeyResult => ({ handled: true, cur: rows[j]!.key });

  if (sq && (key === "ArrowDown" || key === "ArrowUp")) {
    // while searching, up/down step from match to match; the first press after a refused Enter stays on the match
    if (ctx.ambiguous && n.hit) return move(i);
    const d = key === "ArrowDown" ? 1 : -1;
    for (let j = i + d; j >= 0 && j < rows.length; j += d) if (rows[j]!.hit) return move(j);
    return move(i);
  }
  if (key === "ArrowDown") return move(Math.min(rows.length - 1, i + 1));
  if (key === "ArrowUp") return move(Math.max(0, i - 1));
  if (key === "Home") return move(0);
  if (key === "End") return move(rows.length - 1);
  if (key === "Enter" || key === " ") {
    if (ctx.ambiguous) return { handled: true, refuse: true };
    return n.sel === null ? { handled: true, toggle: n.key } : { handled: true, pick: n.key };
  }
  if (key === "ArrowRight") {
    if (n.hasKids && !n.expanded) return { handled: true, toggle: n.key };
    const next = rows[i + 1];
    if (n.hasKids && next && (next.depth > n.depth || (n.kind === "group" && next.kind === "customer"))) return move(i + 1);
    return move(i);
  }
  if (key === "ArrowLeft") {
    if (n.hasKids && n.expanded) return { handled: true, toggle: n.key };
    for (let j = i - 1; j >= 0; j--) {
      const r = rows[j]!;
      if (r.depth < n.depth || (n.kind === "customer" && r.kind === "group")) return move(j);
    }
    return move(i);
  }
  if (key.length === 1) {
    const ta = (ctx.typeahead ?? "") + key.toLowerCase();
    for (let j = 0; j < rows.length; j++) {
      const k = (i + (ta.length > 1 ? 0 : 1) + j) % rows.length;
      const r = rows[k]!;
      if (r.kind !== "group" && r.kind !== "root" && r.label.toLowerCase().startsWith(ta)) return { handled: true, cur: r.key, typeahead: ta };
    }
    const c = ctx.customers?.find((x) => x.name.toLowerCase().startsWith(ta));
    if (c) return { handled: true, cur: c.slug, openGroup: c.mine ? MY_KEY : OTHER_KEY, typeahead: ta };
    return { handled: true, cur: n.key, typeahead: ta };
  }
  return { handled: false };
}

/** Split a label into parts, marking the typed prefix of each matching word. */
export function highlightParts(label: string, tokens: string[]): { text: string; mark: boolean }[] {
  if (!tokens.length) return [{ text: label, mark: false }];
  const out: { text: string; mark: boolean }[] = [];
  for (const w of label.split(/(\s+)/)) {
    const lw = w.toLowerCase();
    const m = tokens.filter((t) => lw.startsWith(t)).sort((a, b) => b.length - a.length)[0];
    if (m) {
      out.push({ text: w.slice(0, m.length), mark: true });
      if (w.length > m.length) out.push({ text: w.slice(m.length), mark: false });
    } else out.push({ text: w, mark: false });
  }
  return out;
}
