// Bundles the three ingest Lambda entry points into dist/{webhook,eventbridge,consumer}/index.mjs
// (infra/aws/central.yaml CodeUri + Handler index.handler, nodejs22.x arm64). Everything is bundled, including the AWS SDK
// (pinned in package.json) and pg; pg-native is optional and not shipped.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
for (const name of ['webhook', 'eventbridge', 'consumer']) {
  mkdirSync(join(root, 'dist', name), { recursive: true });
  await build({
    entryPoints: [join(root, 'src', 'lambda', `${name}.ts`)],
    outfile: join(root, 'dist', name, 'index.mjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: false, sourcemap: false, legalComments: 'none',
    external: ['pg-native'],
    // pg and parts of the SDK are CommonJS and call require(); give the ESM bundle a require.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
}
console.log('ingest lambda bundles written to services/ingest/dist/{webhook,eventbridge,consumer}/index.mjs');
