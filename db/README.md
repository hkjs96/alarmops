# db

Prisma schema for AlarmOps (implements `docs/DATA-MODEL.md`). Postgres standard features only (D-09). Schema changes only via `prisma migrate` (D-10); never `prisma db push`.

- `prisma/schema.prisma` — the model. Constraints Prisma cannot express (partial unique indexes, CHECKs, `NULLS NOT DISTINCT`, PG15+) are appended by hand at the end of `prisma/migrations/0001_init/migration.sql`.
- `npm test -w @alarmops/db` — `prisma validate` + checks that the generated part of `0001_init` matches the schema.
- Regenerate the generated part after a schema change (before the first deploy only; afterwards add a new migration with `prisma migrate dev`):
  `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
  Where binaries.prisma.sh is blocked, `npm run migrate:diff -w @alarmops/db` produces the same DDL with the WASM schema engine (no DB, no native binary).
- `npm run seed -w @alarmops/db` — minimal dev seed (needs `prisma generate` and a dev DB).
- **`0001_init` was edited in place** when `TickStatus` got `DEGRADED` (security review 3; noted in review 4 as N-36). That is the "before the first deploy" path above and is only correct while NO database has `0001_init` applied. If one does (a dev database someone created by hand counts), its checksum no longer matches and the enum value is missing: do not re-apply — add a new migration with `ALTER TYPE "TickStatus" ADD VALUE 'DEGRADED'` instead. This repository cannot tell whether such a database exists; whoever owns the dev database must check before the first `prisma migrate deploy`.
