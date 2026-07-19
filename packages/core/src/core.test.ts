import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpsError } from '@wb/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import { NotFoundError, ValidationError } from './errors.js';

let dataDir: string;
let core: WbCore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-test-'));
  core = new WbCore({ dataDir });
});

afterEach(() => {
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('WbCore sites & pages', () => {
  it('creates a blank site with a home page', () => {
    const site = core.createSite('My Clinic');
    expect(site.theme.brandName).toBe('My Clinic');
    const pages = core.listPages(site.id);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe('');
    expect(pages[0]!.tree.type).toBe('page-root');
  });

  it('applies ops with registry validation and structured errors', () => {
    const site = core.createSite('Ops Site');
    const page = core.listPages(site.id)[0]!;
    const rootId = page.tree.id;

    const updated = core.applyPageOps(site.id, page.id, [
      { op: 'insert', parentId: rootId, node: { type: 'section', children: [
        { type: 'heading', props: { text: 'Hello', level: 1 } },
      ] } },
    ]);
    expect(updated.tree.children).toHaveLength(1);

    expect(() =>
      core.applyPageOps(site.id, page.id, [
        { op: 'insert', parentId: rootId, node: { type: 'nope', props: {} } },
      ]),
    ).toThrow(/unknown component "nope"/);

    try {
      core.applyPageOps(site.id, page.id, [
        { op: 'update', nodeId: updated.tree.children![0]!.id, props: {} },
        { op: 'remove', nodeId: 'missing123' },
      ]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpsError);
      expect((err as OpsError).opIndex).toBe(1);
    }
  });

  it('rejects invalid component props via ops', () => {
    const site = core.createSite('Val Site');
    const page = core.listPages(site.id)[0]!;
    expect(() =>
      core.applyPageOps(site.id, page.id, [
        { op: 'insert', parentId: page.tree.id, node: { type: 'button', props: { label: 'x' } } },
      ]),
    ).toThrow(/href/);
  });

  it('enforces unique slugs and slug format', () => {
    const site = core.createSite('Slugs');
    expect(() => core.addPage(site.id, '', 'Another home')).toThrow(ValidationError);
    expect(() => core.addPage(site.id, 'Bad Slug!', 'X')).toThrow(/invalid slug/);
    core.addPage(site.id, 'services', 'Services');
    expect(core.getPage(site.id, 'services').title).toBe('Services');
  });

  it('merges theme patches', () => {
    const site = core.createSite('Theme Site');
    const updated = core.setTheme(site.id, { colors: { primary: '#ff0000' } as never });
    expect(updated.theme.colors.primary).toBe('#ff0000');
    expect(updated.theme.colors.text).toBe('#1f2937'); // untouched
  });

  it('404s cleanly', () => {
    expect(() => core.getSite('nope')).toThrow(NotFoundError);
    const site = core.createSite('X');
    expect(() => core.getPage(site.id, 'nope')).toThrow(NotFoundError);
  });
});

describe('template instantiation + publish', () => {
  it('creates breakthrough-medical with 4 pages and branded assets', () => {
    const site = core.createSiteFromTemplate('breakthrough-medical');
    const pages = core.listPages(site.id);
    expect(pages.map((p) => p.slug).sort()).toEqual(['', 'about', 'contact', 'services']);
    const assets = core.listAssets(site.id);
    expect(assets.map((a) => a.filename).sort()).toEqual(['about.svg', 'hero.svg', 'logo.svg']);
    // theme logo remapped to a real asset id
    expect(site.theme.logo?.assetId).toBeTruthy();
    expect(assets.some((a) => a.id === site.theme.logo?.assetId)).toBe(true);
  });

  it('applies brand overrides', () => {
    const site = core.createSiteFromTemplate('breakthrough-medical', 'Acme Health', {
      colors: { primary: '#112233' },
    });
    expect(site.name).toBe('Acme Health');
    expect(site.theme.brandName).toBe('Acme Health');
    expect(site.theme.colors.primary).toBe('#112233');
  });

  it('publishes to dist with pages, css, assets, sitemap — and no JS', async () => {
    const site = core.createSiteFromTemplate('breakthrough-medical', undefined, {
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
    const builds = core.listBuilds(site.id);
    expect(builds).toHaveLength(1);
  });

  it('republish after set_theme changes the css', async () => {
    const site = core.createSiteFromTemplate('breakthrough-medical');
    await core.publishSite(site.id);
    core.setTheme(site.id, { colors: { primary: '#123456' } as never });
    const result = await core.publishSite(site.id);
    const css = readFileSync(join(result.distPath, 'styles.css'), 'utf8');
    expect(css).toContain('--color-primary:#123456');
  });
});

describe('preview rendering', () => {
  it('renders pages, css, and assets under a base path', () => {
    const site = core.createSiteFromTemplate('breakthrough-medical');
    const base = `/preview/${site.id}`;
    const home = core.renderPreviewPath(site.id, '/', base);
    expect(home?.kind).toBe('html');
    const body = (home as { body: string }).body;
    expect(body).toContain(`href="${base}/styles.css"`);
    expect(body).toContain(`${base}/assets/`);
    const css = core.renderPreviewPath(site.id, '/styles.css', base);
    expect(css?.kind).toBe('css');
    const missing = core.renderPreviewPath(site.id, '/nope/', base);
    expect(missing).toBeNull();
  });
});

describe('assets', () => {
  it('uploads and deletes asset files', () => {
    const site = core.createSite('Asset Site');
    const asset = core.addAsset(site.id, 'photo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(existsSync(core.assetFilePath(site.id, asset.id))).toBe(true);
    core.deleteAsset(site.id, asset.id);
    expect(core.listAssets(site.id)).toHaveLength(0);
  });
});
