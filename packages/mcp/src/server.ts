import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { componentJsonSchema, componentSummary, getComponent, listComponents } from '@wb/components';
import { WbCore, guessMime } from '@wb/core';
import { NodeInputSchema, ThemeSchema, TreeOpSchema, normalizeSlug } from '@wb/schema';
import { z } from 'zod';
import { treeOutline } from './outline.js';

export interface McpDeps {
  core: WbCore;
  /** Returns the base URL of a running preview server (starting it if needed). */
  ensurePreviewServer: () => Promise<string>;
}

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

const errText = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

// The SSRF guard, the streamed byte cap and the MIME table used to live here
// and, near-identically, in Eve's own add_asset tool. They are one
// implementation now — `@wb/core`'s fetch-asset — reached through
// `core.addAssetFromUrl`, which guards before it reads and writes nothing if
// the guard throws.

const BrandShape = z
  .object({
    brandName: z.string().optional(),
    colors: ThemeSchema.shape.colors.partial().optional().describe('Hex color overrides'),
    fonts: ThemeSchema.shape.fonts.partial().optional(),
    logoUrl: z.string().optional().describe('External logo URL'),
    baseUrl: z.string().optional().describe('Canonical site URL for SEO/sitemap'),
  })
  .strict();

export function buildMcpServer(deps: McpDeps): McpServer {
  const { core } = deps;
  const server = new McpServer({ name: 'wb-website-builder', version: '0.1.0' });

  server.tool(
    'list_templates',
    'List available site templates with their pages and brandable tokens.',
    {},
    async () => text(core.listTemplates()),
  );

  server.tool(
    'create_site',
    'Create a website in one call — optionally from a template with brand overrides (colors, fonts, brand name, logo). Returns site id, page ids, and next steps. This is the one-command path to a full branded site.',
    {
      name: z.string().describe('Site / brand name'),
      template: z
        .string()
        .optional()
        .describe('Template name from list_templates (e.g. "breakthrough-medical"); omit for a blank site'),
      brand: BrandShape.optional().describe('Brand overrides applied to the template theme'),
    },
    async ({ name, template, brand }) => {
      try {
        const site = template
          ? await core.createSiteFromTemplate(template, name, brand)
          : await core.createSite(name);
        const pages = await core.listPages(site.id);
        return text({
          siteId: site.id,
          name: site.name,
          theme: { colors: site.theme.colors, fonts: site.theme.fonts },
          pages: pages.map((p) => ({ id: p.id, slug: p.slug || '(home)', title: p.title, rootId: p.tree.id })),
          next: 'Use get_page to inspect a page, edit_page to modify it, publish_site to render static files, preview_site to see it.',
        });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'list_components',
    'Discover available components. Without `type`: one-line summaries of all components. With `type`: the full props JSON Schema, defaults, and a worked example node ready to insert.',
    { type: z.string().optional().describe('Component type for full contract, e.g. "hero"') },
    async ({ type }) => {
      try {
        if (!type) {
          return text(
            listComponents()
              .map((d) => `${d.type} — ${d.isContainer ? '[container] ' : ''}${d.description}`)
              .join('\n'),
          );
        }
        const def = getComponent(type);
        return text({
          ...componentSummary(def),
          propsSchema: componentJsonSchema(type),
          defaultProps: def.defaultProps,
          exampleNode: { type: def.type, props: def.defaultProps, ...(def.isContainer ? { children: [] } : {}) },
          note: 'Nodes also accept layout {direction:stack|row|grid, gap, padding, align, justify, columns, maxWidth}, style {background, color, radius, shadow, minHeight}, and responsive {tablet:{...}, mobile:{...}} deltas.',
        });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'get_site',
    'Get a site: theme, settings, pages (with ids/slugs), header/footer summary. Use list_sites via this tool with no siteId to enumerate sites.',
    { siteId: z.string().optional().describe('Omit to list all sites') },
    async ({ siteId }) => {
      try {
        if (!siteId) {
          return text((await core.listSites()).map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })));
        }
        const site = await core.getSite(siteId);
        const [pages, assets] = await Promise.all([core.listPages(siteId), core.listAssets(siteId)]);
        return text({
          id: site.id,
          name: site.name,
          theme: site.theme,
          settings: site.settings,
          header: site.header ? `${site.header.id} header` : null,
          footer: site.footer ? `${site.footer.id} footer` : null,
          assets: assets.map((a) => ({ id: a.id, filename: a.filename })),
          pages: pages.map((p) => ({ id: p.id, slug: p.slug || '(home)', title: p.title, rootId: p.tree.id })),
        });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'get_page',
    'Read a page as a compact outline (node ids + types + text snippets) — or the full JSON tree with full=true. Node ids are what edit_page ops target.',
    {
      siteId: z.string(),
      page: z.string().describe('Page id or slug ("" or "index" for home)'),
      full: z.boolean().optional().describe('Return the raw JSON tree instead of the outline'),
    },
    async ({ siteId, page, full }) => {
      try {
        const p = await core.getPage(siteId, page);
        if (full) return text(p);
        return text(
          `page ${p.id} slug=/${normalizeSlug(p.slug)} title="${p.title}"\n${treeOutline(p.tree)}`,
        );
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'edit_page',
    'Edit a page tree with an atomic batch of ops: insert (node under parentId at index), update (shallow-merge props/layout/style, replace responsive), move (nodeId → parentId at index), remove, replace. Either all ops apply and the result validates, or nothing changes and the error names the failing op index — fix and retry.',
    {
      siteId: z.string(),
      page: z.string().describe('Page id or slug'),
      ops: z.array(TreeOpSchema).min(1).describe('Ops applied in order, atomically'),
    },
    async ({ siteId, page, ops }) => {
      try {
        const updated = await core.applyPageOps(siteId, page, ops);
        return text(`applied ${ops.length} op(s). Updated outline:\n${treeOutline(updated.tree)}`);
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'add_page',
    'Add a page to a site. Optionally supply a full tree (rooted at page-root); otherwise starts empty.',
    {
      siteId: z.string(),
      slug: z.string().describe('URL slug, e.g. "pricing" ("" for home)'),
      title: z.string(),
      description: z.string().optional().describe('Meta description for SEO'),
      tree: NodeInputSchema.optional().describe('Optional full page tree rooted at a page-root node'),
    },
    async ({ siteId, slug, title, description, tree }) => {
      try {
        const page = await core.addPage(siteId, slug, title, tree);
        if (description) await core.updatePageMeta(siteId, page.id, { meta: { description } });
        return text({ pageId: page.id, slug: page.slug || '(home)', rootId: page.tree.id });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'list_blocks',
    'List pre-composed section blocks (hero, features, pricing, testimonials, FAQ, CTA, contact, …) that can be dropped into a page in one call. Returns id, name, category, description.',
    {},
    async () => {
      try {
        return text(core.listBlocks());
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'insert_block',
    'Insert a pre-composed section block into a page (see list_blocks for ids). Inserts under parentId — use the page-root id from get_page — at an optional index (default: append).',
    {
      siteId: z.string(),
      pageId: z.string(),
      blockId: z.string(),
      parentId: z.string().describe('Container to insert into; usually the page-root id from get_page'),
      index: z.number().int().min(0).optional().describe('Position among children (default: append)'),
    },
    async ({ siteId, pageId, blockId, parentId, index }) => {
      try {
        const page = await core.insertBlock(siteId, pageId, blockId, parentId, index);
        return text({ pageId: page.id, rootId: page.tree.id, inserted: blockId });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'list_submissions',
    'List form submissions captured for a site (newest first). Optionally filter by formId. Each entry has id, formId, the submitted field values, and createdAt. Requires a contactForm with store enabled + the site’s formEndpoint setting.',
    {
      siteId: z.string(),
      formId: z.string().optional().describe('Only submissions for this form (defaults to all forms on the site)'),
    },
    async ({ siteId, formId }) => {
      try {
        const subs = await core.listSubmissions(siteId, formId);
        return text(subs.map((s) => ({ id: s.id, formId: s.formId, data: s.data, createdAt: s.createdAt })));
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'list_symbols',
    'List reusable symbols defined on a site (id + root component type). A symbol is a subtree rendered by symbolInstance nodes; editing the definition updates every instance.',
    { siteId: z.string() },
    async ({ siteId }) => {
      try {
        return text(await core.listSymbols(siteId));
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'set_symbol',
    'Define or replace a reusable symbol (a subtree). Place it with a symbolInstance node ({type:"symbolInstance",props:{symbolId}}) via edit_page. Cannot be a page-root and cannot reference itself (cycles are rejected).',
    {
      siteId: z.string(),
      symbolId: z.string().describe('Symbol id (letters, digits, hyphens, underscores)'),
      node: z.record(z.unknown()).describe('The symbol definition subtree (a component node, not a page-root)'),
    },
    async ({ siteId, symbolId, node }) => {
      try {
        const saved = await core.setSymbol(siteId, symbolId, node as never);
        return text({ symbolId, rootType: saved.type, rootId: saved.id });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'set_page_meta',
    'Set a page’s SEO & Open Graph metadata (partial merge). Controls the <title>, meta description, canonical, og:*/twitter:* tags, and search-engine indexing. Pass an empty string to clear a field.',
    {
      siteId: z.string(),
      pageId: z.string(),
      title: z.string().optional().describe('SEO <title> override; defaults to the page title + brand'),
      description: z.string().optional().describe('Meta description'),
      ogTitle: z.string().optional().describe('Social title override; defaults to the SEO title'),
      ogDescription: z.string().optional().describe('Social description override; defaults to the meta description'),
      ogImage: z.string().optional().describe('Open Graph image: an absolute URL or an uploaded asset id'),
      twitterCard: z.enum(['summary', 'summary_large_image']).optional(),
      noIndex: z.boolean().optional().describe('Exclude this page from search engines and the sitemap'),
    },
    async ({ siteId, pageId, ...meta }) => {
      try {
        const page = await core.updatePageMeta(siteId, pageId, { meta });
        return text({ pageId: page.id, slug: page.slug || '(home)', meta: page.meta });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'set_theme',
    'Update theme tokens (partial merge): colors (hex), fonts (named stacks), brandName, radiusScale, spacingScale. The whole site restyles automatically.',
    {
      siteId: z.string(),
      colors: ThemeSchema.shape.colors.partial().optional(),
      fonts: ThemeSchema.shape.fonts.partial().optional(),
      brandName: z.string().optional(),
      radiusScale: z.enum(['sharp', 'soft', 'round']).optional(),
      spacingScale: z.number().int().min(4).max(16).optional(),
    },
    async ({ siteId, ...patch }) => {
      try {
        const site = await core.setTheme(siteId, patch as never);
        return text(site.theme);
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'add_asset',
    'Add an image/file asset to a site from a URL or base64 content. Returns the assetId to reference in image props ({image:{assetId, alt}}).',
    {
      siteId: z.string(),
      filename: z.string(),
      url: z.string().optional().describe('Fetch the asset from this URL'),
      base64: z.string().optional().describe('Or provide the file content as base64'),
      mime: z.string().optional().describe('MIME type (inferred from response/filename if omitted)'),
    },
    async ({ siteId, filename, url, base64, mime }) => {
      try {
        // A URL is fetched by core — one SSRF guard, one byte cap, one MIME
        // precedence — rather than by a copy that lives here.
        const asset = url
          ? await core.addAssetFromUrl(siteId, filename, url, mime ? { mime } : {})
          : base64
            ? await core.addAsset(siteId, filename, mime ?? guessMime(filename), Buffer.from(base64, 'base64'))
            : null;
        if (!asset) return errText(new Error('provide either url or base64'));
        return text({ assetId: asset.id, filename: asset.filename, use: { image: { assetId: asset.id, alt: '<describe it>' } } });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'publish_site',
    'Render the site to responsive static HTML/CSS files (the deployable build). Returns dist path, file list, and lint warnings (SEO/accessibility).',
    {
      siteId: z.string(),
      outDir: z.string().optional().describe('Custom output directory (default: data/dist/<siteId>)'),
    },
    async ({ siteId, outDir }) => {
      try {
        const result = await core.publishSite(siteId, outDir);
        return text({
          buildId: result.buildId,
          distPath: result.distPath,
          pages: result.pageCount,
          files: result.files,
          warnings: result.warnings,
          deploy:
            'The dist folder is a complete static site — deploy with `wb deploy <siteId> --adapter static|vercel|netlify|cloudflare` or upload it to any static host.',
        });
      } catch (err) {
        return errText(err);
      }
    },
  );

  server.tool(
    'preview_site',
    'Get a live preview URL for the draft site (no publish needed). With screenshot=true, also returns rendered desktop + mobile screenshots so you can visually verify your work.',
    {
      siteId: z.string(),
      path: z.string().optional().describe('Page path, e.g. "/services/" (default home)'),
      screenshot: z.boolean().optional().describe('Capture desktop (1440px) and mobile (390px) screenshots'),
    },
    async ({ siteId, path, screenshot }) => {
      try {
        await core.getSite(siteId);
        const base = await deps.ensurePreviewServer();
        const url = `${base}/preview/${siteId}${path ?? '/'}`;
        if (!screenshot) return text({ previewUrl: url });
        const shots = await captureScreenshots(url);
        if (!shots) {
          return text({ previewUrl: url, note: 'screenshots unavailable (chromium not found)' });
        }
        return {
          content: [
            { type: 'text' as const, text: `previewUrl: ${url}\ndesktop (1440×900) and mobile (390×844) screenshots:` },
            { type: 'image' as const, data: shots.desktop, mimeType: 'image/png' },
            { type: 'image' as const, data: shots.mobile, mimeType: 'image/png' },
          ],
        };
      } catch (err) {
        return errText(err);
      }
    },
  );

  return server;
}

async function captureScreenshots(url: string): Promise<{ desktop: string; mobile: string } | null> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const shots: Record<string, string> = {};
      for (const [name, viewport] of Object.entries({
        desktop: { width: 1440, height: 900 },
        mobile: { width: 390, height: 844 },
      })) {
        const page = await browser.newPage({ viewport });
        await page.goto(url, { waitUntil: 'networkidle' });
        shots[name] = (await page.screenshot({ fullPage: false })).toString('base64');
        await page.close();
      }
      return { desktop: shots.desktop!, mobile: shots.mobile! };
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}
