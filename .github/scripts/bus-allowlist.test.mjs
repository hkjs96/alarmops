// node --test .github/scripts/bus-allowlist.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAllowlist, parseList } from './bus-allowlist.mjs';

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
