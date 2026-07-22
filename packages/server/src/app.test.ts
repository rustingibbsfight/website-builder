import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore } from '@wb/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

let dataDir: string;
let core: WbCore;
let app: FastifyInstance;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-server-'));
  core = await WbCore.create({ dataDir });
  app = await buildApp({ core });
});

afterEach(async () => {
  await app.close();
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('REST API', () => {
  it('serves health and openapi', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ ok: true });
    const openapi = (await app.inject({ url: '/openapi.json' })).json() as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(openapi.openapi).toMatch(/^3\./);
    expect(Object.keys(openapi.paths)).toContain('/sites/from-template');
    expect(Object.keys(openapi.paths)).toContain('/sites/{siteId}/pages/{pageId}/tree/ops');
  });

  it('lists components with schemas', async () => {
    const list = (await app.inject({ url: '/components' })).json() as Array<{ type: string }>;
    expect(list.length).toBe(29);
    const hero = (await app.inject({ url: '/components/hero' })).json() as {
      propsSchema: { properties: Record<string, unknown> };
      defaultProps: Record<string, unknown>;
    };
    expect(hero.propsSchema.properties).toHaveProperty('headline');
  });

  it('lists blocks and serves a block subtree', async () => {
    const list = (await app.inject({ url: '/blocks' })).json() as Array<{ id: string; category: string }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((b) => b.id === 'faq')).toBe(true);
    const faq = (await app.inject({ url: '/blocks/faq' })).json() as { id: string; node: { type: string } };
    expect(faq.node.type).toBe('faq');
    expect((await app.inject({ url: '/blocks/nope' })).statusCode).toBe(404);
  });

  it('full flow: template → edit via ops → publish', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/sites/from-template',
        payload: { template: 'breakthrough-medical', name: 'API Clinic', brand: { colors: { primary: '#224466' } } },
      })
    ).json() as { site: { id: string; theme: { colors: { primary: string } } }; pages: Array<{ id: string; slug: string; tree: { id: string } }> };
    expect(created.site.theme.colors.primary).toBe('#224466');
    expect(created.pages).toHaveLength(4);

    const siteId = created.site.id;
    const home = created.pages.find((p) => p.slug === '')!;

    const opsRes = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/pages/${home.id}/tree/ops`,
      payload: {
        ops: [
          {
            op: 'insert',
            parentId: home.tree.id,
            node: {
              type: 'section',
              layout: { direction: 'stack', padding: 'xl' },
              children: [{ type: 'heading', props: { text: 'New Section', level: 2 } }],
            },
          },
        ],
      },
    });
    expect(opsRes.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/pages/${home.id}/tree/ops`,
      payload: { ops: [{ op: 'remove', nodeId: 'does-not-exist' }] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ opIndex: 0 });

    const pub = (await app.inject({ method: 'POST', url: `/sites/${siteId}/publish` })).json() as {
      pageCount: number;
      warnings: unknown[];
      distPath: string;
    };
    expect(pub.pageCount).toBe(4);
  });

  it('uploads assets as base64 json', async () => {
    const site = (
      await app.inject({ method: 'POST', url: '/sites', payload: { name: 'Asset API' } })
    ).json() as { id: string };
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${site.id}/assets`,
      payload: {
        filename: 'dot.svg',
        mime: 'image/svg+xml',
        base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
      },
    });
    expect(res.statusCode).toBe(201);
    const assets = (await app.inject({ url: `/sites/${site.id}/assets` })).json() as unknown[];
    expect(assets).toHaveLength(1);
  });

  it('serves live preview html, css, and assets', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/sites/from-template',
        payload: { template: 'breakthrough-medical' },
      })
    ).json() as { site: { id: string } };
    const siteId = created.site.id;

    const home = await app.inject({ url: `/preview/${siteId}/` });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Weight loss, guided by medical experts');
    expect(home.body).toContain(`/preview/${siteId}/styles.css`);

    const css = await app.inject({ url: `/preview/${siteId}/styles.css` });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');

    const services = await app.inject({ url: `/preview/${siteId}/services/` });
    expect(services.statusCode).toBe(200);

    const assetPath = css.body.match(/\/preview\/[^/]+\/assets\/([^')]+)/)?.[1];
    if (assetPath) {
      const asset = await app.inject({ url: `/preview/${siteId}/assets/${assetPath}` });
      expect(asset.statusCode).toBe(200);
    }

    const missing = await app.inject({ url: `/preview/${siteId}/nope/` });
    expect(missing.statusCode).toBe(404);
  });

  it('maps errors to proper status codes', async () => {
    expect((await app.inject({ url: '/sites/nope' })).statusCode).toBe(404);
    const badTemplate = await app.inject({
      method: 'POST',
      url: '/sites/from-template',
      payload: { template: 'nope' },
    });
    expect(badTemplate.statusCode).toBe(422);
    expect((badTemplate.json() as { error: string }).error).toContain('breakthrough-medical');
  });
});
