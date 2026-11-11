// node --test .github/scripts/check-migration-drift.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDrift, statements } from './check-migration-drift.mjs';

const script = fileURLToPath(new URL('./check-migration-drift.mjs', import.meta.url));
const REAL = 'CREATE UNIQUE INDEX "T_a_key" ON "T"("a") NULLS NOT DISTINCT;';
const DROP_X = 'DROP INDEX "X_a_key";';

/** runs the script as the workflow does; returns its exit code */
function run(diff, migration) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
  try {
    fs.mkdirSync(path.join(dir, 'migrations', '0001_init'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'migrations', '0001_init', 'migration.sql'), migration);
    fs.writeFileSync(path.join(dir, 'diff.sql'), diff);
    return spawnSync(process.execPath, [script, path.join(dir, 'diff.sql'), path.join(dir, 'migrations')], { encoding: 'utf8' }).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an empty diff passes; a hand-written NULLS NOT DISTINCT index and a declared extension are ignored', () => {
  const migration = `CREATE EXTENSION IF NOT EXISTS "citext";\n-- hand-written\n${REAL}\n`;
  assert.equal(run('-- This is an empty migration.\n', migration), 0);
  assert.equal(run('-- DropIndex\nDROP INDEX "T_a_key";\n\n-- CreateExtension\nCREATE EXTENSION IF NOT EXISTS "citext";\n', migration), 0);
  assert.equal(run('DROP INDEX "public"."T_a_key";', migration), 0);
});

test('a real difference fails', () => {
  assert.equal(run('ALTER TABLE "T" ADD COLUMN "b" TEXT;', REAL), 1);
  assert.equal(run(DROP_X, REAL), 1);
  assert.equal(run('CREATE EXTENSION IF NOT EXISTS "pgcrypto";', REAL), 1);
});

test('an index named only in a comment is not allowed (the /* … */ bypass exits 1)', () => {
  const hidden = 'CREATE UNIQUE INDEX "X_a_key" ON "X"("a") NULLS NOT DISTINCT;';
  assert.equal(run(DROP_X, `${REAL}\n/* ; ${hidden} */\n`), 1);
  assert.equal(run(DROP_X, `${REAL}\n/* outer /* inner */ ; ${hidden} */\n`), 1);
  assert.equal(run(DROP_X, `${REAL}\n/*\n;\n${hidden}\n*/\n`), 1);
  assert.equal(run(DROP_X, `${REAL}\n-- ; ${hidden}\n`), 1);
  assert.equal(run(DROP_X, `${REAL}\nSELECT 1 -- ; ${hidden}\n;`), 1);
  // an unclosed comment hides everything after it, as it does in Postgres
  assert.equal(run(DROP_X, `${REAL}\n/* ; ${hidden}\n`), 1);
});

test('an index named only inside a string or a $$ body is not allowed', () => {
  const hidden = 'CREATE UNIQUE INDEX "X_a_key" ON "X"("a") NULLS NOT DISTINCT;';
  assert.equal(run(DROP_X, `${REAL}\nDO $$ BEGIN PERFORM 1; ${hidden} END $$;`), 1);
  assert.equal(run(DROP_X, `${REAL}\nDO $do$ BEGIN PERFORM 1; ${hidden} END $do$;`), 1);
  assert.equal(run(DROP_X, `${REAL}\nCOMMENT ON TABLE "T" IS '; ${hidden} ';`), 1);
  assert.equal(run(DROP_X, `${REAL}\nCOMMENT ON TABLE "T" IS 'it''s ; ${hidden} ';`), 1);
  assert.equal(run(DROP_X, `${REAL}\nCOMMENT ON TABLE "T" IS E'a\\'; ${hidden} ';`), 1);
  // a string that only ends in the words does not make its statement a NULLS NOT DISTINCT index
  assert.equal(run(DROP_X, `CREATE UNIQUE INDEX "X_a_key" ON "X"("a") WHERE "a" <> 'NULLS NOT DISTINCT';`), 1);
});

test('a comment in the diff hides nothing', () => {
  assert.equal(run('/* DROP INDEX "T_a_key"; */ ALTER TABLE "T" ADD COLUMN "b" TEXT;', REAL), 1);
  assert.equal(run('/* nothing */', REAL), 0);
});

test('statements: comments go, quoted text stays whole', () => {
  assert.deepEqual(statements('a; -- b;\nc /* d; /* e; */ f; */ ; g'), ['a', 'c', 'g']);
  assert.deepEqual(statements(`SELECT '--x;' ; SELECT "a;b" ; SELECT $q$ ;/* $q$ ;`), [`SELECT '--x;'`, 'SELECT "a;b"', 'SELECT $q$ ;/* $q$']);
  assert.deepEqual(statements('SELECT $1; SELECT a$b$c;'), ['SELECT $1', 'SELECT a$b$c']);
  assert.deepEqual(checkDrift('', []), { ok: true, allowed: [], ignored: [], unexpected: [] });
});

test('the repository\'s own migrations still yield their three hand-written indexes', () => {
  const dir = fileURLToPath(new URL('../../db/prisma/migrations', import.meta.url));
  const diff = ['Alert_customerId_fingerprint_key', 'Rotation_customerId_name_key', 'ThresholdDefault_scope_key'].map((n) => `DROP INDEX "${n}";`).join('\n') + '\nCREATE EXTENSION IF NOT EXISTS "citext";\n';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
  try {
    fs.writeFileSync(path.join(tmp, 'diff.sql'), diff);
    const out = execFileSync(process.execPath, [script, path.join(tmp, 'diff.sql'), dir], { encoding: 'utf8' });
    assert.match(out, /Ignored 3 hand-written/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
