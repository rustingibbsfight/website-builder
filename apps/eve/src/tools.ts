import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { EveConfig } from './config.js';
import type { WbClient } from './wb-client.js';

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/**
 * Eve's tool belt — thin wrappers over the wb REST API. Each returns raw JSON
 * text; errors are returned as text so Claude can self-correct and retry.
 */
export function buildTools(wb: WbClient, config: EveConfig) {
  const run =
    <I>(fn: (input: I) => Promise<unknown>) =>
    async (input: I): Promise<string> => {
      try {
        return asText(await fn(input));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

  const treeOpItems = {
    type: 'object' as const,
    description:
      'One tree op. insert: {op:"insert", parentId, index?, node}. update: {op:"update", nodeId, props?/layout?/style? (shallow-merged; null value deletes a key), responsive?}. move: {op:"move", nodeId, parentId, index}. remove: {op:"remove", nodeId}. replace: {op:"replace", nodeId, node}.',
  };

  return [
    betaTool({
      name: 'list_templates',
      description:
        'List available site templates (name, pages, brandable tokens). Call before create_site when the user wants a ready-made site.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: run(async () => wb.get('/templates')),
    }),

    betaTool({
      name: 'create_site',
      description:
        'Create a website in one call — from a template with brand overrides (colors as #hex, fonts, brand name, logo URL), or blank. Returns siteId and page ids. This is the one-command path to a full branded site.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Site / brand name' },
          template: {
            type: 'string',
            description: 'Template from list_templates (e.g. "breakthrough-medical"); omit for blank',
          },
          brand: {
            type: 'object',
            description:
              'Brand overrides: {brandName?, colors?: {primary?, secondary?, accent?, background?, surface?, text?, textMuted?}, fonts?: {heading?, body?}, logoUrl?, baseUrl?}',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      run: run(async (input: { name: string; template?: string; brand?: Record<string, unknown> }) =>
        input.template
          ? wb.post('/sites/from-template', {
              template: input.template,
              name: input.name,
              ...(input.brand ? { brand: input.brand } : {}),
            })
          : wb.post('/sites', { name: input.name }),
      ),
    }),

    betaTool({
      name: 'get_site',
      description:
        'Without siteId: list all sites. With siteId: full site details — theme, settings, pages with ids/slugs.',
      inputSchema: {
        type: 'object',
        properties: { siteId: { type: 'string' } },
        additionalProperties: false,
      },
      run: run(async (input: { siteId?: string }) => {
        if (!input.siteId) return wb.get('/sites');
        const [site, pages] = await Promise.all([
          wb.get(`/sites/${input.siteId}`),
          wb.get(`/sites/${input.siteId}/pages`),
        ]);
        return { site, pages };
      }),
    }),

    betaTool({
      name: 'get_page',
      description:
        'Read a page: metadata + full component tree JSON. Node ids in the tree are what edit_page ops target.',
      inputSchema: {
        type: 'object',
        properties: {
          siteId: { type: 'string' },
          page: { type: 'string', description: 'Page id or slug ("" or "index" = home)' },
        },
        required: ['siteId', 'page'],
        additionalProperties: false,
      },
      run: run(async (input: { siteId: string; page: string }) =>
        wb.get(`/sites/${input.siteId}/pages/${encodeURIComponent(input.page || 'index')}`),
      ),
    }),

    betaTool({
      name: 'list_components',
      description:
        'Discover buildable components. Without type: all component summaries. With type: full JSON Schema for its props + defaults — call this before inserting a component you have not used yet.',
      inputSchema: {
        type: 'object',
        properties: { type: { type: 'string', description: 'e.g. "hero", "featureGrid"' } },
        additionalProperties: false,
      },
      run: run(async (input: { type?: string }) =>
        input.type ? wb.get(`/components/${input.type}`) : wb.get('/components'),
      ),
    }),

    betaTool({
      name: 'edit_page',
      description:
        'Edit a page tree with an atomic batch of ops (insert/update/move/remove/replace). Either all ops apply, or nothing changes and the error names the failing op index — fix and retry. Nodes support layout {direction: stack|row|grid, gap/padding tokens none-2xl, columns, maxWidth content|wide|full}, style {background/color tokens, radius, shadow, minHeight}, and responsive {tablet/mobile deltas}.',
      inputSchema: {
        type: 'object',
        properties: {
          siteId: { type: 'string' },
          page: { type: 'string', description: 'Page id or slug' },
          ops: { type: 'array', items: treeOpItems, minItems: 1 },
        },
        required: ['siteId', 'page', 'ops'],
        additionalProperties: false,
      },
      run: run(async (input: { siteId: string; page: string; ops: unknown[] }) =>
        wb.post(`/sites/${input.siteId}/pages/${encodeURIComponent(input.page || 'index')}/tree/ops`, {
          ops: input.ops,
        }),
      ),
    }),

    betaTool({
      name: 'add_page',
      description: 'Add a page to a site (empty page-root unless a full tree is provided).',
      inputSchema: {
        type: 'object',
        properties: {
          siteId: { type: 'string' },
          slug: { type: 'string', description: 'lowercase-hyphen slug; "" for home' },
          title: { type: 'string' },
          tree: { type: 'object', description: 'Optional full tree rooted at a page-root node' },
        },
        required: ['siteId', 'slug', 'title'],
        additionalProperties: false,
      },
      run: run(async (input: { siteId: string; slug: string; title: string; tree?: unknown }) =>
        wb.post(`/sites/${input.siteId}/pages`, {
          slug: input.slug,
          title: input.title,
          ...(input.tree ? { tree: input.tree } : {}),
        }),
      ),
    }),

    betaTool({
      name: 'set_theme',
      description:
        'Update theme tokens (partial merge): colors (#hex), fonts (serif-classic|serif-modern|sans-modern|sans-geometric|sans-humanist|mono), brandName, radiusScale (sharp|soft|round). Restyles the whole site.',
      inputSchema: {
        type: 'object',
        properties: {
          siteId: { type: 'string' },
          colors: { type: 'object' },
          fonts: { type: 'object' },
          brandName: { type: 'string' },
          radiusScale: { type: 'string', enum: ['sharp', 'soft', 'round'] },
        },
        required: ['siteId'],
        additionalProperties: false,
      },
      run: run(async ({ siteId, ...patch }: { siteId: string } & Record<string, unknown>) =>
        wb.put(`/sites/${siteId}/theme`, patch),
      ),
    }),

    betaTool({
      name: 'publish_site',
      description:
        'Render the site to its deployable static build (HTML/CSS). Returns dist path, file list, and SEO/accessibility warnings. Do this after edits so changes are reflected in the built site.',
      inputSchema: {
        type: 'object',
        properties: { siteId: { type: 'string' } },
        required: ['siteId'],
        additionalProperties: false,
      },
      run: run(async (input: { siteId: string }) => wb.post(`/sites/${input.siteId}/publish`, {})),
    }),

    betaTool({
      name: 'deploy_site',
      description: `Publish AND deploy a site via the configured adapter${
        config.deployAdapter ? ` (${config.deployAdapter})` : ''
      }. Only call when the user explicitly asks to deploy/go live.`,
      inputSchema: {
        type: 'object',
        properties: {
          siteId: { type: 'string' },
          adapter: {
            type: 'string',
            enum: ['static', 'vercel', 'netlify', 'cloudflare'],
            description: 'Defaults to the server-configured adapter',
          },
        },
        required: ['siteId'],
        additionalProperties: false,
      },
      run: run(async (input: { siteId: string; adapter?: string }) =>
        wb.post(`/sites/${input.siteId}/deploy`, {
          adapter: input.adapter ?? config.deployAdapter ?? 'static',
        }),
      ),
    }),
  ];
}
