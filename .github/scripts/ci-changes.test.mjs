// node --test .github/scripts/ci-changes.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const script = fileURLToPath(new URL('./ci-changes.sh', import.meta.url));

function run(files, env = { EVENT_NAME: 'pull_request' }) {
  const r = spawnSync('bash', [script, '--stdin'], {
    input: files.map((f) => `${f}\0`).join(''),
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
  const o = run(['docs/decisions/DECISIONS.md', 'README.md', 'docs/ui/x.png', '.claude/worktrees/agent-x/file.ts']);
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
  for (const f of ['.github/workflows/ci.yml', 'package-lock.json', 'package.json', 'tsconfig.base.json', 'apps/console/tsconfig.json', '.github/scripts/ci-changes.sh', '.github/scripts/ci-changes.test.mjs']) {
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

test('.claude outside worktrees is unmapped: runs everything', () => {
  assert.deepEqual(on(run(['.claude/hooks/guard.mjs'])), ALL);
  assert.deepEqual(on(run(['.claude/settings.json'])), ALL);
});

test('markdown inside an area follows the area rule', () => {
  assert.deepEqual(on(run(['infra/aws/deploy-role-policy.md'])), ['infra']);
  assert.deepEqual(on(run(['services/alarm-engine/README.md'])), ['engine', 'infra']);
  assert.deepEqual(on(run(['apps/console/README.md'])), ['e2e', 'e2e_live', 'test']);
  assert.deepEqual(on(run(['docs/specs/alarm-rules.md'])), ['engine']);
  assert.deepEqual(on(run(['packages/api/test/fixtures/offboard-account.command.json'])), ['e2e', 'e2e_live', 'engine', 'test']);
  assert.deepEqual(on(run(['tools/vercel-cli/package-lock.json'])), ['infra']);
});

// Real git: a rename out of a watched folder into docs/ must still run the old area; so must a delete.
function repoWith(change) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changes-'));
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'infra/aws'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'infra/aws/central.yaml'), 'Resources: {}\n'.repeat(20));
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  change(dir, git);
  git('add', '-A'); git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD');
  const r = spawnSync('bash', [script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head } });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split('=')));
}

test('rename from infra/ to docs/ still runs infra (old path is judged)', () => {
  const o = repoWith((dir, git) => git('mv', 'infra/aws/central.yaml', 'docs/central.yaml'));
  assert.deepEqual(on(o), ['infra']);
});

test('delete of an infra file runs infra', () => {
  const o = repoWith((dir, git) => git('rm', '-q', 'infra/aws/central.yaml'));
  assert.deepEqual(on(o), ['infra']);
});

test('docs-only change in real git runs nothing', () => {
  const o = repoWith((dir) => writeFileSync(join(dir, 'README.md'), 'y\n'));
  assert.deepEqual(on(o), []);
});

// Every docs/ path a test reads must turn on the job that runs that test.
test('docs/ paths read by tests turn on the right job', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const areas = [ // [test folder, job that runs it]
    ['infra/test', 'infra'],
    ['services/alarm-engine/tests', 'engine'],
    ['services/ingest/test', 'test'],
    ['packages', 'test'],
    ['apps/console/src', 'test'],
    ['db/scripts', 'db'],
  ];
  const walk = (d) => readdirSync(d).flatMap((n) => {
    if (n === 'node_modules' || n === '.next' || n === '__pycache__') return [];
    const f = join(d, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
  const readsFile = /read_text|read_bytes|open\(|readFileSync|Path\(|parents\[|new URL\(/;
  const found = [];
  for (const [dir, job] of areas) {
    for (const f of walk(join(root, dir))) {
      if (!/\.(py|ts|tsx|mjs)$/.test(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!readsFile.test(line)) continue;
        const m = line.match(/docs\/[\w./-]+\.\w+/) || line.match(/"docs"((?:\s*\/\s*"[\w.-]+")+)/);
        if (!m) continue;
        const path = m[0].startsWith('docs/') ? m[0] : 'docs' + [...m[1].matchAll(/"([\w.-]+)"/g)].map((x) => '/' + x[1]).join('');
        found.push([relative(root, f), path, job]);
      }
    }
  }
  assert.ok(found.length >= 1, 'the grep must find at least docs/specs/alarm-rules.md');
  for (const [file, path, job] of found) {
    assert.ok(on(run([path])).includes(job), `${path} (read by ${file}) must turn on ${job}`);
  }
});
