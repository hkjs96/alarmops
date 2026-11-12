// db checks run by `npm test`:
// 1. `prisma validate` on schema.prisma
// 2. migrations/0001_init/migration.sql generated part is in sync with schema.prisma
// Works offline: DATABASE_URL and DIRECT_URL get a placeholder (validate never connects).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const migration = fs.readFileSync(path.join(root, 'prisma/migrations/0001_init/migration.sql'), 'utf8');
if (!migration.startsWith(generated)) {
  console.error('migration.sql is out of sync with schema.prisma. Regenerate (see db/README.md).');
  const g = generated.split('\n'), m = migration.split('\n'), i = g.findIndex((line, n) => line !== m[n]);
  console.error(`first difference at line ${i + 1}:\n  schema:    ${g[i]}\n  migration: ${m[i]}`);
  process.exit(1);
}
console.log('migration 0001_init in sync with schema.prisma');

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
  ['expiry indexes for the tick housekeeping (R-7)', /CREATE INDEX "UndoRecord_expiresAt_idx"[\s\S]*CREATE INDEX "IdempotencyKey_expiresAt_idx"[\s\S]*CREATE INDEX "TickClaim_claimedAt_idx"/],
  ['Supabase Data API roles revoked, guarded by role existence (R-4)', /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = r\)[\s\S]*REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I[\s\S]*ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I/],
];
const missing = required.filter(([, re]) => !re.test(migration)).map(([name]) => name);
if (/CREATE UNIQUE INDEX "Alert_fingerprint_key"/.test(migration)) missing.push('Alert.fingerprint must not be globally unique (B-4)');
if (missing.length) { console.error('missing required constraints:\n- ' + missing.join('\n- ')); process.exit(1); }
console.log(`hand-written constraints present (${required.length})`);
