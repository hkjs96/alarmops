import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Smoke check of the SAM CodeUri layout (infra/aws/central.yaml): build, then import each bundle and see `handler`.
describe('lambda artifacts', () => {
  beforeAll(() => { execFileSync(process.execPath, [join(root, 'scripts', 'build-lambda.mjs')], { stdio: 'pipe' }); }, 60_000);

  for (const name of ['webhook', 'eventbridge', 'consumer']) {
    it(`dist/${name}/index.mjs exports handler`, async () => {
      const file = join(root, 'dist', name, 'index.mjs');
      expect(existsSync(file)).toBe(true);
      const mod = await import(pathToFileURL(file).href);
      expect(typeof mod.handler).toBe('function');
    }, 30_000);
  }
});
