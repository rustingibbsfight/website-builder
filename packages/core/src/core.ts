import { isContainer, validateNodeAgainstRegistry } from '@wb/components';
import {
  makeAssetResolver,
  pageBodyClass,
  renderCss,
  renderPage,
  renderSite,
  writeDist,
  type CssTree,
} from '@wb/renderer';
import {
  applyOps,
  materializeNode,
  newId,
  normalizeSlug,
  nowIso,
  OpsError,
  SLUG_RE,
  ThemeSchema,
  validateTreeStructure,
  walk,
  type Asset,
  type NodeInput,
  type Page,
  type PageMeta,
  type Site,
  type SiteInput,
  type SiteSettings,
  type Theme,
  type TreeOp,
  type WbNode,
} from '@wb/schema';
import { buildBreakthroughMedical, TEMPLATE_META, type BrandOverrides } from '@wb/template-breakthrough-medical';
import type Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetDir, distDir, openDb } from './db.js';
import { EDITOR_PREVIEW_JS } from './editor-script.js';
import { NotFoundError, ValidationError } from './errors.js';
import { AssetStore, BuildStore, PageStore, SiteStore, type BuildRecord } from './stores.js';

export interface TemplateInfo {
  name: string;
  title: string;
  description: string;
  pages: string[];
  brandable: string[];
}

const TEMPLATES: Record<string, { meta: TemplateInfo; build: (brand?: BrandOverrides) => SiteInput }> = {
  'breakthrough-medical': { meta: TEMPLATE_META, build: buildBreakthroughMedical },
};

export interface PublishResult {
  buildId: string;
  distPath: string;
  pageCount: number;
  files: string[];
  warnings: Array<{ page: string; message: string }>;
}

export class WbCore {
  readonly db: Database.Database;
  readonly dataDir: string;
  private sites: SiteStore;
  private pages: PageStore;
  private assets: AssetStore;
  private builds: BuildStore;

  constructor(opts: { dataDir: string }) {
    this.dataDir = opts.dataDir;
    this.db = openDb({ dataDir: opts.dataDir });
    this.sites = new SiteStore(this.db);
    this.pages = new PageStore(this.db);
    this.assets = new AssetStore(this.db);
    this.builds = new BuildStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ── Templates ────────────────────────────────────────────────────────────

  listTemplates(): TemplateInfo[] {
    return Object.values(TEMPLATES).map((t) => t.meta);
  }

  createSiteFromTemplate(template: string, name?: string, brand: BrandOverrides = {}): Site {
    const entry = TEMPLATES[template];
    if (!entry) {
      throw new ValidationError(
        `unknown template "${template}" — available: ${Object.keys(TEMPLATES).join(', ')}`,
      );
    }
    const input = entry.build({ ...brand, ...(name ? { brandName: brand.brandName ?? name } : {}) });
    return this.importSite(input, name);
  }

  /** Create a site from a full SiteInput (template output or agent bulk import). */
  importSite(input: SiteInput, nameOverride?: string): Site {
    const siteId = newId();
    const now = nowIso();

    // Remap template asset ids to globally-unique ids, rewriting references.
    const idMap = new Map<string, string>();
    const assetRecords: Asset[] = [];
    for (const asset of input.assets ?? []) {
      const newAssetId = newId();
      idMap.set(asset.id, newAssetId);
      assetRecords.push({
        id: newAssetId,
        siteId,
        filename: asset.filename,
        mime: asset.mime,
        path: asset.filename,
      });
    }
    const remap = <T>(value: T): T => remapAssetIds(value, idMap);

    const theme = ThemeSchema.parse(remap(input.theme));
    const site: Site = {
      id: siteId,
      name: nameOverride ?? input.name,
      theme,
      ...(input.header ? { header: remap(input.header) } : {}),
      ...(input.footer ? { footer: remap(input.footer) } : {}),
      settings: { locale: 'en', ...input.settings },
      createdAt: now,
      updatedAt: now,
    };
    if (site.header) this.validateTree(site.header);
    if (site.footer) this.validateTree(site.footer);

    const pages: Page[] = input.pages.map((p, i) => {
      const tree = remap(p.tree);
      this.validateTree(tree);
      return {
        id: newId(),
        siteId,
        slug: normalizeSlug(p.slug),
        title: p.title,
        meta: p.meta ?? {},
        tree,
        sortOrder: i,
      };
    });

    // Write asset files to disk.
    if (assetRecords.length > 0) {
      const dir = assetDir(this.dataDir, siteId);
      mkdirSync(dir, { recursive: true });
      (input.assets ?? []).forEach((a, i) => {
        writeFileSync(join(dir, assetRecords[i]!.path), a.content);
      });
    }

    const insertAll = this.db.transaction(() => {
      this.sites.insert(site);
      for (const page of pages) this.pages.insert(page);
      for (const asset of assetRecords) this.assets.insert(asset);
    });
    insertAll();
    return site;
  }

  // ── Sites ────────────────────────────────────────────────────────────────

  createSite(name: string, theme?: Partial<Theme>): Site {
    const now = nowIso();
    const fullTheme = ThemeSchema.parse({
      brandName: name,
      colors: {
        primary: '#2563eb',
        secondary: '#1e293b',
        accent: '#f59e0b',
        background: '#ffffff',
        surface: '#f4f6f8',
        text: '#1f2937',
        textMuted: '#6b7280',
      },
      fonts: { heading: 'sans-modern', body: 'sans-modern' },
      ...theme,
    });
    const site: Site = {
      id: newId(),
      name,
      theme: fullTheme,
      settings: { locale: 'en' },
      createdAt: now,
      updatedAt: now,
    };
    this.sites.insert(site);
    // Every site starts with an empty home page so ops have a root to target.
    this.addPage(site.id, '', 'Home');
    return site;
  }

  listSites(): Site[] {
    return this.sites.list();
  }

  getSite(siteId: string): Site {
    const site = this.sites.get(siteId);
    if (!site) throw new NotFoundError('site', siteId);
    return site;
  }

  updateSite(siteId: string, patch: { name?: string; settings?: Partial<SiteSettings> }): Site {
    const site = this.getSite(siteId);
    if (patch.name) site.name = patch.name;
    if (patch.settings) site.settings = { ...site.settings, ...patch.settings };
    site.updatedAt = nowIso();
    this.sites.update(site);
    return site;
  }

  deleteSite(siteId: string): void {
    this.getSite(siteId);
    this.sites.delete(siteId);
    rmSync(assetDir(this.dataDir, siteId), { recursive: true, force: true });
    rmSync(distDir(this.dataDir, siteId), { recursive: true, force: true });
  }

  setTheme(siteId: string, patch: Partial<Theme>, merge = true): Site {
    const site = this.getSite(siteId);
    const next = merge
      ? {
          ...site.theme,
          ...patch,
          colors: { ...site.theme.colors, ...patch.colors },
          fonts: { ...site.theme.fonts, ...patch.fonts },
        }
      : patch;
    site.theme = ThemeSchema.parse(next);
    site.updatedAt = nowIso();
    this.sites.update(site);
    return site;
  }

  setChrome(siteId: string, which: 'header' | 'footer', node: NodeInput | null): Site {
    const site = this.getSite(siteId);
    if (node === null) {
      delete site[which];
    } else {
      const tree = materializeNode(node, new Set());
      this.validateTree(tree);
      site[which] = tree;
    }
    site.updatedAt = nowIso();
    this.sites.update(site);
    return site;
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  addPage(siteId: string, slug: string, title: string, tree?: NodeInput): Page {
    this.getSite(siteId);
    const cleanSlug = normalizeSlug(slug);
    if (cleanSlug !== '' && !SLUG_RE.test(cleanSlug)) {
      throw new ValidationError(`invalid slug "${slug}" — use lowercase letters, digits, hyphens`);
    }
    if (this.pages.bySlug(siteId, cleanSlug)) {
      throw new ValidationError(`page with slug "${cleanSlug || '(home)'}" already exists`);
    }
    const fullTree = tree
      ? materializeNode(tree, new Set())
      : materializeNode({ type: 'page-root', children: [] }, new Set());
    if (fullTree.type !== 'page-root') {
      throw new ValidationError('page tree must be rooted at a page-root node');
    }
    this.validateTree(fullTree);
    const page: Page = {
      id: newId(),
      siteId,
      slug: cleanSlug,
      title,
      meta: {},
      tree: fullTree,
      sortOrder: this.pages.listForSite(siteId).length,
    };
    this.pages.insert(page);
    this.touchSite(siteId);
    return page;
  }

  listPages(siteId: string): Page[] {
    this.getSite(siteId);
    return this.pages.listForSite(siteId);
  }

  getPage(siteId: string, pageIdOrSlug: string): Page {
    const byId = this.pages.get(pageIdOrSlug);
    if (byId && byId.siteId === siteId) return byId;
    const bySlug = this.pages.bySlug(siteId, normalizeSlug(pageIdOrSlug));
    if (bySlug) return bySlug;
    throw new NotFoundError('page', pageIdOrSlug);
  }

  updatePageMeta(
    siteId: string,
    pageIdOrSlug: string,
    patch: { slug?: string; title?: string; meta?: Partial<PageMeta>; sortOrder?: number },
  ): Page {
    const page = this.getPage(siteId, pageIdOrSlug);
    if (patch.slug !== undefined) {
      const cleanSlug = normalizeSlug(patch.slug);
      if (cleanSlug !== '' && !SLUG_RE.test(cleanSlug)) {
        throw new ValidationError(`invalid slug "${patch.slug}"`);
      }
      const existing = this.pages.bySlug(siteId, cleanSlug);
      if (existing && existing.id !== page.id) {
        throw new ValidationError(`page with slug "${cleanSlug || '(home)'}" already exists`);
      }
      page.slug = cleanSlug;
    }
    if (patch.title !== undefined) page.title = patch.title;
    if (patch.meta) page.meta = { ...page.meta, ...patch.meta };
    if (patch.sortOrder !== undefined) page.sortOrder = patch.sortOrder;
    this.pages.update(page);
    this.touchSite(siteId);
    return page;
  }

  deletePage(siteId: string, pageIdOrSlug: string): void {
    const page = this.getPage(siteId, pageIdOrSlug);
    this.pages.delete(page.id);
    this.touchSite(siteId);
  }

  getTree(siteId: string, pageIdOrSlug: string): WbNode {
    return this.getPage(siteId, pageIdOrSlug).tree;
  }

  setTree(siteId: string, pageIdOrSlug: string, tree: NodeInput): Page {
    const page = this.getPage(siteId, pageIdOrSlug);
    const materialized = materializeNode(tree, new Set());
    if (materialized.type !== 'page-root') {
      throw new ValidationError('page tree must be rooted at a page-root node');
    }
    this.validateTree(materialized);
    page.tree = materialized;
    this.pages.update(page);
    this.touchSite(siteId);
    return page;
  }

  /** Apply a batch of tree ops atomically. Throws OpsError with the failing op index. */
  applyPageOps(siteId: string, pageIdOrSlug: string, ops: TreeOp[]): Page {
    const page = this.getPage(siteId, pageIdOrSlug);
    page.tree = applyOps(page.tree, ops, {
      validateNode: validateNodeAgainstRegistry,
      isContainer,
    });
    this.pages.update(page);
    this.touchSite(siteId);
    return page;
  }

  // ── Assets ───────────────────────────────────────────────────────────────

  addAsset(siteId: string, filename: string, mime: string, content: Uint8Array | string): Asset {
    this.getSite(siteId);
    const safeName = filename.replace(/[^\w.-]/g, '_');
    const id = newId();
    const path = `${id}-${safeName}`;
    const dir = assetDir(this.dataDir, siteId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, path), content);
    const asset: Asset = { id, siteId, filename: safeName, mime, path };
    this.assets.insert(asset);
    this.touchSite(siteId);
    return asset;
  }

  listAssets(siteId: string): Asset[] {
    this.getSite(siteId);
    return this.assets.listForSite(siteId);
  }

  getAsset(siteId: string, assetId: string): Asset {
    const asset = this.assets.get(assetId);
    if (!asset || asset.siteId !== siteId) throw new NotFoundError('asset', assetId);
    return asset;
  }

  assetFilePath(siteId: string, assetId: string): string {
    const asset = this.getAsset(siteId, assetId);
    return join(assetDir(this.dataDir, siteId), asset.path);
  }

  deleteAsset(siteId: string, assetId: string): void {
    const asset = this.getAsset(siteId, assetId);
    this.assets.delete(assetId);
    rmSync(join(assetDir(this.dataDir, siteId), asset.path), { force: true });
  }

  // ── Publish ──────────────────────────────────────────────────────────────

  publishSite(siteId: string, outDir?: string): Promise<PublishResult> {
    return this.publishSiteTo(siteId, outDir ?? distDir(this.dataDir, siteId));
  }

  private async publishSiteTo(siteId: string, out: string): Promise<PublishResult> {
    const site = this.getSite(siteId);
    const pages = this.pages.listForSite(siteId);
    if (pages.length === 0) throw new ValidationError('site has no pages to publish');
    const assets = this.assets.listForSite(siteId);

    const { files, warnings } = renderSite(site, pages, assets);
    rmSync(out, { recursive: true, force: true });
    const written = await writeDist(files, out);

    const srcAssets = assetDir(this.dataDir, siteId);
    if (existsSync(srcAssets) && assets.length > 0) {
      mkdirSync(join(out, 'assets'), { recursive: true });
      for (const asset of assets) {
        copyFileSync(join(srcAssets, asset.path), join(out, 'assets', asset.path));
        written.push(`assets/${asset.path}`);
      }
    }

    const build: BuildRecord = {
      id: newId(),
      siteId,
      createdAt: nowIso(),
      manifest: { pages: pages.map((p) => p.slug || '(home)'), files: written, warnings, distPath: out },
    };
    this.builds.insert(build);
    return { buildId: build.id, distPath: out, pageCount: pages.length, files: written, warnings };
  }

  listBuilds(siteId: string): BuildRecord[] {
    this.getSite(siteId);
    return this.builds.listForSite(siteId);
  }

  // ── Preview ──────────────────────────────────────────────────────────────

  /**
   * Render a draft page (or the stylesheet) for the live preview.
   * `basePath` (e.g. /preview/<siteId>) prefixes styles/assets/internal links.
   * With `editor: true`, injects the visual-editor bridge script instead of
   * the preview nav script (never part of published output).
   */
  renderPreviewPath(
    siteId: string,
    urlPath: string,
    basePath: string,
    opts: { editor?: boolean } = {},
  ): { kind: 'html' | 'css'; body: string } | { kind: 'asset'; filePath: string; mime: string } | null {
    const site = this.getSite(siteId);
    const pages = this.pages.listForSite(siteId);
    const assets = this.assets.listForSite(siteId);
    const clean = urlPath.replace(/^\/+|\/+$/g, '');

    if (clean === 'styles.css') {
      const trees: CssTree[] = [];
      if (site.header) trees.push({ root: site.header, scope: '' });
      if (site.footer) trees.push({ root: site.footer, scope: '' });
      for (const page of pages) trees.push({ root: page.tree, scope: `.${pageBodyClass(page.slug)} ` });
      const resolveAsset = this.previewAssetResolver(assets, basePath);
      return { kind: 'css', body: renderCss(site, trees, resolveAsset) };
    }

    if (clean.startsWith('assets/')) {
      const rel = clean.slice('assets/'.length);
      const asset = assets.find((a) => a.path === rel);
      if (!asset) return null;
      return { kind: 'asset', filePath: join(assetDir(this.dataDir, siteId), asset.path), mime: asset.mime };
    }

    const page = pages.find((p) => normalizeSlug(p.slug) === clean);
    if (!page) return null;
    const resolveAsset = this.previewAssetResolver(assets, basePath);
    const bodyExtra = opts.editor
      ? `<script>${EDITOR_PREVIEW_JS}</script>`
      : previewNavScript(basePath);
    const html = renderPage(site, page, { resolveAsset, bodyExtra }).replace(
      'href="/styles.css"',
      `href="${basePath}/styles.css"`,
    );
    return { kind: 'html', body: html };
  }

  private previewAssetResolver(assets: Asset[], basePath: string) {
    const inner = makeAssetResolver(assets);
    return (ref: Parameters<ReturnType<typeof makeAssetResolver>>[0]) => {
      const url = inner(ref);
      return url.startsWith('/assets/') ? `${basePath}${url}` : url;
    };
  }

  // ── Validation ───────────────────────────────────────────────────────────

  private validateTree(tree: WbNode): void {
    const problems = validateTreeStructure(tree);
    if (problems.length > 0) {
      throw new ValidationError(`invalid tree: ${problems.map((p) => p.message).join('; ')}`, problems);
    }
    walk(tree, (node) => validateNodeAgainstRegistry(node));
  }

  private touchSite(siteId: string): void {
    const site = this.sites.get(siteId);
    if (site) {
      site.updatedAt = nowIso();
      this.sites.update(site);
    }
  }
}

/** Rewrite links in preview so navigation stays inside the preview prefix. Never published. */
function previewNavScript(basePath: string): string {
  return `<script>document.addEventListener('click',function(e){var a=e.target.closest('a[href^="/"]');if(!a)return;var p=a.getAttribute('href');if(p.indexOf(${JSON.stringify(basePath)})===0)return;e.preventDefault();location.href=${JSON.stringify(basePath)}+(p==='/'?'/':p)});</script>`;
}

function remapAssetIds<T>(value: T, idMap: Map<string, string>): T {
  if (idMap.size === 0) return structuredClone(value);
  const rec = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rec);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === 'assetId' && typeof val === 'string' && idMap.has(val)) out[k] = idMap.get(val);
        else out[k] = rec(val);
      }
      return out;
    }
    return v;
  };
  return rec(structuredClone(value)) as T;
}
