import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbGet } from '../../lib/wb';

/**
 * Read what people have sent through a site's contact forms.
 *
 * A Slack alert and an email go out when the deployment is configured for
 * them (PR #57), and best-effort: a failed notification is logged and
 * swallowed so it can never cost the visitor their message. Both of those mean
 * the same thing here — a notification is a nudge, and this is the record.
 *
 * So this stays the authoritative read, and asking is still the only way to be
 * sure. Worth offering when somebody asks after a site, rather than only when
 * they think to ask for it by name.
 */
export default defineTool({
  description:
    "Read form submissions captured for a site (contact form messages). Newest first. Optionally filter to one form " +
    "with formId. Alerts are best-effort and may not be configured at all, so this is the authoritative read.",
  inputSchema: z.object({
    siteId: z.string(),
    formId: z.string().optional().describe('Only this form. Omit for every form on the site.'),
    limit: z.number().int().min(1).max(200).optional().describe('How many to return. Defaults to 25.'),
  }),
  async execute({ siteId, formId, limit }) {
    const query = formId ? `?formId=${encodeURIComponent(formId)}` : '';
    const all = await wbGet<Array<{ id: string; formId: string; data: Record<string, string>; createdAt: string }>>(
      `/sites/${encodeURIComponent(siteId)}/submissions${query}`,
    );
    return {
      total: all.length,
      // Bounded so a site with a thousand messages doesn't arrive as one Slack
      // reply nobody can read. `total` still says how many there really are.
      submissions: all.slice(0, limit ?? 25),
    };
  },
});
