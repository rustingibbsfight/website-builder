import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore } from '@wb/core';
import { buildApp } from '@wb/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wbGet, wbPost } from './wb';

let dataDir: string;
let core: WbCore;
let app: FastifyInstance;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-eve-lib-'));
  core = await WbCore.create({ dataDir });
  app = await buildApp({ core, openapi: false, apiToken: 'sekrit' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  process.env.WB_API_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  process.env.WB_API_TOKEN = 'sekrit';
});

afterAll(async () => {
  await app.close();
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.WB_API_URL;
  delete process.env.WB_API_TOKEN;
});

describe('wb client (Eve tool transport)', () => {
  it('runs the northstar flow with bearer auth: template → edit → publish', async () => {
    const templates = await wbGet<Array<{ name: string }>>('/templates');
    expect(templates[0]!.name).toBe('breakthrough-medical');

    const created = await wbPost<{
      site: { id: string };
      pages: Array<{ id: string; slug: string; tree: { id: string } }>;
    }>('/sites/from-template', {
      template: 'breakthrough-medical',
      name: 'Eve Framework Clinic',
      brand: { colors: { primary: '#446688' } },
    });
    expect(created.pages).toHaveLength(4);

    const home = created.pages.find((p) => p.slug === '')!;
    const edited = await wbPost<{ tree: unknown }>(
      `/sites/${created.site.id}/pages/${home.id}/tree/ops`,
      {
        ops: [
          {
            op: 'insert',
            parentId: home.tree.id,
            node: {
              type: 'section',
              layout: { direction: 'stack', padding: 'lg' },
              children: [{ type: 'heading', props: { text: 'Added by Eve', level: 2 } }],
            },
          },
        ],
      },
    );
    expect(JSON.stringify(edited)).toContain('Added by Eve');

    const published = await wbPost<{ pageCount: number }>(`/sites/${created.site.id}/publish`, {});
    expect(published.pageCount).toBe(4);
  });

  it('surfaces API errors readably and fails clean without auth', async () => {
    await expect(wbPost('/sites/nope/publish', {})).rejects.toThrow(/not found/);
    const token = process.env.WB_API_TOKEN;
    delete process.env.WB_API_TOKEN;
    try {
      await expect(wbGet('/sites')).rejects.toThrow(/unauthorized/);
    } finally {
      process.env.WB_API_TOKEN = token;
    }
  });

  it('errors helpfully when WB_API_URL is missing', async () => {
    const url = process.env.WB_API_URL;
    delete process.env.WB_API_URL;
    try {
      await expect(wbGet('/sites')).rejects.toThrow(/WB_API_URL is not set/);
    } finally {
      process.env.WB_API_URL = url;
    }
  });
});
