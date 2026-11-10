담당과 규칙은 저장소 루트 README.md와 CLAUDE.md 참고. 2주차부터 작성.

## Scope shell (docs/ui/scope-variants.md §7.6)

- Every signed-in screen sits in `ScopeShell` (`src/components/ScopeShell.tsx`): top nav, filter line, docked customer tree (desktop) or step sheet (phone ≤760px), content, optional panel.
- List filter lives in the query: `?customer=&project=&service=` (slugs) or `?mine=1`. Helpers and rules: `src/lib/scope.ts`.
- A panel is one path: `/c/<customer>/<project>/<service>/incident/<id>` (`/c/-/incident/<id>` for an unmapped account). The query on that address is only the reader's list filter. `/incidents/<id>` redirects there.
- Unknown, malformed or out-of-scope addresses render one body: `src/components/NotFoundBody.tsx`.
- Mock data: `src/lib/api/mock/scope-fixtures.ts` (14 customers; `MOCK_CUSTOMERS=34` for the 34-customer set). Scope fields follow `docs/API-CONTRACT.md` §8.0; fields still marked PROPOSED in `src/lib/api/types.ts` are display helpers the contract does not pin yet.
- Screenshots: `node --experimental-strip-types e2e/scope-shots.ts` (server on 3107) → `docs/qa/shots/console-scope/` (gitignored).

## Acknowledge, "open", security headers (11/10 fixes)

- **Open** has one meaning everywhere (badge, tree, Open tile, summary line, "Outside this view"): triggered or escalated, nobody has acknowledged it (`isOpen` in `src/lib/incidents.ts`, `counts.open`). The default tab is **Active** = open + acknowledged.
- Acknowledge (row, card, panel) = `ackIncident(id, version)` → `POST /incidents/{id}/ack` with `If-Match`, returns the undo token. A 409 leaves the row in a "Changed since you loaded this list · Reload" state. Bulk sends `items: [{ id, version }]`.
- An acknowledged row keeps its place until the pointer leaves it, 5 s pass or the list changes (`heldOrder`, `HOLD_MS`). A second press at the same spot within 600 ms is ignored (row buttons, the panel's Undo, a toast's button).
- Panel: "Acknowledged ✓ · Undo" for 5 s, then `Resolve…`, which asks first. Undo tokens are shared through `ShellContext.acks`.
- Read paths fold 403 into Not found (`isHidden`). One id / slug validator: `src/lib/validate.ts`.
- Response headers (CSP, frame-ancestors, nosniff, referrer): `securityHeaders` in `next.config.ts`. The tree's rail/width is applied before first paint by `shellInitScript` (`src/lib/shell-prefs.ts`).
- `Ctrl/⌘K` "Filter to…": `ScopeSearch` in the design system; on a phone the search button in the filter line.
