import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPatch } from '../../lib/wb';

/**
 * Rename a page, move it, or fix its SEO — without touching its content.
 *
 * `edit_page` changes what is *on* a page; this changes what the page *is*.
 * They were one gap before: asked to "call that page Pricing instead of
 * Prices", Eve had no verb for it and had to say so.
 */
export default defineTool({
  description:
    "Change a page's slug, title, SEO meta or position in the nav — not its content (use edit_page for that). " +
    'Only the fields you pass are changed.',
  inputSchema: z.object({
    siteId: z.string(),
    pageId: z.string().describe('Page id or slug'),
    slug: z.string().optional().describe('New lowercase-hyphen slug ("" for home)'),
    title: z.string().optional(),
    meta: z
      .object({
        description: z.string().optional().describe('Meta description for SEO'),
        ogImage: z.string().optional(),
        noindex: z.boolean().optional(),
      })
      .partial()
      .optional(),
    sortOrder: z.number().int().optional().describe('Position among the site’s pages, low to high'),
  }),
  async execute({ siteId, pageId, ...patch }) {
    return wbPatch(
      `/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}`,
      patch,
    );
  },
});
