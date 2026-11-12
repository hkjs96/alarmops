// Checks DATABASE_URL / DIRECT_URL and registers their parts as masked values, so that they show as *** in the job log.
// GitHub already masks the whole secret; Prisma prints the host on its own, which that does not cover.
//
// The job stops here (exit 1) when a URL is missing or is not a Postgres connection string: its parts could not be
// masked then, and a later Prisma error message could print one of them (security review of 2026-11-11, 권고 5).
// The whole value is masked first, before anything is parsed.
// Prints nothing but ::add-mask:: commands and messages that contain no part of a URL.
// Tests: node --test .github/scripts/mask-db-urls.test.mjs
const SECRET = { DATABASE_URL: 'DEV_DATABASE_URL', DIRECT_URL: 'DEV_DIRECT_URL' };
const SHAPE = 'postgresql://user:password@host:port/postgres';
const out = [];
const problems = [];
const mask = new Set();

for (const name of Object.keys(SECRET)) {
  const raw = process.env[name];
  if (raw) mask.add(raw);
}
for (const [name, secret] of Object.entries(SECRET)) {
  const raw = process.env[name];
  if (!raw) {
    problems.push(`Missing secret ${secret} in the GitHub environment 'dev'. Add it under Settings > Environments > dev (docs/SETUP-SUPABASE.md, step 4).`);
    continue;
  }
  let u = null;
  // white space or a line break inside the value: a copy-paste slip, and a line break would split the mask
  if (!/\s/.test(raw)) {
    try {
      u = new URL(raw);
    } catch {
      u = null;
    }
  }
  const port = u && u.port ? Number(u.port) : 5432;
  if (!u || !['postgresql:', 'postgres:'].includes(u.protocol) || !u.hostname || !u.username || !u.password || !(port > 0 && port < 65536) || u.pathname.length < 2) {
    problems.push(`${secret} is not a valid connection string (expected ${SHAPE}, with no spaces or line breaks). Nothing was run. Save the secret again (docs/SETUP-SUPABASE.md, step 3).`);
    continue;
  }
  if (/YOUR-PASSWORD/i.test(safeDecode(u.password))) {
    problems.push(`${secret} still has the [YOUR-PASSWORD] placeholder. Nothing was run. Put the database password in its place (docs/SETUP-SUPABASE.md, step 3).`);
    continue;
  }
  for (const part of [u.password, safeDecode(u.password), u.hostname, u.host]) if (part) mask.add(part);
  // The pooled user name carries the project id (postgres.<id>); a bare "postgres" is left readable.
  if (u.username !== 'postgres') { mask.add(u.username); mask.add(safeDecode(u.username)); }
  if (name === 'DATABASE_URL') {
    if (port !== 6543) out.push('::warning::DEV_DATABASE_URL should be the pooled (transaction) connection, port 6543.');
    if (u.searchParams.get('pgbouncer') !== 'true') out.push('::warning::DEV_DATABASE_URL should end with ?pgbouncer=true&connection_limit=1 (needed by Prisma on the pooled connection).');
  }
  if (name === 'DIRECT_URL' && port !== 5432) out.push('::warning::DEV_DIRECT_URL should be the session connection, port 5432. Migrations do not work through port 6543.');
}

// masks first: whatever follows in the log is already covered
for (const value of mask) for (const line of String(value).split(/\r?\n/)) if (line.trim().length >= 4) console.log(`::add-mask::${line}`);
for (const line of out) console.log(line);
for (const p of problems) console.log(`::error::${p}`);
if (problems.length) process.exit(1);

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
