import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askForImage, nextDelay, readTicket, requestAndWait, type Ticket } from './studio';

const TOKEN = 'wbk_supersecrettokenvalue';

/** A ticket as ComfyStudio's `toView` shapes it. */
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  ticket: 'tkt_1',
  status: 'running',
  images: [],
  alt: 'A coastal clinic at morning light',
  assumptions: [],
  pending: 1,
  ...over,
});

type Call = { url: string; init: RequestInit };
let calls: Call[];

function stubFetch(reply: (call: Call, index: number) => { status?: number; body: unknown }): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const { status = 200, body } = reply(call, calls.length - 1);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  calls = [];
  process.env.STUDIO_API_URL = 'https://comfystudio.example.com/';
  process.env.STUDIO_API_KEY = TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STUDIO_API_URL;
  delete process.env.STUDIO_API_KEY;
});

describe('studio client — transport', () => {
  it('POSTs the spec with a bearer key, no redirect following, and a trimmed base url', async () => {
    stubFetch(() => ({ status: 202, body: ticket({ status: 'ready', images: ['https://blob/a.png'], pending: 0 }) }));

    const out = await askForImage({ purpose: 'hero', subject: 'a coastal clinic' });

    expect(calls[0]!.url).toBe('https://comfystudio.example.com/api/serve/images');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // A credential-bearing request must not follow a redirect — the header goes with it.
    expect(calls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ purpose: 'hero', subject: 'a coastal clinic' });
    // 202 is the success case here: the ticket is the answer, not the picture.
    expect(out.images).toEqual(['https://blob/a.png']);
  });

  it('percent-encodes the ticket id into the poll path', async () => {
    stubFetch(() => ({ body: ticket() }));
    await readTicket('tkt_a/b?c');
    expect(calls[0]!.url).toBe('https://comfystudio.example.com/api/serve/images/tkt_a%2Fb%3Fc');
  });

  it("surfaces the server's message on a refusal and never repeats the key back", async () => {
    stubFetch(() => ({ status: 403, body: { error: 'That key does not hold the images:request scope.' } }));

    await expect(askForImage({ purpose: 'card', subject: 'x' })).rejects.toThrow(/images:request scope/);
    await expect(askForImage({ purpose: 'card', subject: 'x' })).rejects.not.toThrow(
      new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('names the missing environment variable rather than failing at the socket', async () => {
    delete process.env.STUDIO_API_URL;
    await expect(askForImage({ purpose: 'hero', subject: 'x' })).rejects.toThrow(/STUDIO_API_URL is not set/);

    process.env.STUDIO_API_URL = 'https://comfystudio.example.com';
    delete process.env.STUDIO_API_KEY;
    await expect(askForImage({ purpose: 'hero', subject: 'x' })).rejects.toThrow(/STUDIO_API_KEY is not set/);
  });
});

describe('studio client — polling', () => {
  it('backs off and then holds at ten seconds', () => {
    expect([0, 1, 2, 3, 4, 20].map(nextDelay)).toEqual([2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });

  it('polls until the picture lands and returns it', async () => {
    stubFetch((_call, i) =>
      i < 2
        ? { body: ticket() }
        : { body: ticket({ status: 'ready', images: ['https://blob/a.png'], pending: 0 }) },
    );

    let clock = 0;
    const out = await requestAndWait(
      { purpose: 'hero', subject: 'a coastal clinic' },
      120_000,
      () => clock,
      async (ms) => {
        clock += ms;
      },
    );

    expect(out.status).toBe('ready');
    expect(out.images).toEqual(['https://blob/a.png']);
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it('hands back the still-running ticket when the budget runs out, rather than throwing away the id', async () => {
    // A render that never finishes: the id is the only way to collect a render
    // that has already been paid for, so losing it is worse than waiting.
    stubFetch(() => ({ body: ticket({ ticket: 'tkt_slow' }) }));

    let clock = 0;
    const out = await requestAndWait(
      { purpose: 'hero', subject: 'x' },
      1_000,
      () => clock,
      async (ms) => {
        clock += ms;
      },
    );

    expect(out.status).toBe('running');
    expect(out.ticket).toBe('tkt_slow');
    // Budget was under the first backoff step, so it never even polled — and
    // still came back with the id rather than an error.
    expect(calls).toHaveLength(1);
  });
});
