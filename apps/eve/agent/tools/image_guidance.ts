import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { guidance } from '../../lib/studio';

/**
 * What ComfyStudio currently accepts, asked rather than assumed.
 *
 * This tool exists because the alternative kept losing. The image vocabulary —
 * which purposes there are, which aspects, what a brand kit gets filed under —
 * belongs to ComfyStudio and changes there, and every previous attempt to make
 * this side *know* it was a copy that went stale. It had gone stale: five new
 * request fields and six new library categories existed and were unreachable
 * from here, because the enum was written before them.
 *
 * The interesting half is the **ontology**, which is what makes a brand kit
 * worth sending. A kit described as one paragraph gets filed as one thing, and
 * a picture cannot then vary its palette without varying its framing. Knowing
 * that `colour`, `composition`, `style` and `negative` are separate drawers is
 * what lets a brand be decomposed into parts that move independently — and the
 * hints are load-bearing, because `camera` and `style` are indistinguishable
 * from their names alone.
 *
 * Cheap and cached for a minute in `lib/studio.ts`, so calling it before a
 * batch of images costs one round trip rather than one per image.
 */
export default defineTool({
  description:
    'What the ComfyStudio image service currently accepts: the purposes, aspects, media and limits for ' +
    'request_image, the categories a brand kit is filed under, and which brands already exist. Call this ' +
    'before requesting images for a new site, or whenever a request came back with a rejected value — the ' +
    'lists live in ComfyStudio and change there, so this is the current answer rather than a remembered one.',
  inputSchema: z.object({}),
  async execute() {
    const current = await guidance();
    return {
      version: current.version,
      request: current.request,
      // Passed through whole, hints included. A summary here would be this
      // file deciding what matters about a list it deliberately does not know.
      ontology: current.ontology,
      brands: current.brands,
    };
  },
});
