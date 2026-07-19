import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  dataDir = mkdtempSync(join(tmpdir(), 'wb-sec-'));
  core = await WbCore.create({ dataDir });
  app = await buildApp({ core });
});

afterEach(async () => {
  await app.close();
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const makeSite = async (): Promise<string> => {
  const created = (
    await app.inject({ method: 'POST', url: '/sites/from-template', payload: { template: 'breakthrough-medical' } })
  ).json() as { site: { id: string } };
  return created.site.id;
};

describe('publish/deploy cannot touch arbitrary filesystem paths', () => {
  it('publish ignores any client-supplied output directory (no rm -rf of host paths)', async () => {
    const siteId = await makeSite();
    const victim = mkdtempSync(join(tmpdir(), 'wb-victim-'));
    const sentinel = join(victim, 'keep.txt');
    writeFileSync(sentinel, 'precious');

    // Old vulnerability: {outDir} would rm -rf the target before writing.
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/publish`,
      payload: { outDir: victim },
    });
    // The extra field is rejected by strict schema (400) OR ignored — either
    // way the victim dir must survive untouched.
    expect([200, 400]).toContain(res.statusCode);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('precious');

    // And the real build landed under the managed data dir.
    if (res.statusCode === 200) {
      const body = res.json() as { distPath: string };
      expect(body.distPath).toContain(dataDir);
    }
    rmSync(victim, { recursive: true, force: true });
  });

  it('deploy rejects a client-supplied targetDir', async () => {
    const siteId = await makeSite();
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/deploy`,
      payload: { adapter: 'static', targetDir: '/etc/wb-evil' },
    });
    expect(res.statusCode).toBe(400); // strict schema drops the unknown field
    expect(existsSync('/etc/wb-evil')).toBe(false);
  });

  it('static deploy without a targetDir just reports the build path', async () => {
    const siteId = await makeSite();
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/deploy`,
      payload: { adapter: 'static' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('prepared');
  });
});

describe('preview path traversal + asset containment', () => {
  it('cannot escape the asset directory via ../ in the preview path', async () => {
    const siteId = await makeSite();
    for (const attack of [
      `/preview/${siteId}/assets/../../../../etc/passwd`,
      `/preview/${siteId}/assets/..%2f..%2f..%2fetc%2fpasswd`,
      `/preview/${siteId}/assets/....//....//etc/passwd`,
    ]) {
      const res = await app.inject({ url: attack });
      expect(res.statusCode, attack).toBe(404);
      expect(res.body).not.toContain('root:');
    }
  });

  it('serves uploaded assets with a locked-down CSP and nosniff', async () => {
    const siteId = await makeSite();
    const assets = (await app.inject({ url: `/sites/${siteId}/assets` })).json() as Array<{ path: string }>;
    const res = await app.inject({ url: `/preview/${siteId}/assets/${assets[0]!.path}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('input validation hardening', () => {
  it('rejects unknown body fields via strict schemas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sites',
      payload: { name: 'X', __proto__: { admin: true }, extra: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed tree ops with a 422 and does not mutate the page', async () => {
    const siteId = await makeSite();
    const home = (await app.inject({ url: `/sites/${siteId}/pages` })).json() as Array<{ id: string; rootId: string }>;
    const before = await app.inject({ url: `/sites/${siteId}/pages/${home[0]!.id}/tree` });
    const bad = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/pages/${home[0]!.id}/tree/ops`,
      payload: { ops: [{ op: 'frobnicate', nodeId: 'x' }] },
    });
    expect(bad.statusCode).toBe(400); // discriminated-union validation
    const after = await app.inject({ url: `/sites/${siteId}/pages/${home[0]!.id}/tree` });
    expect(after.body).toBe(before.body);
  });

  it('rejects an invalid slug on page creation', async () => {
    const siteId = await makeSite();
    for (const slug of ['Bad Slug', 'UPPER', '../escape', 'has/slash']) {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${siteId}/pages`,
        payload: { slug, title: 'T' },
      });
      expect([400, 422], slug).toContain(res.statusCode);
    }
  });

  it('404s for cross-site page and asset access', async () => {
    const a = await makeSite();
    const b = await makeSite();
    const bPages = (await app.inject({ url: `/sites/${b}/pages` })).json() as Array<{ id: string }>;
    // A page id from site B must not resolve under site A.
    const res = await app.inject({ url: `/sites/${a}/pages/${bPages[0]!.id}` });
    expect(res.statusCode).toBe(404);
  });
});
