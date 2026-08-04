import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

/**
 * Put a file into a site by naming where it lives.
 *
 * This tool used to fetch the URL itself, which meant carrying its own SSRF
 * guard, its own streamed byte cap and its own MIME table — a near-identical
 * second copy of the ones in the MCP server. Two implementations of one
 * security rule is the shape where a fix lands on one of them and the other
 * stays exploitable, quietly, for as long as nobody diffs them.
 *
 * So the address goes to the wb API and the *server* does the reaching, using
 * the single implementation in `@wb/core`. Eve is a client; a client that
 * fetches arbitrary addresses on the caller's behalf is a proxy, and this one
 * has no reason to be.
 *
 * It is also cheaper in the way that matters here: a 12 MB image no longer
 * travels into this function's memory, gets base64'd (a third bigger again) and
 * travels out. The tool sends a URL.
 */
export default defineTool({
  description:
    'Add an image/file asset to a site from a URL. Returns the assetId to reference in image props ({image:{assetId, alt}}).',
  inputSchema: z.object({
    siteId: z.string(),
    filename: z.string(),
    url: z.string().describe('URL to fetch the asset from'),
    mime: z.string().optional().describe('MIME type (inferred from the response/filename if omitted)'),
  }),
  async execute({ siteId, filename, url, mime }) {
    return wbPost(`/sites/${encodeURIComponent(siteId)}/assets`, {
      filename,
      url,
      ...(mime ? { mime } : {}),
    });
  },
});
