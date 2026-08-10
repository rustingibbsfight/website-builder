import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import { componentJsonSchema, componentSummary, escapeHtml, getComponent, listComponents } from '@wb/components';
import { ConflictError, NotConfiguredError, NotFoundError, ValidationError, WbCore } from '@wb/core';
import {
  ImageSpecSchema,
  NodeInputSchema,
  OpsError,
  PageMetaSchema,
  ThemeSchema,
  TreeOpSchema,
} from '@wb/schema';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.js';
import { registerChat } from './chat.js';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z, ZodError } from 'zod';

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

/**
 * Best-effort in-memory per-IP rate limit for the public submission endpoint.
 * Resets on serverless cold start (so it is paired with a durable per-site cap
 * in core); the size guard bounds memory on a long-lived process.
 */
const SUBMISSION_MAX_PER_WINDOW = 30;
const SUBMISSION_WINDOW_MS = 60_000;
const submissionHits = new Map<string, { count: number; resetAt: number }>();
function submissionRateLimited(ip: string): boolean {
  const now = Date.now();
  if (submissionHits.size > 10_000) submissionHits.clear();
  const rec = submissionHits.get(ip);
  if (!rec || now > rec.resetAt) {
    submissionHits.set(ip, { count: 1, resetAt: now + SUBMISSION_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > SUBMISSION_MAX_PER_WINDOW;
}

/** Minimal zero-JS confirmation page returned after a form submission (#27). */
function thankYouHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thanks — message received</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0e1015;color:#e9e9f2}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.6rem;margin:0 0 .5rem}p{color:#9a99ad;margin:0}a{color:#8b7ff4}</style></head><body><main><h1>Thanks — we got it.</h1><p>Your message has been received. You can close this tab and return to the site.</p></main></body></html>`;
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
  /**
   * The `fetch` the chat relay uses to reach eve.
   *
   * Injected so the routes are testable without an agent — the same shape
   * `packages/core/src/notify.ts` already uses, and for the same reason: a
   * transport whose only test is "it works against the real thing" has no test
   * of what it does when the real thing is slow, absent, or a version ahead.
   */
  fetch?: typeof globalThis.fetch;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { core } = opts;
  // 30 MB JSON body limit so base64 asset uploads (the path Eve uses) aren't
  // rejected by Fastify's 1 MiB default — matches the 25 MB multipart cap.
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  // Parse application/x-www-form-urlencoded (native form posts from published
  // sites → the submissions endpoint). Small bodyLimit here bounds abuse. (#27)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        const obj: Record<string, string> = {};
        for (const [k, v] of params) obj[k] = v;
        done(null, obj);
      } catch (err) {
        done(err instanceof Error ? err : new Error('invalid form body'), undefined);
      }
    },
  );
  /**
   * **Fails closed in production.** (#50)
   *
   * `apiToken` unset means "open", which is the right default for
   * `wb serve` on loopback — a single-owner tool on your own laptop should not
   * demand a secret before it will draw a page. It is the wrong default the
   * moment the same code is behind a public hostname, and nothing in between
   * says which one you are.
   *
   * The CLI already refuses to bind a non-loopback host without a token. A
   * deployment has no bind step to refuse at, so the check belongs here: in
   * production, no token is a misconfiguration, and the honest response to a
   * misconfiguration that would expose the whole write API is to not start.
   *
   * Deliberately a throw rather than a warning. A warning in a deploy log is a
   * line nobody reads, and the failure it precedes is silent — the API answers
   * normally, to everyone.
   */
  const apiToken = opts.apiToken ?? process.env.WB_API_TOKEN;
  if (!apiToken && process.env.NODE_ENV === 'production') {
    throw new Error(
      'WB_API_TOKEN is not set and NODE_ENV=production. Every write route would be open to ' +
        'anyone who can reach this host. Set WB_API_TOKEN (e.g. `openssl rand -hex 24`), or run ' +
        'with NODE_ENV unset for local, loopback-only use.',
    );
  }
  await registerAuth(app, apiToken);

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
    if (rawErr instanceof ConflictError) return reply.status(409).send({ error: rawErr.message });
    // 501, not 422. The request was well-formed and this deployment simply
    // cannot do that — a caller told "invalid" will reword and retry for ever,
    // and a model on the far end will do it several times.
    if (rawErr instanceof NotConfiguredError) return reply.status(501).send({ error: rawErr.message });
    if (rawErr instanceof OpsError) {
      return reply.status(422).send({ error: rawErr.message, opIndex: rawErr.opIndex });
    }
    if (rawErr instanceof ValidationError) {
      return reply.status(422).send({ error: rawErr.message, details: rawErr.details });
    }
    // A raw ZodError from a `.parse()` inside a handler/service (e.g. the JSON
    // asset body, or a full-theme parse in setTheme merge=false) is a bad
    // request, not a server fault — map it to 422 like our own ValidationError.
    if (rawErr instanceof ZodError) {
      return reply.status(422).send({
        error: 'validation failed',
        details: rawErr.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      });
    }
    const err = rawErr as Error & { validation?: unknown; statusCode?: number };
    if (err.validation) return reply.status(400).send({ error: err.message });
    // Honor a framework error's own 4xx status (body-too-large, unsupported
    // media type, …) instead of masking it as a 500.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    // Unmapped fault: don't leak internals (SQL text, filesystem paths) to the
    // client. Log the real error server-side; return a generic message.
    // biome-ignore lint/suspicious/noConsole: server-side fault logging
    console.error('[wb] 500:', err);
    return reply.status(500).send({ error: 'internal server error' });
  });

  app.get('/health', async () => ({ ok: true }));

  // ── The editor's chat with Eve ────────────────────────────────────────────
  // Registered here rather than defined inline: it is the one part of this
  // file that talks to another service, and it is bounded by a timeout of its
  // own so a slow agent cannot spend this route's whole budget.
  await registerChat(app, core, { fetch: opts.fetch });

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

  // ── Blocks (pre-composed sections) ─────────────────────────────────────────
  app.get('/blocks', async () => core.listBlocks());
  app.get('/blocks/:blockId', { schema: { params: z.object({ blockId: z.string() }).strict() } }, async (req, reply) => {
    try {
      return core.getBlock(req.params.blockId);
    } catch (err) {
      return reply.status(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post(
    '/sites/:siteId/pages/:pageId/blocks',
    {
      schema: {
        params: PageParams,
        body: z
          .object({ blockId: z.string(), parentId: z.string(), index: z.number().int().min(0).optional() })
          .strict(),
      },
    },
    async (req) =>
      core.insertBlock(req.params.siteId, req.params.pageId, req.body.blockId, req.body.parentId, req.body.index),
  );

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
            name: z.string().min(1).optional(),
            settings: z
              .object({
                locale: z.string().optional(),
                favicon: z.string().optional(),
                baseUrl: z.string().optional(),
                formEndpoint: z.string().optional(),
              })
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

  // ── Form submissions (#27) ────────────────────────────────────────────────
  // Public write: a published (static) site POSTs a native form here (no token).
  // Honeypot + field caps blunt spam; control fields (leading _) are never
  // stored. Confirmation is a zero-JS server-rendered page.
  app.post(
    '/sites/:siteId/submissions/:formId',
    {
      // Route-level body cap so the 64 KB bound holds for ANY content-type — not
      // just urlencoded (a JSON body would otherwise ride the 30 MB global limit
      // on this unauthenticated endpoint).
      bodyLimit: 64 * 1024,
      schema: { params: z.object({ siteId: z.string(), formId: z.string().min(1).max(120) }).strict() },
    },
    async (req, reply) => {
      // Best-effort per-IP rate limit (in-memory; resets on serverless cold
      // start, so pair with the per-site cap in core). Blunts rapid floods.
      if (submissionRateLimited(req.ip || 'unknown')) {
        return reply.status(429).header('retry-after', '60').send({ error: 'too many submissions — try again shortly' });
      }
      const body = (req.body ?? {}) as Record<string, string>;
      // Bots fill the hidden `_hp` field; accept silently (don't tip them off)
      // but store nothing.
      const spam = typeof body._hp === 'string' && body._hp.trim() !== '';
      if (!spam) {
        const data: Record<string, string> = {};
        let n = 0;
        for (const [k, v] of Object.entries(body)) {
          if (k.startsWith('_')) continue; // control fields (_hp, _redirect, …)
          if (++n > 50) break; // cap field count
          data[k] = String(v).slice(0, 5000); // cap field length
        }
        await core.createSubmission(req.params.siteId, req.params.formId, data);
      }
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.status(200).send(thankYouHtml());
    },
  );

  app.get(
    '/sites/:siteId/submissions',
    { schema: { params: SiteIdParams, querystring: z.object({ formId: z.string().optional() }) } },
    async (req) => core.listSubmissions(req.params.siteId, req.query.formId),
  );

  // ── Reusable symbols (#26) ────────────────────────────────────────────────
  const SymbolParams = z.object({ siteId: z.string(), symbolId: z.string() }).strict();
  app.get('/sites/:siteId/symbols', { schema: { params: SiteIdParams } }, async (req) =>
    core.listSymbols(req.params.siteId),
  );
  app.get('/sites/:siteId/symbols/:symbolId', { schema: { params: SymbolParams } }, async (req) =>
    core.getSymbol(req.params.siteId, req.params.symbolId),
  );
  app.put(
    '/sites/:siteId/symbols/:symbolId',
    { schema: { params: SymbolParams, body: NodeInputSchema } },
    async (req) => core.setSymbol(req.params.siteId, req.params.symbolId, req.body),
  );
  app.delete('/sites/:siteId/symbols/:symbolId', { schema: { params: SymbolParams } }, async (req, reply) => {
    await core.deleteSymbol(req.params.siteId, req.params.symbolId);
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
          .object({
            slug: z.string(),
            title: z.string().min(1),
            tree: NodeInputSchema.optional(),
            // Taken at creation so a page arrives whole. The create-then-PATCH
            // shape it replaces could half-finish, leaving a page with no meta
            // description and nothing recording that one was wanted.
            meta: PageMetaSchema.partial().optional(),
          })
          .strict(),
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(await core.addPage(req.params.siteId, req.body.slug, req.body.title, req.body.tree, req.body.meta)),
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
    await core.deletePage(req.params.siteId, req.params.pageId);
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
      // Await the write: otherwise the response serializes the Promise as `{}`
      // (no assetId) and, on serverless, the function can freeze before the
      // async storage put completes — losing the asset.
      return reply.status(201).send(await core.addAsset(siteId, file.filename, file.mimetype, buf));
    }
    // Three ways to say what the bytes are: multipart (above), base64, or a
    // URL for the server to fetch. The URL shape exists so a *client* never
    // has to fetch a stranger's address itself — Eve used to, with its own
    // copy of the SSRF guard and its own byte cap. One implementation lives in
    // core; this is how the callers that aren't in-process reach it.
    const body = z
      .union([
        z
          .object({ filename: z.string().min(1), mime: z.string().min(1), base64: z.string().min(1) })
          .strict(),
        z
          .object({ filename: z.string().min(1), url: z.string().min(1), mime: z.string().min(1).optional() })
          .strict(),
      ])
      .parse(req.body);
    if ('url' in body) {
      return reply
        .status(201)
        .send(await core.addAssetFromUrl(siteId, body.filename, body.url, body.mime ? { mime: body.mime } : {}));
    }
    return reply
      .status(201)
      .send(await core.addAsset(siteId, body.filename, body.mime, Buffer.from(body.base64, 'base64')));
  });

  app.get('/sites/:siteId/assets', { schema: { params: SiteIdParams } }, async (req) =>
    core.listAssets(req.params.siteId),
  );

  /**
   * Ask for a picture, and come back for it.
   *
   * Two routes rather than one that waits, and the split is a correctness rule
   * rather than a latency one. The studio has queued and charged for the render
   * by the time it answers, so the **ticket is a receipt for money already
   * spent** — and a request that blocked until the picture was ready would be
   * holding the only copy of that receipt inside a call the platform can kill.
   * A serverless function that dies mid-render leaves a purchase nobody can
   * collect.
   *
   * So POST returns 202 with the ticket the moment there is one, and GET does
   * the collecting. Asking *is* what advances it — the studio has no worker of
   * its own — and asking again later costs nothing, because the picture is
   * already paid for. The ticket is durable, so a closed tab strands nothing:
   * `GET /assets/generate` lists what is still in flight.
   */
  /**
   * The studio's own vocabulary and brand kits, relayed.
   *
   * Not site-scoped, because neither is about a site: guidance is what the
   * studio currently accepts, and a brand kit is filed under a name there. They
   * are here so that **only this deployment holds the studio credential**. Eve
   * used to hold its own copy of `STUDIO_API_KEY`, which is a second place a
   * key can leak from and a second place it has to be rotated — and no part of
   * what Eve does with it needs the key rather than the answer.
   */
  app.get('/images/guidance', async () => core.imageGuidance());

  app.get('/images/brands', async () => core.listImageBrands());

  app.post(
    '/images/brands',
    {
      schema: {
        body: z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
            palette: z.array(z.string()).optional(),
            voice: z.array(z.string()).optional(),
            avoid: z.array(z.string()).optional(),
          })
          .strict(),
      },
    },
    async (req) => core.saveImageBrand(req.body),
  );

  app.post(
    '/sites/:siteId/assets/generate',
    { schema: { params: SiteIdParams, body: ImageSpecSchema } },
    async (req, reply) => {
      const ticket = await core.requestSiteImage(req.params.siteId, req.body);
      return reply.status(202).send(ticket);
    },
  );

  app.get('/sites/:siteId/assets/generate', { schema: { params: SiteIdParams } }, async (req) => ({
    tickets: await core.listSiteImageTickets(req.params.siteId),
  }));

  app.get(
    '/sites/:siteId/assets/generate/:ticketId',
    { schema: { params: z.object({ siteId: z.string(), ticketId: z.string() }) } },
    async (req) => core.collectSiteImage(req.params.siteId, req.params.ticketId),
  );

  app.delete(
    '/sites/:siteId/assets/:assetId',
    { schema: { params: z.object({ siteId: z.string(), assetId: z.string() }) } },
    async (req, reply) => {
      await core.deleteAsset(req.params.siteId, req.params.assetId);
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
    // The editor drives authenticated mutations; deny cross-origin framing so
    // it can't be clickjacked.
    return reply
      .type(mime[extname(filePath)] ?? 'application/octet-stream')
      .header('x-frame-options', 'SAMEORIGIN')
      .header('content-security-policy', "frame-ancestors 'self'")
      .send(createReadStream(filePath));
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
    if (result.kind === 'html') {
      // Preview is same-origin with the authenticated API, and the htmlEmbed
      // component renders its content unescaped. A strict nonce-based CSP means
      // only our own injected scripts (which carry `result.nonce`) run; any
      // <script>/onerror/javascript: an htmlEmbed slips in is blocked, so it
      // can't ride the session cookie. Media/img/frame stay permissive so real
      // previews (external images, video embeds) still render.
      const csp = [
        "default-src 'self'",
        `script-src 'nonce-${result.nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        'img-src * data: blob:',
        'font-src * data:',
        'frame-src *',
        'media-src *',
        "connect-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'self'",
      ].join('; ');
      return reply
        .type('text/html; charset=utf-8')
        .header('content-security-policy', csp)
        .header('x-content-type-options', 'nosniff')
        .send(result.body);
    }
    return reply.type('text/css; charset=utf-8').send(result.body);
  });

  return app;
}
