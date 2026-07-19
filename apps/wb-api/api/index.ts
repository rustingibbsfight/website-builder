import type { IncomingMessage, ServerResponse } from 'node:http';
import { WbCore } from '@wb/core';
import { buildApp } from '@wb/server';
import type { FastifyInstance } from 'fastify';

/**
 * Vercel serverless entry for the wb REST API + editor + preview.
 *
 * State lives entirely off the ephemeral function filesystem:
 *   - database   → Turso/libSQL   (WB_DB_URL, WB_DB_TOKEN)
 *   - assets     → R2/S3          (WB_ASSET_STORE=s3, WB_S3_* — read by @wb/core)
 *   - dist output→ /tmp (transient) — publish renders here, then a deploy step
 *                  pushes it to a static host.
 *
 * Auth: set WB_API_TOKEN to require a token on every route (see @wb/server).
 */
let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      if (!process.env.WB_DB_URL) {
        // A local file under /tmp works but is per-invocation; Turso is required
        // for anything durable. Fail loudly rather than silently lose data.
        throw new Error('WB_DB_URL is required on serverless (point it at your Turso database)');
      }
      const core = await WbCore.create({
        dataDir: process.env.WB_DATA_DIR ?? '/tmp/wb',
        dbUrl: process.env.WB_DB_URL,
        ...(process.env.WB_DB_TOKEN ? { dbToken: process.env.WB_DB_TOKEN } : {}),
      });
      const app = await buildApp({ core });
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  // Drive Fastify's request lifecycle without binding a port.
  app.server.emit('request', req, res);
}
