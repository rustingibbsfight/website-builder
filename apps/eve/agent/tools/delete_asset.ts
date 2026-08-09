import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbDelete } from '../../lib/wb';

/**
 * Remove an asset from a site.
 *
 * Worth having because assets accumulate invisibly: every rejected generated
 * image and every re-upload of the same logo stays in the site's storage and
 * ships with the deploy. Nothing on any page necessarily references it, so
 * nothing draws attention to it either.
 *
 * The deletion does not check whether a page still points at the asset — wb's
 * own `deleteAsset` doesn't either. A node whose `assetId` no longer resolves
 * renders without its image, so say what was removed rather than assuming it
 * was unused.
 */
export default defineTool({
  description:
    'Delete an asset from a site. Destructive: any image prop still referencing it will render without ' +
    'a picture, so check first if you did not just add it yourself.',
  inputSchema: z.object({
    siteId: z.string(),
    assetId: z.string(),
  }),
  async execute({ siteId, assetId }) {
    await wbDelete(`/sites/${encodeURIComponent(siteId)}/assets/${encodeURIComponent(assetId)}`);
    return { ok: true, deleted: assetId };
  },
});
