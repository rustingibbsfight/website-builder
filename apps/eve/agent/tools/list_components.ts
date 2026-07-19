import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbGet } from '../../lib/wb';

export default defineTool({
  description:
    'Discover buildable components. Without type: all component summaries. With type: the full JSON Schema for its props plus defaults — call this before inserting a component you have not used yet. Nodes also accept layout {direction: stack|row|grid, gap/padding tokens none-2xl, columns, maxWidth content|wide|full}, style {background/color tokens, radius, shadow, minHeight}, and responsive {tablet/mobile} deltas.',
  inputSchema: z.object({
    type: z.string().optional().describe('e.g. "hero", "featureGrid"'),
  }),
  async execute({ type }) {
    return type ? wbGet(`/components/${type}`) : wbGet('/components');
  },
});
