import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPut } from '../../lib/wb';

export default defineTool({
  description:
    'Update theme tokens (partial merge): colors (hex), fonts (serif-classic|serif-modern|sans-modern|sans-geometric|sans-humanist|mono), brandName, radiusScale (sharp|soft|round). The whole site restyles automatically.',
  inputSchema: z.object({
    siteId: z.string(),
    colors: z.record(z.string(), z.string()).optional(),
    fonts: z.object({ heading: z.string().optional(), body: z.string().optional() }).optional(),
    brandName: z.string().optional(),
    radiusScale: z.enum(['sharp', 'soft', 'round']).optional(),
  }),
  async execute({ siteId, ...patch }) {
    return wbPut(`/sites/${encodeURIComponent(siteId)}/theme`, patch);
  },
});
