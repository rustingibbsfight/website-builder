// E2E fixture: create the Breakthrough Medical site via the real CLI,
// build it, then serve the static output on :5173.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const cli = resolve(here, '../packages/cli/dist/index.js');
const dataDir = mkdtempSync(join(tmpdir(), 'wb-e2e-'));
const env = { ...process.env, WB_DATA_DIR: dataDir };

const run = (...args) => execFileSync('node', [cli, ...args], { env, encoding: 'utf8' });

const created = JSON.parse(
  run('create', 'Breakthrough Medical', '--template', 'breakthrough-medical', '--base-url', 'https://breakthrough.example'),
);
const siteId = created.siteId;
const build = JSON.parse(run('build', siteId));
console.log(`e2e site ${siteId} built at ${build.distPath} (${build.files} files)`);

// Re-theme via a second CLI call so e2e also covers the rebrand → republish path.
run('theme', 'set', siteId, '--primary', '#7c3aed');
const rebuilt = JSON.parse(run('build', siteId));
console.log(`rebranded build at ${rebuilt.distPath}`);

const { serveStatic } = await import(resolve(here, '../packages/cli/dist/serve-static.js'));
await serveStatic(rebuilt.distPath, 5173);
console.log('serving on http://127.0.0.1:5173');
