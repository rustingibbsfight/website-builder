import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WbCore } from '@wb/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpServer } from './server.js';

let dataDir: string;
let core: WbCore;
let client: Client;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-mcp-'));
  core = new WbCore({ dataDir });
  const server = buildMcpServer({
    core,
    ensurePreviewServer: async () => 'http://127.0.0.1:9999',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const textOf = (result: unknown): string => {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
};

describe('MCP server', () => {
  it('exposes the 11 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_asset',
      'add_page',
      'create_site',
      'edit_page',
      'get_page',
      'get_site',
      'list_components',
      'list_templates',
      'preview_site',
      'publish_site',
      'set_theme',
    ]);
  });

  it('northstar flow: create_site → get_page → edit_page → publish_site', async () => {
    const created = await client.callTool({
      name: 'create_site',
      arguments: {
        name: 'MCP Clinic',
        template: 'breakthrough-medical',
        brand: { colors: { primary: '#337755' } },
      },
    });
    const createdJson = JSON.parse(textOf(created)) as {
      siteId: string;
      pages: Array<{ id: string; slug: string; rootId: string }>;
    };
    expect(createdJson.pages).toHaveLength(4);

    const outline = await client.callTool({
      name: 'get_page',
      arguments: { siteId: createdJson.siteId, page: '' },
    });
    const outlineText = textOf(outline);
    expect(outlineText).toContain('hero');
    expect(outlineText).toContain('Weight loss');

    const home = createdJson.pages.find((p) => p.slug === '(home)')!;
    const edited = await client.callTool({
      name: 'edit_page',
      arguments: {
        siteId: createdJson.siteId,
        page: home.id,
        ops: [
          {
            op: 'insert',
            parentId: home.rootId,
            node: {
              type: 'section',
              layout: { direction: 'stack', padding: 'xl' },
              children: [{ type: 'heading', props: { text: 'Added via MCP', level: 2 } }],
            },
          },
        ],
      },
    });
    expect(textOf(edited)).toContain('Added via MCP');

    const published = await client.callTool({
      name: 'publish_site',
      arguments: { siteId: createdJson.siteId },
    });
    const pub = JSON.parse(textOf(published)) as { pages: number; distPath: string; files: string[] };
    expect(pub.pages).toBe(4);
    expect(pub.files).toContain('index.html');
  });

  it('returns structured errors agents can act on', async () => {
    const bad = await client.callTool({
      name: 'edit_page',
      arguments: { siteId: 'nope', page: 'x', ops: [{ op: 'remove', nodeId: 'y' }] },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(textOf(bad)).toContain('not found');

    const created = await client.callTool({
      name: 'create_site',
      arguments: { name: 'Err Site' },
    });
    const site = JSON.parse(textOf(created)) as { siteId: string; pages: Array<{ id: string; rootId: string }> };
    const invalidProps = await client.callTool({
      name: 'edit_page',
      arguments: {
        siteId: site.siteId,
        page: site.pages[0]!.id,
        ops: [{ op: 'insert', parentId: site.pages[0]!.rootId, node: { type: 'button', props: { label: 'x' } } }],
      },
    });
    expect((invalidProps as { isError?: boolean }).isError).toBe(true);
    expect(textOf(invalidProps)).toContain('href');
  });

  it('list_components returns contracts with an example node', async () => {
    const summary = textOf(await client.callTool({ name: 'list_components', arguments: {} }));
    expect(summary).toContain('hero —');
    const hero = JSON.parse(
      textOf(await client.callTool({ name: 'list_components', arguments: { type: 'hero' } })),
    ) as { propsSchema: { properties: Record<string, unknown> }; exampleNode: { type: string } };
    expect(hero.propsSchema.properties).toHaveProperty('headline');
    expect(hero.exampleNode.type).toBe('hero');
  });

  it('set_theme merges and returns the theme', async () => {
    const created = JSON.parse(
      textOf(await client.callTool({ name: 'create_site', arguments: { name: 'Theme MCP' } })),
    ) as { siteId: string };
    const theme = JSON.parse(
      textOf(
        await client.callTool({
          name: 'set_theme',
          arguments: { siteId: created.siteId, colors: { primary: '#abcdef' } },
        }),
      ),
    ) as { colors: { primary: string; text: string } };
    expect(theme.colors.primary).toBe('#abcdef');
    expect(theme.colors.text).toBeTruthy();
  });
});
