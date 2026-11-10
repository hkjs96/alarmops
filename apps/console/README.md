담당과 규칙은 저장소 루트 README.md와 CLAUDE.md 참고. 2주차부터 작성.

## Scope shell (docs/ui/scope-variants.md §7.6)

- Every signed-in screen sits in `ScopeShell` (`src/components/ScopeShell.tsx`): top nav, filter line, docked customer tree (desktop) or step sheet (phone ≤760px), content, optional panel.
- List filter lives in the query: `?customer=&project=&service=` (slugs) or `?mine=1`. Helpers and rules: `src/lib/scope.ts`.
- A panel is one path: `/c/<customer>/<project>/<service>/incident/<id>` (`/c/-/incident/<id>` for an unmapped account). The query on that address is only the reader's list filter. `/incidents/<id>` redirects there.
- Unknown, malformed or out-of-scope addresses render one body: `src/components/NotFoundBody.tsx`.
- Mock data: `src/lib/api/mock/scope-fixtures.ts` (14 customers; `MOCK_CUSTOMERS=34` for the 34-customer set). Fields marked PROPOSED in `src/lib/api/types.ts` are not in `docs/API-CONTRACT.md` yet.
- Screenshots: `node --experimental-strip-types e2e/scope-shots.ts` (server on 3107) → `docs/qa/shots/console-scope/` (gitignored).
