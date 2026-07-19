import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-db-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('explicit libSQL dbUrl (Turso path)', () => {
  it('creates parent dirs for a file: url and persists across reconnects', async () => {
    // A nested, not-yet-existing directory — mirrors a fresh Turso-style config.
    const dbUrl = `file:${join(root, 'nested', 'dir', 'wb.db')}`;
    const core = await WbCore.create({ dataDir: join(root, 'data'), dbUrl });
    const site = await core.createSite('Persisted');
    core.close();

    // A brand-new connection to the same URL sees the committed data — proving
    // state lives in the database, not process memory (as it must for Turso).
    const reopened = await WbCore.create({ dataDir: join(root, 'data'), dbUrl });
    const sites = await reopened.listSites();
    expect(sites.map((s) => s.id)).toEqual([site.id]);
    reopened.close();
  });

  it('runs migrations idempotently on an already-migrated database', async () => {
    const dbUrl = `file:${join(root, 'wb.db')}`;
    const a = await WbCore.create({ dataDir: root, dbUrl });
    await a.createSite('One');
    a.close();
    // Second open must not re-run migrations or throw "table already exists".
    const b = await WbCore.create({ dataDir: root, dbUrl });
    expect((await b.listSites()).length).toBe(1);
    b.close();
  });
});
