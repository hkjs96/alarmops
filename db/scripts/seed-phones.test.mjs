import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badSeedPhones, phoneLiterals } from './seed-phones.mjs';

test('allowed +8210000000NN in any quote style (and the templated form) passes', () => {
  const text = `phone: '+821000000001', b: "+821000000042", c: \`+8210000000\${10 + i}\`, sql: ('x', '+821000000099')`;
  assert.deepEqual(badSeedPhones(text), []);
  assert.equal(phoneLiterals(text).length, 4);
});

test('double-quoted dialable literals are caught', () => {
  assert.deepEqual(badSeedPhones(`phone: "+821012345678"`), ['+821012345678']);
});

test('numbers without + are caught, quoted or not, with or without separators', () => {
  for (const n of ['010-1234-5678', '01012345678', '010 123 4567', '1012345678', '+82 10 1234 5678', '82-10-1234-5678']) {
    assert.notDeepEqual(badSeedPhones(`x = ${n};`), [], n);
    assert.notDeepEqual(badSeedPhones(`x = "${n}";`), [], n);
  }
});

test('no false positives on ids, timestamps or longer numbers', () => {
  assert.deepEqual(badSeedPhones(`id: 'ct_10_1234_5678', at: '2026-10-01T00:00:00Z', acct: '123410123456789', n: 1000`), []);
});
