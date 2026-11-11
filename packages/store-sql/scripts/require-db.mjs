// `npm run test:sql` is the run against a REAL Postgres (CI: postgres:16 service). Without a database URL it must
// fail, not quietly fall back to PGlite (that is what `npm test` is for).
if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is not set. test:sql runs the store contract against a real Postgres, e.g.\n  TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:sql -w @alarmops/store-sql\nFor the in-process run (PGlite) use: npm test -w @alarmops/store-sql');
  process.exit(1);
}
