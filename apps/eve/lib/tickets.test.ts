import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextDelay, pollUntil, POLL_BUDGET_MS, type TicketView } from './tickets';

/**
 * Waiting for a picture, bounded.
 *
 * The waiting exists to save **model calls**, not time: at ten seconds a render
 * that is nearly done comes back on this call instead of costing another turn.
 * Every case here is about a way that trade goes wrong — asking too often,
 * waiting past the function's own budget, or turning "not finished" into an
 * error and losing a render that was on its way.
 */

const ticket = (over: Partial<TicketView> = {}): TicketView => ({
  id: 'tick_1',
  status: 'running',
  ...over,
});

let replies: TicketView[];
let asked: string[];

beforeEach(() => {
  process.env.WB_API_URL = 'https://wb.example.com';
  asked = [];
  replies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      asked.push(String(url));
      const next = replies.shift() ?? ticket();
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WB_API_URL;
});

/** A clock and a sleep the test drives, so nothing here waits in real time. */
function fakeTime() {
  let at = 0;
  return {
    now: () => at,
    wait: async (ms: number) => {
      at += ms;
    },
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('backing off', () => {
  it('grows, then stops growing', () => {
    // A render is tens of seconds at best, so a poll every second is ninety
    // requests that all say "still running". It caps so a picture that lands
    // early is not sat on for a minute.
    expect(nextDelay(0)).toBe(2_000);
    expect(nextDelay(1)).toBe(4_000);
    expect(nextDelay(2)).toBe(8_000);
    expect(nextDelay(3)).toBe(10_000);
    expect(nextDelay(99)).toBe(10_000);
  });
});

describe('asking until it settles', () => {
  it('returns as soon as the picture is ready', async () => {
    const clock = fakeTime();
    replies = [ticket({ status: 'ready', assetIds: ['as_1'], alt: 'a quiet lobby' })];

    const result = await pollUntil('site_1', 'tick_1', POLL_BUDGET_MS, clock.now, clock.wait);

    expect(result.status).toBe('ready');
    expect(result.assetIds).toEqual(['as_1']);
    // One call. It did not wait out the budget for an answer it already had.
    expect(asked).toHaveLength(1);
  });

  it('asks again while it is still rendering', async () => {
    const clock = fakeTime();
    replies = [ticket(), ticket(), ticket({ status: 'ready', assetIds: ['as_1'] })];

    const result = await pollUntil('site_1', 'tick_1', POLL_BUDGET_MS, clock.now, clock.wait);

    expect(result.status).toBe('ready');
    expect(asked).toHaveLength(3);
  });

  it('gives the ticket back rather than throwing when the budget runs out', async () => {
    /**
     * The refusal that matters. Still running is **not** a failure, and turning
     * it into one loses a render that is already paid for — the caller needs
     * the id back so it can ask again on a later turn.
     */
    const clock = fakeTime();
    replies = [];

    const result = await pollUntil('site_1', 'tick_1', POLL_BUDGET_MS, clock.now, clock.wait);

    expect(result.status).toBe('running');
    expect(result.id).toBe('tick_1');
  });

  it('never waits past the budget it was given', async () => {
    /**
     * The magnitude is the bug, not the concept: ten seconds saves a model
     * call, and the hundred and fifty this used to carry outlived the function
     * it ran in — which is how a paid-for render ended up unreachable.
     */
    const clock = fakeTime();
    const started = clock.now();

    await pollUntil('site_1', 'tick_1', POLL_BUDGET_MS, clock.now, clock.wait);

    expect(clock.now() - started).toBeLessThanOrEqual(POLL_BUDGET_MS);
  });

  it('asks the site-scoped route, with both ids escaped', async () => {
    // A ticket id is a stranger's string as far as this is concerned, and a
    // site id comes from the model. Neither may reshape the path.
    const clock = fakeTime();
    replies = [ticket({ status: 'ready' })];

    await pollUntil('site/../other', 'tick 1', POLL_BUDGET_MS, clock.now, clock.wait);

    expect(asked[0]).toBe('https://wb.example.com/sites/site%2F..%2Fother/assets/generate/tick%201');
  });
});
