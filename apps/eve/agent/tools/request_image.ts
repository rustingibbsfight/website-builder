import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { askForImage, nextDelay } from '../../lib/studio';

/**
 * Ask ComfyStudio for a picture.
 *
 * Deliberately says nothing about how images are made. You describe what the
 * *page* needs and the studio's own agent chooses the model, the workflow and
 * the prompt — which is what keeps this tool working when it changes any of
 * them. There is no field here for a workflow, a checkpoint or a prompt, and
 * one should not be added: an integration that names a workflow breaks the
 * first time that workflow is republished.
 *
 * **And it no longer names the values either.** `purpose` was a `z.enum` of six
 * literals and `aspect` one of five, copied from the studio. That is the same
 * mistake one level down: the studio grew `width`, `height`, `media`, `seconds`
 * and `brand`, and this schema could not express any of them — a feature
 * shipped at one end and unreachable from the other.
 *
 * A zod enum here would also be the *worst* place to hold the list, because it
 * fails closed and silently: the model never sees the seventh purpose, so it
 * never asks for it, so nobody notices. Strings plus `image_guidance` fails the
 * other way — a wrong value comes back as the studio's own error naming the
 * whole accepted list, which the model can act on in the same turn.
 */

/**
 * It does not wait, and that is a correctness fix rather than a speed one.
 *
 * This used to submit and then poll for up to 150 seconds inside one tool call.
 * The ticket is the **receipt for a spend**, and holding the only copy of it
 * inside a call the platform can kill means a render that was submitted and
 * paid for and whose id exists nowhere the agent can see. `apps/eve` has no
 * `vercel.json`, so its `maxDuration` is the platform default — nowhere near
 * 150 seconds — which made that the likely outcome rather than the unlucky one.
 *
 * It also made the editor's chat panel look frozen: a turn that emits no events
 * for two and a half minutes is indistinguishable from a stuck one, and the
 * panel now has somebody watching it.
 *
 * So the ticket comes back immediately and `image_status` does the waiting, on
 * a later call, once the id is safely written into the transcript. The cost is
 * one extra model call on a render that would have landed inside the old
 * window; the thing bought is that no render is ever unreachable.
 */

export default defineTool({
  description:
    'Ask the ComfyStudio image agent to make an original image or clip for a page. Describe what the page ' +
    'needs — purpose, subject, mood, palette, the exact slot size, where a headline will sit — not how to ' +
    'make it. Call image_guidance first if you are unsure what a field accepts; the accepted values live in ' +
    'ComfyStudio and change there. Returns URLs and alt text. If it is still rendering, call image_status.',
  inputSchema: z.object({
    purpose: z
      .string()
      .describe('What the image is for on the page, e.g. hero. image_guidance lists what is accepted.'),
    subject: z.string().describe('What the picture is of, in plain words.'),
    mood: z.string().optional().describe('e.g. "calm, clinical" or "warm, lived-in".'),
    palette: z
      .array(z.string())
      .optional()
      .describe("The site's colours as hex, so the picture belongs to the page it lands on."),
    aspect: z.string().optional().describe('Shape, when you have not laid the slot out yet. e.g. 16/9.'),
    width: z
      .number()
      .optional()
      .describe('Exact slot width in pixels. Prefer this over aspect once the layout is decided.'),
    height: z.number().optional().describe('Exact slot height. Either edge alone is enough.'),
    minWidth: z.number().optional().describe('A floor under whatever the size works out to.'),
    media: z.string().optional().describe('"image" (default) or "video" for a clip.'),
    seconds: z.number().optional().describe('How long a clip runs. Only with media: "video".'),
    brand: z
      .string()
      .optional()
      .describe('A kit already sent with brand_kit. Gets the same look again without re-describing it.'),
    textSafe: z
      .string()
      .optional()
      .describe('Where a headline will sit, so the composition leaves room for it. e.g. left.'),
    avoid: z.array(z.string()).optional().describe('e.g. ["people", "text", "logos"].'),
    count: z.number().int().min(1).max(4).optional().describe('How many to choose between. Defaults to 1.'),
  }),
  async execute(spec) {
    const ticket = await askForImage(spec);

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
        ? {
            // Told when to come back, so the first poll is not instant. Asking
            // is what advances it, but asking a hundred times in a row is a
            // hundred model calls that all say "still running".
            retryAfterMs: nextDelay(0),
            note:
              `Submitted and paid for (${ticket.pending} rendering). Call image_status with ticket ` +
              `"${ticket.ticket}" in a few seconds — it waits a little on your behalf. Do not discard ` +
              `the ticket: it is the only way to collect this render.`,
          }
        : {}),
    };
  },
});
