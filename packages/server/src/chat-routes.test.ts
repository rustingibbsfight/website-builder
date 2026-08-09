import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore } from '@wb/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

/**
 * The transport, verified without an agent.
 *
 * This is the reason the transport is a separate increment from the panel: a
 * relay is testable with a stubbed eve and a `curl`, and every property that
 * matters about it — that POST does not wait, that the cursor only moves
 * forward, that a missing header does not invent a backlog — is invisible from
 * the UI and expensive to reproduce there.
 */

let dataDir: string;
let core: WbCore;
let app: FastifyInstance;
let siteId: string;
let calls: { url: string; init?: RequestInit }[];

/** A stubbed eve. `reply` decides what each call gets, in order. */
function withEve(reply: (url: string, index: number) => Response) {
  calls = [];
  return vi.fn(async (url: any, init?: RequestInit) => {
    const at = calls.length;
    calls.push({ url: String(url), init });
    return reply(String(url), at);
  }) as unknown as typeof globalThis.fetch;
}

const ndjson = (rows: unknown[], headers: Record<string, string> = {}) =>
  new Response(rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { status: 200, headers });

const accepted = (session = 'sess_1') =>
  new Response('{}', { status: 200, headers: { 'x-eve-session': session } });

async function boot(fetchImpl: typeof globalThis.fetch) {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-chat-'));
  core = await WbCore.create({ dataDir });
  const site = await core.createSiteFromTemplate('portfolio');
  siteId = site.id;
  app = await buildApp({ core, fetch: fetchImpl });
}

beforeEach(() => {
  process.env.WB_EVE_URL = 'https://eve.example.com';
});

afterEach(async () => {
  await app?.close();
  core?.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.WB_EVE_URL;
  delete process.env.WB_EVE_TOKEN;
});

describe('posting a message', () => {
  it('returns 202 without waiting for the turn', async () => {
    /**
     * The property the whole shape rests on. A route that read the turn to the
     * end would hold a serverless function open for minutes and time out for
     * the rest — so wb-api's budget must bound a *relay leg*, never the work.
     */
    await boot(withEve(() => accepted()));

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/chat`,
      payload: { message: 'make the hero headline shorter' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ sessionId: 'sess_1' });
  });

  it('resolves the page itself rather than believing the client', async () => {
    /**
     * The client sends `pageId` and nothing else about the page. This text goes
     * into the model's context *above* the user's message, so a title the
     * browser chose would be a string a tampered client could put in a place
     * the agent reads as fact.
     */
    await boot(withEve(() => accepted()));
    const pages = await core.listPages(siteId);
    const first = pages[0]!;

    await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/chat`,
      payload: { message: 'hi', pageId: first.id, selectedNodeId: 'n1' },
    });

    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.clientContext).toContain(first.id);
    expect(sent.clientContext).toContain('Do not ask which site or which page');
    // Nothing tree-sized reaches the model on every turn.
    expect(sent.clientContext.length).toBeLessThan(800);
  });

  it('adopts the session another tab already claimed', async () => {
    /**
     * Two tabs opening at once both post and both get a session. The loser must
     * *adopt* the winner's rather than overwrite it — overwriting detaches a
     * conversation the other tab may be mid-turn in.
     */
    await boot(withEve((_url, index) => accepted(index === 0 ? 'sess_first' : 'sess_second')));

    const first = await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'a' } });
    const second = await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'b' } });

    expect(first.json().sessionId).toBe('sess_first');
    expect(second.json().sessionId).toBe('sess_first');
  });

  it('says the agent is unreachable rather than failing opaquely', async () => {
    await boot(
      withEve(() => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const res = await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'hi' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/could not reach the agent/i);
  });

  it("does not forward the browser's credential to eve", async () => {
    // The browser is authenticated to wb-api. Passing a user credential onward
    // is how a proxy becomes a confused deputy.
    process.env.WB_EVE_TOKEN = 'eve_token_value';
    await boot(withEve(() => accepted()));

    await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/chat`,
      payload: { message: 'hi' },
      cookies: { wb_session: 'a-user-session-cookie' },
    });

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer eve_token_value');
    expect(JSON.stringify(headers)).not.toContain('a-user-session-cookie');
  });
});

describe('reading it back', () => {
  it('is empty rather than 404 before anything has been said', async () => {
    // Every site starts here, and a 404 would make the panel look broken on
    // first open.
    await boot(withEve(() => accepted()));
    const res = await app.inject({ url: `/sites/${siteId}/chat` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], nextIndex: 0, live: false });
  });

  it('only moves the cursor forward, over two reads', async () => {
    await boot(
      withEve((url, index) => {
        if (index === 0) return accepted();
        return ndjson(
          index === 1
            ? [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]
            : [{ type: 'text', text: 'three' }],
          { 'x-eve-tail-index': index === 1 ? '3' : '3' },
        );
      }),
    );
    await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'hi' } });

    const read1 = (await app.inject({ url: `/sites/${siteId}/chat?since=0` })).json();
    expect(read1.nextIndex).toBe(2);

    const read2 = (await app.inject({ url: `/sites/${siteId}/chat?since=${read1.nextIndex}` })).json();
    expect(read2.nextIndex).toBe(3);
    expect(read2.nextIndex).toBeGreaterThan(read1.nextIndex);
    // And the cursor it asked eve for is the one it was given.
    expect(calls[2]!.url).toContain('startIndex=2');
  });

  it('reads a missing tail-index header as not behind, never as behind', async () => {
    /**
     * Carried verbatim from ComfyStudio's `session-watch.ts`. An older eve, a
     * proxy that strips the header and a retired session all arrive here
     * identically, and inventing a backlog from any of them puts "the agent
     * kept working" on screen for ever — with no event that could ever clear
     * it.
     */
    await boot(
      withEve((_url, index) => (index === 0 ? accepted() : ndjson([{ type: 'text', text: 'hello' }]))),
    );
    await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'hi' } });

    const body = (await app.inject({ url: `/sites/${siteId}/chat?since=0` })).json();
    expect(body.live).toBe(false);
    expect(body).not.toHaveProperty('tailIndex');
  });

  it('reads an unparseable tail-index the same way', async () => {
    await boot(
      withEve((_url, index) =>
        index === 0 ? accepted() : ndjson([{ type: 'text', text: 'x' }], { 'x-eve-tail-index': 'soon' }),
      ),
    );
    await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'hi' } });
    expect((await app.inject({ url: `/sites/${siteId}/chat?since=0` })).json().live).toBe(false);
  });

  it('says it is live while eve has more than has been read', async () => {
    await boot(
      withEve((_url, index) =>
        index === 0 ? accepted() : ndjson([{ type: 'text', text: 'x' }], { 'x-eve-tail-index': '9' }),
      ),
    );
    await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'hi' } });

    const body = (await app.inject({ url: `/sites/${siteId}/chat?since=0` })).json();
    expect(body).toMatchObject({ nextIndex: 1, tailIndex: 9, live: true });
  });
});

describe('starting again', () => {
  it('forgets the pointer without touching the transcript', async () => {
    await boot(withEve(() => accepted()));
    await app.inject({ method: 'POST', url: `/sites/${siteId}/chat`, payload: { message: 'hi' } });

    expect((await app.inject({ method: 'DELETE', url: `/sites/${siteId}/chat` })).statusCode).toBe(204);
    expect((await app.inject({ url: `/sites/${siteId}/chat` })).json()).toEqual({
      events: [],
      nextIndex: 0,
      live: false,
    });
    // Only wb-api's own row went — eve was never asked to delete anything.
    expect(calls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(0);
  });
});
