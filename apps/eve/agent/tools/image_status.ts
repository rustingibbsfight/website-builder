import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { nextDelay, pollUntil } from '../../lib/studio';

/**
 * Ask again for a picture `request_image` did not finish waiting for.
 *
 * Asking *is* what moves it along — ComfyStudio has no worker of its own, so a
 * ticket nobody polls never finishes. Nothing is lost by asking again later:
 * the render is already submitted and paid for.
 *
 * **This one may wait, where `request_image` may not.** The difference is not
 * politeness: by the time anybody calls this, the ticket id is written down in
 * the transcript, so a call the platform kills loses a few seconds rather than
 * losing a render. The budget is ten seconds — enough that a picture which is
 * nearly done comes back on this call instead of costing another turn, short
 * enough to sit inside any function budget.
 */
export default defineTool({
  description:
    'Check a ComfyStudio image request that was still rendering. Takes the ticket from request_image and ' +
    'returns the image URLs once they are ready.',
  inputSchema: z.object({
    ticket: z.string().describe('The ticket id returned by request_image.'),
    attempt: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('How many times you have already asked about this ticket. Pass back `nextAttempt`.'),
  }),
  async execute({ ticket: id, attempt = 0 }) {
    const ticket = await pollUntil(id);
    if (ticket.status === 'failed') {
      throw new Error(ticket.error ?? 'That image request failed.');
    }
    return {
      status: ticket.status,
      ticket: ticket.ticket,
      images: ticket.images,
      alt: ticket.alt,
      assumptions: ticket.assumptions,
      ...(ticket.status === 'running'
        ? {
            // Backing off, so a slow render is not a hundred model calls that
            // all say the same thing.
            retryAfterMs: nextDelay(attempt + 1),
            nextAttempt: attempt + 1,
            note: `Still rendering (${ticket.pending} left). Ask again, and keep the ticket.`,
          }
        : {}),
    };
  },
});
