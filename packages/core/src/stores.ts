import type { Client, InStatement, Row } from '@libsql/client';
import type { Asset, Page, PageMeta, Site, SiteSettings, Theme, WbNode } from '@wb/schema';

const str = (v: unknown): string => String(v);
const numOrNull = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

const siteFromRow = (r: Row): Site => ({
  id: str(r.id),
  name: str(r.name),
  theme: JSON.parse(str(r.theme_json)) as Theme,
  ...(r.header_json ? { header: JSON.parse(str(r.header_json)) as WbNode } : {}),
  ...(r.footer_json ? { footer: JSON.parse(str(r.footer_json)) as WbNode } : {}),
  settings: JSON.parse(str(r.settings_json)) as SiteSettings,
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

const pageFromRow = (r: Row): Page => ({
  id: str(r.id),
  siteId: str(r.site_id),
  slug: str(r.slug),
  title: str(r.title),
  meta: JSON.parse(str(r.meta_json)) as PageMeta,
  tree: JSON.parse(str(r.tree_json)) as WbNode,
  sortOrder: Number(r.sort_order),
  version: Number(r.version ?? 0),
});

const assetFromRow = (r: Row): Asset => ({
  id: str(r.id),
  siteId: str(r.site_id),
  filename: str(r.filename),
  mime: str(r.mime),
  ...(numOrNull(r.width) !== undefined ? { width: numOrNull(r.width) } : {}),
  ...(numOrNull(r.height) !== undefined ? { height: numOrNull(r.height) } : {}),
  path: str(r.path),
});

export class SiteStore {
  constructor(private db: Client) {}

  insertStatement(site: Site): InStatement {
    return {
      sql: `INSERT INTO sites (id, name, theme_json, header_json, footer_json, settings_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        site.id,
        site.name,
        JSON.stringify(site.theme),
        site.header ? JSON.stringify(site.header) : null,
        site.footer ? JSON.stringify(site.footer) : null,
        JSON.stringify(site.settings),
        site.createdAt,
        site.updatedAt,
      ],
    };
  }

  async insert(site: Site): Promise<void> {
    await this.db.execute(this.insertStatement(site));
  }

  /** Scoped bump of updated_at only — never clobbers concurrent theme/chrome edits. */
  async touch(id: string, updatedAt: string): Promise<void> {
    await this.db.execute({ sql: 'UPDATE sites SET updated_at=? WHERE id=?', args: [updatedAt, id] });
  }

  async update(site: Site): Promise<void> {
    await this.db.execute({
      sql: `UPDATE sites SET name=?, theme_json=?, header_json=?, footer_json=?, settings_json=?, updated_at=? WHERE id=?`,
      args: [
        site.name,
        JSON.stringify(site.theme),
        site.header ? JSON.stringify(site.header) : null,
        site.footer ? JSON.stringify(site.footer) : null,
        JSON.stringify(site.settings),
        site.updatedAt,
        site.id,
      ],
    });
  }

  async get(id: string): Promise<Site | null> {
    const rows = (await this.db.execute({ sql: 'SELECT * FROM sites WHERE id=?', args: [id] })).rows;
    return rows[0] ? siteFromRow(rows[0]) : null;
  }

  async list(): Promise<Site[]> {
    const rows = (await this.db.execute('SELECT * FROM sites ORDER BY created_at')).rows;
    return rows.map(siteFromRow);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.execute({ sql: 'DELETE FROM sites WHERE id=?', args: [id] });
    return res.rowsAffected > 0;
  }
}

export class PageStore {
  constructor(private db: Client) {}

  insertStatement(page: Page): InStatement {
    return {
      sql: `INSERT INTO pages (id, site_id, slug, title, meta_json, tree_json, sort_order, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        page.id,
        page.siteId,
        page.slug,
        page.title,
        JSON.stringify(page.meta),
        JSON.stringify(page.tree),
        page.sortOrder,
        page.version ?? 0,
      ],
    };
  }

  async insert(page: Page): Promise<void> {
    await this.db.execute(this.insertStatement(page));
  }

  /**
   * Optimistic-locked update: succeeds only if the row's version still matches
   * the version we read. Returns false on a lost race (caller throws Conflict),
   * so concurrent editors can never silently overwrite each other. On success
   * the in-memory page's version is bumped to match the row.
   */
  async update(page: Page): Promise<boolean> {
    const res = await this.db.execute({
      sql: `UPDATE pages SET slug=?, title=?, meta_json=?, tree_json=?, sort_order=?, version=version+1
            WHERE id=? AND version=?`,
      args: [
        page.slug,
        page.title,
        JSON.stringify(page.meta),
        JSON.stringify(page.tree),
        page.sortOrder,
        page.id,
        page.version ?? 0,
      ],
    });
    if (res.rowsAffected > 0) {
      page.version = (page.version ?? 0) + 1;
      return true;
    }
    return false;
  }

  /** Next sort order for a site's pages, computed in SQL to avoid a read-then-count race. */
  async nextSortOrder(siteId: string): Promise<number> {
    const rows = (
      await this.db.execute({ sql: 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM pages WHERE site_id=?', args: [siteId] })
    ).rows;
    return Number(rows[0]?.n ?? 0);
  }

  async get(id: string): Promise<Page | null> {
    const rows = (await this.db.execute({ sql: 'SELECT * FROM pages WHERE id=?', args: [id] })).rows;
    return rows[0] ? pageFromRow(rows[0]) : null;
  }

  async bySlug(siteId: string, slug: string): Promise<Page | null> {
    const rows = (
      await this.db.execute({ sql: 'SELECT * FROM pages WHERE site_id=? AND slug=?', args: [siteId, slug] })
    ).rows;
    return rows[0] ? pageFromRow(rows[0]) : null;
  }

  async listForSite(siteId: string): Promise<Page[]> {
    const rows = (
      await this.db.execute({ sql: 'SELECT * FROM pages WHERE site_id=? ORDER BY sort_order, slug', args: [siteId] })
    ).rows;
    return rows.map(pageFromRow);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.execute({ sql: 'DELETE FROM pages WHERE id=?', args: [id] });
    return res.rowsAffected > 0;
  }
}

export class AssetStore {
  constructor(private db: Client) {}

  insertStatement(asset: Asset): InStatement {
    return {
      sql: `INSERT INTO assets (id, site_id, filename, mime, width, height, path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [asset.id, asset.siteId, asset.filename, asset.mime, asset.width ?? null, asset.height ?? null, asset.path],
    };
  }

  async insert(asset: Asset): Promise<void> {
    await this.db.execute(this.insertStatement(asset));
  }

  async get(id: string): Promise<Asset | null> {
    const rows = (await this.db.execute({ sql: 'SELECT * FROM assets WHERE id=?', args: [id] })).rows;
    return rows[0] ? assetFromRow(rows[0]) : null;
  }

  async listForSite(siteId: string): Promise<Asset[]> {
    const rows = (
      await this.db.execute({ sql: 'SELECT * FROM assets WHERE site_id=? ORDER BY filename', args: [siteId] })
    ).rows;
    return rows.map(assetFromRow);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.execute({ sql: 'DELETE FROM assets WHERE id=?', args: [id] });
    return res.rowsAffected > 0;
  }
}

export interface BuildRecord {
  id: string;
  siteId: string;
  createdAt: string;
  manifest: { pages: string[]; files: string[]; warnings: Array<{ page: string; message: string }>; distPath: string };
}

export class BuildStore {
  constructor(private db: Client) {}

  async insert(build: BuildRecord): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO builds (id, site_id, created_at, manifest_json) VALUES (?, ?, ?, ?)`,
      args: [build.id, build.siteId, build.createdAt, JSON.stringify(build.manifest)],
    });
  }

  async listForSite(siteId: string): Promise<BuildRecord[]> {
    const rows = (
      await this.db.execute({ sql: 'SELECT * FROM builds WHERE site_id=? ORDER BY created_at DESC', args: [siteId] })
    ).rows;
    return rows.map((r) => ({
      id: str(r.id),
      siteId: str(r.site_id),
      createdAt: str(r.created_at),
      manifest: JSON.parse(str(r.manifest_json)) as BuildRecord['manifest'],
    }));
  }

  async get(id: string): Promise<BuildRecord | null> {
    const rows = (await this.db.execute({ sql: 'SELECT * FROM builds WHERE id=?', args: [id] })).rows;
    const r = rows[0];
    if (!r) return null;
    return {
      id: str(r.id),
      siteId: str(r.site_id),
      createdAt: str(r.created_at),
      manifest: JSON.parse(str(r.manifest_json)) as BuildRecord['manifest'],
    };
  }
}
