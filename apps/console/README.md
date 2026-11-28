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
- **Sign-out origin check** (`src/lib/auth/origin.ts`): `Origin` is compared with the request's scheme and the `Host` header (see the last section for `CONSOLE_ORIGIN`). `X-Forwarded-Host` is ignored unless **`TRUSTED_PROXY=1`** is set (required in a deployment behind a load balancer: the `/auth/session` rate limit also reads the client address from `X-Forwarded-For` only then; without it all callers share one bucket). Set it only when the console runs behind a reverse proxy that (a) rewrites `Host` to an internal name and (b) *overwrites* `X-Forwarded-Host` with the host the browser addressed, discarding any value the client sent. If the proxy rewrites `Host` and `TRUSTED_PROXY` is not set, same-origin sign-out answers 403; if it is set and the proxy passes the client's header through, the check can be bypassed. A proxy that preserves `Host` (and sets `X-Forwarded-Proto` when it ends TLS) needs nothing.
- **Roles in server actions** (`src/lib/auth/role.ts`, `requireRole`): after the session check and before input is looked at, an action asks `GET /me` and refuses with `ROLE_REQUIRED` when the role is too low — ADMIN for every call-order and Responders write, OPERATOR for acknowledge / escalate / resolve / bulk / undo. This is a second line only: the API checks the role on the write itself and stays the authority. Tests: `src/lib/action-roles.test.ts`.
- **Rows do not rely on scroll anchoring**: while Responders are edited, a 44px status line above the lists (`co-resp-live`) says how reachable the customer is now and whether the last change applied; everything that needs room (problems, "Changed — reload", errors) is below the last row (`co-resp-status`); the top of the panel is held, and marked as held, until Done (next section). `e2e/helpers/no-row-shift.ts` switches `overflow-anchor` off for every measurement, and `e2e/zzzz-recheck.spec.ts` asserts 0px.
- **Playwright**: `PORT=<n>` picks the port (default 3107). `PW_NO_REUSE=1` (or `CI`) makes the run start its own server and fail if the port is taken — a leftover server has a changed mock store. `PW_WEBKIT=1` adds a WebKit project for `zzzz-recheck.spec.ts` (needs `npx playwright install webkit`).

## Held panel top, ended sessions (11/11 최종 점검 fixes)

- **Responders edit — the top of the panel** (`CallOrderPanel`, `co-top`): from the press on Edit until Done the block (sentence, "Paged (n)", steps, health) is a box of the height it had: labelled "Before your changes — updates when you press Done", its old text dimmed and inert, and one live line of fixed height on top — "Now: UNREACHABLE — nobody is paged" (`co-held-now`). Each change is applied when it is made, so leaving without Done shows the list / a reopened panel as the server has it.
- **Status lines** (`co-resp-live`, `co-held-now`) have one height (52px, 70px on a phone) and wrap inside it; nothing is cut with an ellipsis. Reload after "Changed — reload" keeps every row's height and the status area's room until Done.
- **A session that is gone** (`src/lib/session-ended.ts`): every server action is called as `callAction(() => action(…))` — a unit test fails for a bare call. The middleware answers a server action without a session with `401 SESSION_ENDED` instead of a redirect; `callAction` turns that (or `UNAUTHORIZED` / `UNAUTHENTICATED`, or an unreadable answer while `GET /auth/session` says 401) into a failure with the code `SESSION_ENDED`, so pending states end, and the shell shows "Your session ended — sign in again. Nothing was changed." with **Sign in** → `/login?next=<this address>` (`components/SessionEnded.tsx`). Drafts are kept. An unreadable answer with the session still there is `NO_ANSWER` ("not known whether this was applied").
- **Sign-out reaches the other tabs**: `signOutNow` posts on `BroadcastChannel("ao-auth")` and stamps `localStorage["ao-signed-out"]` (a time, nothing else); other tabs remove their `ao-…` sessionStorage keys and show the same state.
- **Save and sign out**: the confirmation of a wide save says sign-out follows; cancelling it says "Not signed out"; pressed while a save is on its way, it follows that save (one request) and says so.
- **Sign-out origin check** compares scheme + host + port. The scheme is the one Next reports (`X-Forwarded-Proto` when a load balancer sets it, the connection otherwise). **`CONSOLE_ORIGIN`** (e.g. `https://console.example.com`)is the only origin accepted and is **required when `NODE_ENV=production`**: unset or not an http(s) origin → every request answers 503 (fail closed; only the mock e2e run, `MOCK_API=1` + `E2E_ALLOW_MOCK=1`, is exempt). `/auth/session` is rate limited (120/min per address, 30/min per session, in memory — per instance) and every response carries a per-request-nonce CSP (`src/lib/csp.ts`, set in `middleware.ts`).

## Live mode: the API inside the console (11/12, D-09)

- `MOCK_API` unset → `/api/v1/*` is `packages/api` on `packages/store-sql` (`DATABASE_URL`, `DATABASE_POOLER=transaction` behind Supavisor/PgBouncer). The pages call the same handler in-process (`lib/server/backend.ts`); the AuthContext is built on the server from the session's user (`User.status = ACTIVE`, role and customer from the row).
- `POST /api/internal/tick` — `Authorization: Bearer $TICK_SECRET` (≥ 32 chars, constant time, 503 when unset). pg_cron + pg_net call it every minute (SQL in docs/API-CONTRACT.md §5).
- Dev sign-in against the real API: `LIVE_DEV_LOGIN=1` + `SESSION_SECRET` with `next dev` only (never under NODE_ENV=production): `/auth/dev-login?as=admin|operator|viewer` signs in as the users of `db/prisma/seed.ts`.

### Live e2e (`npm run e2e:live -w @alarmops/console`)

`LIVE_DATABASE_URL` = admin URL of a LOCAL Postgres (≥ 15). `e2e-live/prepare.mjs` drops and creates `alarmops_live`, applies every migration and runs the db seed, then `next dev` starts on 3117 (`.next-live/`). Without `LIVE_DATABASE_URL` the tests are skipped with that reason. CI: job `e2e-live` on a `postgres:16` service. Locally without Docker, e.g. the Postgres binaries in `/opt/pglocal` (run as a non-root user):
`initdb -D /tmp/pg/data -U postgres --auth=trust && pg_ctl -D /tmp/pg/data -o "-p 55432 -k /tmp/pg" start`, then `LIVE_DATABASE_URL=postgresql://postgres@localhost:55432/postgres`.

## Google sign-in (issue #64, D-55)

Routes: `/auth/google/start` (public) → Google → `/auth/google/callback` (public). Setup for a person: `docs/SETUP-GOOGLE-SSO.md`.

| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the OAuth client (Web application). The secret is Sensitive and never reaches the build (`strip-deploy-env.mjs` is an allowlist). |
| `SSO_ALLOWED_DOMAINS` | comma-separated domains whose addresses MSP staff may sign in with (initial: `mz.co.kr`, `megazone.com`). Plain Vercel variable (the deploy check reads it). |
| `SSO_ALLOWED_EMAILS` | optional, comma-separated exact addresses outside those domains. Values only in configuration, never in the repo. |

- **Fail closed** (`lib/auth/sso-config.ts`): missing client id/secret/`SESSION_SECRET`, or no valid list entry → `/login?sso=unavailable`, never "allow all". Entries are trimmed and lowercased; wildcards, spaces, `@`, non-ASCII, single labels are dropped with one warning (no values in it).
- **Flow** (`lib/auth/google-oidc.ts`, Node crypto + fetch, no dependency): authorization code + PKCE (S256). `state`, `nonce` and the PKCE verifier are sealed (HMAC, key derived from `SESSION_SECRET` with a purpose label) into the HttpOnly, SameSite=Lax, `Secure` (https), 10-minute `ao_sso` cookie scoped to `/auth/google`; it is single use (cleared on every callback outcome). The redirect URI is `<CONSOLE_ORIGIN>/auth/google/callback`, never from request headers (production without `CONSOLE_ORIGIN` → unavailable; the middleware already answers 503).
- **ID token**: header `alg` must be RS256 with a `kid`; signature checked against Google's JWKS (cached by `Cache-Control: max-age`, one refetch per minute on an unknown `kid`); `iss` is `https://accounts.google.com` or `accounts.google.com`; `aud` is the client id (a list also needs `azp`); `exp` (60 s skew) and `iat`; `nonce` equal (constant time); `email_verified === true`. `hd` is never read.
- **Who gets in** (`lib/auth/sso-signin.ts`): the user row decides. An active, pre-registered user whose principal the API accepts (`signInUserByEmail` → `sessionPrincipal`, so a suspended customer's portal user is refused as everywhere else). MSP staff (INTERNAL, any role) must also be inside the fence: exact domain in `SSO_ALLOWED_DOMAINS` (no suffix match, ASCII only) or exact address in `SSO_ALLOWED_EMAILS`. A portal (CUSTOMER) user needs no domain: an ADMIN registering them is the approval. Every refusal is the same `/login?sso=refused`; the reason code (`no_user`, `staff_outside_fence`, …) goes to the server log without the address.
- **Per-customer login domain (`Customer.loginDomains`, R4-3) is live** (#74): when no user row exists and the address is NOT in the staff fence/exception list (the staff rule wins, no auto-enrolment), the callback asks `enrolByLoginDomain` → store `enrolPortalUserByDomain`, which creates (or returns) the VIEWER portal user of the ONE active customer that registered the domain. The result still goes through `sessionPrincipal` (ACTIVE, customer not suspended). Every store refusal (`DOMAIN_UNKNOWN`, `AMBIGUOUS`, `CUSTOMER_INACTIVE`, `FREE_MAIL`, `STAFF_EMAIL`, `OTHER_CUSTOMER`, `USER_INACTIVE`, `INVALID_EMAIL`) is the same `/login?sso=refused`; the code goes to the server log as `no_user (enrol <CODE>)`, never an address. Where domains are set: the customer screen (issue #63); until then `PATCH /customers/{id}` `{loginDomains}`.
- **Google `sub` binding is live** (#74): `bindGoogleAccount` → store `bindGoogleSub`. `bound` (first sign-in) and `ok` give a session; `mismatch` and `NOT_FOUND` → refused, reason `sub_mismatch`. An ADMIN clears a binding in Settings › Users (`PATCH /users/{id} {clearGoogleSub:true}`); the next sign-in binds again.
- After a successful sign-in `touchLastLogin` stamps `User.lastLoginAt`; a failure is logged (`[sso] touchLastLogin failed`) and never blocks the sign-in.
- Before any lookup an address that is not plain printable ASCII with exactly one `@` is refused (customer rows have no domain fence and `User.email` is citext).
- Session: the same `ao_session` cookie as dev login (`sub` = `User.id`, no e-mail in the cookie; `Secure` follows `CONSOLE_ORIGIN`). `next` goes through `safeNextPath` at start and again at the callback.
- Tests: `lib/auth/{sso-config,sso-signin,google-oidc}.test.ts`, `app/auth/google/route.test.ts` (stubbed Google and store, no network), `app/login/page.test.tsx`. No e2e: it would need Google.

## Deploy environment, retention, commands (D-45, D-46, D-49)

Production deploys only through `.github/workflows/deploy-console.yml` (D-53; setup in `docs/GO-LIVE.md` step 3). It checks the pulled Vercel production environment with `.github/scripts/check-console-deploy-env.mjs` (`CONSOLE_ORIGIN`, `TRUSTED_PROXY`, `GOOGLE_CLIENT_ID` and `SSO_ALLOWED_DOMAINS` must be Plain, not Sensitive, Vercel variables or the pull omits them), then smoke-checks `/login`, the nonce CSP and the unauthenticated tick (`.github/scripts/smoke-console.mjs`).

| Variable | Meaning |
|---|---|
| `ALARM_COMMANDS_QUEUE_URL` | `https://sqs.<region>.amazonaws.com[.cn]/<12-digit account>/<queue>` (`.cn` host only with a `cn-*` region). The SQS client uses the region of this URL (D-58). Unset: no publisher, terminating a customer answers 503 `COMMANDS_UNAVAILABLE` (nothing changes). Malformed: the API refuses to start. |
| `AWS_PARTITION` | **Config, optional**, default `aws` (leave it unset for the commercial partition). One of `aws`, `aws-cn`, `aws-us-gov`; used for the customer role ARNs the API builds (`createApi({ partition })`). When the queue URL is set and its partition differs, the console refuses to start. Unset: the partition of the queue URL, else `aws`. Any other value refuses to start. |
| `ALARM_COMMANDS_EXPECTED_ACCOUNT` | 12-digit account that must own the queue; required when the URL is set. |
| `AWS_ROLE_ARN` | **Deployed Vercel runtime only: never set it in local dev, CI or an agent session** (the OIDC helper may fall back to the Vercel CLI / a developer login). IAM role the console assumes with Vercel OIDC (`awsCredentialsProvider` from `@vercel/functions/oidc`, no access keys, D-49). Permission: `sqs:SendMessage` on that queue only. Queue URL set without it: the publisher stays off (fail closed, a warning is logged). The AWS SDK is imported on the first send only. |
| `RETENTION_RETURN_DAYS` / `RETENTION_AUDIT_DAYS` / `RETENTION_SLA_DAYS` | optional, defaults 30 / 730 / 1826; floors 7 / 90 / 365; bad values are ignored with a warning. One config object (`lib/server/wiring.ts`) is shared by the API (export window, schedule on the deletion record) and the tick's daily retention job. |

- `/api/v1/*` and in-process calls write `ApiResponse.stream` as a streamed Response (`lib/server/response.ts`): headers first, an error midway aborts the stream.
- Customer detail (ADMIN): Legal hold card, "Export incident history (CSV)" (TERMINATED, until the end of the return period; fetched from `/customers/<slug>/export.csv`, which also works in mock mode), Deletion record table. Top nav: "Business-hours summary: N" (suspended-customer incidents + terminated customers still sending events) from `GET /digests/latest`.
- "Escalate now" is off for incidents marked `pagingSuppressed` (customer suspended or terminated, D-43) and says nobody will be paged.

## Customer onboarding (issue #63)

- `/customers/new` (step 1, Admin) creates the customer; steps 2–5 (Organization, AWS account, Connection, People) are at `/customers/<slug>/onboarding?step=…`. Everything is saved by the step that made it, so leaving and returning shows the same state; the address carries a slug and the step, never a value. The customer page has a Connection card that links back.
- **Connection kit**: ExternalId (server-made, shown to Admin only), the stack parameters with Copy (clipboard written in the click handler; falls back to selecting the text), the account id for the `bus-allowlist` workflow (text only; a person runs it), optional roles off by default (Remediator carries the D-15 warning and a confirm). `CentralRoleArn`, `CentralEventBusArn` and `RemediatorCallerRoleArn` come from the three variables below (`lib/server/central.ts`). When one is missing the kit says "This kit is not complete: N values are still missing", disables copying of the missing values and of "all parameters", and names the source (the outputs of the central deployment, deploy-central). In the mock the values are fake and present, except for a customer whose slug starts with `no-central`.
- Manual verification: the console requires a note of 5 to 300 characters; the API does not yet (backend follow-up: enforce it in `POST /contacts/{id}/verify`). `GET /verify/{token}` does not return the customer name yet (backend follow-up: the public page would say who asked).
- **Check**: `POST /accounts/{id}/check` then poll `GET /accounts/{id}/status` every 2 s, at most 30 times, until `lastCheckedAt` changes (`lib/onboarding-poll.ts`). A 429 is worded as a clock time.
- **Public verification page** `/verify/<token>`: no session (exact pattern in `middleware.ts`, `lib/verify-token.ts`). Opening it only reads (GET); the Confirm button POSTs once. `Referrer-Policy: no-referrer`, `X-Robots-Tag`, `no-store`; the token is never logged or stored.
- Mock switches (documented in `lib/api/mock/onboarding-mock.ts`): the last three digits of the AWS account id choose the check result (401 all OK, 402 AlarmWriter denied, 403 Reader denied, 404 stack missing, 503 no command queue); e-mail links work, SMS links answer 503 `VERIFICATION_UNAVAILABLE`; demo tokens `vf_demo_email_1..4`, `vf_demo_sms_1`.

| Variable | Meaning |
|---|---|
| `CENTRAL_ROLE_ARN` | **Plain, runtime** (not a secret, not needed by the build; the deploy check does not require it). ARN of the central IAM role (`arn:aws[a-z-]*:iam::<12 digits>:role/…`), output `CentralRoleArn` of the central deployment. Invalid → treated as unset with one warning (no value). |
| `CENTRAL_EVENT_BUS_ARN` | **Plain, runtime.** ARN of the central event bus, any region (`arn:<aws|aws-cn|aws-us-gov>:events:<region>:<12 digits>:event-bus/…`), output `CentralBusArn`. |
| `REMEDIATOR_CALLER_ROLE_ARN` | **Plain, runtime.** ARN of the separate IAM role that runs approved remediations; needed only for a customer that turns Remediator on. |
| `VERIFY_HASH_SECRET` | **Sensitive, runtime only** (not needed by the build; the deploy check does not require it, it is not visible to `vercel pull`). ≥ 32 characters. Keys the per-destination send cap of verification links. Unset or shorter: the API answers 503 `NOT_CONFIGURED` to a link request (nothing sent). Links also need a sender (`createApi({ verification })`, #39), which does not exist yet: until then `POST /contacts/{id}/verify` with `link` answers 503 `VERIFICATION_UNAVAILABLE` and the page offers manual verification. |
