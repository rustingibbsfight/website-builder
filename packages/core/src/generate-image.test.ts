import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WbCore } from './core.js';
import type { ImageSpec, ImageStudio, StudioTicket } from './studio.js';

/**
 * Asking for a picture, and collecting one that was paid for.
 *
 * Every rule here is about **money that has already been spent**. The studio
 * queues and charges for a render the moment it accepts the request, so a
 * ticket is a receipt: losing it is not a lost request, it is a lost purchase.
 * That is why the row is written before anything waits, why a failed poll must
 * not settle it, and why collecting twice must not buy or store twice.
 */

let dataDir: string;

/** A studio that answers from a script, and counts what it was asked. */
class FakeStudio implements ImageStudio {
  requests: ImageSpec[] = [];
  reads: string[] = [];
  answer: StudioTicket = {
    ticket: 'tick_1',
    status: 'running',
    images: [],
    alt: '',
    assumptions: [],
    pending: 1,
  };
  reply: StudioTicket | (() => StudioTicket | Promise<StudioTicket>) = this.answer;

  async request(spec: ImageSpec): Promise<StudioTicket> {
    this.requests.push(spec);
    return this.answer;
  }
  async read(ticket: string): Promise<StudioTicket> {
    this.reads.push(ticket);
    return typeof this.reply === 'function' ? this.reply() : this.reply;
  }
  async guidance(): Promise<never> {
    throw new Error('not used here');
  }
  async sendBrandKit(): Promise<never> {
    throw new Error('not used here');
  }
  async listBrands(): Promise<never> {
    throw new Error('not used here');
  }
}

let studio: FakeStudio;
let core: WbCore;

/** Counts every fetch, so "ingested once" is a fact rather than an assumption. */
let fetched: string[] = [];
const fetchFn = (async (url: string | URL) => {
  fetched.push(String(url));
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}) as unknown as typeof fetch;
const publicLookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as never;

/** Handed to every collect below, so no test can silently reach the network. */
const net = { fetchFn, lookupFn: publicLookup };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-genimg-'));
  studio = new FakeStudio();
  core = await WbCore.create({ dataDir, imageStudio: studio });
  fetched = [];
});

afterEach(() => {
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const ready = (images: string[], alt = 'a quiet lobby'): StudioTicket => ({
  ticket: 'tick_1',
  status: 'ready',
  images,
  alt,
  assumptions: [],
  pending: 0,
});

async function site(): Promise<string> {
  return (await core.createSite('Palette Co')).id;
}

describe('asking for a picture', () => {
  it("sends the site's own colours when the caller named none", async () => {
    /**
     * The reason this lives in core rather than in the picker: a picture that
     * does not belong to the page it lands on is the ordinary failure of
     * generated imagery, and the colours are right here. Doing it in one
     * surface only would mean Eve and MCP quietly produced worse pictures than
     * the editor.
     */
    const siteId = await site();
    await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'a quiet lobby' });

    const theme = (await core.getSite(siteId)).theme;
    expect(studio.requests[0]?.palette).toEqual([
      theme.colors.primary,
      theme.colors.secondary,
      theme.colors.accent,
    ]);
  });

  it('keeps a palette the caller chose', async () => {
    // "Match the site" is the default, not the rule. A caller asking for an
    // off-brand picture on purpose is a thing somebody does deliberately.
    const siteId = await site();
    await core.requestSiteImage(siteId, {
      purpose: 'hero',
      subject: 'a quiet lobby',
      palette: ['#000000'],
    });
    expect(studio.requests[0]?.palette).toEqual(['#000000']);
  });

  it('writes the ticket down before anything can wait on it', async () => {
    /**
     * The rule the whole design rests on. The render is queued and charged by
     * the time the studio answers, so if the id only existed in the reply, a
     * dropped connection would be a purchase nobody could collect.
     */
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });

    const stored = await core.imageTickets.get(siteId, started.id);
    expect(stored?.status).toBe('running');
    expect(stored?.spec).toMatchObject({ subject: 'x' });
  });

  it('refuses for a site that does not exist, without asking the studio', async () => {
    // A render is money. Spending one for a typo'd site id, then having
    // nowhere to put the picture, is the worst available order.
    await expect(core.requestSiteImage('no-such-site', { purpose: 'hero', subject: 'x' })).rejects.toThrow();
    expect(studio.requests).toHaveLength(0);
  });

  it('says which variables are missing when no studio is configured', async () => {
    /**
     * `null` rather than a throw at construction: image generation is
     * optional, so a deployment without it must start, serve, publish and
     * deploy exactly as before. The refusal belongs at the one route that
     * needs it, where it can name the fix.
     */
    const bare = await WbCore.create({ dataDir: mkdtempSync(join(tmpdir(), 'wb-nostudio-')), imageStudio: null });
    const siteId = (await bare.createSite('No studio')).id;
    expect(bare.hasImageStudio()).toBe(false);
    await expect(bare.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' })).rejects.toThrow(
      /STUDIO_API_URL/,
    );
    bare.close();
  });
});

describe('collecting one', () => {
  it('ingests the picture into the site and settles the ticket', async () => {
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });
    studio.reply = ready(['https://studio.example.com/renders/a.png']);

    const collected = await core.collectSiteImage(siteId, started.id, net);

    expect(collected.status).toBe('ready');
    expect(collected.assetIds).toHaveLength(1);
    expect(collected.alt).toBe('a quiet lobby');
    const assets = await core.listAssets(siteId);
    expect(assets).toHaveLength(1);
    // Named from the ticket, not from the studio's filename: a remote name is
    // often a hash, is sometimes shared between two renders, and says nothing
    // about where the picture came from a month later.
    expect(assets[0]?.filename).toBe(`generated-${started.id}-1.png`);
  });

  it('collects twice without buying or storing twice', async () => {
    /**
     * The rule somebody hits by refreshing the panel. Without it, every poll
     * of a ready ticket fetches the same picture again and adds a second asset
     * under a second id — and the page ends up referencing whichever one was
     * on screen at the time.
     */
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });
    studio.reply = ready(['https://studio.example.com/renders/a.png']);

    const first = await core.collectSiteImage(siteId, started.id, net);
    const fetchesAfterFirst = fetched.length;
    const second = await core.collectSiteImage(siteId, started.id, net);

    expect(second.assetIds).toEqual(first.assetIds);
    expect(await core.listAssets(siteId)).toHaveLength(1);
    // And it did not even ask the studio again — a settled ticket answers from
    // the row.
    expect(fetched).toHaveLength(fetchesAfterFirst);
    expect(studio.reads).toHaveLength(1);
  });

  it('leaves the ticket running when the poll itself fails', async () => {
    /**
     * A failed poll is not a failed render. The studio is usually just busy,
     * and marking the ticket failed strands a picture that was on its way —
     * one that has been paid for and can no longer be collected, because a
     * settled ticket is never reopened.
     */
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });
    studio.reply = () => {
      throw new Error('502 from the studio');
    };

    await expect(core.collectSiteImage(siteId, started.id, net)).rejects.toThrow(/502/);
    expect((await core.imageTickets.get(siteId, started.id))?.status).toBe('running');
  });

  it('treats a finished render with no pictures as a failure', async () => {
    /**
     * Worse than an error, if allowed through: a result reporting success and
     * carrying nothing gets written into a page as an empty image reference,
     * and is discovered by whoever visits the site.
     */
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });
    studio.reply = ready([]);

    const collected = await core.collectSiteImage(siteId, started.id, net);
    expect(collected.status).toBe('failed');
    expect(collected.error).toMatch(/no pictures/i);
    expect(await core.listAssets(siteId)).toHaveLength(0);
  });

  it('reports a still-running render as still running, not as nothing', async () => {
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });

    const collected = await core.collectSiteImage(siteId, started.id, net);
    expect(collected.status).toBe('running');
    expect(await core.listAssets(siteId)).toHaveLength(0);
  });

  it("will not read another site's ticket", async () => {
    // Scoped in the query rather than compared afterwards: a ticket id is
    // guessable enough that "read, then check" is one forgotten comparison
    // away from one site collecting another's render.
    const mine = await site();
    const theirs = (await core.createSite('Someone else')).id;
    const started = await core.requestSiteImage(mine, { purpose: 'hero', subject: 'x' });

    await expect(core.collectSiteImage(theirs, started.id, net)).rejects.toThrow(/not found/i);
  });

  it('lists what is still in flight, so a closed tab strands nothing', async () => {
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });

    expect((await core.listSiteImageTickets(siteId)).map((t) => t.id)).toEqual([started.id]);

    studio.reply = ready(['https://studio.example.com/renders/a.png']);
    await core.collectSiteImage(siteId, started.id, net);
    expect(await core.listSiteImageTickets(siteId)).toHaveLength(0);
  });
});

describe('the fetch is the same guarded one everything else uses', () => {
  it('refuses a render URL that resolves to a private address', async () => {
    /**
     * The studio is a service we trust, and this still runs. A far end that is
     * compromised, misconfigured or simply proxying somebody else's response
     * would otherwise be a way to make *this* server fetch an internal
     * address — and the point of one ingest path is that nothing gets to
     * bypass it by being trusted.
     */
    const siteId = await site();
    const started = await core.requestSiteImage(siteId, { purpose: 'hero', subject: 'x' });
    studio.reply = ready(['http://169.254.169.254/latest/meta-data/']);

    await expect(core.collectSiteImage(siteId, started.id, net)).rejects.toThrow();
    expect(await core.listAssets(siteId)).toHaveLength(0);
    // And the ticket stays collectable: the render is still paid for, and the
    // failure was on this side.
    expect((await core.imageTickets.get(siteId, started.id))?.status).toBe('running');
  });
});
