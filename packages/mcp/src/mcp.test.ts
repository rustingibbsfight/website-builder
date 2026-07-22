import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WbCore } from '@wb/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpServer } from './server.js';
import { treeOutline } from './outline.js';

let dataDir: string;
let core: WbCore;
let client: Client;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-mcp-'));
  core = await WbCore.create({ dataDir });
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
  it('exposes the 15 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_asset',
      'add_page',
      'create_site',
      'edit_page',
      'get_page',
      'get_site',
      'insert_block',
      'list_blocks',
      'list_components',
      'list_submissions',
      'list_templates',
      'preview_site',
      'publish_site',
      'set_page_meta',
      'set_theme',
    ]);
  });

  it('list_blocks + insert_block drops a section into a page', async () => {
    const created = await client.callTool({
      name: 'create_site',
      arguments: { name: 'Blocks Clinic', template: 'breakthrough-medical' },
    });
    const { siteId, pages } = JSON.parse(textOf(created)) as {
      siteId: string;
      pages: Array<{ id: string; slug: string; rootId: string }>;
    };
    const home = pages.find((p) => p.slug === '' || p.slug === 'index') ?? pages[0]!;

    const blocks = JSON.parse(textOf(await client.callTool({ name: 'list_blocks', arguments: {} }))) as Array<{
      id: string;
    }>;
    expect(blocks.length).toBeGreaterThan(0);

    const before = (await core.getPage(siteId, home.id)).tree.children?.length ?? 0;
    const res = await client.callTool({
      name: 'insert_block',
      arguments: { siteId, pageId: home.id, blockId: 'faq', parentId: home.rootId },
    });
    expect(textOf(res)).toContain('"inserted": "faq"');
    const after = (await core.getPage(siteId, home.id)).tree.children?.length ?? 0;
    expect(after).toBe(before + 1);
  });

  it('set_page_meta updates SEO/OG metadata programmatically', async () => {
    const created = await client.callTool({
      name: 'create_site',
      arguments: { name: 'SEO Clinic', template: 'breakthrough-medical' },
    });
    const { siteId, pages } = JSON.parse(textOf(created)) as {
      siteId: string;
      pages: Array<{ id: string; slug: string }>;
    };
    const home = pages.find((p) => p.slug === '' || p.slug === 'index') ?? pages[0]!;
    const res = await client.callTool({
      name: 'set_page_meta',
      arguments: {
        siteId,
        pageId: home.id,
        title: 'Weight loss that works — Clinic',
        description: 'Physician-supervised care.',
        ogImage: 'https://clinic.example/og.png',
        noIndex: false,
      },
    });
    const out = JSON.parse(textOf(res)) as { meta: Record<string, unknown> };
    expect(out.meta.title).toBe('Weight loss that works — Clinic');
    expect(out.meta.ogImage).toBe('https://clinic.example/og.png');
    // and it round-trips through the renderer
    const page = await core.getPage(siteId, home.id);
    expect(page.meta.description).toBe('Physician-supervised care.');
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

  it('add_page validates slug and add_asset rejects missing content', async () => {
    const site = JSON.parse(
      textOf(await client.callTool({ name: 'create_site', arguments: { name: 'MCP Pages' } })),
    ) as { siteId: string };

    const badSlug = await client.callTool({
      name: 'add_page',
      arguments: { siteId: site.siteId, slug: 'Bad Slug', title: 'X' },
    });
    expect((badSlug as { isError?: boolean }).isError).toBe(true);

    const noContent = await client.callTool({
      name: 'add_asset',
      arguments: { siteId: site.siteId, filename: 'x.svg' },
    });
    expect((noContent as { isError?: boolean }).isError).toBe(true);
    expect(textOf(noContent)).toMatch(/url or base64/);

    const ok = await client.callTool({
      name: 'add_page',
      arguments: { siteId: site.siteId, slug: 'pricing', title: 'Pricing', description: 'Plans' },
    });
    expect(textOf(ok)).toContain('pricing');
  });

  it('get_page outline is compact and reflects edits', async () => {
    const site = JSON.parse(
      textOf(await client.callTool({ name: 'create_site', arguments: { name: 'Outline' } })),
    ) as { siteId: string; pages: Array<{ id: string; rootId: string }> };
    await client.callTool({
      name: 'edit_page',
      arguments: {
        siteId: site.siteId,
        page: site.pages[0]!.id,
        ops: [
          {
            op: 'insert',
            parentId: site.pages[0]!.rootId,
            node: { type: 'heading', props: { text: 'Special Marker Text', level: 2 } },
          },
        ],
      },
    });
    const outline = textOf(await client.callTool({ name: 'get_page', arguments: { siteId: site.siteId, page: '' } }));
    expect(outline).toContain('heading');
    expect(outline).toContain('Special Marker Text');
    // Full JSON is available on request.
    const full = textOf(
      await client.callTool({ name: 'get_page', arguments: { siteId: site.siteId, page: '', full: true } }),
    );
    expect(full).toContain('"type": "page-root"');
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
