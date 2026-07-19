import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbGet } from '../../lib/wb';

export default defineTool({
  description:
    'List available site templates (name, pages, brandable tokens). Call before create_site when the user wants a ready-made site.',
  inputSchema: z.object({}),
  async execute() {
    return wbGet('/templates');
  },
});
