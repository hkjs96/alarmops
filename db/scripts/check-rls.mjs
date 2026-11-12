// D-40: fails if any table in the schema has ROW LEVEL SECURITY off, or FORCEd (the owner must bypass it),
// or has a policy (D-40 says none). Run after `prisma migrate deploy`.
// Usage: DATABASE_URL=postgres://… node scripts/check-rls.mjs [schema]   (schema defaults to public)
import pg from 'pg';

export async function rlsProblems(client, schema = 'public') {
  const { rows } = await client.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`, [schema]);
  const problems = [];
  for (const r of rows) {
    if (!r.relrowsecurity) problems.push(`${r.relname}: ROW LEVEL SECURITY is off`);
    if (r.relforcerowsecurity) problems.push(`${r.relname}: FORCE ROW LEVEL SECURITY is on (owner would read 0 rows)`);
    if (r.policies > 0) problems.push(`${r.relname}: has ${r.policies} policy(ies); D-40 says none`);
  }
  return { tables: rows.length, problems };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-rls.mjs')) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { tables, problems } = await rlsProblems(client, process.argv[2] ?? 'public');
    if (tables === 0) { console.error('no tables found; did migrate deploy run?'); process.exit(1); }
    if (problems.length) { console.error('RLS check failed (D-40):\n- ' + problems.join('\n- ')); process.exit(1); }
    console.log(`RLS enabled, not forced, no policies on all ${tables} tables`);
  } finally { await client.end(); }
}
