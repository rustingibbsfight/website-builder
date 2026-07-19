import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DbOptions {
  /** Directory holding wb.sqlite, assets/, dist/. Use ':memory:' for tests. */
  dataDir: string;
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

export function openDb(opts: DbOptions): Database.Database {
  let db: Database.Database;
  if (opts.dataDir === ':memory:') {
    db = new Database(':memory:');
  } else {
    mkdirSync(opts.dataDir, { recursive: true });
    db = new Database(join(opts.dataDir, 'wb.sqlite'));
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]!);
    db.pragma(`user_version = ${v + 1}`);
  }
  return db;
}

export function assetDir(dataDir: string, siteId: string): string {
  return join(dataDir, 'assets', siteId);
}

export function distDir(dataDir: string, siteId: string): string {
  return join(dataDir, 'dist', siteId);
}

export function ensureDirFor(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
