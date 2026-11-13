// node --test .github/scripts/bus-allowlist.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextAllowlist, parseList, updateParameters } from './bus-allowlist.mjs';

const A = '111111111111';
const B = '222222222222';

test('add appends once, sorted', () => {
  assert.deepEqual(nextAllowlist('', 'add', B), { list: B, changed: true });
  assert.deepEqual(nextAllowlist(B, 'add', A), { list: `${A},${B}`, changed: true });
  assert.deepEqual(nextAllowlist(`${A},${B}`, 'add', A), { list: `${A},${B}`, changed: false });
});

test('remove drops only that account; removing an absent one is a no-op', () => {
  assert.deepEqual(nextAllowlist(`${A},${B}`, 'remove', B), { list: A, changed: true });
  assert.deepEqual(nextAllowlist(A, 'remove', A), { list: '', changed: true });
  assert.deepEqual(nextAllowlist(A, 'remove', B), { list: A, changed: false });
  assert.deepEqual(nextAllowlist(undefined, 'remove', B), { list: '', changed: false });
});

test('bad input throws', () => {
  assert.throws(() => nextAllowlist(A, 'sync', B));
  assert.throws(() => nextAllowlist(A, 'add', '123'));
  assert.throws(() => nextAllowlist(A, 'add', `${B},${A}`));
  assert.throws(() => nextAllowlist('abc', 'add', B));
  assert.throws(() => parseList('1111111111111'));
});

test('parameters JSON keeps a list of 2+ accounts as ONE value (commas intact) and reuses BusName', () => {
  const list = nextAllowlist(`${A},${B}`, 'add', '333333333333').list;
  const params = updateParameters(list);
  assert.deepEqual(params[0], { ParameterKey: 'AllowedAccountIds', ParameterValue: `${A},${B},333333333333` });
  assert.deepEqual(params[1], { ParameterKey: 'BusName', UsePreviousValue: true });
});

test('CLI writes the parameters file for 2+ accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allow-'));
  const file = join(dir, 'p.json');
  const script = fileURLToPath(new URL('./bus-allowlist.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, CURRENT: `${A},${B}`, ACTION: 'add', ACCOUNT_ID: '333333333333', PARAMS_FILE: file } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${A},${B},333333333333`);
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].ParameterValue, `${A},${B},333333333333`);
});
