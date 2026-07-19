import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore } from '@wb/core';
import { buildApp } from '@wb/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dataDir: string;
let core: WbCore;
let app: FastifyInstance;
let siteId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-probe-'));
  core = await WbCore.create({ dataDir });
  app = await buildApp({ core, openapi: false }); // no auth
  const site = await core.createSite('probe');
  siteId = site.id;
});
afterAll(async () => {
  await app.close();
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('probe', () => {
  it('base64 asset > ~760KB via JSON body', async () => {
    const raw = Buffer.alloc(1_000_000, 1); // 1 MB raw -> ~1.33MB base64
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/assets`,
      payload: { filename: 'big.png', mime: 'image/png', base64: raw.toString('base64') },
    });
    console.log('BIG-ASSET status=', res.statusCode, 'body=', res.body.slice(0, 200));
  });

  it('DELETE nonexistent page status', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/sites/${siteId}/pages/does-not-exist` });
    console.log('DELETE-PAGE status=', res.statusCode, 'body=', res.body.slice(0, 200));
  });

  it('DELETE nonexistent asset status', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/sites/${siteId}/assets/does-not-exist` });
    console.log('DELETE-ASSET status=', res.statusCode, 'body=', res.body.slice(0, 200));
  });
});
