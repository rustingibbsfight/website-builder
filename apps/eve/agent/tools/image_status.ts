import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { readTicket } from '../../lib/studio';

/**
 * Ask again for a picture `request_image` did not finish waiting for.
 *
 * Asking *is* what moves it along — ComfyStudio has no worker of its own, so a
 * ticket nobody polls never finishes. Nothing is lost by asking again later:
 * the render is already submitted and paid for.
 */
export default defineTool({
  description:
    'Check a ComfyStudio image request that was still rendering. Takes the ticket from request_image and ' +
    'returns the image URLs once they are ready.',
  inputSchema: z.object({
    ticket: z.string().describe('The ticket id returned by request_image.'),
  }),
  async execute({ ticket: id }) {
    const ticket = await readTicket(id);
    if (ticket.status === 'failed') {
      throw new Error(ticket.error ?? 'That image request failed.');
    }
    return {
      status: ticket.status,
      ticket: ticket.ticket,
      images: ticket.images,
      alt: ticket.alt,
      assumptions: ticket.assumptions,
      ...(ticket.status === 'running' ? { note: `Still rendering (${ticket.pending} left).` } : {}),
    };
  },
});
