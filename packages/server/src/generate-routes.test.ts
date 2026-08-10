import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore, type ImageSpec, type ImageStudio, type StudioTicket } from '@wb/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

/**
 * The two routes, verified without a studio and without a browser.
 *
 * The property worth testing over HTTP rather than in core is the **shape of
 * the exchange**: that POST answers 202 with a ticket instead of waiting for a
 * render, and that GET is where collection happens. A route that quietly waited
 * would pass every core test and still lose a paid-for render the first time a
 * serverless function hit its budget mid-request.
 */

let dataDir: string;
let core: WbCore;
let app: FastifyInstance;
let siteId: string;

class FakeStudio implements ImageStudio {
  requests: ImageSpec[] = [];
  reply: StudioTicket = {
    ticket: 'tick_1',
    status: 'running',
    images: [],
    alt: '',
    assumptions: [],
    pending: 1,
  };
  async request(spec: ImageSpec): Promise<StudioTicket> {
    this.requests.push(spec);
    return this.reply;
  }
  async read(): Promise<StudioTicket> {
    return this.reply;
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

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-genroutes-'));
  studio = new FakeStudio();
  core = await WbCore.create({ dataDir, imageStudio: studio });
  siteId = (await core.createSiteFromTemplate('portfolio')).id;
  app = await buildApp({ core });
});

afterEach(async () => {
  await app?.close();
  core?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const start = async (payload: Record<string, unknown>) =>
  await app.inject({ method: 'POST', url: `/sites/${siteId}/assets/generate`, payload });

describe('starting a request', () => {
  it('answers 202 with the ticket rather than waiting for the picture', async () => {
    /**
     * The whole reason there are two routes. A render takes tens of seconds and
     * a serverless function does not; a request that waited would be holding
     * the only copy of a receipt for money already spent.
     */
    const res = await start({ purpose: 'hero', subject: 'a quiet lobby' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: 'tick_1', status: 'running', siteId });
    // It never even asked how the render was going.
    expect(studio.requests).toHaveLength(1);
  });

  it("defaults the palette to the site's theme, through the route as well", async () => {
    // Because the default lives in core, every surface gets it. A route that
    // had to remember would be a route that eventually forgot.
    await start({ purpose: 'hero', subject: 'x' });
    expect(studio.requests[0]?.palette?.length).toBeGreaterThan(0);
  });

  it('rejects a body the schema does not describe', async () => {
    // The bound numbers are ours rather than the studio's vocabulary: a count
    // of forty is a bill, and it should not reach the far end to be refused.
    expect((await start({ purpose: 'hero', subject: 'x', count: 40 })).statusCode).toBe(400);
    expect((await start({ purpose: 'hero' })).statusCode).toBe(400);
    expect((await start({ purpose: 'hero', subject: 'x', nonsense: true })).statusCode).toBe(400);
  });

  it('404s for a site that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sites/no-such-site/assets/generate',
      payload: { purpose: 'hero', subject: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(studio.requests).toHaveLength(0);
  });
});

describe('coming back for it', () => {
  it('reports a render still in flight without failing it', async () => {
    const started = (await start({ purpose: 'hero', subject: 'x' })).json();
    const res = await app.inject({ url: `/sites/${siteId}/assets/generate/${started.id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'running' });
  });

  it('lists what is still in flight, so a closed tab strands nothing', async () => {
    // The alternative to a durable ticket is a cron advancing everybody's
    // renders on a schedule, which is money spent with nobody watching.
    const started = (await start({ purpose: 'hero', subject: 'x' })).json();
    const res = await app.inject({ url: `/sites/${siteId}/assets/generate` });

    expect(res.json().tickets.map((t: { id: string }) => t.id)).toEqual([started.id]);
  });

  it("404s rather than answering about another site's ticket", async () => {
    const started = (await start({ purpose: 'hero', subject: 'x' })).json();
    const other = (await core.createSite('Someone else')).id;

    const res = await app.inject({ url: `/sites/${other}/assets/generate/${started.id}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('when no studio is configured', () => {
  it('serves everything else and refuses only this, naming the fix', async () => {
    /**
     * Image generation is optional. A deployment without it must start, serve,
     * publish and deploy exactly as before — so the refusal is one route's,
     * not a failure at boot, and it says which variables are missing rather
     * than "not configured".
     */
    const bareDir = mkdtempSync(join(tmpdir(), 'wb-genroutes-bare-'));
    const bare = await WbCore.create({ dataDir: bareDir, imageStudio: null });
    const bareSite = (await bare.createSiteFromTemplate('portfolio')).id;
    const bareApp = await buildApp({ core: bare });

    expect((await bareApp.inject({ url: `/sites/${bareSite}/assets` })).statusCode).toBe(200);
    const res = await bareApp.inject({
      method: 'POST',
      url: `/sites/${bareSite}/assets/generate`,
      payload: { purpose: 'hero', subject: 'x' },
    });
    // 501, not 4xx: the request was perfect, and a caller told "invalid" will
    // reword and retry for ever — which a model on the far end certainly does.
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/STUDIO_API_URL/);

    await bareApp.close();
    bare.close();
    rmSync(bareDir, { recursive: true, force: true });
  });
});
