import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPatch } from '../../lib/wb';

/**
 * Rename a site, or fix the settings that decide where things point.
 *
 * `baseUrl` and `formEndpoint` are the two that matter and the two nobody
 * thinks about until something is broken: `baseUrl` is what the sitemap and
 * the canonical tags are built from, and `formEndpoint` is where a contact
 * form posts. A site created before `WB_PUBLIC_URL` was configured has an
 * empty `formEndpoint`, which is a form that silently discards every message
 * — the exact bug that shipped on three live sites. This is the verb that
 * repairs one without a redeploy.
 */
export default defineTool({
  description:
    "Change a site's name or its settings (locale, favicon, baseUrl for SEO, formEndpoint for contact " +
    'forms). Only the fields you pass are changed. Use this to repair a site whose contact form posts ' +
    'nowhere, or whose canonical URLs are wrong.',
  inputSchema: z.object({
    siteId: z.string(),
    name: z.string().optional(),
    settings: z
      .object({
        locale: z.string().optional(),
        favicon: z.string().optional(),
        baseUrl: z.string().optional().describe('Canonical public URL, used for sitemap and SEO tags'),
        formEndpoint: z
          .string()
          .optional()
          .describe('Absolute URL of the wb API that contact forms post to'),
      })
      .partial()
      .optional(),
  }),
  async execute({ siteId, ...patch }) {
    return wbPatch(`/sites/${encodeURIComponent(siteId)}`, patch);
  },
});
