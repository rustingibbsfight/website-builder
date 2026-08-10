import type { Client, InStatement, Row } from '@libsql/client';
import type { Asset, Page, PageMeta, Site, SiteSettings, Theme, WbNode } from '@wb/schema';

/** A partial site update; only the present keys are written (header/footer null clears them). */
export interface SiteFieldUpdate {
  name?: string;
  theme?: Theme;
  settings?: SiteSettings;
  header?: WbNode | null;
  footer?: WbNode | null;
  symbols?: Record<string, WbNode> | null;
}

const str = (v: unknown): string => String(v);
const numOrNull = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));

const siteFromRow = (r: Row): Site => ({
  id: str(r.id),
  name: str(r.name),
  theme: JSON.parse(str(r.theme_json)) as Theme,
  ...(r.header_json ? { header: JSON.parse(str(r.header_json)) as WbNode } : {}),
  ...(r.footer_json ? { footer: JSON.parse(str(r.footer_json)) as WbNode } : {}),
  ...(r.symbols_json ? { symbols: JSON.parse(str(r.symbols_json)) as Record<string, WbNode> } : {}),
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
      sql: `INSERT INTO sites (id, name, theme_json, header_json, footer_json, symbols_json, settings_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        site.id,
        site.name,
        JSON.stringify(site.theme),
        site.header ? JSON.stringify(site.header) : null,
        site.footer ? JSON.stringify(site.footer) : null,
        site.symbols ? JSON.stringify(site.symbols) : null,
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

  /**
   * Update only the columns a given edit actually touches, so concurrent edits
   * to disjoint parts of a site (e.g. one request setting the theme, another
   * setting the header) can't clobber each other via a full-row rewrite. A key
   * being present means "write it"; for header/footer a null value clears the
   * column. updated_at is always bumped.
   */
  async updateFields(id: string, fields: SiteFieldUpdate, updatedAt: string): Promise<boolean> {
    const cols: string[] = [];
    const args: (string | null)[] = [];
    if (fields.name !== undefined) {
      cols.push('name=?');
      args.push(fields.name);
    }
    if (fields.theme !== undefined) {
      cols.push('theme_json=?');
      args.push(JSON.stringify(fields.theme));
    }
    if (fields.settings !== undefined) {
      cols.push('settings_json=?');
      args.push(JSON.stringify(fields.settings));
    }
    if ('header' in fields) {
      cols.push('header_json=?');
      args.push(fields.header ? JSON.stringify(fields.header) : null);
    }
    if ('footer' in fields) {
      cols.push('footer_json=?');
      args.push(fields.footer ? JSON.stringify(fields.footer) : null);
    }
    if ('symbols' in fields) {
      cols.push('symbols_json=?');
      args.push(fields.symbols ? JSON.stringify(fields.symbols) : null);
    }
    cols.push('updated_at=?');
    args.push(updatedAt);
    args.push(id);
    const res = await this.db.execute({ sql: `UPDATE sites SET ${cols.join(', ')} WHERE id=?`, args });
    return res.rowsAffected > 0;
  }

  /**
   * Atomically set/replace one symbol in the JSON map (#26). A single json_set
   * statement so concurrent edits to DIFFERENT symbols can't clobber each other
   * (the read-modify-write of updateFields could). `symbolId` is validated
   * `[A-Za-z0-9_-]` upstream, so quoting the path key is injection-safe.
   */
  async setSymbol(siteId: string, symbolId: string, node: WbNode, updatedAt: string): Promise<boolean> {
    const res = await this.db.execute({
      sql: `UPDATE sites SET symbols_json = json_set(COALESCE(symbols_json, '{}'), ?, json(?)), updated_at=? WHERE id=?`,
      args: [`$."${symbolId}"`, JSON.stringify(node), updatedAt, siteId],
    });
    return res.rowsAffected > 0;
  }

  /** Atomically remove one symbol from the JSON map (leaves other keys intact). */
  async removeSymbol(siteId: string, symbolId: string, updatedAt: string): Promise<boolean> {
    const res = await this.db.execute({
      sql: `UPDATE sites SET symbols_json = json_remove(symbols_json, ?), updated_at=? WHERE id=? AND symbols_json IS NOT NULL`,
      args: [`$."${symbolId}"`, updatedAt, siteId],
    });
    return res.rowsAffected > 0;
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

  async deleteForSite(siteId: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM builds WHERE site_id=?', args: [siteId] });
  }
}

export interface SubmissionRecord {
  id: string;
  siteId: string;
  formId: string;
  data: Record<string, string>;
  createdAt: string;
}

export class SubmissionStore {
  constructor(private db: Client) {}

  async insert(sub: SubmissionRecord): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO submissions (id, site_id, form_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      args: [sub.id, sub.siteId, sub.formId, JSON.stringify(sub.data), sub.createdAt],
    });
  }

  async listForSite(siteId: string, formId?: string): Promise<SubmissionRecord[]> {
    const rows = (
      await this.db.execute(
        formId
          ? { sql: 'SELECT * FROM submissions WHERE site_id=? AND form_id=? ORDER BY created_at DESC', args: [siteId, formId] }
          : { sql: 'SELECT * FROM submissions WHERE site_id=? ORDER BY created_at DESC', args: [siteId] },
      )
    ).rows;
    return rows.map((r) => ({
      id: str(r.id),
      siteId: str(r.site_id),
      formId: str(r.form_id),
      data: JSON.parse(str(r.data_json)) as Record<string, string>,
      createdAt: str(r.created_at),
    }));
  }

  async countForSite(siteId: string): Promise<number> {
    const rows = (await this.db.execute({ sql: 'SELECT COUNT(*) AS n FROM submissions WHERE site_id=?', args: [siteId] })).rows;
    return Number(rows[0]?.n ?? 0);
  }

  async deleteForSite(siteId: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM submissions WHERE site_id=?', args: [siteId] });
  }
}

/**
 * Which eve session holds the conversation about a site.
 *
 * One row per site, and that is the design rather than a schema convenience.
 * The conversation about a site belongs to *the site*: a reload, a second tab
 * and a different machine should all pick it up where it was left. Keeping the
 * id in `localStorage` would have made it a browser's, which is the wrong owner
 * for something eve already keeps durable history of — and it would have meant
 * a cleared cache silently orphaning a conversation that still exists.
 *
 * Only the id is stored. The transcript stays eve's, read back from its own
 * durable log by cursor, so there is no second copy of the conversation here to
 * drift from the first.
 */
export class ChatSessionStore {
  constructor(private db: Client) {}

  async get(siteId: string): Promise<string | null> {
    const rows = (
      await this.db.execute({ sql: 'SELECT session_id FROM chat_sessions WHERE site_id=?', args: [siteId] })
    ).rows;
    return rows[0] ? str(rows[0].session_id) : null;
  }

  /**
   * Remember it, or keep the one already there.
   *
   * `INSERT OR IGNORE` rather than an upsert: two tabs opening at once both
   * post, both create a session, and the loser must *adopt the winner's* rather
   * than overwrite it — otherwise the tab that lost has just detached a
   * conversation the other tab is mid-turn in. The return value is the session
   * that won, which the caller uses instead of its own.
   */
  async claim(siteId: string, sessionId: string, createdAt: string): Promise<string> {
    await this.db.execute({
      sql: `INSERT OR IGNORE INTO chat_sessions (site_id, session_id, created_at) VALUES (?, ?, ?)`,
      args: [siteId, sessionId, createdAt],
    });
    return (await this.get(siteId)) ?? sessionId;
  }

  /** Start a fresh conversation about this site, forgetting the old id. */
  async clear(siteId: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM chat_sessions WHERE site_id=?', args: [siteId] });
  }
}

/**
 * One image request the studio accepted, and what became of it.
 *
 * The row exists because the ticket is a **receipt for money already spent**.
 * A render is submitted at one moment and finishes at another, and everything
 * that might be holding the id in the meantime can die: a serverless function
 * hits its budget, a browser tab closes, a chat turn is interrupted. If the id
 * lived only in the caller, a picture that was paid for would be unreachable —
 * which is not a lost request, it is a lost purchase.
 *
 * So the row is written the moment the studio answers, before anything waits.
 */
export interface ImageTicketRecord {
  id: string;
  siteId: string;
  status: 'running' | 'ready' | 'failed';
  spec: Record<string, unknown>;
  /** Set once, when the render was collected into the site's assets. */
  assetIds?: string[];
  alt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const ticketFromRow = (r: Row): ImageTicketRecord => ({
  id: str(r.id),
  siteId: str(r.site_id),
  status: str(r.status) as ImageTicketRecord['status'],
  spec: JSON.parse(str(r.spec_json)) as Record<string, unknown>,
  ...(r.asset_ids_json ? { assetIds: JSON.parse(str(r.asset_ids_json)) as string[] } : {}),
  ...(r.alt ? { alt: str(r.alt) } : {}),
  ...(r.error ? { error: str(r.error) } : {}),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

export class ImageTicketStore {
  constructor(private db: Client) {}

  async insert(ticket: ImageTicketRecord): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO image_tickets (id, site_id, status, spec_json, asset_ids_json, alt, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ticket.id,
        ticket.siteId,
        ticket.status,
        JSON.stringify(ticket.spec),
        ticket.assetIds ? JSON.stringify(ticket.assetIds) : null,
        ticket.alt ?? null,
        ticket.error ?? null,
        ticket.createdAt,
        ticket.updatedAt,
      ],
    });
  }

  async get(siteId: string, id: string): Promise<ImageTicketRecord | null> {
    // Scoped by site in the query rather than checked afterwards. A ticket id
    // is guessable enough that "read it, then compare" is one forgotten
    // comparison away from letting one site read another's render.
    const rows = (
      await this.db.execute({ sql: 'SELECT * FROM image_tickets WHERE id=? AND site_id=?', args: [id, siteId] })
    ).rows;
    return rows[0] ? ticketFromRow(rows[0]) : null;
  }

  /**
   * Record the outcome — once.
   *
   * `WHERE status='running'` is the whole guard, and it is what makes
   * collection idempotent under a race. Two polls of the same ready ticket both
   * see `running`, both ingest, and both try to write; only one row update
   * succeeds, and the loser re-reads to find the winner's asset ids rather than
   * leaving the site with the same picture stored twice under two names.
   *
   * A settled ticket is never reopened. `failed` and `ready` are both final:
   * the studio does not un-fail a render, and a ticket that flipped back to
   * running would be one nothing could ever stop polling.
   */
  async settle(
    siteId: string,
    id: string,
    outcome: { status: 'ready' | 'failed'; assetIds?: string[]; alt?: string; error?: string; at: string },
  ): Promise<boolean> {
    const result = await this.db.execute({
      sql: `UPDATE image_tickets SET status=?, asset_ids_json=?, alt=?, error=?, updated_at=?
            WHERE id=? AND site_id=? AND status='running'`,
      args: [
        outcome.status,
        outcome.assetIds ? JSON.stringify(outcome.assetIds) : null,
        outcome.alt ?? null,
        outcome.error ?? null,
        outcome.at,
        id,
        siteId,
      ],
    });
    return (result.rowsAffected ?? 0) > 0;
  }

  /** Requests still in flight, oldest first — what a picker reopens onto. */
  async listRunning(siteId: string): Promise<ImageTicketRecord[]> {
    const rows = (
      await this.db.execute({
        sql: `SELECT * FROM image_tickets WHERE site_id=? AND status='running' ORDER BY created_at ASC`,
        args: [siteId],
      })
    ).rows;
    return rows.map(ticketFromRow);
  }
}
