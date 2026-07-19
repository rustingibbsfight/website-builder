// E2E fixture for the visual editor: fresh data dir, one Breakthrough Medical
// site, then the full wb server (REST + preview + editor SPA) on :4600.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const cli = resolve(here, '../packages/cli/dist/index.js');
const dataDir = mkdtempSync(join(tmpdir(), 'wb-editor-e2e-'));

const created = JSON.parse(
  execFileSync('node', [cli, 'create', 'Breakthrough Medical', '--template', 'breakthrough-medical'], {
    env: { ...process.env, WB_DATA_DIR: dataDir },
    encoding: 'utf8',
  }),
);
console.log(`editor e2e site: ${created.siteId}`);

const { startServer } = await import(resolve(here, '../packages/server/dist/index.js'));
await startServer({ dataDir, port: 4600 });
console.log('wb server on http://127.0.0.1:4600');
