// Helpers for the automatic rollback in deploy-console.yml. No secrets, no network: it only reads files and prints.
//
//   node .github/scripts/rollback-console.mjs origin <KEY=VALUE file>   # prints origin=<CONSOLE_ORIGIN> or exits 1
//   node .github/scripts/rollback-console.mjs previous <inspect output file> [<new deployment url>]
//       # reads the output of `vercel inspect <CONSOLE_ORIGIN>` taken BEFORE the deploy and prints GITHUB_OUTPUT lines
//       #   prev_id=dpl_...   prev_url=https://....vercel.app     (both empty when nothing usable was found)
//
// Why a parser: the deploy job must know which deployment production pointed to before the new one went live. Anything that
// is not clearly a Vercel deployment URL (*.vercel.app) is treated as "no previous deployment" (fail closed: the workflow
// then refuses to guess and tells a person what to do). A previous deployment equal to the new one is also dropped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './check-console-deploy-env.mjs';

const ID_RE = /^dpl_[A-Za-z0-9]{8,64}$/;
const URL_RE = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.vercel\.app$/;

/** @param {string} text output of `vercel inspect` (stdout and stderr, as is) @param {string} [exclude] new deployment URL
 *  @returns {{ id: string, url: string }} empty strings when not found */
export function parsePrevious(text, exclude = '') {
  let id = '';
  let url = '';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(id|url)\s+(\S+)\s*$/.exec(raw.replace(/\x1b\[[0-9;]*m/g, ''));
    if (!m) continue;
    if (m[1] === 'id' && !id && ID_RE.test(m[2])) id = m[2];
    if (m[1] === 'url' && !url && URL_RE.test(m[2])) url = m[2];
  }
  if (!url) return { id: '', url: '' }; // the URL is what `vercel promote` is given
  if (exclude && url.replace(/\/+$/, '') === exclude.replace(/\/+$/, '')) return { id: '', url: '' };
  return { id, url };
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
