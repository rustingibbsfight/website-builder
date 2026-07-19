import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

export default defineTool({
  description:
    'Deploy a site LIVE to the internet and return its public URL (renders the latest content and pushes it to the configured hosting target). Also commits the source + build to the site\'s GitHub repo for version history (the response includes versionControl.repoUrl and commitUrl — mention the repo link too). Only call when the user explicitly asks to deploy / go live / ship it. Always report the returned url to the user.',
  inputSchema: z.object({
    siteId: z.string(),
  }),
  async execute({ siteId }) {
    return wbPost(`/sites/${siteId}/deploy`, {});
  },
});
