// Fails a console deploy whose environment would run the console unsafely (fail before the deploy, not after).
//
//   node .github/scripts/check-console-deploy-env.mjs [env-file]
//
// Checked (apps/console/README.md, "Sign-out origin check" and the mock mode notes):
//   CONSOLE_ORIGIN  set, and an https origin only (no path, query, credentials)
//   TRUSTED_PROXY   exactly "1" (the deployment sits behind a load balancer that overwrites X-Forwarded-Host)
//   MOCK_API, E2E_ALLOW_MOCK   must not exist at all (an empty value counts as present)
//
// Without an argument the values come from process.env, i.e. the step's `env:` block, which the deploy job fills from
// the GitHub environment's variables. With a file argument (KEY=VALUE lines, as the deploy would write them to the
// runtime's configuration) that file is checked instead, and the process environment is ignored.
// Values are never printed, only the variable names and the reason.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @param {Record<string, string | undefined>} env @returns {string[]} problems, empty when the environment is fine */
export function checkConsoleDeployEnv(env) {
  const problems = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(env, k) && env[k] !== undefined;

  const origin = has('CONSOLE_ORIGIN') ? env.CONSOLE_ORIGIN.trim() : '';
  if (!origin) {
    problems.push('CONSOLE_ORIGIN is not set (the console answers 503 to every request in production without it)');
  } else {
    let u = null;
    try {
      u = new URL(origin);
    } catch {
      /* reported below */
    }
    if (!u) problems.push('CONSOLE_ORIGIN is not a URL');
    else if (u.protocol !== 'https:') problems.push('CONSOLE_ORIGIN must be an https origin');
    else if (origin.includes('?') || origin.includes('#') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '') || origin.endsWith('/'))
      problems.push('CONSOLE_ORIGIN must be only scheme://host[:port], with no path, query, credentials or trailing slash');
  }

  if (!has('TRUSTED_PROXY') || env.TRUSTED_PROXY !== '1') problems.push('TRUSTED_PROXY must be exactly 1');

  for (const k of ['MOCK_API', 'E2E_ALLOW_MOCK']) {
    if (has(k)) problems.push(`${k} must not be present in a deploy environment (mock mode serves fake data without sign-in)`);
  }
  return problems;
}

/** KEY=VALUE, KEY = VALUE and KEY: VALUE (YAML-style) lines; blank lines and # comments skipped; optional `export ` and surrounding quotes removed. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const env = file ? parseEnvFile(readFileSync(file, 'utf8')) : process.env;
  const problems = checkConsoleDeployEnv(env);
  if (problems.length) {
    for (const p of problems) console.error(`::error::console deploy environment: ${p}`);
    process.exit(1);
  }
  console.log('console deploy environment ok (CONSOLE_ORIGIN https, TRUSTED_PROXY=1, no mock flags)');
}
