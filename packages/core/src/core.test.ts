import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THEME, OpsError } from '@wb/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import { NotFoundError, ValidationError } from './errors.js';

let dataDir: string;
let core: WbCore;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-test-'));
  core = await WbCore.create({ dataDir });
});

afterEach(() => {
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('WbCore sites & pages', () => {
  it('creates a blank site with a home page', async () => {
    const site = await core.createSite('My Clinic');
    expect(site.theme.brandName).toBe('My Clinic');
    const pages = await core.listPages(site.id);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe('');
    expect(pages[0]!.tree.type).toBe('page-root');
  });

  it('seeds formEndpoint from the API\'s own public URL so contact forms work on arrival', async () => {
    // A published site is served from a static host on another origin, so a
    // form has to post to an absolute URL. Left to be set by hand, it isn't.
    const dir = mkdtempSync(join(tmpdir(), 'wb-pub-'));
    const withUrl = await WbCore.create({ dataDir: dir, publicUrl: 'https://wb-api-gold.vercel.app/' });
    try {
      const blank = await withUrl.createSite('Clinic');
      expect(blank.settings.formEndpoint).toBe('https://wb-api-gold.vercel.app'); // trailing slash trimmed

      const templated = await withUrl.createSiteFromTemplate('breakthrough-medical', 'From Template');
      expect(templated.settings.formEndpoint).toBe('https://wb-api-gold.vercel.app');
    } finally {
      withUrl.close();
      rmSync(dir, { recursive: true, force: true });
    }

    // Unset: no endpoint invented, and the renderer's lint is what says so.
    const site = await core.createSite('No Public URL');
    expect(site.settings.formEndpoint).toBeUndefined();
  });

  it('backfills formEndpoint onto sites that predate it, once, without clobbering a set one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-backfill-'));
    try {
      // A database from before the seeding existed: two sites, no endpoints.
      const before = await WbCore.create({ dataDir: dir });
      const stale = await before.createSite('Old Clinic');
      const custom = await before.createSite('Own Handler');
      await before.updateSite(custom.id, { settings: { formEndpoint: 'https://forms.example.com' } });
      expect((await before.getSite(stale.id)).settings.formEndpoint).toBeUndefined();
      before.close();

      // Reopening with a public URL configured fixes the one that had none.
      const after = await WbCore.create({ dataDir: dir, publicUrl: 'https://wb-api-gold.vercel.app' });
      expect((await after.getSite(stale.id)).settings.formEndpoint).toBe('https://wb-api-gold.vercel.app');
      // A site that already pointed somewhere is left alone.
      expect((await after.getSite(custom.id)).settings.formEndpoint).toBe('https://forms.example.com');
      after.close();

      // Runs once: clearing an endpoint on purpose must survive the next start.
      const third = await WbCore.create({ dataDir: dir, publicUrl: 'https://wb-api-gold.vercel.app' });
      await third.updateSite(stale.id, { settings: { formEndpoint: undefined } });
      third.close();
      const fourth = await WbCore.create({ dataDir: dir, publicUrl: 'https://wb-api-gold.vercel.app' });
      expect((await fourth.getSite(stale.id)).settings.formEndpoint).toBeUndefined();
      fourth.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies ops with registry validation and structured errors', async () => {
    const site = await core.createSite('Ops Site');
    const page = (await core.listPages(site.id))[0]!;
    const rootId = page.tree.id;

    const updated = await core.applyPageOps(site.id, page.id, [
      { op: 'insert', parentId: rootId, node: { type: 'section', children: [
        { type: 'heading', props: { text: 'Hello', level: 1 } },
      ] } },
    ]);
    expect(updated.tree.children).toHaveLength(1);

    await expect(
      core.applyPageOps(site.id, page.id, [
        { op: 'insert', parentId: rootId, node: { type: 'nope', props: {} } },
      ]),
    ).rejects.toThrow(/unknown component "nope"/);

    try {
      await core.applyPageOps(site.id, page.id, [
        { op: 'update', nodeId: updated.tree.children![0]!.id, props: {} },
        { op: 'remove', nodeId: 'missing123' },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpsError);
      expect((err as OpsError).opIndex).toBe(1);
    }
  });

  it('enforces the destination parent allowedChildren via ops (insert + move)', async () => {
    const site = await core.createSite('AllowedChildren');
    const page = (await core.listPages(site.id))[0]!;
    const rootId = page.tree.id;
    // featureGrid only allows card/testimonial/stack/image children.
    const afterGrid = await core.applyPageOps(site.id, page.id, [
      { op: 'insert', parentId: rootId, node: { type: 'featureGrid', props: {}, children: [{ type: 'card', props: { title: 'A' } }] } },
      { op: 'insert', parentId: rootId, node: { type: 'heading', props: { text: 'loose', level: 2 } } },
    ]);
    const gridId = afterGrid.tree.children!.find((c) => c.type === 'featureGrid')!.id;
    const headingId = afterGrid.tree.children!.find((c) => c.type === 'heading')!.id;

    // Inserting a disallowed child type must be rejected (was silently allowed).
    await expect(
      core.applyPageOps(site.id, page.id, [{ op: 'insert', parentId: gridId, node: { type: 'heading', props: { text: 'x', level: 2 } } }]),
    ).rejects.toThrow(/only allows children/);

    // Moving a disallowed node into it is rejected too.
    await expect(
      core.applyPageOps(site.id, page.id, [{ op: 'move', nodeId: headingId, parentId: gridId, index: 0 }]),
    ).rejects.toThrow(/only allows children/);
  });

  it('importSite persists symbols and getSymbol resists proto lookups (#26 hardening)', async () => {
    const site = await core.importSite({
      name: 'Imported',
      theme: DEFAULT_THEME,
      symbols: { cta: { id: 'c', type: 'heading', props: { text: 'Hi', level: 2 }, children: [] } },
      pages: [
        {
          slug: '',
          title: 'Home',
          tree: { id: 'r', type: 'page-root', props: {}, children: [{ id: 'i', type: 'symbolInstance', props: { symbolId: 'cta' } }] },
        },
      ],
    });
    // Symbols survive the import (previously silently dropped).
    expect(await core.listSymbols(site.id)).toEqual([{ id: 'cta', rootType: 'heading' }]);
    // Own-property lookup — inherited members 404, no Object.prototype leak.
    await expect(core.getSymbol(site.id, '__proto__')).rejects.toThrow(NotFoundError);
  });

  it('concurrent setSymbol on different keys does not clobber (atomic json_set) (#26 hardening)', async () => {
    const site = await core.createSite('Concurrent');
    await Promise.all([
      core.setSymbol(site.id, 'x', { type: 'heading', props: { text: 'X', level: 2 } } as never),
      core.setSymbol(site.id, 'y', { type: 'heading', props: { text: 'Y', level: 2 } } as never),
    ]);
    // Both survive — a read-all/write-all would have dropped one.
    expect((await core.listSymbols(site.id)).map((s) => s.id).sort()).toEqual(['x', 'y']);
    // Deleting one leaves the other intact.
    await core.deleteSymbol(site.id, 'x');
    expect((await core.listSymbols(site.id)).map((s) => s.id)).toEqual(['y']);
  });

  it('sanitizes uploaded SVGs (strips script/handlers) (F3 hardening)', async () => {
    const site = await core.createSite('SvgSan');
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script>' +
      '<rect width="10" height="10" onload="alert(1)"/><a xlink:href="javascript:alert(2)">x</a></svg>';
    const asset = await core.addAsset(site.id, 'logo.svg', 'image/svg+xml', evil);
    const { buffer } = await core.readAsset(site.id, asset.id);
    const out = buffer.toString('utf8');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onload\s*=/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('<rect'); // legitimate graphics preserved
  });

  it('rejects invalid component props via ops', async () => {
    const site = await core.createSite('Val Site');
    const page = (await core.listPages(site.id))[0]!;
    await expect(
      core.applyPageOps(site.id, page.id, [
        { op: 'insert', parentId: page.tree.id, node: { type: 'button', props: { label: 'x' } } },
      ]),
    ).rejects.toThrow(/href/);
  });

  it('enforces unique slugs and slug format', async () => {
    const site = await core.createSite('Slugs');
    await expect(core.addPage(site.id, '', 'Another home')).rejects.toThrow(ValidationError);
    await expect(core.addPage(site.id, 'Bad Slug!', 'X')).rejects.toThrow(/invalid slug/);
    await core.addPage(site.id, 'services', 'Services');
    expect((await core.getPage(site.id, 'services')).title).toBe('Services');
  });

  it('merges theme patches', async () => {
    const site = await core.createSite('Theme Site');
    const updated = await core.setTheme(site.id, { colors: { primary: '#ff0000' } as never });
    expect(updated.theme.colors.primary).toBe('#ff0000');
    expect(updated.theme.colors.text).toBe('#1f2937'); // untouched
  });

  it('404s cleanly', async () => {
    await expect(core.getSite('nope')).rejects.toThrow(NotFoundError);
    const site = await core.createSite('X');
    await expect(core.getPage(site.id, 'nope')).rejects.toThrow(NotFoundError);
  });
});

describe('template instantiation + publish', () => {
  it('creates breakthrough-medical with 4 pages and branded assets', async () => {
    const site = await core.createSiteFromTemplate('breakthrough-medical');
    const pages = await core.listPages(site.id);
    expect(pages.map((p) => p.slug).sort()).toEqual(['', 'about', 'contact', 'services']);
    const assets = await core.listAssets(site.id);
    expect(assets.map((a) => a.filename).sort()).toEqual(['about.svg', 'hero.svg', 'logo.svg']);
    expect(site.theme.logo?.assetId).toBeTruthy();
    expect(assets.some((a) => a.id === site.theme.logo?.assetId)).toBe(true);
  });

  it('applies brand overrides', async () => {
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'Acme Health', {
      colors: { primary: '#112233' },
    });
    expect(site.name).toBe('Acme Health');
    expect(site.theme.brandName).toBe('Acme Health');
    expect(site.theme.colors.primary).toBe('#112233');
  });

  it('publishes to dist with pages, css, assets, sitemap — and no JS', async () => {
    const site = await core.createSiteFromTemplate('breakthrough-medical', undefined, {
      baseUrl: 'https://breakthrough.example',
    });
    const result = await core.publishSite(site.id);
    expect(result.pageCount).toBe(4);
    for (const f of ['index.html', 'services/index.html', 'about/index.html', 'contact/index.html', 'styles.css', 'sitemap.xml', 'robots.txt', '404.html']) {
      expect(existsSync(join(result.distPath, f)), f).toBe(true);
    }
    expect(result.files.some((f) => f.endsWith('.js'))).toBe(false);
    const html = readFileSync(join(result.distPath, 'index.html'), 'utf8');
    expect(html).toContain('Weight loss, guided by medical experts');
    expect(html).not.toContain('<script>');
    const css = readFileSync(join(result.distPath, 'styles.css'), 'utf8');
    expect(css).toContain('--color-primary:#0e7c66');
    // assets were copied into the build from storage
    expect(result.files.some((f) => f.startsWith('assets/'))).toBe(true);
    expect(existsSync(join(result.distPath, 'assets'))).toBe(true);
    const builds = await core.listBuilds(site.id);
    expect(builds).toHaveLength(1);
  });

  it('republish after set_theme changes the css', async () => {
    const site = await core.createSiteFromTemplate('breakthrough-medical');
    await core.publishSite(site.id);
    await core.setTheme(site.id, { colors: { primary: '#123456' } as never });
    const result = await core.publishSite(site.id);
    const css = readFileSync(join(result.distPath, 'styles.css'), 'utf8');
    expect(css).toContain('--color-primary:#123456');
  });
});

describe('preview rendering', () => {
  it('renders pages, css, and asset bytes under a base path', async () => {
    const site = await core.createSiteFromTemplate('breakthrough-medical');
    const base = `/preview/${site.id}`;
    const home = await core.renderPreviewPath(site.id, '/', base);
    expect(home?.kind).toBe('html');
    const body = (home as { body: string }).body;
    expect(body).toContain(`href="${base}/styles.css"`);
    expect(body).toContain(`${base}/assets/`);
    const css = await core.renderPreviewPath(site.id, '/styles.css', base);
    expect(css?.kind).toBe('css');

    // an asset path returns bytes
    const assets = await core.listAssets(site.id);
    const asset = await core.renderPreviewPath(site.id, `/assets/${assets[0]!.path}`, base);
    expect(asset?.kind).toBe('asset');
    expect((asset as { body: Buffer }).body.length).toBeGreaterThan(0);

    const missing = await core.renderPreviewPath(site.id, '/nope/', base);
    expect(missing).toBeNull();
  });
});

describe('assets', () => {
  it('uploads, reads, and deletes assets', async () => {
    const site = await core.createSite('Asset Site');
    const asset = await core.addAsset(site.id, 'photo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const read = await core.readAsset(site.id, asset.id);
    expect(read.buffer.toString()).toContain('<svg');
    expect(read.mime).toBe('image/svg+xml');
    await core.deleteAsset(site.id, asset.id);
    expect(await core.listAssets(site.id)).toHaveLength(0);
    await expect(core.readAsset(site.id, asset.id)).rejects.toThrow(/not found/);
  });
});
