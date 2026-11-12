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
//
// Only SQL that Postgres would run counts. Comments (`-- …` anywhere on a line, `/* … */` with nesting) are removed
// before the text is cut into statements, and a `;` inside a string, a quoted name or a `$tag$ … $tag$` body does
// not end a statement. Otherwise a migration could put `CREATE UNIQUE INDEX "X" … NULLS NOT DISTINCT` in a comment
// or a string and so get `DROP INDEX "X"` ignored (security review of 2026-11-11, 권고 4).
// Tests: node --test .github/scripts/check-migration-drift.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;
const WORD = /[A-Za-z0-9_$\u0080-￿]/;

/** The statements Postgres would run, comments removed, white space collapsed. */
export function statements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const two = sql.substr(i, 2);
    if (two === '--') {
      // to the end of the line
      while (i < n && sql[i] !== '\n') i++;
      cur += ' ';
    } else if (two === '/*') {
      // Postgres block comments nest; one that is never closed swallows the rest, as it does in Postgres
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.substr(i, 2) === '/*') { depth++; i += 2; }
        else if (sql.substr(i, 2) === '*/') { depth--; i += 2; }
        else i++;
      }
      cur += ' ';
    } else if (c === "'") {
      // E'…' also takes backslash escapes
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !WORD.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '$' && !WORD.test(sql[i - 1] ?? '') && DOLLAR_TAG.test(sql.slice(i, i + 80))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 80))[0];
      const end = sql.indexOf(tag, i + tag.length);
      const j = end === -1 ? n : end + tag.length;
      cur += sql.slice(i, j);
      i = j;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  out.push(cur);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** { ok, allowed, ignored, unexpected } for a diff against the migration files' own SQL. */
export function checkDrift(diffSql, migrationSqls) {
  const handWritten = new Set();
  const extensions = new Set();
  for (const sql of migrationSqls) {
    for (const st of statements(sql)) {
      const m = /^CREATE UNIQUE INDEX "([^"]+)" ON [^']*\bNULLS NOT DISTINCT$/i.exec(st);
      if (m) handWritten.add(m[1]);
      if (/^CREATE EXTENSION IF NOT EXISTS "[^"]+"$/.test(st)) extensions.add(st);
    }
  }
  const allowed = [];
  const ignored = [];
  const unexpected = [];
  for (const st of statements(diffSql)) {
    const m = /^DROP INDEX (?:"public"\.)?"([^"]+)"$/i.exec(st);
    if (m && handWritten.has(m[1])) allowed.push(m[1]);
    else if (extensions.has(st)) ignored.push(st);
    else unexpected.push(st);
  }
  return { ok: unexpected.length === 0, allowed, ignored, unexpected };
}

function main() {
  const [diffFile, migrationsDir] = process.argv.slice(2);
  if (!diffFile || !migrationsDir) {
    console.error('usage: check-migration-drift.mjs <diff.sql> <migrations dir>');
    process.exit(1);
  }
  const migrationSqls = [];
  for (const entry of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(migrationsDir, entry.name, 'migration.sql');
    if (fs.existsSync(file)) migrationSqls.push(fs.readFileSync(file, 'utf8'));
  }
  const r = checkDrift(fs.readFileSync(diffFile, 'utf8'), migrationSqls);
  for (const st of r.ignored) console.log(`Ignored: ${st}; (already in a migration)`);
  if (!r.ok) {
    console.error('schema.prisma and the migrations disagree. Statements Prisma would still need to run:');
    for (const st of r.unexpected) console.error(`  ${st};`);
    console.error('Add a migration (npx prisma migrate dev) or fix schema.prisma. See db/README.md.');
    process.exit(1);
  }
  if (r.allowed.length) {
    console.log(`Ignored ${r.allowed.length} hand-written NULLS NOT DISTINCT index(es) that schema.prisma cannot express: ${r.allowed.join(', ')}`);
  }
  console.log('Migrations match schema.prisma.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
