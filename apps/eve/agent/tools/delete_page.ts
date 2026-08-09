import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbDelete } from '../../lib/wb';

/**
 * Remove a page.
 *
 * Destructive and irreversible — there is no undo on the wb side, and the
 * page's tree goes with it. The instructions say to confirm first; that is a
 * rule the model follows rather than a lock, which is the right level for a
 * single page. It is deliberately not the level chosen for a whole *site*:
 * there is no `delete_site` tool at all, because "confirm first" is not a
 * strong enough guard for losing every page at once, and a capability that is
 * absent cannot be talked past.
 */
export default defineTool({
  description:
    'Delete a page from a site. Destructive and irreversible — confirm with the user first unless they ' +
    'just asked for exactly this. Returns nothing on success.',
  inputSchema: z.object({
    siteId: z.string(),
    pageId: z.string().describe('Page id or slug'),
  }),
  async execute({ siteId, pageId }) {
    await wbDelete(`/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}`);
    return { ok: true, deleted: pageId };
  },
});
