import { defineTool } from 'eve/tools';
import { z } from 'zod';

/** What the studio filed the kit as. Its shape, relayed by wb-api. */
interface SavedBrand {
  brand: string;
  tag: string;
  snippets: { name: string; kind: string }[];
}

import { wbGet, wbPost } from '../../lib/wb';

/**
 * Teach ComfyStudio a brand, once, so every later picture matches.
 *
 * The problem is not the first image. It is the **ninth**: a site's pictures
 * arrive over a week, from different pages, and describing the look afresh in
 * each `request_image` means it is re-interpreted each time. By the third
 * reading it is a different brand — subtly warmer, differently framed — and
 * nobody can point at the call where it drifted.
 *
 * Sending the same paragraph every time does not fix that, because the
 * paragraph was never the stable thing. What is stable is the *stored* words.
 * A kit sent here is decomposed by the studio's agent into parts, filed under
 * its library categories, and named; every later request carrying
 * `brand: "<name>"` is written against those parts rather than a fresh reading.
 *
 * **So send this once per site, early**, before the images. Sending it again
 * with a changed description edits the kit rather than making a second one —
 * which is how a brand is corrected once somebody has seen a picture and
 * disagreed with it.
 *
 * What it does *not* do is delete. A kit that has parts you no longer want is
 * tidied in ComfyStudio's own library by its owner. This side can create and
 * amend; a tool that could also destroy library rows is one bad turn away from
 * emptying somebody's library.
 */
export default defineTool({
  description:
    "Teach ComfyStudio a site's brand so every image made for it matches. Send this once per site, before " +
    'requesting images, then pass brand: "<name>" to request_image. Sending it again with a changed ' +
    'description edits the kit rather than adding a second one. Call with no arguments to list the brands ' +
    'that already exist.',
  inputSchema: z.object({
    name: z
      .string()
      .optional()
      .describe('What later image requests will call this brand. Omit everything to list existing brands.'),
    description: z
      .string()
      .optional()
      .describe(
        'What the brand looks like: photography style, framing, lighting, how much empty space, what it ' +
          'never does. Prose is fine — ComfyStudio decomposes it. Call image_guidance to see the ' +
          'categories it will be filed under, which is what makes the parts vary independently.',
      ),
    palette: z.array(z.string()).optional().describe("The brand's colours as hex."),
    voice: z
      .array(z.string()).optional()
      .describe('Words the brand uses about itself — "quiet", "engineered", "warm".'),
    avoid: z
      .array(z.string())
      .optional()
      .describe('What it never does. Becomes the negative prompt part, e.g. ["lens flare", "stock smiles"].'),
  }),
  async execute(input) {
    // No name and no description is the listing call. Treated as a question
    // rather than a malformed write, because "which brands are there" is the
    // thing somebody asks first and there is no reason to make it a second tool.
    if (!input.name && !input.description) {
      return { brands: (await wbGet<{ brands: string[] }>('/images/brands')).brands };
    }
    if (!input.name || !input.description) {
      throw new Error('A brand kit needs both a name and a description, or neither to list what exists.');
    }

    const saved = await wbPost<SavedBrand>('/images/brands', {
      name: input.name,
      description: input.description,
      ...(input.palette?.length ? { palette: input.palette } : {}),
      ...(input.voice?.length ? { voice: input.voice } : {}),
      ...(input.avoid?.length ? { avoid: input.avoid } : {}),
    });

    return {
      brand: saved.brand,
      // What it was actually decomposed into, so a kit that came back as one
      // vague part is visible here rather than three pictures later.
      parts: saved.snippets,
      note: `Pass brand: "${saved.brand}" to request_image from now on.`,
    };
  },
});
