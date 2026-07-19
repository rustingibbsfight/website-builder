import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THEME, type SiteInput } from '@wb/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import { assetDir } from './db.js';

let dataDir: string;
let core: WbCore;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-core-sec-'));
  core = await WbCore.create({ dataDir });
});

afterEach(() => {
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('asset filename sanitization', () => {
  it('neutralizes traversal and odd characters in uploaded filenames', async () => {
    const site = await core.createSite('S');
    for (const name of ['../../evil.svg', '..\\..\\evil.svg', 'a/b/c.png', 'nul .png', '....//x.svg']) {
      const asset = await core.addAsset(site.id, name, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>');
      // Stored path stays inside the site's asset dir — no separators survive.
      expect(asset.path).not.toContain('/');
      expect(asset.path).not.toContain('\\');
      expect(asset.path).not.toContain('..');
      // Bytes are retrievable through the storage layer and land in the site dir.
      const read = await core.readAsset(site.id, asset.id);
      expect(read.buffer.length).toBeGreaterThan(0);
      expect(existsSync(join(assetDir(dataDir, site.id), asset.path))).toBe(true);
    }
  });

  it('template assets are namespaced by id and never collide or escape', async () => {
    const site = await core.createSiteFromTemplate('breakthrough-medical');
    const dir = assetDir(dataDir, site.id);
    const files = readdirSync(dir);
    // Every file is <id>-<name> — no bare template filenames.
    expect(files.every((f) => /^[0-9a-z]{14}-/.test(f))).toBe(true);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('deleteSite only removes its own directories', () => {
  it('leaves sibling sites and the data root intact', async () => {
    const a = await core.createSiteFromTemplate('breakthrough-medical');
    const b = await core.createSiteFromTemplate('breakthrough-medical');
    const canary = join(dataDir, 'canary.txt');
    writeFileSync(canary, 'x');

    await core.deleteSite(a.id);
    expect(existsSync(assetDir(dataDir, a.id))).toBe(false);
    expect(existsSync(assetDir(dataDir, b.id))).toBe(true);
    expect(existsSync(canary)).toBe(true);
    expect((await core.listSites()).map((s) => s.id)).toEqual([b.id]);
    // Child rows are gone too (no orphans).
    await expect(core.getPage(a.id, '')).rejects.toThrow();
  });
});

describe('importSite validates slugs (no dist path escape via bulk import)', () => {
  const baseInput = (slug: string): SiteInput => ({
    name: 'Imported',
    theme: DEFAULT_THEME,
    pages: [{ slug, title: 'P', tree: { id: 'r', type: 'page-root', props: {}, children: [] } }],
  });

  it('rejects a traversal slug before anything is persisted', async () => {
    for (const slug of ['../../../tmp/pwn', 'has/slash', '..', 'UPPER', 'a b']) {
      await expect(core.importSite(baseInput(slug))).rejects.toThrow(/invalid slug/);
    }
    // Nothing was written for the failed imports.
    expect(await core.listSites()).toHaveLength(0);
  });

  it('rejects duplicate slugs in one import', async () => {
    const input: SiteInput = {
      name: 'Dupes',
      theme: DEFAULT_THEME,
      pages: [
        { slug: 'a', title: 'A', tree: { id: 'r', type: 'page-root', props: {}, children: [] } },
        { slug: 'a', title: 'A2', tree: { id: 'r', type: 'page-root', props: {}, children: [] } },
      ],
    };
    await expect(core.importSite(input)).rejects.toThrow(/duplicate slug/);
  });

  it('accepts valid slugs including empty (home) and "index"', async () => {
    const input: SiteInput = {
      name: 'Good',
      theme: DEFAULT_THEME,
      pages: [
        { slug: 'index', title: 'Home', tree: { id: 'r', type: 'page-root', props: {}, children: [] } },
        { slug: 'about-us', title: 'About', tree: { id: 'r', type: 'page-root', props: {}, children: [] } },
      ],
    };
    const site = await core.importSite(input);
    const slugs = (await core.listPages(site.id)).map((p) => p.slug).sort();
    expect(slugs).toEqual(['', 'about-us']);
  });
});

describe('cross-site access is denied at the service layer', () => {
  it('cannot read or mutate another site’s pages/assets by id', async () => {
    const a = await core.createSite('A');
    const b = await core.createSiteFromTemplate('breakthrough-medical');
    const bPage = (await core.listPages(b.id))[0]!;
    const bAsset = (await core.listAssets(b.id))[0]!;
    await expect(core.getPage(a.id, bPage.id)).rejects.toThrow(/not found/);
    await expect(core.getAsset(a.id, bAsset.id)).rejects.toThrow(/not found/);
    await expect(core.applyPageOps(a.id, bPage.id, [{ op: 'remove', nodeId: 'x' }])).rejects.toThrow(/not found/);
  });
});

describe('tree op validation is enforced end-to-end', () => {
  it('rejects invalid component props through the service layer', async () => {
    const site = await core.createSite('V');
    const page = (await core.listPages(site.id))[0]!;
    await expect(
      core.applyPageOps(site.id, page.id, [
        { op: 'insert', parentId: page.tree.id, node: { type: 'heading', props: { text: '', level: 99 } } },
      ]),
    ).rejects.toThrow(/invalid props|level/);
  });

  it('enforces the page-root invariant on whole-tree replace', async () => {
    const site = await core.createSite('R');
    const page = (await core.listPages(site.id))[0]!;
    await expect(core.setTree(site.id, page.id, { type: 'section', props: {} })).rejects.toThrow(/page-root/);
  });

  it('publish refuses a site with no pages', async () => {
    const site = await core.createSite('Empty');
    await core.deletePage(site.id, (await core.listPages(site.id))[0]!.id);
    await expect(core.publishSite(site.id)).rejects.toThrow(/no pages/);
  });
});
