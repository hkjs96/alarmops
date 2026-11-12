// Live e2e database: a FRESH database `alarmops_live` on the server of LIVE_DATABASE_URL (dropped and created again),
// every migration of db/prisma/migrations applied in order (what `prisma migrate deploy` applies), then the dev seed
// (db/prisma/seed.ts). Refuses anything but a local server: this script drops a database.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const admin = process.env.LIVE_DATABASE_URL;
if (!admin) { console.error('LIVE_DATABASE_URL is not set'); process.exit(1); }
const u = new URL(admin);
if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) { console.error(`live e2e: refusing to drop a database on ${u.hostname} (local servers only)`); process.exit(1); }
const NAME = 'alarmops_live';
const c = new pg.Client({ connectionString: admin });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${NAME}`);
await c.end();
u.pathname = `/${NAME}`;
const url = u.toString();
const db = new pg.Client({ connectionString: url });
await db.connect();
const dir = new URL('../../../db/prisma/migrations/', import.meta.url);
for (const m of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  await db.query(readFileSync(new URL(`${m}/migration.sql`, dir), 'utf8'));
  console.log(`live e2e: applied ${m}`);
}
await db.end();
const seed = spawnSync('npx', ['tsx', 'prisma/seed.ts'], { cwd: new URL('../../../db/', import.meta.url), env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'development' }, stdio: 'inherit' });
if (seed.status !== 0) process.exit(seed.status ?? 1);
console.log(`live e2e: database ready (${NAME})`);
