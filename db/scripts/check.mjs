// db checks run by `npm test`:
// 1. `prisma validate` on schema.prisma
// 2. the migrations (0001_init + the generated statements of later ones) are in sync with schema.prisma
// Works offline: DATABASE_URL and DIRECT_URL get a placeholder (validate never connects).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { badSeedPhones, phoneLiterals } from './seed-phones.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const offline = 'postgresql://offline@localhost:5432/none';
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? offline, DIRECT_URL: process.env.DIRECT_URL ?? offline };
const v = spawnSync('npx', ['prisma', 'validate'], { cwd: root, env, encoding: 'utf8', shell: process.platform === 'win32' });
process.stdout.write(v.stdout); process.stderr.write(v.stderr);
if (v.status !== 0) {
  if (/binaries\.prisma\.sh/.test(v.stderr + v.stdout)) {
    console.warn('prisma engine download blocked; retrying validate with placeholder engine paths (sandbox only)');
    const fake = path.join(root, 'node_modules', '.fake-engine.so.node');
    fs.mkdirSync(path.dirname(fake), { recursive: true }); fs.writeFileSync(fake, '');
    const r = spawnSync('npx', ['prisma', 'validate'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
      env: { ...env, PRISMA_QUERY_ENGINE_LIBRARY: fake, PRISMA_SCHEMA_ENGINE_BINARY: process.execPath } });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) process.exit(1);
  } else process.exit(1);
}

// The real Prisma CLI when its engine is there (CI, a normal PC); the WASM engine only where the download is blocked.
// Node < 22.19 needs a flag to import the .wasm file.
const wasmFlag = process.allowedNodeEnvironmentFlags.has('--experimental-wasm-modules') ? ['--experimental-wasm-modules'] : [];
const d = v.status === 0
  ? spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { cwd: root, env, encoding: 'utf8', shell: process.platform === 'win32' })
  : spawnSync(process.execPath, [...wasmFlag, 'scripts/migrate-diff-offline.mjs', 'prisma/schema.prisma'], { cwd: root, encoding: 'utf8' });
if (d.status !== 0) { console.error(d.stderr); process.exit(1); }
const generated = d.stdout.replace(/\r\n/g, '\n').replace(/^-- CreateSchema\nCREATE SCHEMA IF NOT EXISTS "public";\n\n/, '').trimEnd();
const migDir = path.join(root, 'prisma/migrations');
const migNames = fs.readdirSync(migDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const migration = fs.readFileSync(path.join(migDir, '0001_init/migration.sql'), 'utf8');
const later = migNames.filter((m) => m !== '0001_init').map((m) => [m, fs.readFileSync(path.join(migDir, m, 'migration.sql'), 'utf8')]);

// 2a. Only 0001_init: its generated part is the start of the file (as before 0002).
// 2b. With later migrations: 0001_init + the generated statements of every later migration, folded together, must
//     give what the schema generates — every enum and every table with exactly the same columns, and every other
//     generated statement (index, foreign key) present. Offline, statement by statement; CI's
//     `prisma migrate diff --from-migrations` against a shadow database stays the authority.
//     A later migration may hold CREATE TYPE … AS ENUM, CREATE TABLE, ALTER TABLE … ADD COLUMN, CREATE [UNIQUE] INDEX,
//     ALTER TABLE … ADD CONSTRAINT and hand-written blocks (DO $$ … $$, CREATE FUNCTION, ALTER TABLE … ENABLE ROW LEVEL SECURITY,
//     REVOKE, GRANT, COMMENT). Anything else (DROP, ALTER COLUMN, RENAME, ALTER TYPE …) is not folded: extend this check.
if (later.length === 0) {
  if (!migration.startsWith(generated)) {
    console.error('migration.sql is out of sync with schema.prisma. Regenerate (see db/README.md).');
    const g = generated.split('\n'), m = migration.split('\n'), i = g.findIndex((line, n) => line !== m[n]);
    console.error(`first difference at line ${i + 1}:\n  schema:    ${g[i]}\n  migration: ${m[i]}`);
    process.exit(1);
  }
  console.log('migration 0001_init in sync with schema.prisma');
} else {
  const { statements } = await import(pathToFileURL(path.join(root, '../.github/scripts/check-migration-drift.mjs')).href);
  /** Top-level comma split of a CREATE TABLE body. */
  const items = (body) => { const out = []; let depth = 0, cur = ''; for (const ch of body) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const model = () => ({ enums: new Map(), tables: new Map(), other: new Set() });
  const add = (m, st, strict, where) => {
    let x;
    if ((x = /^CREATE TYPE ("[^"]+") AS ENUM (\(.*\))$/.exec(st))) m.enums.set(x[1], x[2]);
    else if ((x = /^CREATE TABLE ("[^"]+") \((.*)\)$/.exec(st))) m.tables.set(x[1], new Set(items(x[2])));
    else if ((x = /^ALTER TABLE ("[^"]+") (ADD COLUMN .*)$/.exec(st))) {
      const t = m.tables.get(x[1]);
      if (!t) { console.error(`${where}: ADD COLUMN on unknown table ${x[1]}`); process.exit(1); }
      for (const c of x[2].split(/, ADD COLUMN /)) t.add(c.replace(/^ADD COLUMN /, '').trim());
    } else if (/^(CREATE (UNIQUE )?INDEX|ALTER TABLE "[^"]+" ADD CONSTRAINT|CREATE EXTENSION)/.test(st)) m.other.add(st);
    else if (strict && !/^(DO |CREATE FUNCTION |ALTER TABLE "?[^" ]+"? ENABLE ROW LEVEL SECURITY|REVOKE |GRANT |COMMENT )/.test(st)) { console.error(`${where}: check.mjs cannot fold this statement; extend db/scripts/check.mjs:\n  ${st.slice(0, 160)}`); process.exit(1); }
  };
  const want = model();
  for (const st of statements(generated)) add(want, st, false, 'schema');
  const have = model();
  for (const st of statements(migration)) add(have, st, false, '0001_init');
  for (const [name, sql] of later) for (const st of statements(sql)) add(have, st, true, name);
  const problems = [];
  for (const [n, v] of want.enums) if (have.enums.get(n) !== v) problems.push(`enum ${n}: schema ${v}, migrations ${have.enums.get(n) ?? 'missing'}`);
  for (const n of have.enums.keys()) if (!want.enums.has(n)) problems.push(`enum ${n}: in the migrations, not in the schema`);
  for (const [n, cols] of want.tables) {
    const h = have.tables.get(n);
    if (!h) { problems.push(`table ${n}: missing from the migrations`); continue; }
    for (const c of cols) if (!h.has(c)) problems.push(`table ${n}: schema has  ${c}`);
    for (const c of h) if (!cols.has(c)) problems.push(`table ${n}: migrations have  ${c}`);
  }
  for (const n of have.tables.keys()) if (!want.tables.has(n)) problems.push(`table ${n}: in the migrations, not in the schema`);
  for (const st of want.other) if (!have.other.has(st)) problems.push(`missing: ${st.slice(0, 160)}`);
  if (problems.length) { console.error('migrations are out of sync with schema.prisma (add a migration, see db/README.md):\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log(`migrations ${migNames.join(', ')} in sync with schema.prisma (${want.tables.size} tables, ${want.enums.size} enums)`);
}

// 3. Hand-written constraints that guard tenant isolation and the D-15 approval path must stay present.
const required = [
  ['Alert (customerId, fingerprint) UQ NULLS NOT DISTINCT (B-4/B-6)', /CREATE UNIQUE INDEX "Alert_customerId_fingerprint_key" ON "Alert"\("customerId", "fingerprint"\) NULLS NOT DISTINCT/],
  ['RemediationRequest decided CHECK (B-5)', /"RemediationRequest_decided_chk"\s+CHECK \("status" NOT IN \('APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED'\) OR \("decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL\)\)/],
  ['RemediationRequest composite FK to Resource(id, customerId) (B-5)', /FOREIGN KEY \("resourceId", "customerId"\) REFERENCES "Resource"\("id", "customerId"\)/],
  ['RemediationRequest active partial UQ (D-15)', /"RemediationRequest_active_key"/],
  ['AlertGroup one OPEN group per axis (G-3)', /CREATE UNIQUE INDEX "AlertGroup_groupKey_open_key" ON "AlertGroup"\("groupKey"\) WHERE "status" = 'OPEN'/],
  ['Incident one merge target per axis (I-3)', /CREATE UNIQUE INDEX "Incident_axis_mergeTarget_key" ON "Incident"\("axis"\) WHERE "isMergeTarget"/],
  ['NotificationJob idempotencyKey UQ (outbox dedup)', /CREATE UNIQUE INDEX "NotificationJob_idempotencyKey_key"/],
  ['NotificationJob due index for the outbox claim', /CREATE INDEX "NotificationJob_due_idx"/],
  ['Incident due index for the escalation tick', /CREATE INDEX "Incident_nextEscalationAt_due_idx"/],
  ['slug format CHECK (D-33)', /"Customer_slug_chk"[\s\S]*"Project_slug_chk"[\s\S]*"Service_slug_chk"/],
  ['ContactRevealLog emergency reason CHECK (D-35)', /"ContactRevealLog_emergency_reason_chk"/],
  ['slug reserved words CHECK (security review SQL, N-7)', /"Customer_slug_reserved_chk"[\s\S]*"Project_slug_reserved_chk"[\s\S]*"Service_slug_reserved_chk"/],
  ['expiry indexes for the tick housekeeping (R-7)', /^(?=[\s\S]*CREATE INDEX "UndoRecord_expiresAt_idx")(?=[\s\S]*CREATE INDEX "IdempotencyKey_expiresAt_idx")(?=[\s\S]*CREATE INDEX "TickClaim_claimedAt_idx")/],
  ['Supabase Data API roles revoked, guarded by role existence (R-4)', /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)[\s\S]*REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I[\s\S]*ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I/],
];
const missing = required.filter(([, re]) => !re.test(migration)).map(([name]) => name);
if (/CREATE UNIQUE INDEX "Alert_fingerprint_key"/.test(migration)) missing.push('Alert.fingerprint must not be globally unique (B-4)');
if (missing.length) { console.error('missing required constraints:\n- ' + missing.join('\n- ')); process.exit(1); }
console.log(`hand-written constraints present (${required.length})`);

// 4. Seed phones must be non-dialable (+82 10-0000-00NN, an exchange never issued in KR) so no sender can ever page a real person.
//    Any quote style, and phone-shaped numbers without + as well (seed-phones.mjs).
const seed = fs.readFileSync(new URL('../prisma/seed.ts', import.meta.url), 'utf8');
const phones = phoneLiterals(seed);
const bad = badSeedPhones(seed);
if (!phones.length || bad.length) { console.error('seed phones must match +8210000000NN (non-dialable):\n- ' + (bad.join('\n- ') || 'none found')); process.exit(1); }
console.log(`seed phones non-dialable (${phones.length})`);
