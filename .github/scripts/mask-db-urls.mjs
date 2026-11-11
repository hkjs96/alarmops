// Registers the parts of DATABASE_URL / DIRECT_URL as masked values so that they show as *** in the job log.
// GitHub already masks the whole secret; Prisma prints the host on its own, which that does not cover.
// Prints nothing but ::add-mask:: commands and warnings that contain no part of a URL.
const mask = new Set();
for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
  const raw = process.env[name];
  if (!raw) continue;
  mask.add(raw);
  let u;
  try {
    u = new URL(raw);
  } catch {
    console.log(`::warning::DEV_${name} is not a valid connection string (expected postgresql://user:password@host:port/postgres).`);
    continue;
  }
  for (const part of [u.password, safeDecode(u.password), u.hostname, u.host]) if (part) mask.add(part);
  // The pooled user name carries the project id (postgres.<id>); a bare "postgres" is left readable.
  if (u.username && u.username !== 'postgres') mask.add(safeDecode(u.username));
  const port = u.port || '5432';
  if (name === 'DATABASE_URL') {
    if (port !== '6543') console.log('::warning::DEV_DATABASE_URL should be the pooled (transaction) connection, port 6543.');
    if (u.searchParams.get('pgbouncer') !== 'true') console.log('::warning::DEV_DATABASE_URL should end with ?pgbouncer=true&connection_limit=1 (needed by Prisma on the pooled connection).');
  }
  if (name === 'DIRECT_URL' && port !== '5432') console.log('::warning::DEV_DIRECT_URL should be the session connection, port 5432. Migrations do not work through port 6543.');
}
for (const value of mask) for (const line of String(value).split('\n')) if (line.length >= 4) console.log(`::add-mask::${line}`);

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
