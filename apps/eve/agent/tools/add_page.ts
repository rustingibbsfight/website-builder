import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost, wbRequest } from '../../lib/wb';

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
    const page = await wbPost<{ id: string }>(`/sites/${siteId}/pages`, {
      slug,
      title,
      ...(tree ? { tree } : {}),
    });
    if (description) {
      await wbRequest('PATCH', `/sites/${siteId}/pages/${page.id}`, { meta: { description } });
    }
    return page;
  },
});
