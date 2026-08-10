import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

/**
 * Ask for a picture for a page, and get it as an asset of that site.
 *
 * Two things changed when this moved onto the wb API, and both are the point
 * rather than plumbing.
 *
 * **It names a site, and the picture lands in it.** Before, this returned URLs
 * on ComfyStudio's storage and the model had to remember to call `add_asset`
 * afterwards — two steps, of which the second was skippable, so a page could
 * end up pointing at a picture on somebody else's deployment. Publishing that
 * site then depended on that deployment staying up. One call now, and the
 * assetId comes back.
 *
 * **The studio credential is no longer here.** This app used to hold its own
 * `STUDIO_API_KEY`, which is a second place a key leaks from and a second place
 * it has to be rotated — for no gain, since nothing this app does with it needs
 * the key rather than the answer. wb-api holds it, along with the ticket store
 * and the ingest guard.
 *
 * **The vocabulary is still not written down here.** `purpose` was once a
 * `z.enum` of six literals and `aspect` one of five, copied from the studio;
 * the studio then grew five request fields that could not be sent from here at
 * all. A copied enum fails closed and silently — the model never sees the
 * seventh purpose, so it never asks for it, so nobody notices. Strings plus
 * `image_guidance` fails the other way: a wrong value comes back as the
 * studio's own error naming the whole accepted list, which the model can act on
 * in the same turn.
 */

/**
 * It does not wait, and that is a correctness fix rather than a speed one.
 *
 * This used to submit and then poll for up to 150 seconds inside one tool call.
 * The ticket is the **receipt for a spend**, and holding the only copy of it
 * inside a call the platform can kill means a render that was submitted and
 * paid for and whose id exists nowhere anybody can see. `apps/eve` has no
 * `vercel.json`, so its `maxDuration` is the platform default — nowhere near
 * 150 seconds — which made that the likely outcome rather than the unlucky one.
 *
 * The ticket is now durable on the wb side too, so even losing this transcript
 * does not strand a render: the site's open tickets can be listed.
 */

export default defineTool({
  description:
    'Ask for an original image or clip for a page, and add it to that site as an asset. Describe what the ' +
    'page needs — purpose, subject, mood, the exact slot size, where a headline will sit — not how to make ' +
    'it. Call image_guidance first if you are unsure what a field accepts. The palette defaults to the ' +
    "site's own theme. Returns a ticket; call image_status with it to collect the finished picture.",
  inputSchema: z.object({
    siteId: z.string().describe('The site the picture is for. It becomes an asset of this site.'),
    purpose: z
      .string()
      .describe('What the image is for on the page, e.g. hero. image_guidance lists what is accepted.'),
    subject: z.string().describe('What the picture is of, in plain words.'),
    mood: z.string().optional().describe('e.g. "calm, clinical" or "warm, lived-in".'),
    palette: z
      .array(z.string())
      .optional()
      .describe("Hex colours. Leave it out to use the site's own theme, which is usually what you want."),
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
  async execute({ siteId, ...spec }) {
    const ticket = await wbPost<{ id: string; status: string }>(
      `/sites/${encodeURIComponent(siteId)}/assets/generate`,
      spec,
    );

    return {
      status: ticket.status,
      ticket: ticket.id,
      note:
        `Submitted and paid for. Call image_status with ticket "${ticket.id}" and siteId "${siteId}" in a ` +
        'few seconds — asking is what advances it. Do not discard the ticket: it is how this render is ' +
        'collected, and asking again later costs nothing because it is already paid for.',
    };
  },
});
