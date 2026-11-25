// Helpers for the automatic rollback in deploy-console.yml. No secrets, no network: it only reads files and prints.
//
//   node .github/scripts/rollback-console.mjs origin <KEY=VALUE file>   # prints origin=<CONSOLE_ORIGIN> or exits 1
//   node .github/scripts/rollback-console.mjs previous <inspect output file> [<new deployment url>]
//       # reads the output of `vercel inspect <CONSOLE_ORIGIN>` taken BEFORE the deploy and prints GITHUB_OUTPUT lines
//       #   prev_id=dpl_...   prev_url=https://....vercel.app     (both empty unless target=production and status=Ready)
//
// Why a parser: the deploy job must know which deployment production pointed to before the new one went live. Anything that
// is not clearly a Vercel deployment URL (*.vercel.app) is treated as "no previous deployment" (fail closed: the workflow
// then refuses to guess and tells a person what to do). A previous deployment equal to the new one is also dropped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './check-console-deploy-env.mjs';

const ID_RE = /^dpl_[A-Za-z0-9]{8,64}$/;
const URL_RE = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.vercel\.app$/;

/** Parses the "General" block of `vercel inspect` (CLI 65.16.0 prints `id`, `name`, `target`, `status`, `url` lines: see
 *  the CLI's printDetails). Only a deployment that is target=production AND status=Ready is a
 *  rollback target; anything else (preview, custom environment, Error, Building, Canceled, odd output) is "none".
 *  @param {string} text output of `vercel inspect` (stdout and stderr, as is) @param {string} [exclude] new deployment URL
 *  @returns {{ id: string, url: string }} empty strings when not usable */
export function parsePrevious(text, exclude = '') {
  const f = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(id|target|status|url)\s+(.+?)\s*$/.exec(raw.replace(/\x1b\[[0-9;]*m/g, ''));
    if (m && !(m[1] in f)) f[m[1]] = m[2];
  }
  const status = (f.status ?? '').replace(/^[^A-Za-z]+/, ''); // "● Ready"
  const none = { id: '', url: '' };
  if (f.target !== 'production' || status !== 'Ready') return none;
  if (!ID_RE.test(f.id ?? '') || !URL_RE.test(f.url ?? '')) return none; // promote gets the id; the url is for the summary
  if (exclude && f.url.replace(/\/+$/, '') === exclude.replace(/\/+$/, '')) return none;
  return { id: f.id, url: f.url };
}

/** @param {string} envFileText @returns {string | null} */
export function originFrom(envFileText) {
  const v = parseEnvFile(envFileText).CONSOLE_ORIGIN;
  return v && /^https:\/\/[^/\s?#]+$/.test(v) ? v : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, file, extra] = process.argv.slice(2);
  if (cmd === 'origin') {
    const o = originFrom(readFileSync(file, 'utf8'));
    if (!o) {
      console.error('::error::rollback: no https CONSOLE_ORIGIN in the environment file');
      process.exit(1);
    }
    console.log(`origin=${o}`);
  } else if (cmd === 'previous') {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      /* no file: no previous deployment */
    }
    const { id, url } = parsePrevious(text, extra);
    console.log(`prev_id=${id}`);
    console.log(`prev_url=${url}`);
  } else {
    console.error('usage: rollback-console.mjs origin <env file> | previous <inspect output> [<new url>]');
    process.exit(2);
  }
}
