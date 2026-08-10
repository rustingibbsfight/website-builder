/**
 * Waiting for a picture, on the one call that is allowed to.
 *
 * The rule this serves is stated in `blocking.test.ts`: **the ticket reaches
 * the transcript before anything waits on it.** `request_image` may not wait,
 * because a submit that blocks holds the only copy of a receipt for money
 * already spent inside a call the platform can kill. `image_status` may, because
 * by the time it runs the id is written down — in the transcript *and* durably
 * on the wb side — so a call that dies loses a few seconds rather than a render.
 *
 * What the waiting buys is model calls, not time. At ten seconds a picture that
 * is nearly done comes back on this call instead of costing another turn, and
 * one that is not simply reports that it is not.
 */

import { wbGet } from './wb';

export interface TicketView {
  id: string;
  status: 'running' | 'ready' | 'failed';
  assetIds?: string[];
  alt?: string;
  error?: string;
}

/**
 * How long to wait before asking again.
 *
 * Backs off rather than hammering: a render is tens of seconds at best, and a
 * poll every second is ninety requests that all say "still running". It stops
 * growing at ten seconds so a picture that lands early is not sat on.
 */
export function nextDelay(attempt: number): number {
  return Math.min(10_000, 2_000 * 2 ** Math.min(attempt, 3));
}

/**
 * How long a poll may wait before answering.
 *
 * Bounded well under any serverless budget, and that is the whole of the
 * number. The magnitude is what made the old 150-second version a bug rather
 * than the concept.
 */
export const POLL_BUDGET_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask about a ticket until it settles, or until the budget is spent.
 *
 * Returns whatever the ticket says when the budget runs out rather than
 * throwing: still running is not a failure, and the id is how to collect it.
 * Asking again later costs nothing, because the render is already paid for.
 */
export async function pollUntil(
  siteId: string,
  ticketId: string,
  budgetMs: number = POLL_BUDGET_MS,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<TicketView> {
  const path = `/sites/${encodeURIComponent(siteId)}/assets/generate/${encodeURIComponent(ticketId)}`;
  const started = now();
  let ticket = await wbGet<TicketView>(path);

  for (let attempt = 0; ticket.status === 'running'; attempt += 1) {
    const left = budgetMs - (now() - started);
    const delay = nextDelay(attempt);
    if (left <= delay) return ticket;
    await wait(delay);
    ticket = await wbGet<TicketView>(path);
  }
  return ticket;
}
