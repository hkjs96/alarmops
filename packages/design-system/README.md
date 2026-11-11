담당과 규칙은 저장소 루트 README.md와 CLAUDE.md 참고. 2주차부터 작성.

## Lists: rows never move under the pointer

One rule for every list in the console (Incidents, Call order, Responders, and the next one). Build a list from `src/list/`:

- `useStableRows(items, listKey, { fresh, keep })` — the rows on screen. A row that changed stays in place; a row that left stays as `gone` (render it as a tombstone); new rows wait (`"wait"`, a feed: "3 new · Show") or go after the last row (`"append"`, a short list the user adds to). The order is taken again only by `resort()` or a new `listKey`.
- `<Tombstone label name onUndo />` — what a removed row leaves behind ("Removed · Undo"). Put it where the row's text was, never where its buttons were.
- `markSpot(e)` / `isSameSpot(e)` / `installSameSpotGuard()` — a second press at the same spot within 600 ms does nothing, whatever is under the pointer by then. `ConfirmDialog` marks and checks by itself.
- `ConfirmDialog` — the safe choice has the focus by default; `warning` is shown first and loud. A destructive row action asks first, naming who and where.

Give every row `data-row-key` and every control that changes a list `data-list-action="<list>.<action>"`. The console's unit test `src/lib/contract.test.ts` fails until an e2e test calls `assertNoRowShift(page, { name: "<list>.<action>", … })` (`apps/console/e2e/helpers/no-row-shift.ts`) for it.
