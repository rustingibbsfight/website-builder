import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The submit must not wait, and no unit test can see that.
 *
 * `studio.test.ts` proves `askForImage` makes one round trip and `pollUntil`
 * respects a budget. Neither says anything about what the *tool* does with
 * them, and the tool is where the bug was: restoring
 * `pollUntil(submitted.ticket, 150_000)` inside `request_image` leaves all
 * twenty-four of those tests green. Verified by doing it.
 *
 * The property is worth a source read because of what it costs when it breaks.
 * The ticket is the **receipt for a spend**, and a submit that then blocks is
 * holding the only copy of it inside a call the platform can kill — `apps/eve`
 * has no `vercel.json`, so `maxDuration` is the platform default and nowhere
 * near the old 150-second budget. What that loses is not time: it is a render
 * that was submitted, paid for, and whose id exists nowhere the agent can see.
 *
 * The rule, stated once: **the ticket reaches the transcript before anything
 * waits on it.** `image_status` may wait, because by the time it runs the id is
 * already written down.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

/** Only the executable half — the prose above it explains why the wait went. */
function body(source: string): string {
  return source.slice(source.indexOf('export default defineTool('));
}

describe('the ticket reaches the transcript before anything waits on it', () => {
  it('request_image does not poll, sleep, or otherwise wait', () => {
    const source = body(read('agent/tools/request_image.ts'));

    expect(
      /pollUntil|setTimeout|requestAndWait/.test(source),
      'request_image waits again. The ticket is the receipt for a spend: a submit that blocks holds the ' +
        'only copy of it inside a call the platform can kill, and the render is already paid for. Return ' +
        'the ticket and let image_status do the waiting.',
    ).toBe(false);
  });

  it('image_status is the one allowed to wait', () => {
    // The load-bearing negative. "No tool waits" is not the rule and a check
    // that enforced it would be switched off the first time somebody wanted a
    // picture back without a second turn.
    expect(body(read('agent/tools/image_status.ts'))).toMatch(/pollUntil/);
  });

  it('no tool carries a budget long enough to outlive its function', () => {
    /**
     * The magnitude is the bug, not the concept. Ten seconds saves a model call
     * on a render that is nearly done; a hundred and fifty outlives the process.
     */
    for (const tool of ['request_image', 'image_status']) {
      const source = body(read(`agent/tools/${tool}.ts`));
      for (const [literal] of source.matchAll(/(\d[\d_]{4,})/g)) {
        expect(Number(literal.replace(/_/g, '')), `${tool} carries ${literal}`).toBeLessThanOrEqual(30_000);
      }
    }
  });
});
