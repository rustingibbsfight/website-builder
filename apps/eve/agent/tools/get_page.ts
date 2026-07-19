import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbGet } from '../../lib/wb';

export default defineTool({
  description:
    'Read a page: metadata + the full component tree JSON. Node ids in the tree are what edit_page ops target.',
  inputSchema: z.object({
    siteId: z.string(),
    page: z.string().describe('Page id or slug ("index" for the home page)'),
  }),
  async execute({ siteId, page }) {
    return wbGet(`/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(page || 'index')}`);
  },
});
