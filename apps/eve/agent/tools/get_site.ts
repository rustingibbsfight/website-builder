import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbGet } from '../../lib/wb';

export default defineTool({
  description:
    'Without siteId: list all sites. With siteId: full site details — theme, settings, and pages with their ids/slugs.',
  inputSchema: z.object({
    siteId: z.string().optional().describe('Omit to list all sites'),
  }),
  async execute({ siteId }) {
    if (!siteId) return wbGet('/sites');
    const enc = encodeURIComponent(siteId);
    const [site, pages] = await Promise.all([wbGet(`/sites/${enc}`), wbGet(`/sites/${enc}/pages`)]);
    return { site, pages };
  },
});
