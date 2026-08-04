import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { requestAndWait } from '../../lib/studio';

/**
 * Ask ComfyStudio for a picture.
 *
 * Deliberately says nothing about how images are made. You describe what the
 * *page* needs and the studio's own agent chooses the model, the workflow and
 * the prompt — which is what keeps this tool working when it changes any of
 * them. There is no field here for a workflow, a checkpoint or a prompt, and
 * one should not be added: an integration that names a workflow breaks the
 * first time that workflow is republished.
 */

/** Most of a render, without holding a tool call open for a whole one. */
const WAIT_MS = 150_000;

export default defineTool({
  description:
    'Ask the ComfyStudio image agent to make an original image for a page. Describe what the page needs — ' +
    'purpose, subject, mood, palette, where a headline will sit — not how to make it. Returns image URLs and ' +
    'alt text. If it is still rendering when this returns, call image_status with the ticket.',
  inputSchema: z.object({
    purpose: z
      .enum(['hero', 'section', 'card', 'background', 'icon', 'portrait'])
      .describe('What the image is for on the page. Sets the shape and the level of detail.'),
    subject: z.string().describe('What the picture is of, in plain words.'),
    mood: z.string().optional().describe('e.g. "calm, clinical" or "warm, lived-in".'),
    palette: z
      .array(z.string())
      .optional()
      .describe("The site's colours as hex, so the picture belongs to the page it lands on."),
    aspect: z.enum(['16/9', '4/3', '1/1', '3/4', '21/9']).optional().describe('Overrides the purpose default.'),
    minWidth: z.number().optional().describe('Smallest acceptable width in pixels. Capped at 2048.'),
    textSafe: z
      .enum(['none', 'left', 'right', 'top', 'bottom', 'centre'])
      .optional()
      .describe('Where a headline will sit, so the composition leaves room for it.'),
    avoid: z.array(z.string()).optional().describe('e.g. ["people", "text", "logos"].'),
    count: z.number().int().min(1).max(4).optional().describe('How many to choose between. Defaults to 1.'),
  }),
  async execute(spec) {
    const ticket = await requestAndWait(spec, WAIT_MS);

    if (ticket.status === 'failed') {
      throw new Error(ticket.error ?? 'ComfyStudio could not make that image.');
    }

    return {
      status: ticket.status,
      ticket: ticket.ticket,
      images: ticket.images,
      // Straight into the <img>. A picture with no alt is this integration
      // quietly making the site worse.
      alt: ticket.alt,
      // What the studio's agent had to decide that the brief did not cover —
      // how a wrong picture is diagnosable without reading its transcript.
      assumptions: ticket.assumptions,
      ...(ticket.status === 'running'
        ? { note: `Still rendering (${ticket.pending} left). Call image_status with ticket "${ticket.ticket}".` }
        : {}),
    };
  },
});
