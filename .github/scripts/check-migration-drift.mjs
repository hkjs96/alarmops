// Decides whether the output of
//   prisma migrate diff --from-migrations <dir> --to-schema-datamodel <schema> --script
// is acceptable. Usage: node check-migration-drift.mjs <diff.sql> <migrations dir>
//
// An empty diff passes. Two kinds of statement also pass, both seen on the first CI run (Prisma 5.22, postgres:16):
//   1. `DROP INDEX "<name>"` for a unique index a migration creates by hand with NULLS NOT DISTINCT, which the
//      Prisma schema language cannot express (end of db/prisma/migrations/0001_init/migration.sql). Prisma finds
//      it in the database, not in schema.prisma, and proposes to drop it. Observed: Alert_customerId_fingerprint_key,
//      Rotation_customerId_name_key, ThresholdDefault_scope_key. Partial indexes (WHERE …) and CHECK constraints
//      are not reported by Prisma at all, so they are not allowed here either.
//   2. `CREATE EXTENSION IF NOT EXISTS "<name>"` when a migration contains that same statement. Prisma repeats it
//      for every extension listed in the datasource, whether or not the database has it (observed: citext).
// Anything else (a table, column, enum, foreign key or ordinary index that differs) fails the job.
import fs from 'node:fs';
import path from 'node:path';

const [diffFile, migrationsDir] = process.argv.slice(2);
if (!diffFile || !migrationsDir) {
  console.error('usage: check-migration-drift.mjs <diff.sql> <migrations dir>');
  process.exit(1);
}

const statements = (sql) =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const handWritten = new Set();
const extensions = new Set();
for (const entry of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(migrationsDir, entry.name, 'migration.sql');
  if (!fs.existsSync(file)) continue;
  for (const st of statements(fs.readFileSync(file, 'utf8'))) {
    const m = /^CREATE UNIQUE INDEX "([^"]+)" ON .*\bNULLS NOT DISTINCT$/i.exec(st);
    if (m) handWritten.add(m[1]);
    if (/^CREATE EXTENSION IF NOT EXISTS "[^"]+"$/.test(st)) extensions.add(st);
  }
}

const allowed = [];
const unexpected = [];
for (const st of statements(fs.readFileSync(diffFile, 'utf8'))) {
  const m = /^DROP INDEX (?:"public"\.)?"([^"]+)"$/i.exec(st);
  if (m && handWritten.has(m[1])) allowed.push(m[1]);
  else if (extensions.has(st)) console.log(`Ignored: ${st}; (already in a migration)`);
  else unexpected.push(st);
}

if (unexpected.length) {
  console.error('schema.prisma and the migrations disagree. Statements Prisma would still need to run:');
  for (const st of unexpected) console.error(`  ${st};`);
  console.error('Add a migration (npx prisma migrate dev) or fix schema.prisma. See db/README.md.');
  process.exit(1);
}
if (allowed.length) {
  console.log(`Ignored ${allowed.length} hand-written NULLS NOT DISTINCT index(es) that schema.prisma cannot express: ${allowed.join(', ')}`);
}
console.log('Migrations match schema.prisma.');
