export { buildApp, type BuildAppOptions } from './app.js';

import { WbCore } from '@wb/core';
import { buildApp } from './app.js';

export interface StartServerOptions {
  dataDir: string;
  port?: number;
  host?: string;
  /** Remote libSQL/Turso URL + token (defaults to a local file under dataDir). */
  dbUrl?: string;
  dbToken?: string;
}

export async function startServer(opts: StartServerOptions) {
  const core = await WbCore.create({
    dataDir: opts.dataDir,
    ...(opts.dbUrl ? { dbUrl: opts.dbUrl } : {}),
    ...(opts.dbToken ? { dbToken: opts.dbToken } : {}),
  });
  const app = await buildApp({ core });
  const port = opts.port ?? 4000;
  await app.listen({ port, host: opts.host ?? '127.0.0.1' });
  return { app, core, port };
}
