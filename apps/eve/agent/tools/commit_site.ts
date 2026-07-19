import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

export default defineTool({
  description:
    "Commit a site's current source + rendered build to its GitHub version-control repo, without deploying it live. Use to snapshot a checkpoint or when the user asks to save/commit progress. Returns the repo and commit URL — report them.",
  inputSchema: z.object({
    siteId: z.string(),
    message: z.string().optional().describe('Commit message (defaults to a timestamped publish message)'),
  }),
  async execute({ siteId, message }) {
    return wbPost(`/sites/${siteId}/commit`, message ? { message } : {});
  },
});
