// Removes every secret from the env file `vercel pull` wrote, before `vercel build` runs (the build runs repo code:
// the Next build and its dependencies; they must not see DATABASE_URL, SESSION_SECRET, TICK_SECRET, VERCEL_OIDC_TOKEN, ...).
//
//   node .github/scripts/strip-deploy-env.mjs <env-file>
//
// The file is rewritten in place with only the allowlisted names (non-secret settings the build or the smoke check
// needs); the runtime gets its real variables from the Vercel project, not from this file. The console builds without any
// of the dropped variables (the CI job `test` runs `next build` with none of them). Only names are printed, never values.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const KEEP = ['CONSOLE_ORIGIN', 'TRUSTED_PROXY'];
export const KEEP_PREFIXES = ['NEXT_PUBLIC_']; // public by definition: inlined into the browser bundle

const keepName = (n) => KEEP.includes(n) || KEEP_PREFIXES.some((p) => n.startsWith(p));

/** @returns {{ text: string, kept: string[], dropped: string[] }} */
export function stripEnv(text) {
  const kept = [];
  const dropped = [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/.exec(raw);
    if (!m) continue; // comments, blanks and anything unparsable are dropped
    if (keepName(m[1])) {
      kept.push(m[1]);
      out.push(raw);
    } else dropped.push(m[1]);
  }
  return { text: out.length ? out.join('\n') + '\n' : '', kept, dropped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: strip-deploy-env.mjs <env-file>');
    process.exit(2);
  }
  const { text, kept, dropped } = stripEnv(readFileSync(file, 'utf8'));
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`kept ${kept.length} variable(s): ${kept.join(', ') || '-'}; removed ${dropped.length} (names not listed)`);
}
