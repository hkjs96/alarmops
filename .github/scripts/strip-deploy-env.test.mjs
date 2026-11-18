// node --test .github/scripts/strip-deploy-env.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripEnv } from './strip-deploy-env.mjs';

const script = fileURLToPath(new URL('./strip-deploy-env.mjs', import.meta.url));
const SAMPLE = [
  '# Created by Vercel CLI',
  'CONSOLE_ORIGIN="https://x.vercel.app"',
  'DATABASE_URL="postgres://u:topsecret@h/db"',
  'SESSION_SECRET="s3cr3t"',
  'TICK_SECRET="t1ck"',
  'VERCEL_OIDC_TOKEN="eyJ.jwt"',
  'TRUSTED_PROXY="1"',
  'NEXT_PUBLIC_FOO="bar"',
  'MOCK_API="1"',
  '',
].join('\n');

test('keeps only the allowlisted names', () => {
  const r = stripEnv(SAMPLE);
  assert.deepEqual(r.kept, ['CONSOLE_ORIGIN', 'TRUSTED_PROXY', 'NEXT_PUBLIC_FOO']);
  for (const bad of ['DATABASE_URL', 'SESSION_SECRET', 'TICK_SECRET', 'VERCEL_OIDC_TOKEN', 'topsecret']) assert.ok(!r.text.includes(bad), bad);
});

test('a mock flag is dropped here but already rejected by the env check that runs first', () => {
  assert.ok(!stripEnv('MOCK_API=1\nCONSOLE_ORIGIN=https://x.vercel.app\n').text.includes('MOCK_API'));
});

test('cli rewrites the file in place and prints names only', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'strip-')), 'env');
  writeFileSync(f, SAMPLE);
  const r = spawnSync(process.execPath, [script, f], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('topsecret') && !r.stdout.includes('s3cr3t'));
  assert.equal(readFileSync(f, 'utf8'), 'CONSOLE_ORIGIN="https://x.vercel.app"\nTRUSTED_PROXY="1"\nNEXT_PUBLIC_FOO="bar"\n');
});

test('the Google client secret and the SSO lists are never passed to the build', () => {
  const r = stripEnv(['CONSOLE_ORIGIN="https://x.vercel.app"', 'GOOGLE_CLIENT_SECRET="gs3cret"', 'GOOGLE_CLIENT_ID="id"', 'SSO_ALLOWED_DOMAINS="mz.co.kr"', 'SSO_ALLOWED_EMAILS="a@example.com"', ''].join('\n'));
  assert.deepEqual(r.kept, ['CONSOLE_ORIGIN']);
  for (const bad of ['GOOGLE_CLIENT_SECRET', 'gs3cret', 'GOOGLE_CLIENT_ID', 'SSO_ALLOWED']) assert.ok(!r.text.includes(bad), bad);
});
