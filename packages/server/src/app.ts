import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import { componentJsonSchema, componentSummary, getComponent, listComponents } from '@wb/components';
import { NotFoundError, ValidationError, WbCore } from '@wb/core';
import {
  NodeInputSchema,
  OpsError,
  PageMetaSchema,
  ThemeSchema,
  TreeOpSchema,
} from '@wb/schema';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.js';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

const BrandSchema = z
  .object({
    brandName: z.string().optional(),
    colors: ThemeSchema.shape.colors.partial().optional(),
    fonts: ThemeSchema.shape.fonts.partial().optional(),
    logoUrl: z.string().optional(),
    baseUrl: z.string().optional(),
  })
  .strict();

const SiteIdParams = z.object({ siteId: z.string() });
const PageParams = z.object({ siteId: z.string(), pageId: z.string() });

/** Locate the built editor SPA without a hard dependency on @wb/editor. */
function resolveEditorDist(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@wb/editor/package.json');
    const dist = join(dirname(pkg), 'dist');
    return existsSync(join(dist, 'index.html')) ? dist : null;
  } catch {
    return null;
  }
}

export interface BuildAppOptions {
  core: WbCore;
  /** Expose swagger/openapi (on by default). */
  openapi?: boolean;
  /** Path to the built editor SPA (auto-resolved from @wb/editor when omitted). */
  editorDist?: string;
  /**
   * API token. When set (or WB_API_TOKEN is in the environment), all routes
   * except /health and /auth/* require it — via Authorization: Bearer,
   * x-api-key, or the session cookie from POST /auth/login. Unset = open.
   */
  apiToken?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { core } = opts;
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await registerAuth(app, opts.apiToken ?? process.env.WB_API_TOKEN);

  if (opts.openapi !== false) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'wb — website builder API',
          version: '0.1.0',
          description:
            'API-first website builder. Sites are JSON component trees with auto-layout; publish renders responsive static HTML/CSS.',
        },
      },
      transform: jsonSchemaTransform,
    });
    app.get('/openapi.json', async () => app.swagger());
  }

  app.setErrorHandler((rawErr: unknown, _req, reply) => {
    if (rawErr instanceof NotFoundError) return reply.status(404).send({ error: rawErr.message });
    if (rawErr instanceof OpsError) {
      return reply.status(422).send({ error: rawErr.message, opIndex: rawErr.opIndex });
    }
    if (rawErr instanceof ValidationError) {
      return reply.status(422).send({ error: rawErr.message, details: rawErr.details });
    }
    const err = rawErr as Error & { validation?: unknown };
    if (err.validation) return reply.status(400).send({ error: err.message });
    return reply.status(500).send({ error: err.message });
  });

  app.get('/health', async () => ({ ok: true }));

  // ── Components ───────────────────────────────────────────────────────────
  app.get('/components', async () => listComponents().map(componentSummary));
  app.get('/components/:type', { schema: { params: z.object({ type: z.string() }) } }, async (req) => {
    const { type } = req.params;
    const def = getComponent(type);
    return {
      ...componentSummary(def),
      propsSchema: componentJsonSchema(type),
      defaultProps: def.defaultProps,
      layoutTarget: def.layoutTarget ?? 'self',
    };
  });

  // ── Templates & sites ────────────────────────────────────────────────────
  app.get('/templates', async () => core.listTemplates());

  app.post(
    '/sites/from-template',
    {
      schema: {
        body: z.object({ template: z.string(), name: z.string().optional(), brand: BrandSchema.optional() }).strict(),
      },
    },
    async (req, reply) => {
      const site = await core.createSiteFromTemplate(req.body.template, req.body.name, req.body.brand);
      return reply.status(201).send({ site, pages: await core.listPages(site.id) });
    },
  );

  app.post(
    '/sites',
    { schema: { body: z.object({ name: z.string().min(1), theme: ThemeSchema.partial().optional() }).strict() } },
    async (req, reply) => reply.status(201).send(await core.createSite(req.body.name, req.body.theme)),
  );

  app.get('/sites', async () => core.listSites());
  app.get('/sites/:siteId', { schema: { params: SiteIdParams } }, async (req) => core.getSite(req.params.siteId));

  app.patch(
    '/sites/:siteId',
    {
      schema: {
        params: SiteIdParams,
        body: z
          .object({
            name: z.string().optional(),
            settings: z
              .object({ locale: z.string().optional(), favicon: z.string().optional(), baseUrl: z.string().optional() })
              .optional(),
          })
          .strict(),
      },
    },
    async (req) => core.updateSite(req.params.siteId, req.body),
  );

  app.delete('/sites/:siteId', { schema: { params: SiteIdParams } }, async (req, reply) => {
    await core.deleteSite(req.params.siteId);
    return reply.status(204).send();
  });

  app.get('/sites/:siteId/theme', { schema: { params: SiteIdParams } }, async (req) => (await core.getSite(req.params.siteId)).theme);

  app.put(
    '/sites/:siteId/theme',
    {
      schema: {
        params: SiteIdParams,
        querystring: z.object({ merge: z.enum(['true', 'false']).default('true') }),
        body: ThemeSchema.deepPartial(),
      },
    },
    async (req) => (await core.setTheme(req.params.siteId, req.body as never, req.query.merge === 'true')).theme,
  );

  for (const which of ['header', 'footer'] as const) {
    app.put(
      `/sites/:siteId/${which}`,
      { schema: { params: SiteIdParams, body: NodeInputSchema.nullable() } },
      async (req) => core.setChrome(req.params.siteId, which, req.body),
    );
  }

  // ── Pages ────────────────────────────────────────────────────────────────
  app.post(
    '/sites/:siteId/pages',
    {
      schema: {
        params: SiteIdParams,
        body: z
          .object({ slug: z.string(), title: z.string().min(1), tree: NodeInputSchema.optional() })
          .strict(),
      },
    },
    async (req, reply) =>
      reply.status(201).send(await core.addPage(req.params.siteId, req.body.slug, req.body.title, req.body.tree)),
  );

  app.get('/sites/:siteId/pages', { schema: { params: SiteIdParams } }, async (req) =>
    (await core.listPages(req.params.siteId)).map(({ tree, ...rest }) => ({ ...rest, rootId: tree.id })),
  );

  app.get('/sites/:siteId/pages/:pageId', { schema: { params: PageParams } }, async (req) =>
    core.getPage(req.params.siteId, req.params.pageId),
  );

  app.patch(
    '/sites/:siteId/pages/:pageId',
    {
      schema: {
        params: PageParams,
        body: z
          .object({
            slug: z.string().optional(),
            title: z.string().optional(),
            meta: PageMetaSchema.partial().optional(),
            sortOrder: z.number().int().optional(),
          })
          .strict(),
      },
    },
    async (req) => core.updatePageMeta(req.params.siteId, req.params.pageId, req.body),
  );

  app.delete('/sites/:siteId/pages/:pageId', { schema: { params: PageParams } }, async (req, reply) => {
    core.deletePage(req.params.siteId, req.params.pageId);
    return reply.status(204).send();
  });

  app.get('/sites/:siteId/pages/:pageId/tree', { schema: { params: PageParams } }, async (req) =>
    core.getTree(req.params.siteId, req.params.pageId),
  );

  app.put(
    '/sites/:siteId/pages/:pageId/tree',
    { schema: { params: PageParams, body: NodeInputSchema } },
    async (req) => core.setTree(req.params.siteId, req.params.pageId, req.body),
  );

  app.post(
    '/sites/:siteId/pages/:pageId/tree/ops',
    { schema: { params: PageParams, body: z.object({ ops: z.array(TreeOpSchema).min(1) }).strict() } },
    async (req) => core.applyPageOps(req.params.siteId, req.params.pageId, req.body.ops),
  );

  // ── Assets ───────────────────────────────────────────────────────────────
  app.post('/sites/:siteId/assets', { schema: { params: SiteIdParams } }, async (req, reply) => {
    const { siteId } = req.params;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new ValidationError('no file in multipart body');
      const buf = await file.toBuffer();
      return reply.status(201).send(core.addAsset(siteId, file.filename, file.mimetype, buf));
    }
    const body = z
      .object({ filename: z.string().min(1), mime: z.string().min(1), base64: z.string().min(1) })
      .strict()
      .parse(req.body);
    return reply
      .status(201)
      .send(core.addAsset(siteId, body.filename, body.mime, Buffer.from(body.base64, 'base64')));
  });

  app.get('/sites/:siteId/assets', { schema: { params: SiteIdParams } }, async (req) =>
    core.listAssets(req.params.siteId),
  );

  app.delete(
    '/sites/:siteId/assets/:assetId',
    { schema: { params: z.object({ siteId: z.string(), assetId: z.string() }) } },
    async (req, reply) => {
      core.deleteAsset(req.params.siteId, req.params.assetId);
      return reply.status(204).send();
    },
  );

  // ── Publish / builds / deploy ────────────────────────────────────────────
  // No outDir over HTTP: publish always targets the managed data/dist tree.
  // (An arbitrary outDir would let any API client delete/overwrite host paths;
  // custom output dirs are a local-CLI capability only.)
  app.post(
    '/sites/:siteId/publish',
    { schema: { params: SiteIdParams, body: z.object({}).strict().nullish() } },
    async (req) => core.publishSite(req.params.siteId),
  );

  app.get('/sites/:siteId/builds', { schema: { params: SiteIdParams } }, async (req) =>
    core.listBuilds(req.params.siteId),
  );

  // Commit the site's source + build to version control (per-site repo).
  app.post(
    '/sites/:siteId/commit',
    { schema: { params: SiteIdParams, body: z.object({ message: z.string().optional() }).strict().nullish() } },
    async (req) => core.commitSiteToVcs(req.params.siteId, req.body?.message),
  );

  app.post(
    '/sites/:siteId/deploy',
    {
      schema: {
        params: SiteIdParams,
        body: z
          .object({
            adapter: z.enum(['static', 'vercel', 'netlify', 'cloudflare']).optional(),
            projectName: z.string().optional(),
          })
          .strict()
          .nullish(),
      },
    },
    async (req) => {
      // Without an adapter: the fully-serverless path — render in memory and
      // push to the configured publish target (Vercel API / R2). With an
      // adapter: legacy local-CLI adapters (no targetDir over HTTP — arbitrary
      // filesystem writes stay a local-CLI capability).
      if (!req.body?.adapter) {
        return core.deploySite(req.params.siteId);
      }
      const { deployDist } = await import('@wb/core');
      const result = await core.publishSite(req.params.siteId);
      return deployDist(result.distPath, req.body.adapter, {
        projectName: req.body.projectName,
      });
    },
  );

  // ── Visual editor SPA ────────────────────────────────────────────────────
  const editorDist = opts.editorDist ?? resolveEditorDist();
  app.get('/editor', async (_req, reply) => reply.redirect('/editor/'));
  app.get('/editor/*', async (req, reply) => {
    if (!editorDist) {
      return reply
        .status(404)
        .type('text/plain')
        .send('editor not built — run `pnpm --filter @wb/editor build`');
    }
    const rest = ((req.params as Record<string, string>)['*'] ?? '').split('?')[0]!;
    const { createReadStream, existsSync } = await import('node:fs');
    const { extname, join, normalize, resolve, sep } = await import('node:path');
    const safe = normalize(rest).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(editorDist, safe);
    // Containment: never serve anything outside the editor dist.
    const root = resolve(editorDist);
    if (!resolve(filePath).startsWith(root + sep) && resolve(filePath) !== root) {
      filePath = join(editorDist, 'index.html');
    }
    if (!safe || !existsSync(filePath) || !extname(filePath)) filePath = join(editorDist, 'index.html');
    if (!existsSync(filePath)) return reply.status(404).send({ error: 'editor build missing' });
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.map': 'application/json',
    };
    return reply.type(mime[extname(filePath)] ?? 'application/octet-stream').send(createReadStream(filePath));
  });

  // ── Preview ──────────────────────────────────────────────────────────────
  app.get('/preview/:siteId', { schema: { params: SiteIdParams } }, async (req, reply) =>
    reply.redirect(`/preview/${req.params.siteId}/`),
  );
  app.get('/preview/:siteId/*', {
    schema: {
      params: z.object({ siteId: z.string(), '*': z.string() }),
      querystring: z.object({ editor: z.string().optional() }),
    },
  }, async (req, reply) => {
    const { siteId } = req.params;
    const rest = req.params['*'] ?? '';
    const result = await core.renderPreviewPath(siteId, `/${rest}`, `/preview/${siteId}`, {
      editor: req.query.editor === '1',
    });
    if (!result) return reply.status(404).send({ error: `no page at "/${rest}"` });
    if (result.kind === 'asset') {
      // Uploaded assets (esp. SVG) must never execute script in this origin —
      // an SVG with <script> could otherwise ride the editor session cookie.
      return reply
        .type(result.mime)
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
        .header('x-content-type-options', 'nosniff')
        .send(result.body);
    }
    const type = result.kind === 'html' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
    return reply.type(type).send(result.body);
  });

  return app;
}
