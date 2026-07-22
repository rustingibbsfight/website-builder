import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpsError } from '@wb/schema';
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
