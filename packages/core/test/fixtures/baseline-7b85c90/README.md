# baseline-7b85c90 — do not edit

`packages/core/src` exactly as it was at commit `7b85c90` (before the outbox lanes), taken with

    git archive 7b85c90 packages/core/src | tar -x -C packages/core/test/fixtures/baseline-7b85c90

It is the REAL baseline engine for `test/security-review-4.baseline.test.ts`, which runs its `runTick` +
`MemoryTickStore` and the current ones through the same scenarios (`test/real-engine.ts`).

- Not part of the build: excluded in `packages/core/tsconfig.json`, imported only by that one test.
- Never change a file here. To check it is untouched: `git diff 7b85c90 -- packages/core/src` against this copy, or
  re-run the command above and see that `git status` stays clean.
