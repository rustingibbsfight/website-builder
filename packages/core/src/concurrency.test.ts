import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@wb/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import { ConflictError } from './errors.js';
import { openDb } from './db.js';
import { PageStore } from './stores.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-conc-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const mkPage = (over: Partial<Page> = {}): Page => ({
  id: 'pg1',
  siteId: 'site1',
  slug: '',
  title: 'Home',
  meta: {},
  tree: { id: 'r', type: 'page-root', props: {}, children: [] },
  sortOrder: 0,
  version: 0,
  ...over,
});

describe('PageStore optimistic locking', () => {
  it('rejects a stale write (version mismatch) so concurrent edits never silently overwrite', async () => {
    const db = await openDb({ dataDir });
    // A site row must exist for the FK.
    await db.execute({
      sql: `INSERT INTO sites (id, name, theme_json, settings_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
      args: ['site1', 'S', '{}', '{}', 't', 't'],
    });
    const pages = new PageStore(db);
    await pages.insert(mkPage());

    // Two readers both hold version 0.
    const a = (await pages.get('pg1'))!;
    const b = (await pages.get('pg1'))!;
    expect(a.version).toBe(0);
    expect(b.version).toBe(0);

    // First writer wins → row is now version 1, and the in-memory copy is bumped.
    a.title = 'Edited by A';
    expect(await pages.update(a)).toBe(true);
    expect(a.version).toBe(1);

    // Second writer still thinks it's version 0 → rejected (no silent overwrite).
    b.title = 'Edited by B';
    expect(await pages.update(b)).toBe(false);

    // The row still holds A's edit.
    expect((await pages.get('pg1'))!.title).toBe('Edited by A');
    db.close();
  });

  it('a bumped writer can immediately write again', async () => {
    const db = await openDb({ dataDir });
    await db.execute({
      sql: `INSERT INTO sites (id, name, theme_json, settings_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
      args: ['site1', 'S', '{}', '{}', 't', 't'],
    });
    const pages = new PageStore(db);
    await pages.insert(mkPage());
    const p = (await pages.get('pg1'))!;
    expect(await pages.update(p)).toBe(true); // v1
    expect(await pages.update(p)).toBe(true); // v2 (version tracked in memory)
    expect((await pages.get('pg1'))!.version).toBe(2);
    db.close();
  });
});

describe('WbCore concurrent page ops surface a conflict, never lose data', () => {
  it('parallel edits: the losers get ConflictError; no edit is silently dropped', async () => {
    const core = await WbCore.create({ dataDir });
    const site = await core.createSite('Parallel');
    const page = (await core.listPages(site.id))[0]!;

    // Fire several edits at the same page concurrently. Each does its own
    // read-modify-write; interleaved reads that collide must conflict rather
    // than clobber.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        core.applyPageOps(site.id, page.id, [
          { op: 'insert', parentId: page.tree.id, node: { type: 'heading', props: { text: `E${i}`, level: 2 } } },
        ]),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && (r.reason as Error) instanceof ConflictError,
    ).length;
    // Every result is either a clean success or a clean conflict (no other error).
    expect(ok + conflicts).toBe(6);
    expect(ok).toBeGreaterThanOrEqual(1);

    // Final state contains exactly the successful edits — none lost, none partial.
    const finalTree = (await core.getPage(site.id, page.id)).tree;
    expect(finalTree.children).toHaveLength(ok);
    core.close();
  });
});
