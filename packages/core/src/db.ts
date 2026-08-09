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

/**
 * Migrations as arrays of individual statements. Each migration (with its
 * version bump) is applied in one transactional libSQL batch, and every DDL
 * statement uses IF NOT EXISTS / additive ALTERs so that concurrent serverless
 * cold starts running the same migration can't corrupt each other (idempotent).
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      theme_json TEXT NOT NULL,
      header_json TEXT,
      footer_json TEXT,
      symbols_json TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      tree_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      UNIQUE (site_id, slug)
    )`,
    `CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      path TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS builds (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      manifest_json TEXT NOT NULL
    )`,
  ],
  // v2 — captured form submissions (see #27). form_id groups a site's forms;
  // data_json holds the validated field values.
  [
    `CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      form_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_submissions_site ON submissions(site_id, created_at)`,
  ],
  // v3 — the editor's chat with Eve. One row per site: the conversation about a
  // site is *the site's*, not a tab's, so a reload, a second tab and another
  // machine all resume it. `localStorage` would have made it a browser's, which
  // is the wrong owner for something the agent has durable history of anyway.
  [
    `CREATE TABLE IF NOT EXISTS chat_sessions (
      site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ],
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
  const version = Number(
    (await client.execute({ sql: 'SELECT value FROM _wb_meta WHERE key = ?', args: ['schema_version'] }))
      .rows[0]?.value ?? 0,
  );
  // Apply each pending migration + its version bump in a single transactional
  // batch — all-or-nothing, so a crash mid-migration can't leave a
  // half-migrated schema that reports itself complete. IF NOT EXISTS DDL makes
  // concurrent cold starts running the same migration harmless.
  for (let v = version; v < MIGRATIONS.length; v++) {
    await client.batch(
      [
        ...MIGRATIONS[v]!.map((sql) => ({ sql, args: [] as never[] })),
        {
          sql: `INSERT INTO _wb_meta (key, value) VALUES ('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          args: [String(v + 1)],
        },
      ],
      'write',
    );
  }

  // Additive columns, ensured idempotently every startup. This covers databases
  // created by an earlier migration (already at the latest schema_version, so
  // the loop above is a no-op) that predate a column — e.g. pages.version, which
  // fresh CREATE TABLEs above already include.
  await ensureColumn(client, 'pages', 'version', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(client, 'sites', 'symbols_json', 'TEXT'); // reusable symbols (#26)
  return client;
}

/** Add a column if it isn't already present. Idempotent and race-tolerant. */
async function ensureColumn(client: Client, table: string, column: string, def: string): Promise<void> {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  if (info.rows.some((r) => r.name === column)) return;
  try {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  } catch (err) {
    // A concurrent startup may have added it first — that's fine.
    if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}

export function assetDir(dataDir: string, siteId: string): string {
  return join(dataDir, 'assets', siteId);
}

export function distDir(dataDir: string, siteId: string): string {
  return join(dataDir, 'dist', siteId);
}
