import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WbCore } from './core.js';

/**
 * `addAssetFromUrl` does three things in an order that is the whole point, and
 * both halves of that order were got wrong on the first attempt.
 *
 * Checking the site first made a typo'd site id mask an SSRF refusal — the
 * caller pointing at the metadata service got told "site not found", which is
 * the wrong answer to the more important question. Fetching before checking
 * the site pulled 20 MB from a stranger's server for something that was never
 * going to be stored.
 *
 * So: guard, then site, then fetch. Each of these tests fails if two of the
 * three swap places.
 */
let dataDir: string;
let core: WbCore;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-asset-url-'));
  core = await WbCore.create({ dataDir });
});

afterEach(() => {
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const never = (() => {
  throw new Error('fetch should not have been attempted');
}) as unknown as typeof fetch;

const publicLookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as never;

async function makeSite() {
  const site = await core.createSite('Ordering');
  return site.id;
}

describe('WbCore.addAssetFromUrl', () => {
  it('refuses a hostile url even when the site id is also wrong', async () => {
    // The security answer wins. Otherwise a caller probing internal addresses
    // can hide the refusal behind a bad site id and learn nothing either way.
    await expect(
      core.addAssetFromUrl('no-such-site', 'x.png', 'http://169.254.169.254/latest/meta-data/', {
        fetchFn: never,
      }),
    ).rejects.toThrow(/private|internal/i);
  });

  it('does not fetch when the site does not exist', async () => {
    // `never` throws if it is called, so reaching the NotFound means the fetch
    // was skipped — a bad site id costs no request to somebody else's server.
    await expect(
      core.addAssetFromUrl('no-such-site', 'x.png', 'https://example.com/a.png', {
        fetchFn: never,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('stores the bytes and the resolved mime when everything is in order', async () => {
    const siteId = await makeSite();
    const fetchFn = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })) as never;
    const asset = await core.addAssetFromUrl(siteId, 'hero.png', 'https://example.com/hero.png', {
      fetchFn,
      lookupFn: publicLookup,
    });
    expect(asset.mime).toBe('image/png');
    const read = await core.readAsset(siteId, asset.id);
    expect(Array.from(read.buffer)).toEqual([1, 2, 3]);
  });

  it('writes nothing when the fetch fails', async () => {
    const siteId = await makeSite();
    const before = (await core.listAssets(siteId)).length;
    const fetchFn = (async () => new Response('nope', { status: 500 })) as never;
    await expect(
      core.addAssetFromUrl(siteId, 'hero.png', 'https://example.com/hero.png', {
        fetchFn,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/500/);
    expect(await core.listAssets(siteId)).toHaveLength(before);
  });
});
