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

## Sign-out, roles, rows that hold still (11/11 재점검 fixes)

- **Sign out** (`src/lib/sign-out.ts`): clears the `ao-…` sessionStorage keys, then POSTs `/auth/sign-out` from a form attached to `document.body` — it does not depend on the account menu still being open. Over an unsaved edit the guard offers **Save for … and sign out / Sign out without saving / Cancel** (`DirtyGuard signOut`); a draft is not offered because sign-out removes drafts. Save-and-sign-out signs out only after the save went through; otherwise the user stays signed in and is told.
- **Sign-out origin check** (`src/lib/auth/origin.ts`): `Origin` is compared with the `Host` header. `X-Forwarded-Host` is ignored unless **`TRUSTED_PROXY=1`** is set. Set it only when the console runs behind a reverse proxy that (a) rewrites `Host` to an internal name and (b) *overwrites* `X-Forwarded-Host` with the host the browser addressed, discarding any value the client sent. If the proxy rewrites `Host` and `TRUSTED_PROXY` is not set, same-origin sign-out answers 403; if it is set and the proxy passes the client's header through, the check can be bypassed. A proxy that preserves `Host` needs nothing.
- **Roles in server actions** (`src/lib/auth/role.ts`, `requireRole`): after the session check and before input is looked at, an action asks `GET /me` and refuses with `ROLE_REQUIRED` when the role is too low — ADMIN for every call-order and Responders write, OPERATOR for acknowledge / escalate / resolve / bulk / undo. This is a second line only: the API checks the role on the write itself and stays the authority. Tests: `src/lib/action-roles.test.ts`.
- **Rows do not rely on scroll anchoring**: while Responders are edited, a 44px status line above the lists (`co-resp-live`) says how reachable the customer is now and whether the last change applied; everything that needs room (problems, "Changed — reload", errors) is below the last row (`co-resp-status`); the panel around the card is held as it was until Done. `e2e/helpers/no-row-shift.ts` switches `overflow-anchor` off for every measurement, and `e2e/zzzz-recheck.spec.ts` asserts 0px.
- **Playwright**: `PORT=<n>` picks the port (default 3107). `PW_NO_REUSE=1` (or `CI`) makes the run start its own server and fail if the port is taken — a leftover server has a changed mock store. `PW_WEBKIT=1` adds a WebKit project for `zzzz-recheck.spec.ts` (needs `npx playwright install webkit`).
