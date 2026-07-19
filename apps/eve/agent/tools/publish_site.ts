import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

export default defineTool({
  description:
    'Render the site to its deployable static build (responsive HTML/CSS). Returns the file list and SEO/accessibility lint warnings. Use after content edits; use deploy_site to actually put it live.',
  inputSchema: z.object({
    siteId: z.string(),
  }),
  async execute({ siteId }) {
    return wbPost(`/sites/${encodeURIComponent(siteId)}/publish`, {});
  },
});
