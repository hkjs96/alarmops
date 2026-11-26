// node --test .github/scripts/rollback-console.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { originFrom, parsePrevious } from './rollback-console.mjs';

const script = fileURLToPath(new URL('./rollback-console.mjs', import.meta.url));
const INSPECT = [
  'Vercel CLI 65.16.0',
  'Fetched deployment "console-abc123-my-team.vercel.app" in my-team [1s]',
  '',
  '  General',
  '',
  '    id\t\tdpl_AbCdEf123456GhIj',
  '    name\tconsole',
  '    target\tproduction',
  '    status\t\u25cf Ready',
  '    url\t\thttps://console-abc123-my-team.vercel.app',
  '    created\tTue Nov 24 2026 10:00:00 GMT+0900 [2m ago]',
  '',
  '  Aliases',
  '',
  '    \u2576 https://console.example.com',
  '',
].join('\n');
const withLine = (key, value) => INSPECT.replace(new RegExp(`(\\n    ${key}\\t+)[^\\n]*`), `$1${value}`);


test('previous: id and url from inspect output', () => {
  assert.deepEqual(parsePrevious(INSPECT), { id: 'dpl_AbCdEf123456GhIj', url: 'https://console-abc123-my-team.vercel.app' });
});

test('previous: ANSI colours and CRLF do not matter', () => {
  const t = INSPECT.replace(/\n/g, '\r\n').replace('dpl_AbCdEf123456GhIj', '\x1b[1mdpl_AbCdEf123456GhIj\x1b[22m');
  assert.equal(parsePrevious(t).id, 'dpl_AbCdEf123456GhIj');
});

test('previous: only target production + status Ready is a target', () => {
  for (const t of [
    withLine('target', 'preview'),
    withLine('target', 'staging'),
    withLine('status', '\u25cf Error'),
    withLine('status', '\u25cf Building'),
    withLine('status', '\u25cf Queued'),
    withLine('status', '\u25cf Canceled'),
    withLine('status', 'UNKNOWN'),
    INSPECT.replace(/\n    status\t[^\n]*/, ''),
    INSPECT.replace(/\n    target\t[^\n]*/, ''),
  ])
    assert.deepEqual(parsePrevious(t), { id: '', url: '' }, t);
});

test('previous: other formats mean none (JSON, bad id, non-vercel url)', () => {
  assert.deepEqual(parsePrevious('{"id":"dpl_AbCdEf123456GhIj","target":"production","readyState":"READY"}'), { id: '', url: '' });
  assert.deepEqual(parsePrevious(withLine('id', 'abc; rm -rf /')), { id: '', url: '' });
  assert.deepEqual(parsePrevious(withLine('url', 'https://evil.example.com')), { id: '', url: '' });
});

test('previous: nothing usable means empty (first deploy, inspect failed, odd output)', () => {
  for (const t of ['', "Error: Can't find deployment", '    url     http://evil.example.com\n', '    url     https://x.vercel.app.evil.com\n', null, undefined])
    assert.deepEqual(parsePrevious(t), { id: '', url: '' });
});

test('previous: only a *.vercel.app url counts, an id alone is not enough', () => {
  assert.deepEqual(parsePrevious('    id      dpl_AbCdEf123456GhIj\n'), { id: '', url: '' });
});

test('previous: the same deployment as the new one is not a rollback target', () => {
  assert.deepEqual(parsePrevious(INSPECT, 'https://console-abc123-my-team.vercel.app'), { id: '', url: '' });
  assert.equal(parsePrevious(INSPECT, 'https://other.vercel.app').url, 'https://console-abc123-my-team.vercel.app');
});

test('origin: https origin from the pulled env file only', () => {
  assert.equal(originFrom('A=1\nCONSOLE_ORIGIN="https://console.example.com"\n'), 'https://console.example.com');
  assert.equal(originFrom('CONSOLE_ORIGIN=https://console.example.com/path\n'), null);
  assert.equal(originFrom('CONSOLE_ORIGIN=http://console.example.com\n'), null);
  assert.equal(originFrom('A=1\n'), null);
});

test('cli: origin and previous print GITHUB_OUTPUT lines; missing file means empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-'));
  writeFileSync(join(dir, 'env'), 'CONSOLE_ORIGIN=https://console.example.com\n');
  writeFileSync(join(dir, 'ins'), INSPECT);
  assert.equal(spawnSync('node', [script, 'origin', join(dir, 'env')], { encoding: 'utf8' }).stdout, 'origin=https://console.example.com\n');
  assert.equal(
    spawnSync('node', [script, 'previous', join(dir, 'ins')], { encoding: 'utf8' }).stdout,
    'prev_id=dpl_AbCdEf123456GhIj\nprev_url=https://console-abc123-my-team.vercel.app\n',
  );
  assert.equal(spawnSync('node', [script, 'previous', join(dir, 'none')], { encoding: 'utf8' }).stdout, 'prev_id=\nprev_url=\n');
  writeFileSync(join(dir, 'env2'), 'A=1\n');
  assert.equal(spawnSync('node', [script, 'origin', join(dir, 'env2')], { encoding: 'utf8' }).status, 1);
});
