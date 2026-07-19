import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WbCore } from '@wb/core';
import { buildMcpServer, type McpDeps } from './server.js';

export { buildMcpServer, type McpDeps } from './server.js';
export { treeOutline } from './outline.js';

export interface StartMcpOptions {
  dataDir: string;
  /** Port for the on-demand preview server (default 4400). */
  previewPort?: number;
}

/** Start the stdio MCP server. This is what `wb mcp` runs. */
export async function startMcpServer(opts: StartMcpOptions): Promise<void> {
  const core = new WbCore({ dataDir: opts.dataDir });
  let previewBase: string | null = null;

  const deps: McpDeps = {
    core,
    ensurePreviewServer: async () => {
      if (previewBase) return previewBase;
      const { buildApp } = await import('@wb/server');
      const app = await buildApp({ core, openapi: false });
      const port = opts.previewPort ?? 4400;
      await app.listen({ port, host: '127.0.0.1' });
      previewBase = `http://127.0.0.1:${port}`;
      return previewBase;
    },
  };

  const server = buildMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
