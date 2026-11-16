// Smoke check of a deployed console (deploy-console.yml runs it right after the production deploy).
//
//   node .github/scripts/smoke-console.mjs <https-origin>
//   node .github/scripts/smoke-console.mjs --env-file <KEY=VALUE file>   # origin = CONSOLE_ORIGIN from that file
//
// Checks (any failure exits 1, the deploy job turns red):
//   GET  /login                  200, no mock markers in the page
//   CSP of that response         script-src has a 'nonce-...' and no 'unsafe-inline' (and no 'unsafe-eval')
//   POST /api/internal/tick      with no Authorization header: 401 with the console's own error body
//                                (code UNAUTHENTICATED). 503 means TICK_SECRET is not set: fail. A 401 without that
//                                body is not the console (e.g. Vercel deployment protection answering): fail.
// Nothing secret is sent or printed: no credentials are used, and only status codes and rule names are logged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './check-console-deploy-env.mjs';

// What a production page must never contain: the mock-mode banner/link, the mock flags, the dev sign-in route.
export const MOCK_MARKERS = [/mock mode/i, /MOCK_API/, /E2E_ALLOW_MOCK/, /auth\/dev-login/i];

/** @param {number} status @param {string} body @returns {string[]} */
export function checkLogin(status, body) {
  const problems = [];
  if (status !== 200) problems.push(`GET /login answered ${status}, expected 200`);
  for (const re of MOCK_MARKERS) if (re.test(body)) problems.push(`GET /login contains a mock marker (${re.source})`);
  return problems;
}

/** @param {string | null | undefined} csp @returns {string[]} */
export function checkCsp(csp) {
  if (!csp) return ['GET /login has no Content-Security-Policy header'];
  const problems = [];
  const script = csp.split(';').map((d) => d.trim()).find((d) => /^script-src(\s|$)/.test(d));
  if (!script) return ["CSP has no script-src directive (default-src would apply; the console sets script-src with a nonce)"];
  if (!/'nonce-[A-Za-z0-9+/=_-]{16,}'/.test(script)) problems.push("CSP script-src has no 'nonce-...' source");
  if (script.includes("'unsafe-inline'")) problems.push("CSP script-src contains 'unsafe-inline'");
  if (script.includes("'unsafe-eval'")) problems.push("CSP script-src contains 'unsafe-eval' (development build?)");
  return problems;
}

/** @param {number} status @param {string} body @returns {string[]} */
export function checkTick(status, body) {
  if (status === 503) return ['POST /api/internal/tick answered 503: TICK_SECRET is not configured in the deployed environment (the 1-minute tick cannot work)'];
  if (status !== 401) return [`POST /api/internal/tick without credentials answered ${status}, expected 401`];
  let code = null;
  try {
    code = JSON.parse(body)?.error?.code ?? null;
  } catch {
    /* not JSON */
  }
  if (code !== 'UNAUTHENTICATED') return ['POST /api/internal/tick answered 401 but not with the console error body (deployment protection or a proxy in front?)'];
  return [];
}

/** Same nonce twice would mean a cached page (CDN must not cache HTML, infra/aws/README.md). */
export function nonceOf(csp) {
  return /'nonce-([^']+)'/.exec(csp ?? '')?.[1] ?? null;
}

async function get(url, init, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init });
      return { status: res.status, headers: res.headers, body: await res.text() };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(`request failed after ${tries} tries: ${last?.cause?.code ?? last?.name ?? 'error'}`);
}

export async function smoke(origin) {
  const base = origin.replace(/\/+$/, '');
  const problems = [];
  const login = await get(`${base}/login`, { method: 'GET' });
  problems.push(...checkLogin(login.status, login.body));
  const csp = login.headers.get('content-security-policy');
  problems.push(...checkCsp(csp));
  const again = await get(`${base}/login`, { method: 'GET' });
  const n1 = nonceOf(csp);
  if (n1 && n1 === nonceOf(again.headers.get('content-security-policy'))) problems.push('two requests got the same CSP nonce (HTML cached?)');
  const tick = await get(`${base}/api/internal/tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  problems.push(...checkTick(tick.status, tick.body));
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let origin = args[0];
  if (args[0] === '--env-file') origin = parseEnvFile(readFileSync(args[1], 'utf8')).CONSOLE_ORIGIN;
  if (!origin || !/^https:\/\/[^/\s?#]+$/.test(origin)) {
    console.error('::error::smoke: need an https origin (argument or --env-file with CONSOLE_ORIGIN)');
    process.exit(2);
  }
  const host = new URL(origin).host;
  console.log(`smoke check of https://${host}`);
  let problems;
  try {
    problems = await smoke(origin);
  } catch (e) {
    problems = [String(e.message)];
  }
  if (problems.length) {
    for (const p of problems) console.error(`::error::smoke: ${p}`);
    process.exit(1);
  }
  console.log('smoke ok (login 200 without mock markers, nonce CSP without unsafe-inline, tick 401 without credentials)');
}
