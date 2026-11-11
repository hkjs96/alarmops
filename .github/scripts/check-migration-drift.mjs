// Decides whether the output of
//   prisma migrate diff --from-migrations <dir> --to-schema-datamodel <schema> --script
// is acceptable. Usage: node check-migration-drift.mjs <diff.sql> <migrations dir>
//
// An empty diff passes. The only other statements that pass are `DROP INDEX "<name>"` for indexes that a
// migration creates by hand because the Prisma schema language cannot express them: unique indexes with
// NULLS NOT DISTINCT or with a WHERE clause (see the end of db/prisma/migrations/0001_init/migration.sql).
// Prisma sees those in the database, does not find them in schema.prisma and proposes to drop them.
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
for (const entry of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(migrationsDir, entry.name, 'migration.sql');
  if (!fs.existsSync(file)) continue;
  for (const st of statements(fs.readFileSync(file, 'utf8'))) {
    const m = /^CREATE UNIQUE INDEX "([^"]+)" ON .*(?:\bNULLS NOT DISTINCT\b|\bWHERE\b)/i.exec(st);
    if (m) handWritten.add(m[1]);
  }
}

const allowed = [];
const unexpected = [];
for (const st of statements(fs.readFileSync(diffFile, 'utf8'))) {
  const m = /^DROP INDEX (?:"public"\.)?"([^"]+)"$/i.exec(st);
  if (m && handWritten.has(m[1])) allowed.push(m[1]);
  else unexpected.push(st);
}

if (unexpected.length) {
  console.error('schema.prisma and the migrations disagree. Statements Prisma would still need to run:');
  for (const st of unexpected) console.error(`  ${st};`);
  console.error('Add a migration (npx prisma migrate dev) or fix schema.prisma. See db/README.md.');
  process.exit(1);
}
if (allowed.length) {
  console.log(`Ignored ${allowed.length} hand-written index(es) that schema.prisma cannot express: ${allowed.join(', ')}`);
}
console.log('Migrations match schema.prisma.');
