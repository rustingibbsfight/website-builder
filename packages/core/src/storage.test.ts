import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import { LocalAssetStorage, createAssetStorage, type AssetStorage } from './storage.js';

describe('createAssetStorage selection', () => {
  it('defaults to local filesystem', () => {
    expect(createAssetStorage('/tmp/x', {})).toBeInstanceOf(LocalAssetStorage);
    expect(createAssetStorage('/tmp/x', { WB_ASSET_STORE: 'local' })).toBeInstanceOf(LocalAssetStorage);
  });

  it('requires full S3 credentials when WB_ASSET_STORE=s3', () => {
    expect(() => createAssetStorage('/tmp/x', { WB_ASSET_STORE: 's3' })).toThrow(/WB_S3_BUCKET/);
    expect(() =>
      createAssetStorage('/tmp/x', {
        WB_ASSET_STORE: 's3',
        WB_S3_BUCKET: 'b',
        WB_S3_ACCESS_KEY_ID: 'k',
        WB_S3_SECRET_ACCESS_KEY: 's',
        WB_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      }),
    ).not.toThrow();
  });
});

describe('LocalAssetStorage roundtrip', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wb-store-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('puts, gets, deletes, and clears a site', async () => {
    const s = new LocalAssetStorage(dataDir);
    await s.put('site1', 'a.svg', '<svg/>', 'image/svg+xml');
    expect((await s.get('site1', 'a.svg')).toString()).toBe('<svg/>');
    await s.put('site1', 'b.png', new Uint8Array([1, 2, 3]), 'image/png');
    await s.delete('site1', 'a.svg');
    await expect(s.get('site1', 'a.svg')).rejects.toThrow();
    await s.deleteSite('site1');
    await expect(s.get('site1', 'b.png')).rejects.toThrow();
  });
});

/** In-memory AssetStorage — proves WbCore works against any backend (e.g. R2). */
class MemoryStorage implements AssetStorage {
  store = new Map<string, Buffer>();
  private k(siteId: string, path: string) {
    return `${siteId}/${path}`;
  }
  async put(siteId: string, path: string, body: Uint8Array | string): Promise<void> {
    this.store.set(this.k(siteId, path), Buffer.from(body));
  }
  async get(siteId: string, path: string): Promise<Buffer> {
    const b = this.store.get(this.k(siteId, path));
    if (!b) throw new Error('not found');
    return b;
  }
  async delete(siteId: string, path: string): Promise<void> {
    this.store.delete(this.k(siteId, path));
  }
  async deleteSite(siteId: string): Promise<void> {
    for (const key of [...this.store.keys()]) if (key.startsWith(`${siteId}/`)) this.store.delete(key);
  }
}

describe('WbCore against a pluggable (non-fs) asset store', () => {
  let dataDir: string;
  let core: WbCore;
  let mem: MemoryStorage;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wb-memstore-'));
    mem = new MemoryStorage();
    core = await WbCore.create({ dataDir, assetStorage: mem });
  });
  afterEach(() => {
    core.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('template assets, preview, and publish all route bytes through the store', async () => {
    const site = await core.createSiteFromTemplate('breakthrough-medical');
    // template assets landed in the (non-fs) store
    expect(mem.store.size).toBeGreaterThan(0);

    // preview reads asset bytes from the store
    const assets = await core.listAssets(site.id);
    const preview = await core.renderPreviewPath(site.id, `/assets/${assets[0]!.path}`, `/preview/${site.id}`);
    expect(preview?.kind).toBe('asset');
    expect((preview as { body: Buffer }).body.length).toBeGreaterThan(0);

    // publish pulls every asset from the store into the build
    const result = await core.publishSite(site.id);
    expect(result.files.filter((f) => f.startsWith('assets/')).length).toBe(assets.length);

    // deleting the site clears the store namespace
    await core.deleteSite(site.id);
    expect(mem.store.size).toBe(0);
  });

  it('uploaded asset bytes are retrievable and deletable through the store', async () => {
    const site = await core.createSite('Mem');
    const asset = await core.addAsset(site.id, 'x.svg', 'image/svg+xml', '<svg id="mem"/>');
    expect((await core.readAsset(site.id, asset.id)).buffer.toString()).toContain('mem');
    await core.deleteAsset(site.id, asset.id);
    expect(mem.store.size).toBe(0);
  });
});
