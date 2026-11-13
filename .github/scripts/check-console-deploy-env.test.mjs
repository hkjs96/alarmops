// node --test .github/scripts/check-console-deploy-env.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkConsoleDeployEnv, parseEnvFile } from './check-console-deploy-env.mjs';

const GOOD = { CONSOLE_ORIGIN: 'https://console.example.com', TRUSTED_PROXY: '1' };
const script = fileURLToPath(new URL('./check-console-deploy-env.mjs', import.meta.url));

test('good environment passes', () => {
  assert.deepEqual(checkConsoleDeployEnv(GOOD), []);
  assert.deepEqual(checkConsoleDeployEnv({ ...GOOD, CONSOLE_ORIGIN: 'https://console.example.com:8443' }), []);
});

test('CONSOLE_ORIGIN unset, empty, http, malformed or with a path fails', () => {
  for (const v of [undefined, '', '  ', 'http://console.example.com', 'console.example.com', 'https://console.example.com/app', 'https://console.example.com/', 'https://u:p@console.example.com', 'https://console.example.com?x=1', 'https://console.example.com?', 'https://console.example.com#']) {
    const env = { ...GOOD };
    if (v === undefined) delete env.CONSOLE_ORIGIN;
    else env.CONSOLE_ORIGIN = v;
    assert.ok(checkConsoleDeployEnv(env).some((p) => p.startsWith('CONSOLE_ORIGIN')), String(v));
  }
});

test('TRUSTED_PROXY must be exactly 1', () => {
  for (const v of [undefined, '', '0', 'true', '11', ' 1']) {
    const env = { ...GOOD };
    if (v === undefined) delete env.TRUSTED_PROXY;
    else env.TRUSTED_PROXY = v;
    assert.ok(checkConsoleDeployEnv(env).some((p) => p.startsWith('TRUSTED_PROXY')), String(v));
  }
});

test('MOCK_API and E2E_ALLOW_MOCK fail when present, whatever the value (even empty or 0)', () => {
  for (const k of ['MOCK_API', 'E2E_ALLOW_MOCK']) {
    for (const v of ['1', '', '0', 'false']) {
      assert.ok(checkConsoleDeployEnv({ ...GOOD, [k]: v }).some((p) => p.startsWith(k)), `${k}=${v}`);
    }
  }
});

test('parseEnvFile accepts spaces around =, colon form and export', () => {
  assert.deepEqual(parseEnvFile('MOCK_API = 1\nE2E_ALLOW_MOCK: "1"\nexport  TRUSTED_PROXY =1'), { MOCK_API: '1', E2E_ALLOW_MOCK: '1', TRUSTED_PROXY: '1' });
  assert.ok(checkConsoleDeployEnv(parseEnvFile('CONSOLE_ORIGIN: https://c.example.com\nTRUSTED_PROXY: 1\nMOCK_API : 1')).some((p) => p.startsWith('MOCK_API')));
});

test('parseEnvFile handles comments, export, quotes', () => {
  assert.deepEqual(parseEnvFile('# c\nexport A="x y"\nB=\'z\'\n\nC=\nbad line\r\nD=1\r\n'), { A: 'x y', B: 'z', C: '', D: '1' });
});

function run(args, env) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('CLI: process environment, exit codes and no value is echoed', () => {
  assert.equal(run([], GOOD).status, 0);
  const bad = run([], { ...GOOD, MOCK_API: 'secret-looking-1', CONSOLE_ORIGIN: 'http://leak.example.com' });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /MOCK_API/);
  assert.doesNotMatch(bad.out, /secret-looking-1|leak\.example/);
});

test('CLI: env file argument is checked, process environment is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-env-'));
  const good = join(dir, 'good.env');
  const bad = join(dir, 'bad.env');
  writeFileSync(good, 'CONSOLE_ORIGIN=https://console.example.com\nTRUSTED_PROXY=1\n');
  writeFileSync(bad, 'CONSOLE_ORIGIN=https://console.example.com\nTRUSTED_PROXY=1\nE2E_ALLOW_MOCK=1\n');
  assert.equal(run([good], { MOCK_API: '1' }).status, 0);
  assert.equal(run([bad], GOOD).status, 1);
});
