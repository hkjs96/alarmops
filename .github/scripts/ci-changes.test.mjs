// node --test .github/scripts/ci-changes.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-changes.sh', import.meta.url));

function run(files, env = { EVENT_NAME: 'pull_request' }) {
  const r = spawnSync('bash', [script, '--stdin'], {
    input: files.join('\n'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')));
}
const on = (o) => Object.keys(o).filter((k) => o[k] === 'true' && k !== 'all' && k !== 'docs_only').sort();
const ALL = ['db', 'e2e', 'e2e_live', 'engine', 'infra', 'test'];

test('infra only: infra job only', () => {
  const o = run(['infra/aws/central.yaml', 'infra/test/test_templates.py']);
  assert.deepEqual(on(o), ['infra']);
  assert.equal(o.all, 'false');
});

test('docs only: nothing runs', () => {
  const o = run(['docs/decisions/DECISIONS.md', 'README.md', 'docs/ui/x.png']);
  assert.deepEqual(on(o), []);
  assert.equal(o.docs_only, 'true');
});

test('the doc the infra tests read still runs infra', () => {
  assert.deepEqual(on(run(['docs/SETUP-PROD-DB.md'])), ['infra']);
});

test('console only: test, e2e, e2e_live', () => {
  assert.deepEqual(on(run(['apps/console/src/app/page.tsx'])), ['e2e', 'e2e_live', 'test']);
});

test('store-sql adds db', () => {
  assert.deepEqual(on(run(['packages/store-sql/src/x.ts'])), ['db', 'e2e', 'e2e_live', 'test']);
});

test('alarm-engine: engine and infra (infra tests read its sources)', () => {
  assert.deepEqual(on(run(['services/alarm-engine/src/alarm_engine/events.py'])), ['engine', 'infra']);
});

test('ingest: npm tests only', () => {
  assert.deepEqual(on(run(['services/ingest/src/index.ts'])), ['test']);
});

test('db migrations: db, engine, test, e2e_live but not mock e2e', () => {
  assert.deepEqual(on(run(['db/prisma/migrations/0002/migration.sql'])), ['db', 'e2e_live', 'engine', 'test']);
});

test('workflow, lockfile, tsconfig changes run everything', () => {
  for (const f of ['.github/workflows/ci.yml', 'package-lock.json', 'package.json', 'tsconfig.base.json', 'apps/console/tsconfig.json']) {
    const o = run(['docs/a.md', f]);
    assert.deepEqual(on(o), ALL, f);
    assert.equal(o.all, 'true');
  }
});

test('empty diff runs everything (fail-safe)', () => {
  assert.deepEqual(on(run([])), ALL);
});

test('unmapped path runs everything (fail-safe)', () => {
  assert.deepEqual(on(run(['tools/docs-site/build.mjs'])), ALL);
});

test('push and workflow_dispatch run everything', () => {
  for (const EVENT_NAME of ['push', 'workflow_dispatch', '']) {
    assert.deepEqual(on(run(['docs/a.md'], { EVENT_NAME })), ALL, EVENT_NAME);
  }
});

test('git diff failure runs everything', () => {
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, EVENT_NAME: 'pull_request', BASE_SHA: 'deadbeef', HEAD_SHA: 'cafebabe' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^all=true$/m);
});
