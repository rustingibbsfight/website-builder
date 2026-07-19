export { buildApp, type BuildAppOptions } from './app.js';

import { WbCore } from '@wb/core';
import { buildApp } from './app.js';

export interface StartServerOptions {
  dataDir: string;
  port?: number;
  host?: string;
}

export async function startServer(opts: StartServerOptions) {
  const core = new WbCore({ dataDir: opts.dataDir });
  const app = await buildApp({ core });
  const port = opts.port ?? 4000;
  await app.listen({ port, host: opts.host ?? '127.0.0.1' });
  return { app, core, port };
}
