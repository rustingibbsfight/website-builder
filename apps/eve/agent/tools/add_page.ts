import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

/**
 * One call, so a page cannot arrive half-made.
 *
 * This used to POST the page and then PATCH the description onto it. A failed
 * second call left a page with no meta description and nothing anywhere
 * recording that one had been asked for — the page looked finished and was
 * not. The API takes `meta` at creation now, so there is one request and one
 * outcome.
 */
export default defineTool({
  description: 'Add a page to a site (empty page-root unless a full tree is provided).',
  inputSchema: z.object({
    siteId: z.string(),
    slug: z.string().describe('lowercase-hyphen slug, e.g. "pricing" ("" for home)'),
    title: z.string(),
    description: z.string().optional().describe('Meta description for SEO'),
    tree: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Optional full page tree rooted at a page-root node'),
  }),
  async execute({ siteId, slug, title, description, tree }) {
    return wbPost(`/sites/${encodeURIComponent(siteId)}/pages`, {
      slug,
      title,
      ...(tree ? { tree } : {}),
      ...(description ? { meta: { description } } : {}),
    });
  },
});
