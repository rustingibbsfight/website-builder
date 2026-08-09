import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askForImage,
  forgetGuidance,
  guidance,
  GUIDANCE_TTL_MS,
  nextDelay,
  readTicket,
  requestAndWait,
  sendBrandKit,
  type Guidance,
  type Ticket,
} from './studio';

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

describe('the vocabulary is fetched, not remembered', () => {
  /**
   * The failure this replaced, stated once. `ImageSpec` held a union of six
   * purposes and five aspects copied out of ComfyStudio, and by the time anyone
   * looked the studio had grown `width`, `height`, `media`, `seconds` and
   * `brand` — all unreachable from here, because a type written months ago does
   * not know about them. A copied enum has two ways to be wrong and no way to
   * stay right.
   */
  const doc = (over: Partial<Guidance> = {}): Guidance => ({
    version: 1,
    request: {
      endpoint: 'POST /api/serve/images',
      purposes: ['hero', 'section', 'card'],
      aspects: ['16/9', '1/1'],
      textSafe: ['none', 'left'],
      media: ['image', 'video'],
      limits: { maxCount: 4, maxEdge: 2048, maxVideoEdge: 1280, maxSeconds: 10 },
      fields: [{ name: 'purpose', required: true, note: 'Where on the page it goes.' }],
    },
    ontology: [{ kind: 'colour', label: 'Colour', hint: 'The palette.' }],
    brands: { endpoint: 'POST /api/serve/brands', note: 'Send once.', known: [] },
    ...over,
  });

  beforeEach(() => forgetGuidance());

  it('asks the studio rather than answering from a constant', async () => {
    stubFetch(() => ({ body: doc() }));
    const out = await guidance();

    expect(calls[0].url).toBe('https://comfystudio.example.com/api/serve/guidance');
    expect(calls[0].init.method).toBe('GET');
    expect(out.request.purposes).toEqual(['hero', 'section', 'card']);
  });

  it('does not ask twice in a minute', async () => {
    // An agent building one page asks three times in a row, and three identical
    // round trips to another deployment is latency spent on an answer that
    // cannot have changed.
    stubFetch(() => ({ body: doc() }));
    const now = () => 1_000;
    await guidance(now);
    await guidance(now);
    expect(calls).toHaveLength(1);
  });

  it('asks again once the cache is cold', async () => {
    stubFetch(() => ({ body: doc() }));
    let clock = 1_000;
    await guidance(() => clock);
    clock += GUIDANCE_TTL_MS + 1;
    await guidance(() => clock);
    expect(calls).toHaveLength(2);
  });

  it('serves a stale answer rather than throwing', async () => {
    /**
     * Guidance sixty seconds old is a far better answer than an exception,
     * because the alternative is the agent falling back to guessing — which is
     * precisely what this replaced. A studio that is briefly down should slow
     * the integration, not un-teach it.
     */
    stubFetch((_call, index) => (index === 0 ? { body: doc() } : { status: 500, body: { error: 'down' } }));
    let clock = 1_000;
    await guidance(() => clock);
    clock += GUIDANCE_TTL_MS + 1;

    await expect(guidance(() => clock)).resolves.toMatchObject({ version: 1 });
    expect(calls).toHaveLength(2);
  });

  it('throws when there is nothing stale to fall back to', async () => {
    // The honest failure. Inventing a vocabulary here would be the copied enum
    // again, arriving through the error path.
    stubFetch(() => ({ status: 500, body: { error: 'down' } }));
    await expect(guidance()).rejects.toThrow(/guidance/);
  });
});

describe('sending a spec the type used to forbid', () => {
  it('passes the exact slot, the media and the brand straight through', async () => {
    /**
     * The point of widening `ImageSpec`. This *is* the caller that lays pages
     * out — a builder holding a 1440x480 slot and only able to say "16/9, at
     * least 1280 wide" is doing a conversion it can get wrong, and getting it
     * wrong looks like a picture that does not fit rather than like an error.
     */
    stubFetch(() => ({ status: 202, body: ticket() }));
    await askForImage({
      purpose: 'hero',
      subject: 'a coastal clinic',
      width: 1440,
      height: 480,
      media: 'video',
      seconds: 4,
      brand: 'acme',
    });

    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      width: 1440,
      height: 480,
      media: 'video',
      seconds: 4,
      brand: 'acme',
    });
  });

  it('sends a value this side has never heard of', async () => {
    /**
     * The transport half of the decoupling: an unfamiliar purpose is forwarded
     * rather than mangled.
     *
     * It does **not** prove the type would have let you call it — a TS union is
     * erased before this runs, so restoring `purpose: 'hero' | 'section'`
     * leaves this green. `vocabulary.test.ts` is the half that can see that,
     * and it reads the source for exactly this reason.
     */
    stubFetch(() => ({ status: 202, body: ticket() }));
    await askForImage({ purpose: 'testimonial-strip', subject: 'x', aspect: '32/9' });

    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      purpose: 'testimonial-strip',
      aspect: '32/9',
    });
  });
});

describe('a brand kit', () => {
  it('is sent to the brands endpoint and reports what it became', async () => {
    stubFetch(() => ({
      status: 201,
      body: {
        brand: 'acme',
        tag: 'brand-acme',
        snippets: [{ name: 'acme_palette', kind: 'colour' }],
      },
    }));

    const saved = await sendBrandKit({ name: 'Acme', description: 'quiet, engineered' });

    expect(calls[0].url).toBe('https://comfystudio.example.com/api/serve/brands');
    expect(calls[0].init.method).toBe('POST');
    // What it decomposed into, so a kit that came back as one vague part is
    // visible immediately rather than three pictures later.
    expect(saved.snippets).toEqual([{ name: 'acme_palette', kind: 'colour' }]);
  });

  it('never puts the key in an error', async () => {
    // The same rule the transport already follows, asserted on the new path:
    // an error message is the single most likely thing to reach a log.
    stubFetch(() => ({ status: 502, body: { error: 'the studio agent did not answer' } }));
    await expect(sendBrandKit({ name: 'Acme', description: 'x' })).rejects.toThrow(
      /did not answer/,
    );
    await expect(sendBrandKit({ name: 'Acme', description: 'x' })).rejects.not.toThrow(
      new RegExp(TOKEN),
    );
  });
});
