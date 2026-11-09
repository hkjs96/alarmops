// Offline equivalent of `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
// Used because binaries.prisma.sh is unreachable in the agent sandbox; the WASM schema engine needs no native
// binary and no database (the fake adapter answers the single version probe with an empty result).
// Usage: node scripts/migrate-diff-offline.mjs prisma/schema.prisma > out.sql
import fs from 'node:fs';
import { SchemaEngine } from '@prisma/schema-engine-wasm';
import { bindMigrationAwareSqlAdapterFactory } from '@prisma/driver-adapter-utils';
// Prisma 7 engine rejects datasource `url`; it is irrelevant to the DDL, so strip it.
const content = fs.readFileSync(process.argv[2], 'utf8').replace(/^\s*url\s*=.*$/m, '');
const log = () => {};
const conn = {
  provider: 'postgres', adapterName: '@prisma/adapter-pg',
  queryRaw: async (q) => { log('query', q.sql); return { columnNames: [], columnTypes: [], rows: [] }; },
  executeRaw: async (q) => { log('exec', q.sql); return 0; },
  executeScript: async (s) => { log('script', s); },
  startTransaction: async () => { throw new Error('no tx'); },
  getConnectionInfo: () => ({ schemaName: 'public', supportsRelationJoins: true }),
  dispose: async () => {},
};
const adapter = bindMigrationAwareSqlAdapterFactory({ provider: 'postgres', adapterName: '@prisma/adapter-pg', connect: async () => conn, connectToShadowDb: async () => conn });
const eng = await SchemaEngine.new({ datamodels: [['schema.prisma', content]] }, (l) => {}, adapter);
const r = await eng.diff({ from: { tag: 'empty' }, to: { tag: 'schemaDatamodel', files: [{ path: 'schema.prisma', content }] }, script: true, exitCode: null, filters: { externalTables: [], externalEnums: [] } });
process.stdout.write(r.stdout ?? '');
