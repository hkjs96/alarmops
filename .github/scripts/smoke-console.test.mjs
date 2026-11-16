// node --test .github/scripts/smoke-console.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCsp, checkLogin, checkTick, nonceOf } from './smoke-console.mjs';

const script = fileURLToPath(new URL('./smoke-console.mjs', import.meta.url));
const GOOD_CSP = "default-src 'self'; script-src 'self' 'nonce-QUJDREVGR0hJSktMTU5PUA==' 'strict-dynamic'; style-src 'self' 'unsafe-inline'";

test('login: 200 and no mock marker', () => {
  assert.deepEqual(checkLogin(200, '<html>Sign in with Google</html>'), []);
  assert.equal(checkLogin(500, 'x').length, 1);
  assert.equal(checkLogin(302, '').length, 1);
  for (const body of ['Mock mode: sign in', 'MOCK_API=1', 'E2E_ALLOW_MOCK', '<a href="/auth/dev-login?as=admin">']) assert.equal(checkLogin(200, body).length, 1, body);
});

test('csp: nonce required, unsafe-inline in script-src fails, style-src unsafe-inline is fine', () => {
  assert.deepEqual(checkCsp(GOOD_CSP), []);
  assert.ok(checkCsp(null).length);
  assert.ok(checkCsp("script-src 'self' 'strict-dynamic'").some((p) => p.includes('nonce')));
  assert.ok(checkCsp("script-src 'self' 'unsafe-inline' 'nonce-QUJDREVGR0hJSktMTU5PUA=='").some((p) => p.includes('unsafe-inline')));
  assert.ok(checkCsp("script-src 'self' 'nonce-QUJDREVGR0hJSktMTU5PUA==' 'unsafe-eval'").some((p) => p.includes('unsafe-eval')));
  assert.ok(checkCsp("default-src 'self'").some((p) => p.includes('script-src')));
  // a script-src-elem or a style-src with unsafe-inline must not be mistaken for script-src
  assert.deepEqual(checkCsp("style-src 'unsafe-inline'; script-src 'nonce-QUJDREVGR0hJSktMTU5PUA=='"), []);
});

test('tick: 401 with the console body passes; 503 and others fail', () => {
  assert.deepEqual(checkTick(401, '{"error":{"code":"UNAUTHENTICATED"}}'), []);
  assert.ok(checkTick(503, '{"error":{"code":"NOT_CONFIGURED"}}')[0].includes('TICK_SECRET'));
  assert.equal(checkTick(200, '{}').length, 1);
  assert.equal(checkTick(405, '').length, 1);
  assert.equal(checkTick(401, 'Authentication Required').length, 1);
  assert.equal(checkTick(401, '{"error":{"code":"X"}}').length, 1);
});

test('nonceOf', () => {
  assert.equal(nonceOf(GOOD_CSP), 'QUJDREVGR0hJSktMTU5PUA==');
  assert.equal(nonceOf(''), null);
});

test('cli: refuses a non-https origin', () => {
  const r = spawnSync(process.execPath, [script, 'http://example.com'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

// End to end against a local server: the CLI itself only talks https, the library function takes any origin.
test('smoke() against a local fake console', async () => {
  const { smoke } = await import('./smoke-console.mjs');
  let n = 0;
  const server = createServer((req, res) => {
    if (req.url === '/login') {
      res.setHeader('content-security-policy', `script-src 'self' 'nonce-${Buffer.from(`nonce-${++n}-padding-xx`).toString('base64')}' 'strict-dynamic'`);
      res.end('<html>Sign in</html>');
    } else if (req.url === '/api/internal/tick' && req.method === 'POST') {
      res.statusCode = 401;
      res.end('{"error":{"code":"UNAUTHENTICATED"}}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    assert.deepEqual(await smoke(`http://127.0.0.1:${server.address().port}`), []);
  } finally {
    server.close();
  }
});
