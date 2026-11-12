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
- **Sign-out origin check** (`src/lib/auth/origin.ts`): `Origin` is compared with the request's scheme and the `Host` header (see the last section for `CONSOLE_ORIGIN`). `X-Forwarded-Host` is ignored unless **`TRUSTED_PROXY=1`** is set. Set it only when the console runs behind a reverse proxy that (a) rewrites `Host` to an internal name and (b) *overwrites* `X-Forwarded-Host` with the host the browser addressed, discarding any value the client sent. If the proxy rewrites `Host` and `TRUSTED_PROXY` is not set, same-origin sign-out answers 403; if it is set and the proxy passes the client's header through, the check can be bypassed. A proxy that preserves `Host` (and sets `X-Forwarded-Proto` when it ends TLS) needs nothing.
- **Roles in server actions** (`src/lib/auth/role.ts`, `requireRole`): after the session check and before input is looked at, an action asks `GET /me` and refuses with `ROLE_REQUIRED` when the role is too low — ADMIN for every call-order and Responders write, OPERATOR for acknowledge / escalate / resolve / bulk / undo. This is a second line only: the API checks the role on the write itself and stays the authority. Tests: `src/lib/action-roles.test.ts`.
- **Rows do not rely on scroll anchoring**: while Responders are edited, a 44px status line above the lists (`co-resp-live`) says how reachable the customer is now and whether the last change applied; everything that needs room (problems, "Changed — reload", errors) is below the last row (`co-resp-status`); the top of the panel is held, and marked as held, until Done (next section). `e2e/helpers/no-row-shift.ts` switches `overflow-anchor` off for every measurement, and `e2e/zzzz-recheck.spec.ts` asserts 0px.
- **Playwright**: `PORT=<n>` picks the port (default 3107). `PW_NO_REUSE=1` (or `CI`) makes the run start its own server and fail if the port is taken — a leftover server has a changed mock store. `PW_WEBKIT=1` adds a WebKit project for `zzzz-recheck.spec.ts` (needs `npx playwright install webkit`).

## Held panel top, ended sessions (11/11 최종 점검 fixes)

- **Responders edit — the top of the panel** (`CallOrderPanel`, `co-top`): from the press on Edit until Done the block (sentence, "Paged (n)", steps, health) is a box of the height it had: labelled "Before your changes — updates when you press Done", its old text dimmed and inert, and one live line of fixed height on top — "Now: UNREACHABLE — nobody is paged" (`co-held-now`). Each change is applied when it is made, so leaving without Done shows the list / a reopened panel as the server has it.
- **Status lines** (`co-resp-live`, `co-held-now`) have one height (52px, 70px on a phone) and wrap inside it; nothing is cut with an ellipsis. Reload after "Changed — reload" keeps every row's height and the status area's room until Done.
- **A session that is gone** (`src/lib/session-ended.ts`): every server action is called as `callAction(() => action(…))` — a unit test fails for a bare call. The middleware answers a server action without a session with `401 SESSION_ENDED` instead of a redirect; `callAction` turns that (or `UNAUTHORIZED` / `UNAUTHENTICATED`, or an unreadable answer while `GET /auth/session` says 401) into a failure with the code `SESSION_ENDED`, so pending states end, and the shell shows "Your session ended — sign in again. Nothing was changed." with **Sign in** → `/login?next=<this address>` (`components/SessionEnded.tsx`). Drafts are kept. An unreadable answer with the session still there is `NO_ANSWER` ("not known whether this was applied").
- **Sign-out reaches the other tabs**: `signOutNow` posts on `BroadcastChannel("ao-auth")` and stamps `localStorage["ao-signed-out"]` (a time, nothing else); other tabs remove their `ao-…` sessionStorage keys and show the same state.
- **Save and sign out**: the confirmation of a wide save says sign-out follows; cancelling it says "Not signed out"; pressed while a save is on its way, it follows that save (one request) and says so.
- **Sign-out origin check** compares scheme + host + port. The scheme is the one Next reports (`X-Forwarded-Proto` when a load balancer sets it, the connection otherwise). **`CONSOLE_ORIGIN`** (e.g. `https://console.example.com`), when set, is the only origin accepted — the strict setting for production.

## Live mode: the API inside the console (11/12, D-09)

- `MOCK_API` unset → `/api/v1/*` is `packages/api` on `packages/store-sql` (`DATABASE_URL`, `DATABASE_POOLER=transaction` behind Supavisor/PgBouncer). The pages call the same handler in-process (`lib/server/backend.ts`); the AuthContext is built on the server from the session's user (`User.status = ACTIVE`, role and customer from the row).
- `POST /api/internal/tick` — `Authorization: Bearer $TICK_SECRET` (≥ 32 chars, constant time, 503 when unset). pg_cron + pg_net call it every minute (SQL in docs/API-CONTRACT.md §5).
- Dev sign-in against the real API: `LIVE_DEV_LOGIN=1` + `SESSION_SECRET` with `next dev` only (never under NODE_ENV=production): `/auth/dev-login?as=admin|operator|viewer` signs in as the users of `db/prisma/seed.ts`.

### Live e2e (`npm run e2e:live -w @alarmops/console`)

`LIVE_DATABASE_URL` = admin URL of a LOCAL Postgres (≥ 15). `e2e-live/prepare.mjs` drops and creates `alarmops_live`, applies every migration and runs the db seed, then `next dev` starts on 3117 (`.next-live/`). Without `LIVE_DATABASE_URL` the tests are skipped with that reason. CI: job `e2e-live` on a `postgres:16` service. Locally without Docker, e.g. the Postgres binaries in `/opt/pglocal` (run as a non-root user):
`initdb -D /tmp/pg/data -U postgres --auth=trust && pg_ctl -D /tmp/pg/data -o "-p 55432 -k /tmp/pg" start`, then `LIVE_DATABASE_URL=postgresql://postgres@localhost:55432/postgres`.
