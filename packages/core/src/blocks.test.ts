import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOCKS } from './blocks.js';
import { WbCore } from './core.js';

let dataDir: string;
let core: WbCore;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-blocks-'));
  core = await WbCore.create({ dataDir });
});
afterEach(() => {
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('block library', () => {
  it('lists blocks without their subtrees', () => {
    const list = core.listBlocks();
    expect(list.length).toBe(BLOCKS.length);
    for (const b of list) {
      expect(b).toHaveProperty('id');
      expect(b).toHaveProperty('category');
      expect(b).not.toHaveProperty('node');
    }
  });

  it('every block inserts into a page (valid props, valid tree)', async () => {
    const site = await core.createSite('Blocks');
    const [home] = await core.listPages(site.id);
    const rootId = home!.tree.id;

    for (const block of BLOCKS) {
      // Fresh page per block so counts are unambiguous.
      const page = await core.addPage(site.id, `b-${block.id}`, block.name);
      const before = page.tree.children?.length ?? 0;
      const updated = await core.insertBlock(site.id, page.id, block.id, page.tree.id);
      expect(updated.tree.children?.length, block.id).toBe(before + 1);
    }
    // sanity: the home root is untouched by the per-block pages
    expect((await core.getPage(site.id, rootId ? '' : '')).tree.id).toBe(rootId);
  });

  it('rejects an unknown block id with an agent-readable message', () => {
    expect(() => core.getBlock('nope')).toThrow(/unknown block "nope".*valid:/);
  });
});
