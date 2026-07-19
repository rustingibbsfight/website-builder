import type Database from 'better-sqlite3';
import type { Asset, Page, PageMeta, Site, SiteSettings, Theme, WbNode } from '@wb/schema';

interface SiteRow {
  id: string;
  name: string;
  theme_json: string;
  header_json: string | null;
  footer_json: string | null;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

interface PageRow {
  id: string;
  site_id: string;
  slug: string;
  title: string;
  meta_json: string;
  tree_json: string;
  sort_order: number;
}

const siteFromRow = (r: SiteRow): Site => ({
  id: r.id,
  name: r.name,
  theme: JSON.parse(r.theme_json) as Theme,
  ...(r.header_json ? { header: JSON.parse(r.header_json) as WbNode } : {}),
  ...(r.footer_json ? { footer: JSON.parse(r.footer_json) as WbNode } : {}),
  settings: JSON.parse(r.settings_json) as SiteSettings,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const pageFromRow = (r: PageRow): Page => ({
  id: r.id,
  siteId: r.site_id,
  slug: r.slug,
  title: r.title,
  meta: JSON.parse(r.meta_json) as PageMeta,
  tree: JSON.parse(r.tree_json) as WbNode,
  sortOrder: r.sort_order,
});

export class SiteStore {
  constructor(private db: Database.Database) {}

  insert(site: Site): void {
    this.db
      .prepare(
        `INSERT INTO sites (id, name, theme_json, header_json, footer_json, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        site.id,
        site.name,
        JSON.stringify(site.theme),
        site.header ? JSON.stringify(site.header) : null,
        site.footer ? JSON.stringify(site.footer) : null,
        JSON.stringify(site.settings),
        site.createdAt,
        site.updatedAt,
      );
  }

  update(site: Site): void {
    this.db
      .prepare(
        `UPDATE sites SET name=?, theme_json=?, header_json=?, footer_json=?, settings_json=?, updated_at=? WHERE id=?`,
      )
      .run(
        site.name,
        JSON.stringify(site.theme),
        site.header ? JSON.stringify(site.header) : null,
        site.footer ? JSON.stringify(site.footer) : null,
        JSON.stringify(site.settings),
        site.updatedAt,
        site.id,
      );
  }

  get(id: string): Site | null {
    const row = this.db.prepare('SELECT * FROM sites WHERE id=?').get(id) as SiteRow | undefined;
    return row ? siteFromRow(row) : null;
  }

  list(): Site[] {
    const rows = this.db.prepare('SELECT * FROM sites ORDER BY created_at').all() as SiteRow[];
    return rows.map(siteFromRow);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM sites WHERE id=?').run(id).changes > 0;
  }
}

export class PageStore {
  constructor(private db: Database.Database) {}

  insert(page: Page): void {
    this.db
      .prepare(
        `INSERT INTO pages (id, site_id, slug, title, meta_json, tree_json, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        page.id,
        page.siteId,
        page.slug,
        page.title,
        JSON.stringify(page.meta),
        JSON.stringify(page.tree),
        page.sortOrder,
      );
  }

  update(page: Page): void {
    this.db
      .prepare(`UPDATE pages SET slug=?, title=?, meta_json=?, tree_json=?, sort_order=? WHERE id=?`)
      .run(page.slug, page.title, JSON.stringify(page.meta), JSON.stringify(page.tree), page.sortOrder, page.id);
  }

  get(id: string): Page | null {
    const row = this.db.prepare('SELECT * FROM pages WHERE id=?').get(id) as PageRow | undefined;
    return row ? pageFromRow(row) : null;
  }

  bySlug(siteId: string, slug: string): Page | null {
    const row = this.db.prepare('SELECT * FROM pages WHERE site_id=? AND slug=?').get(siteId, slug) as
      | PageRow
      | undefined;
    return row ? pageFromRow(row) : null;
  }

  listForSite(siteId: string): Page[] {
    const rows = this.db
      .prepare('SELECT * FROM pages WHERE site_id=? ORDER BY sort_order, slug')
      .all(siteId) as PageRow[];
    return rows.map(pageFromRow);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM pages WHERE id=?').run(id).changes > 0;
  }
}

export class AssetStore {
  constructor(private db: Database.Database) {}

  insert(asset: Asset): void {
    this.db
      .prepare(`INSERT INTO assets (id, site_id, filename, mime, width, height, path) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(asset.id, asset.siteId, asset.filename, asset.mime, asset.width ?? null, asset.height ?? null, asset.path);
  }

  get(id: string): Asset | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id) as
      | { id: string; site_id: string; filename: string; mime: string; width: number | null; height: number | null; path: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      siteId: row.site_id,
      filename: row.filename,
      mime: row.mime,
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      path: row.path,
    };
  }

  listForSite(siteId: string): Asset[] {
    const rows = this.db.prepare('SELECT * FROM assets WHERE site_id=? ORDER BY filename').all(siteId) as Array<{
      id: string;
      site_id: string;
      filename: string;
      mime: string;
      width: number | null;
      height: number | null;
      path: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      filename: row.filename,
      mime: row.mime,
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      path: row.path,
    }));
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM assets WHERE id=?').run(id).changes > 0;
  }
}

export interface BuildRecord {
  id: string;
  siteId: string;
  createdAt: string;
  manifest: { pages: string[]; files: string[]; warnings: Array<{ page: string; message: string }>; distPath: string };
}

export class BuildStore {
  constructor(private db: Database.Database) {}

  insert(build: BuildRecord): void {
    this.db
      .prepare(`INSERT INTO builds (id, site_id, created_at, manifest_json) VALUES (?, ?, ?, ?)`)
      .run(build.id, build.siteId, build.createdAt, JSON.stringify(build.manifest));
  }

  listForSite(siteId: string): BuildRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM builds WHERE site_id=? ORDER BY created_at DESC')
      .all(siteId) as Array<{ id: string; site_id: string; created_at: string; manifest_json: string }>;
    return rows.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      createdAt: r.created_at,
      manifest: JSON.parse(r.manifest_json) as BuildRecord['manifest'],
    }));
  }

  get(id: string): BuildRecord | null {
    const r = this.db.prepare('SELECT * FROM builds WHERE id=?').get(id) as
      | { id: string; site_id: string; created_at: string; manifest_json: string }
      | undefined;
    if (!r) return null;
    return { id: r.id, siteId: r.site_id, createdAt: r.created_at, manifest: JSON.parse(r.manifest_json) };
  }
}
