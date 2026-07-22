import { isContainer, validateNodeAgainstRegistry } from '@wb/components';
import {
  type Block,
  type BlockSummary,
  getBlock as getBlockDef,
  listBlocks as listBlockDefs,
} from './blocks.js';
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
import { STARTER_TEMPLATES } from './starter-templates.js';
import type { Client } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { assetDir, distDir, openDb } from './db.js';
import { EDITOR_PREVIEW_JS } from './editor-script.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { createPublishTarget, type PublishTarget } from './publish-target.js';
import { createAssetStorage, type AssetStorage } from './storage.js';
import { createVersionControl, type VersionControl, type VersionControlResult } from './version-control.js';
import { AssetStore, BuildStore, PageStore, SiteStore, SubmissionStore, type BuildRecord, type SubmissionRecord } from './stores.js';

/** Symbol ids referenced (directly) by a subtree's symbolInstance nodes. */
function collectSymbolRefs(node: WbNode, out: Set<string>): void {
  if (node.type === 'symbolInstance') {
    const s = (node.props as { symbolId?: unknown }).symbolId;
    if (typeof s === 'string' && s) out.add(s);
  }
  for (const child of node.children ?? []) collectSymbolRefs(child, out);
}

/** All symbol ids transitively reachable from symbols[startId]. If it contains
 *  startId, the definition references itself (a cycle). */
function symbolReferences(symbols: Record<string, WbNode>, startId: string): Set<string> {
  const reachable = new Set<string>();
  const stack: string[] = [];
  const seed = symbols[startId];
  if (seed) {
    const r = new Set<string>();
    collectSymbolRefs(seed, r);
    r.forEach((x) => stack.push(x));
  }
  while (stack.length) {
    const s = stack.pop()!;
    if (reachable.has(s)) continue;
    reachable.add(s);
    const def = symbols[s];
    if (def) {
      const r = new Set<string>();
      collectSymbolRefs(def, r);
      r.forEach((x) => stack.push(x));
    }
  }
  return reachable;
}

export interface TemplateInfo {
  name: string;
  title: string;
  description: string;
  pages: string[];
  brandable: string[];
}

const TEMPLATES: Record<string, { meta: TemplateInfo; build: (brand?: BrandOverrides) => SiteInput }> = {
  'breakthrough-medical': { meta: TEMPLATE_META, build: buildBreakthroughMedical },
  ...STARTER_TEMPLATES,
};

export interface PublishResult {
  buildId: string;
  distPath: string;
  pageCount: number;
  files: string[];
  warnings: Array<{ page: string; message: string }>;
}

export interface WbCoreOptions {
  /** Local data directory (SQLite file + dist output when not using remote stores). */
  dataDir: string;
  /** Remote libSQL/Turso URL. Defaults to a local file under dataDir. */
  dbUrl?: string;
  dbToken?: string;
  /** Asset storage. Defaults to env selection (local fs, or S3/R2 via WB_ASSET_STORE=s3). */
  assetStorage?: AssetStorage;
  /** API-based live-deploy destination. Defaults to env selection (WB_PUBLISH_TARGET). */
  publishTarget?: PublishTarget | null;
  /** Version control for published sites. Defaults to env selection (WB_VCS). */
  versionControl?: VersionControl | null;
}

export interface DeploySiteResult {
  buildId: string;
  target: string;
  url: string;
  detail?: string;
  pageCount: number;
  warnings: Array<{ page: string; message: string }>;
  /** Set when version control committed this deploy. */
  versionControl?: VersionControlResult;
  /** Set when version control was configured but the commit failed (non-fatal). */
  versionControlError?: string;
}

export class WbCore {
  readonly dataDir: string;
  private sites: SiteStore;
  private pages: PageStore;
  private assets: AssetStore;
  private builds: BuildStore;
  private submissions: SubmissionStore;

  private constructor(
    private db: Client,
    private storage: AssetStorage,
    private publishTarget: PublishTarget | null,
    private versionControl: VersionControl | null,
    dataDir: string,
  ) {
    this.dataDir = dataDir;
    this.sites = new SiteStore(db);
    this.pages = new PageStore(db);
    this.assets = new AssetStore(db);
    this.builds = new BuildStore(db);
    this.submissions = new SubmissionStore(db);
  }

  /** Open the database (local file or remote Turso), run migrations, wire storage. */
  static async create(opts: WbCoreOptions): Promise<WbCore> {
    const db = await openDb({ dataDir: opts.dataDir, dbUrl: opts.dbUrl, dbToken: opts.dbToken });
    const storage = opts.assetStorage ?? createAssetStorage(opts.dataDir);
    const publishTarget = opts.publishTarget !== undefined ? opts.publishTarget : createPublishTarget();
    const versionControl = opts.versionControl !== undefined ? opts.versionControl : createVersionControl();
    return new WbCore(db, storage, publishTarget, versionControl, opts.dataDir);
  }

  hasPublishTarget(): boolean {
    return this.publishTarget !== null;
  }

  hasVersionControl(): boolean {
    return this.versionControl !== null;
  }

  close(): void {
    this.db.close();
  }

  // ── Templates ────────────────────────────────────────────────────────────

  listTemplates(): TemplateInfo[] {
    return Object.values(TEMPLATES).map((t) => t.meta);
  }

  // ── Blocks (pre-composed section subtrees) ─────────────────────────────────

  listBlocks(): BlockSummary[] {
    return listBlockDefs();
  }

  getBlock(id: string): Block {
    return getBlockDef(id);
  }

  /** Insert a pre-composed block subtree into a page (validated like any op). */
  async insertBlock(
    siteId: string,
    pageIdOrSlug: string,
    blockId: string,
    parentId: string,
    index?: number,
  ): Promise<Page> {
    const block = getBlockDef(blockId);
    return this.applyPageOps(siteId, pageIdOrSlug, [
      { op: 'insert', parentId, ...(index !== undefined ? { index } : {}), node: block.node },
    ]);
  }

  createSiteFromTemplate(template: string, name?: string, brand: BrandOverrides = {}): Promise<Site> {
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
  async importSite(input: SiteInput, nameOverride?: string): Promise<Site> {
    const siteId = newId();
    const now = nowIso();

    // Remap template asset ids to globally-unique ids, rewriting references.
    const idMap = new Map<string, string>();
    const assetRecords: Asset[] = [];
    for (const asset of input.assets ?? []) {
      const newAssetId = newId();
      idMap.set(asset.id, newAssetId);
      const safeName = sanitizeFilename(asset.filename);
      assetRecords.push({
        id: newAssetId,
        siteId,
        filename: safeName,
        mime: asset.mime,
        path: `${newAssetId}-${safeName}`,
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

    const seenSlugs = new Set<string>();
    const pages: Page[] = input.pages.map((p, i) => {
      const tree = remap(p.tree);
      this.validateTree(tree);
      // Validate slugs here too — importSite is a public bulk-import entry point,
      // and an unchecked slug like "../../etc" would escape the dist directory
      // at publish time (pagePath → writeDist). Mirror addPage's rule.
      const slug = normalizeSlug(p.slug);
      if (slug !== '' && !SLUG_RE.test(slug)) {
        throw new ValidationError(`invalid slug "${p.slug}" — use lowercase letters, digits, hyphens`);
      }
      if (seenSlugs.has(slug)) throw new ValidationError(`duplicate slug "${slug || '(home)'}" in import`);
      seenSlugs.add(slug);
      return {
        id: newId(),
        siteId,
        slug,
        title: p.title,
        meta: p.meta ?? {},
        tree,
        sortOrder: i,
        version: 0,
      };
    });

    // Everything is validated before any write. Write asset blobs first, then
    // commit all DB rows in one transactional batch. If anything fails, delete
    // the blobs we wrote so a failed import never leaves orphaned storage or a
    // half-built site.
    const inputAssets = input.assets ?? [];
    const writtenPaths: string[] = [];
    try {
      for (let i = 0; i < assetRecords.length; i++) {
        await this.storage.put(siteId, assetRecords[i]!.path, inputAssets[i]!.content, assetRecords[i]!.mime);
        writtenPaths.push(assetRecords[i]!.path);
      }
      await this.db.batch(
        [
          this.sites.insertStatement(site),
          ...pages.map((p) => this.pages.insertStatement(p)),
          ...assetRecords.map((a) => this.assets.insertStatement(a)),
        ],
        'write',
      );
    } catch (err) {
      await Promise.allSettled(writtenPaths.map((p) => this.storage.delete(siteId, p)));
      throw err;
    }
    return site;
  }

  // ── Sites ────────────────────────────────────────────────────────────────

  async createSite(name: string, theme?: Partial<Theme>): Promise<Site> {
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
    await this.sites.insert(site);
    // Every site starts with an empty home page so ops have a root to target.
    await this.addPage(site.id, '', 'Home');
    return site;
  }

  listSites(): Promise<Site[]> {
    return this.sites.list();
  }

  async getSite(siteId: string): Promise<Site> {
    const site = await this.sites.get(siteId);
    if (!site) throw new NotFoundError('site', siteId);
    return site;
  }

  async updateSite(siteId: string, patch: { name?: string; settings?: Partial<SiteSettings> }): Promise<Site> {
    const site = await this.getSite(siteId);
    const fields: { name?: string; settings?: SiteSettings } = {};
    if (patch.name) {
      site.name = patch.name;
      fields.name = patch.name;
    }
    if (patch.settings) {
      site.settings = { ...site.settings, ...patch.settings };
      fields.settings = site.settings;
    }
    site.updatedAt = nowIso();
    // Write only name/settings — never the theme/header/footer columns a
    // concurrent edit may be changing.
    await this.sites.updateFields(siteId, fields, site.updatedAt);
    return site;
  }

  async deleteSite(siteId: string): Promise<void> {
    await this.getSite(siteId);
    // Explicit child cleanup so correctness never depends on FK cascade being
    // active (remote libSQL backends may not honor connection pragmas).
    for (const asset of await this.assets.listForSite(siteId)) await this.assets.delete(asset.id);
    for (const page of await this.pages.listForSite(siteId)) await this.pages.delete(page.id);
    await this.builds.deleteForSite(siteId);
    await this.submissions.deleteForSite(siteId);
    await this.sites.delete(siteId);
    await this.storage.deleteSite(siteId);
    rmSync(distDir(this.dataDir, siteId), { recursive: true, force: true });
  }

  // ── Form submissions (see #27) ─────────────────────────────────────────────
  /** Store a captured form submission. Field validation happens at the edge. */
  async createSubmission(siteId: string, formId: string, data: Record<string, string>): Promise<SubmissionRecord> {
    await this.getSite(siteId); // 404 if the site is gone
    const rec: SubmissionRecord = { id: newId(), siteId, formId, data, createdAt: nowIso() };
    await this.submissions.insert(rec);
    return rec;
  }

  /** List captured submissions for a site, newest first (optionally one form). */
  async listSubmissions(siteId: string, formId?: string): Promise<SubmissionRecord[]> {
    await this.getSite(siteId);
    return this.submissions.listForSite(siteId, formId);
  }

  // ── Reusable symbols (#26) ─────────────────────────────────────────────────
  async listSymbols(siteId: string): Promise<Array<{ id: string; rootType: string }>> {
    const site = await this.getSite(siteId);
    return Object.entries(site.symbols ?? {}).map(([id, node]) => ({ id, rootType: node.type }));
  }

  async getSymbol(siteId: string, symbolId: string): Promise<WbNode> {
    const site = await this.getSite(siteId);
    const node = site.symbols?.[symbolId];
    if (!node) throw new NotFoundError('symbol', symbolId);
    return node;
  }

  /** Define or replace a symbol. Validates the subtree and rejects cycles. */
  async setSymbol(siteId: string, symbolId: string, input: NodeInput): Promise<WbNode> {
    if (!/^[a-zA-Z0-9][\w-]{0,63}$/.test(symbolId)) {
      throw new ValidationError(`invalid symbol id "${symbolId}" — use letters, digits, hyphens, underscores`);
    }
    const site = await this.getSite(siteId);
    const node = materializeNode(input, new Set());
    if (node.type === 'page-root') {
      throw new ValidationError('a symbol cannot be a page-root — use a section or component as its root');
    }
    this.validateTree(node);
    const symbols = { ...(site.symbols ?? {}), [symbolId]: node };
    if (symbolReferences(symbols, symbolId).has(symbolId)) {
      throw new ValidationError(`symbol "${symbolId}" would reference itself (cycle)`);
    }
    await this.sites.updateFields(siteId, { symbols }, nowIso());
    return node;
  }

  async deleteSymbol(siteId: string, symbolId: string): Promise<void> {
    const site = await this.getSite(siteId);
    if (!site.symbols?.[symbolId]) throw new NotFoundError('symbol', symbolId);
    const symbols = { ...site.symbols };
    delete symbols[symbolId];
    await this.sites.updateFields(
      siteId,
      { symbols: Object.keys(symbols).length ? symbols : null },
      nowIso(),
    );
  }

  async setTheme(siteId: string, patch: Partial<Theme>, merge = true): Promise<Site> {
    const site = await this.getSite(siteId);
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
    // Scoped to theme_json only — a concurrent header/footer/name edit survives.
    await this.sites.updateFields(siteId, { theme: site.theme }, site.updatedAt);
    return site;
  }

  async setChrome(siteId: string, which: 'header' | 'footer', node: NodeInput | null): Promise<Site> {
    const site = await this.getSite(siteId);
    let value: WbNode | null;
    if (node === null) {
      delete site[which];
      value = null;
    } else {
      const tree = materializeNode(node, new Set());
      this.validateTree(tree);
      site[which] = tree;
      value = tree;
    }
    site.updatedAt = nowIso();
    // Scoped to just the one chrome column being changed.
    await this.sites.updateFields(siteId, { [which]: value }, site.updatedAt);
    return site;
  }

  // ── Pages ────────────────────────────────────────────────────────────────

  async addPage(siteId: string, slug: string, title: string, tree?: NodeInput): Promise<Page> {
    await this.getSite(siteId);
    const cleanSlug = normalizeSlug(slug);
    if (cleanSlug !== '' && !SLUG_RE.test(cleanSlug)) {
      throw new ValidationError(`invalid slug "${slug}" — use lowercase letters, digits, hyphens`);
    }
    if (await this.pages.bySlug(siteId, cleanSlug)) {
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
      sortOrder: await this.pages.nextSortOrder(siteId),
      version: 0,
    };
    try {
      await this.pages.insert(page);
    } catch (err) {
      // A concurrent add of the same slug loses the UNIQUE(site_id, slug) race —
      // surface it as a clean validation error, not a raw DB failure.
      if (/UNIQUE|constraint/i.test(err instanceof Error ? err.message : String(err))) {
        throw new ValidationError(`page with slug "${cleanSlug || '(home)'}" already exists`);
      }
      throw err;
    }
    await this.touchSite(siteId);
    return page;
  }

  async listPages(siteId: string): Promise<Page[]> {
    await this.getSite(siteId);
    return this.pages.listForSite(siteId);
  }

  async getPage(siteId: string, pageIdOrSlug: string): Promise<Page> {
    const byId = await this.pages.get(pageIdOrSlug);
    if (byId && byId.siteId === siteId) return byId;
    const bySlug = await this.pages.bySlug(siteId, normalizeSlug(pageIdOrSlug));
    if (bySlug) return bySlug;
    throw new NotFoundError('page', pageIdOrSlug);
  }

  async updatePageMeta(
    siteId: string,
    pageIdOrSlug: string,
    patch: { slug?: string; title?: string; meta?: Partial<PageMeta>; sortOrder?: number },
  ): Promise<Page> {
    const page = await this.getPage(siteId, pageIdOrSlug);
    if (patch.slug !== undefined) {
      const cleanSlug = normalizeSlug(patch.slug);
      if (cleanSlug !== '' && !SLUG_RE.test(cleanSlug)) {
        throw new ValidationError(`invalid slug "${patch.slug}"`);
      }
      const existing = await this.pages.bySlug(siteId, cleanSlug);
      if (existing && existing.id !== page.id) {
        throw new ValidationError(`page with slug "${cleanSlug || '(home)'}" already exists`);
      }
      page.slug = cleanSlug;
    }
    if (patch.title !== undefined) page.title = patch.title;
    if (patch.meta) page.meta = { ...page.meta, ...patch.meta };
    if (patch.sortOrder !== undefined) page.sortOrder = patch.sortOrder;
    await this.savePage(page);
    await this.touchSite(siteId);
    return page;
  }

  /** Persist a page with optimistic locking; throws ConflictError on a lost race. */
  private async savePage(page: Page): Promise<void> {
    if (!(await this.pages.update(page))) {
      throw new ConflictError(
        `page "${page.id}" was modified concurrently — reload and reapply your change`,
      );
    }
  }

  async deletePage(siteId: string, pageIdOrSlug: string): Promise<void> {
    const page = await this.getPage(siteId, pageIdOrSlug);
    await this.pages.delete(page.id);
    await this.touchSite(siteId);
  }

  async getTree(siteId: string, pageIdOrSlug: string): Promise<WbNode> {
    return (await this.getPage(siteId, pageIdOrSlug)).tree;
  }

  async setTree(siteId: string, pageIdOrSlug: string, tree: NodeInput): Promise<Page> {
    const page = await this.getPage(siteId, pageIdOrSlug);
    const materialized = materializeNode(tree, new Set());
    if (materialized.type !== 'page-root') {
      throw new ValidationError('page tree must be rooted at a page-root node');
    }
    this.validateTree(materialized);
    page.tree = materialized;
    await this.savePage(page);
    await this.touchSite(siteId);
    return page;
  }

  /** Apply a batch of tree ops atomically. Throws OpsError with the failing op index. */
  async applyPageOps(siteId: string, pageIdOrSlug: string, ops: TreeOp[]): Promise<Page> {
    const page = await this.getPage(siteId, pageIdOrSlug);
    page.tree = applyOps(page.tree, ops, {
      validateNode: validateNodeAgainstRegistry,
      isContainer,
    });
    await this.savePage(page);
    await this.touchSite(siteId);
    return page;
  }

  // ── Assets ───────────────────────────────────────────────────────────────

  async addAsset(siteId: string, filename: string, mime: string, content: Uint8Array | string): Promise<Asset> {
    await this.getSite(siteId);
    const safeName = sanitizeFilename(filename);
    const id = newId();
    const path = `${id}-${safeName}`;
    await this.storage.put(siteId, path, content, mime);
    const asset: Asset = { id, siteId, filename: safeName, mime, path };
    await this.assets.insert(asset);
    await this.touchSite(siteId);
    return asset;
  }

  async listAssets(siteId: string): Promise<Asset[]> {
    await this.getSite(siteId);
    return this.assets.listForSite(siteId);
  }

  async getAsset(siteId: string, assetId: string): Promise<Asset> {
    const asset = await this.assets.get(assetId);
    if (!asset || asset.siteId !== siteId) throw new NotFoundError('asset', assetId);
    return asset;
  }

  /** Read an asset's bytes (from local fs or R2/S3, wherever it lives). */
  async readAsset(siteId: string, assetId: string): Promise<{ buffer: Buffer; mime: string; filename: string }> {
    const asset = await this.getAsset(siteId, assetId);
    const buffer = await this.storage.get(siteId, asset.path);
    return { buffer, mime: asset.mime, filename: asset.filename };
  }

  async deleteAsset(siteId: string, assetId: string): Promise<void> {
    const asset = await this.getAsset(siteId, assetId);
    await this.assets.delete(assetId);
    await this.storage.delete(siteId, asset.path);
  }

  // ── Publish ──────────────────────────────────────────────────────────────

  publishSite(siteId: string, outDir?: string): Promise<PublishResult> {
    return this.publishSiteTo(siteId, outDir ?? distDir(this.dataDir, siteId));
  }

  /**
   * Render the complete deployable site fully in memory: pages/css/meta from
   * the renderer plus asset bytes from storage. No filesystem involved —
   * callers write to disk (publish) or push to a live target (deploy).
   */
  private async renderFullSite(siteId: string): Promise<{
    pages: Page[];
    files: Map<string, string | Uint8Array>;
    warnings: Array<{ page: string; message: string }>;
  }> {
    const site = await this.getSite(siteId);
    const pages = await this.pages.listForSite(siteId);
    if (pages.length === 0) throw new ValidationError('site has no pages to publish');
    const assets = await this.assets.listForSite(siteId);

    const { files, warnings } = renderSite(site, pages, assets);
    const all = new Map<string, string | Uint8Array>(files);
    for (const asset of assets) {
      all.set(`assets/${asset.path}`, await this.storage.get(siteId, asset.path));
    }
    return { pages, files: all, warnings };
  }

  private async publishSiteTo(siteId: string, out: string): Promise<PublishResult> {
    const { pages, files, warnings } = await this.renderFullSite(siteId);
    rmSync(out, { recursive: true, force: true });
    const written = await writeDist(files, out);

    const build: BuildRecord = {
      id: newId(),
      siteId,
      createdAt: nowIso(),
      manifest: { pages: pages.map((p) => p.slug || '(home)'), files: written, warnings, distPath: out },
    };
    await this.builds.insert(build);
    return { buildId: build.id, distPath: out, pageCount: pages.length, files: written, warnings };
  }

  /** Full, restorable source export of a site: site record + all pages. */
  async exportSite(siteId: string): Promise<{ site: Site; pages: Page[] }> {
    const site = await this.getSite(siteId);
    const pages = await this.pages.listForSite(siteId);
    return { site, pages };
  }

  /**
   * Commit a site's source + rendered build to version control (a per-site
   * GitHub repo). Republishes stack up as commit history. Returns the repo and
   * commit info.
   */
  async commitSiteToVcs(siteId: string, message?: string): Promise<VersionControlResult> {
    if (!this.versionControl) {
      throw new ValidationError(
        'no version control configured — set WB_VCS=github (with WB_GITHUB_TOKEN and WB_GITHUB_OWNER)',
      );
    }
    const site = await this.getSite(siteId);
    const { pages, files } = await this.renderFullSite(siteId);
    return this.versionControl.commitSite({
      siteId,
      siteName: site.name,
      source: { site, pages },
      files,
      message: message ?? `Publish ${site.name} — ${nowIso()}`,
    });
  }

  /**
   * Render in memory and push straight to the configured live target
   * (Vercel API / R2). The fully-serverless deploy path: no CLI, no disk.
   * When version control is configured, also commits the source + build to the
   * site's repo (non-fatal if that fails — the live deploy still succeeds).
   */
  async deploySite(siteId: string): Promise<DeploySiteResult> {
    if (!this.publishTarget) {
      throw new ValidationError(
        'no publish target configured — set WB_PUBLISH_TARGET=vercel (with WB_VERCEL_TOKEN) or =r2 (with WB_PUBLISH_S3_BUCKET), or use the CLI deploy adapters',
      );
    }
    const site = await this.getSite(siteId);
    const { pages, files, warnings } = await this.renderFullSite(siteId);
    const result = await this.publishTarget.deploy({ siteId, siteName: site.name, files });

    // Version control: commit this published snapshot. Best-effort — a VCS
    // hiccup must not fail a successful live deploy.
    let vcs: VersionControlResult | undefined;
    let vcsError: string | undefined;
    if (this.versionControl) {
      try {
        vcs = await this.versionControl.commitSite({
          siteId,
          siteName: site.name,
          source: { site, pages },
          files,
          message: `Deploy ${site.name} → ${result.url} — ${nowIso()}`,
        });
      } catch (err) {
        vcsError = err instanceof Error ? err.message : String(err);
      }
    }

    const build: BuildRecord = {
      id: newId(),
      siteId,
      createdAt: nowIso(),
      manifest: {
        pages: pages.map((p) => p.slug || '(home)'),
        files: [...files.keys()],
        warnings,
        distPath: result.url,
      },
    };
    await this.builds.insert(build);
    return {
      buildId: build.id,
      target: this.publishTarget.name,
      url: result.url,
      ...(result.detail ? { detail: result.detail } : {}),
      pageCount: pages.length,
      warnings,
      ...(vcs ? { versionControl: vcs } : {}),
      ...(vcsError ? { versionControlError: vcsError } : {}),
    };
  }

  async listBuilds(siteId: string): Promise<BuildRecord[]> {
    await this.getSite(siteId);
    return this.builds.listForSite(siteId);
  }

  // ── Preview ──────────────────────────────────────────────────────────────

  /**
   * Render a draft page (or the stylesheet), or return an asset's bytes, for
   * the live preview. `basePath` (e.g. /preview/<siteId>) prefixes
   * styles/assets/internal links. With `editor: true`, injects the visual-editor
   * bridge script instead of the preview nav script (never in published output).
   */
  async renderPreviewPath(
    siteId: string,
    urlPath: string,
    basePath: string,
    opts: { editor?: boolean } = {},
  ): Promise<
    | { kind: 'html'; body: string; nonce: string }
    | { kind: 'css'; body: string }
    | { kind: 'asset'; body: Buffer; mime: string }
    | null
  > {
    const site = await this.getSite(siteId);
    const pages = await this.pages.listForSite(siteId);
    const assets = await this.assets.listForSite(siteId);
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
      const buffer = await this.storage.get(siteId, asset.path);
      return { kind: 'asset', body: buffer, mime: asset.mime };
    }

    const page = pages.find((p) => normalizeSlug(p.slug) === clean);
    if (!page) return null;
    const resolveAsset = this.previewAssetResolver(assets, basePath);
    // Per-response nonce so ONLY our trusted inline scripts (editor bridge / nav
    // shim / video facade) run under the preview's strict CSP — an htmlEmbed's
    // injected <script> never carries it and is blocked. The nonce is returned
    // so the HTTP layer can set the matching script-src.
    const nonce = randomBytes(16).toString('base64');
    const bodyExtra = opts.editor
      ? `<script nonce="${nonce}">${EDITOR_PREVIEW_JS}</script>`
      : previewNavScript(basePath, nonce);
    const html = renderPage(site, page, { resolveAsset, bodyExtra, nonce }).replace(
      'href="/styles.css"',
      `href="${basePath}/styles.css"`,
    );
    return { kind: 'html', body: html, nonce };
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

  private async touchSite(siteId: string): Promise<void> {
    // Scoped updated_at bump — a full-row rewrite here would clobber a
    // concurrent theme/header/footer/settings edit.
    await this.sites.touch(siteId, nowIso());
  }
}

/** Rewrite links in preview so navigation stays inside the preview prefix. Never published. */
function previewNavScript(basePath: string, nonce: string): string {
  return `<script nonce="${nonce}">document.addEventListener('click',function(e){var a=e.target.closest('a[href^="/"]');if(!a)return;var p=a.getAttribute('href');if(p.indexOf(${JSON.stringify(basePath)})===0)return;e.preventDefault();location.href=${JSON.stringify(basePath)}+(p==='/'?'/':p)});</script>`;
}

/** Reduce a filename to a safe basename: word chars/dot/hyphen only, no dot-segments. */
function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[^\w.-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '');
  return cleaned || 'asset';
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
