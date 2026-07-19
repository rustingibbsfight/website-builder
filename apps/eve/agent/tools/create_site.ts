import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

export default defineTool({
  description:
    'Create a website in one call — from a template with brand overrides (hex colors, fonts, brand name, logo URL), or blank. Returns the siteId and page ids. This is the one-command path to a full branded site.',
  inputSchema: z.object({
    name: z.string().describe('Site / brand name'),
    template: z
      .string()
      .optional()
      .describe('Template from list_templates (e.g. "breakthrough-medical"); omit for a blank site'),
    brand: z
      .object({
        brandName: z.string().optional(),
        colors: z
          .record(z.string(), z.string())
          .optional()
          .describe('Hex overrides: primary, secondary, accent, background, surface, text, textMuted'),
        fonts: z
          .object({ heading: z.string().optional(), body: z.string().optional() })
          .optional()
          .describe('serif-classic|serif-modern|sans-modern|sans-geometric|sans-humanist|mono'),
        logoUrl: z.string().optional(),
        baseUrl: z.string().optional().describe('Canonical site URL for SEO/sitemap'),
      })
      .optional()
      .describe('Brand overrides applied to the template theme'),
  }),
  async execute({ name, template, brand }) {
    if (!template) return wbPost('/sites', { name });
    return wbPost('/sites/from-template', { template, name, ...(brand ? { brand } : {}) });
  },
});
