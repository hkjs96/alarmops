# db

Prisma schema for AlarmOps (implements `docs/DATA-MODEL.md`). Postgres standard features only (D-09). Schema changes only via `prisma migrate` (D-10); never `prisma db push`.

- `prisma/schema.prisma` — the model. Constraints Prisma cannot express (partial unique indexes, CHECKs, `NULLS NOT DISTINCT`, PG15+) are appended by hand at the end of `prisma/migrations/0001_init/migration.sql`.
- `npm test -w @alarmops/db` — `prisma validate` + checks that the generated part of `0001_init` matches the schema.
- Regenerate the generated part after a schema change (before the first deploy only; afterwards add a new migration with `prisma migrate dev`):
  `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
  Where binaries.prisma.sh is blocked, `npm run migrate:diff -w @alarmops/db` produces the same DDL with the WASM schema engine (no DB, no native binary).
- `npm run seed -w @alarmops/db` — minimal dev seed (needs `prisma generate` and a dev DB).
