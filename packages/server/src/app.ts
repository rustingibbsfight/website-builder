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

export interface BuildAppOptions {
  core: WbCore;
  /** Expose swagger/openapi (on by default). */
  openapi?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { core } = opts;
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

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
      const site = core.createSiteFromTemplate(req.body.template, req.body.name, req.body.brand);
      return reply.status(201).send({ site, pages: core.listPages(site.id) });
    },
  );

  app.post(
    '/sites',
    { schema: { body: z.object({ name: z.string().min(1), theme: ThemeSchema.partial().optional() }).strict() } },
    async (req, reply) => reply.status(201).send(core.createSite(req.body.name, req.body.theme)),
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
    core.deleteSite(req.params.siteId);
    return reply.status(204).send();
  });

  app.get('/sites/:siteId/theme', { schema: { params: SiteIdParams } }, async (req) => core.getSite(req.params.siteId).theme);

  app.put(
    '/sites/:siteId/theme',
    {
      schema: {
        params: SiteIdParams,
        querystring: z.object({ merge: z.enum(['true', 'false']).default('true') }),
        body: ThemeSchema.deepPartial(),
      },
    },
    async (req) => core.setTheme(req.params.siteId, req.body as never, req.query.merge === 'true').theme,
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
      reply.status(201).send(core.addPage(req.params.siteId, req.body.slug, req.body.title, req.body.tree)),
  );

  app.get('/sites/:siteId/pages', { schema: { params: SiteIdParams } }, async (req) =>
    core.listPages(req.params.siteId).map(({ tree, ...rest }) => ({ ...rest, rootId: tree.id })),
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
  app.post(
    '/sites/:siteId/publish',
    { schema: { params: SiteIdParams, body: z.object({ outDir: z.string().optional() }).strict().nullish() } },
    async (req) => core.publishSite(req.params.siteId, req.body?.outDir),
  );

  app.get('/sites/:siteId/builds', { schema: { params: SiteIdParams } }, async (req) =>
    core.listBuilds(req.params.siteId),
  );

  app.post(
    '/sites/:siteId/deploy',
    {
      schema: {
        params: SiteIdParams,
        body: z
          .object({
            adapter: z.enum(['static', 'vercel', 'netlify', 'cloudflare']),
            targetDir: z.string().optional(),
            projectName: z.string().optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      const { deployDist, distDir } = await import('@wb/core');
      const result = await core.publishSite(req.params.siteId);
      void distDir;
      return deployDist(result.distPath, req.body.adapter, {
        targetDir: req.body.targetDir,
        projectName: req.body.projectName,
      });
    },
  );

  // ── Preview ──────────────────────────────────────────────────────────────
  app.get('/preview/:siteId', { schema: { params: SiteIdParams } }, async (req, reply) =>
    reply.redirect(`/preview/${req.params.siteId}/`),
  );
  app.get('/preview/:siteId/*', { schema: { params: z.object({ siteId: z.string(), '*': z.string() }) } }, async (req, reply) => {
    const { siteId } = req.params;
    const rest = req.params['*'] ?? '';
    const result = core.renderPreviewPath(siteId, `/${rest}`, `/preview/${siteId}`);
    if (!result) return reply.status(404).send({ error: `no page at "/${rest}"` });
    if (result.kind === 'asset') {
      const { createReadStream } = await import('node:fs');
      return reply.type(result.mime).send(createReadStream(result.filePath));
    }
    const type = result.kind === 'html' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
    return reply.type(type).send(result.body);
  });

  return app;
}
