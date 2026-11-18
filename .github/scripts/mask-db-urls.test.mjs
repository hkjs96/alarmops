// node --test .github/scripts/mask-db-urls.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./mask-db-urls.mjs', import.meta.url));
// made-up values: nothing here is a real host or password
const POOLED = 'postgresql://postgres.abcdefghijklmnop:s3cr%40t-Pw0rd@aws-0-example.pooler.invalid:6543/postgres?pgbouncer=true&connection_limit=1';
const SESSION = 'postgresql://postgres.abcdefghijklmnop:s3cr%40t-Pw0rd@aws-0-example.pooler.invalid:5432/postgres';

function run(env) {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const lines = (r.stdout + r.stderr).split('\n').filter(Boolean);
  return { status: r.status, lines, masks: lines.filter((l) => l.startsWith('::add-mask::')).map((l) => l.slice(12)), rest: lines.filter((l) => !l.startsWith('::add-mask::')) };
}

test('two good URLs: exit 0, every part is masked, nothing else is printed', () => {
  const r = run({ DATABASE_URL: POOLED, DIRECT_URL: SESSION });
  assert.equal(r.status, 0);
  for (const part of [POOLED, SESSION, 's3cr%40t-Pw0rd', 's3cr@t-Pw0rd', 'aws-0-example.pooler.invalid', 'aws-0-example.pooler.invalid:6543', 'aws-0-example.pooler.invalid:5432', 'postgres.abcdefghijklmnop']) {
    assert.ok(r.masks.includes(part), part);
  }
  assert.deepEqual(r.rest, []);
});

test('a missing URL fails the job and names the secret', () => {
  for (const env of [{}, { DATABASE_URL: POOLED }, { DIRECT_URL: SESSION }, { DATABASE_URL: '', DIRECT_URL: SESSION }]) {
    const r = run(env);
    assert.equal(r.status, 1);
    assert.ok(r.rest.some((l) => l.startsWith('::error::Missing secret DEV_')));
  }
  assert.ok(run({ DIRECT_URL: SESSION }).rest.some((l) => l.includes('DEV_DATABASE_URL')));
  assert.ok(run({ DATABASE_URL: POOLED }).rest.some((l) => l.includes('DEV_DIRECT_URL')));
});

test('a malformed URL fails the job, and no part of it is printed outside a mask', () => {
  const bad = [
    'aws-0-example.pooler.invalid:5432/postgres',
    'postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD@aws-0-example.pooler.invalid:5432/postgres extra',
    'postgresql://postgres.abcdefghijklmnop@aws-0-example.pooler.invalid:5432/postgres',
    'postgresql://:hunter2hunter2@aws-0-example.pooler.invalid:5432/postgres',
    'https://postgres.abcdefghijklmnop:hunter2hunter2@aws-0-example.pooler.invalid:5432/postgres',
    'postgresql://postgres.abcdefghijklmnop:hunter2hunter2@aws-0-example.pooler.invalid:5432',
    'postgresql://postgres.abcdefghijklmnop:hunter2hunter2@aws-0-example.pooler.invalid:5432/postgres\nsecond-line-value',
    'postgresql://user:pass@:5432/postgres',
    'not a url at all',
  ];
  for (const value of bad) {
    for (const env of [{ DATABASE_URL: value, DIRECT_URL: SESSION }, { DATABASE_URL: POOLED, DIRECT_URL: value }]) {
      const r = run(env);
      assert.equal(r.status, 1, value);
      assert.ok(r.rest.some((l) => /^::error::DEV_(DATABASE|DIRECT)_URL is not a valid connection string/.test(l)), value);
      // the whole value is masked (line by line), and the messages carry none of it
      for (const line of value.split('\n')) assert.ok(r.masks.includes(line), value);
      for (const l of r.rest) for (const piece of ['example', 'hunter2', 'abcdefghijklmnop', 'YOUR-PASSWORD', 'second-line', 'not a url']) assert.ok(!l.includes(piece), `${piece} in: ${l}`);
      // masks come before every message
      const firstMessage = r.lines.findIndex((l) => !l.startsWith('::add-mask::'));
      assert.ok(r.lines.slice(firstMessage).every((l) => !l.startsWith('::add-mask::')));
    }
  }
});

test('swapped ports only warn', () => {
  const r = run({ DATABASE_URL: SESSION, DIRECT_URL: POOLED });
  assert.equal(r.status, 0);
  assert.equal(r.rest.filter((l) => l.startsWith('::warning::')).length, 3);
});

const PROD = { DB_SECRET_PREFIX: 'PROD_', DB_ENVIRONMENT: 'production-db', DB_SETUP_DOC: 'docs/SETUP-PROD-DB.md' };

test('production names: messages name PROD_ secrets, the production-db environment and the prod guide; nothing says DEV or dev', () => {
  const missing = run({ ...PROD, DIRECT_URL: SESSION });
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.rest, ["::error::Missing secret PROD_DATABASE_URL in the GitHub environment 'production-db'. Add it under Settings > Environments > production-db (docs/SETUP-PROD-DB.md)."]);

  const malformed = run({ ...PROD, DATABASE_URL: 'not a url at all', DIRECT_URL: SESSION });
  assert.equal(malformed.status, 1);
  assert.ok(malformed.rest.some((l) => l.startsWith('::error::PROD_DATABASE_URL is not a valid connection string') && l.includes('(docs/SETUP-PROD-DB.md)')));

  const placeholder = run({ ...PROD, DATABASE_URL: POOLED.replace('s3cr%40t-Pw0rd', '[YOUR-PASSWORD]'), DIRECT_URL: SESSION });
  assert.equal(placeholder.status, 1);
  assert.ok(placeholder.rest.some((l) => l.includes('PROD_DATABASE_URL still has the [YOUR-PASSWORD] placeholder')));

  const swapped = run({ ...PROD, DATABASE_URL: SESSION, DIRECT_URL: POOLED });
  assert.equal(swapped.status, 0);
  assert.equal(swapped.rest.filter((l) => l.startsWith('::warning::PROD_')).length, 3);

  for (const r of [missing, malformed, placeholder, swapped]) {
    for (const l of r.rest) assert.ok(!/DEV_|SETUP-SUPABASE|'dev'/.test(l), l);
  }
});

test('without the new variables the dev messages are unchanged (dev-db.yml sets none)', () => {
  const r = run({ DIRECT_URL: SESSION });
  assert.deepEqual(r.rest, ["::error::Missing secret DEV_DATABASE_URL in the GitHub environment 'dev'. Add it under Settings > Environments > dev (docs/SETUP-SUPABASE.md, step 4)."]);
  assert.ok(run({ DATABASE_URL: 'x y', DIRECT_URL: SESSION }).rest.some((l) => l.includes('(docs/SETUP-SUPABASE.md, step 3)')));
});
