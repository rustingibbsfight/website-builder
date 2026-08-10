import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { pollUntil } from '../../lib/tickets';

/**
 * Collect a picture `request_image` started.
 *
 * **Asking is what advances it** — the studio has no worker of its own, so a
 * ticket nobody polls never finishes. Nothing is lost by asking again later:
 * the render is already submitted and paid for, and the ticket is durable on
 * the wb side, so even losing this conversation does not strand it.
 *
 * This call is where the picture becomes an **asset of the site**, so the
 * assetId it returns is what goes into a page. Collecting twice is safe and
 * cheap: a settled ticket answers from the stored row without re-fetching, so
 * a model that asks once more to be sure does not buy or store a second copy.
 */
export default defineTool({
  description:
    'Check and collect an image request started by request_image. Returns the assetId once the picture is ' +
    'ready — put that straight into an image prop as {image:{assetId, alt}}. Safe to call repeatedly: a ' +
    'finished request answers from what was already collected.',
  inputSchema: z.object({
    siteId: z.string().describe('The site the request was made for.'),
    ticket: z.string().describe('The ticket id returned by request_image.'),
  }),
  async execute({ siteId, ticket }) {
    const result = await pollUntil(siteId, ticket);

    if (result.status === 'failed') {
      throw new Error(result.error ?? 'That image request failed.');
    }

    return {
      status: result.status,
      ticket: result.id,
      ...(result.assetIds ? { assetIds: result.assetIds } : {}),
      // Straight into the <img>. A picture with no alt is this integration
      // quietly making the site worse.
      ...(result.alt ? { alt: result.alt } : {}),
      ...(result.status === 'ready' && result.assetIds?.[0]
        ? { use: { image: { assetId: result.assetIds[0], alt: result.alt ?? '<describe it>' } } }
        : {}),
      ...(result.status === 'running'
        ? {
            note:
              'Still rendering. Ask again in a few seconds and keep the ticket — asking is what advances ' +
              'it, and it is already paid for.',
          }
        : {}),
    };
  },
});
