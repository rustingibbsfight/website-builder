import { createClient, type Client } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface DbOptions {
  /** Local data directory (SQLite file lives here when no dbUrl is given). */
  dataDir: string;
  /** libSQL/Turso URL. Defaults to a local file under dataDir. e.g. libsql://db.turso.io */
  dbUrl?: string;
  /** Auth token for a remote libSQL/Turso database. */
  dbToken?: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    theme_json TEXT NOT NULL,
    header_json TEXT,
    footer_json TEXT,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    tree_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (site_id, slug)
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    path TEXT NOT NULL
  );
  CREATE TABLE builds (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    manifest_json TEXT NOT NULL
  );`,
];

/**
 * Open (and migrate) the libSQL database. Works with a local file — the default,
 * used by the CLI and self-hosting — and with a remote libSQL/Turso URL for
 * serverless deployments. The same async client covers both.
 */
export async function openDb(opts: DbOptions): Promise<Client> {
  let url = opts.dbUrl;
  if (!url) {
    if (opts.dataDir === ':memory:') {
      url = ':memory:';
    } else {
      mkdirSync(opts.dataDir, { recursive: true });
      url = `file:${resolve(join(opts.dataDir, 'wb.sqlite'))}`;
    }
  } else if (url.startsWith('file:')) {
    // A local libSQL file needs its parent directory to exist first.
    mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  }
  const client = createClient({ url, ...(opts.dbToken ? { authToken: opts.dbToken } : {}) });

  // Best-effort: enforce foreign keys where the backend honors the pragma.
  // deleteSite also cleans up children explicitly, so correctness never relies
  // on cascade being active. (Remote Turso rejects write-form pragmas — hence
  // the try/catch, and hence schema versioning via a table below, not
  // PRAGMA user_version.)
  try {
    await client.execute('PRAGMA foreign_keys = ON');
  } catch {
    /* remote backends may ignore/deny connection pragmas */
  }

  await client.execute('CREATE TABLE IF NOT EXISTS _wb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  let version = Number(
    (await client.execute({ sql: 'SELECT value FROM _wb_meta WHERE key = ?', args: ['schema_version'] }))
      .rows[0]?.value ?? 0,
  );
  // Compatibility: a local DB migrated by the older PRAGMA-based scheme has the
  // tables but no _wb_meta row — treat it as fully migrated so we don't re-run.
  if (version === 0) {
    const hasSites = (
      await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='sites'")
    ).rows.length > 0;
    if (hasSites) version = MIGRATIONS.length;
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    await client.executeMultiple(MIGRATIONS[v]!);
  }
  await client.execute({
    sql: `INSERT INTO _wb_meta (key, value) VALUES ('schema_version', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [String(MIGRATIONS.length)],
  });
  return client;
}

export function assetDir(dataDir: string, siteId: string): string {
  return join(dataDir, 'assets', siteId);
}

export function distDir(dataDir: string, siteId: string): string {
  return join(dataDir, 'dist', siteId);
}
