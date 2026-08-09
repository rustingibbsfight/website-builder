import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore } from '@wb/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const TOKEN = 'wb-secret-token-123';

let dataDir: string;
let core: WbCore;
let app: FastifyInstance;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-auth-'));
  core = await WbCore.create({ dataDir });
  app = await buildApp({ core, apiToken: TOKEN });
});

afterEach(async () => {
  await app.close();
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('token auth', () => {
  it('rejects unauthenticated data requests, allows health', async () => {
    expect((await app.inject({ url: '/sites' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/sites', payload: { name: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/openapi.json' })).statusCode).toBe(401);
  });

  it('accepts Bearer and x-api-key headers', async () => {
    const bearer = await app.inject({ url: '/sites', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.statusCode).toBe(200);
    const apiKey = await app.inject({ url: '/sites', headers: { 'x-api-key': TOKEN } });
    expect(apiKey.statusCode).toBe(200);
    const wrong = await app.inject({ url: '/sites', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
  });

  it('rate-limits repeated failed logins with a 429', async () => {
    // Hammer with wrong tokens; after the failure threshold the endpoint locks.
    let saw429 = false;
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { token: `wrong-${i}` } });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
      expect(res.statusCode).toBe(401);
    }
    expect(saw429).toBe(true);
  });

  it('supports the cookie login flow for browsers', async () => {
    const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { token: 'wrong' } });
    expect(bad.statusCode).toBe(401);

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { token: TOKEN } });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'] as string;
    expect(setCookie).toContain('wb_session=');
    expect(setCookie).toContain('HttpOnly');

    const cookie = setCookie.split(';')[0]!;
    const sites = await app.inject({ url: '/sites', headers: { cookie } });
    expect(sites.statusCode).toBe(200);
    // Preview documents also work via cookie (the editor iframe path).
    const site = await core.createSiteFromTemplate('breakthrough-medical');
    const preview = await app.inject({ url: `/preview/${site.id}/`, headers: { cookie } });
    expect(preview.statusCode).toBe(200);
    const previewNoAuth = await app.inject({ url: `/preview/${site.id}/` });
    expect(previewNoAuth.statusCode).toBe(401);
  });

  it('reports auth state on /auth/me and serves the editor shell openly', async () => {
    const anon = (await app.inject({ url: '/auth/me' })).json() as { authRequired: boolean; authenticated: boolean };
    expect(anon).toEqual({ authRequired: true, authenticated: false });
    const authed = (
      await app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${TOKEN}` } })
    ).json() as { authenticated: boolean };
    expect(authed.authenticated).toBe(true);
    // Editor static shell loads without auth so the token gate can render.
    const editor = await app.inject({ url: '/editor/' });
    expect([200, 404]).toContain(editor.statusCode); // 404 only if the SPA isn't built
    expect(editor.statusCode).not.toBe(401);
  });

  it('stays fully open when no token is configured', async () => {
    const openApp = await buildApp({ core, openapi: false });
    expect((await openApp.inject({ url: '/sites' })).statusCode).toBe(200);
    const me = (await openApp.inject({ url: '/auth/me' })).json() as { authRequired: boolean };
    expect(me.authRequired).toBe(false);
    await openApp.close();
  });
});

describe('failing closed in production (#50)', () => {
  /**
   * No token means "open", which is the right default for `wb serve` on
   * loopback — a single-owner tool on your own laptop should not demand a
   * secret before it will draw a page. It is the wrong default the moment the
   * same code is behind a public hostname, and nothing in between says which
   * one you are.
   *
   * The CLI already refuses to bind a non-loopback host without a token. A
   * deployment has no bind step to refuse at, so the check lives in `buildApp`:
   * in production, no token is a misconfiguration, and the honest response to a
   * misconfiguration that would expose every write route is to not start.
   */
  const withEnv = async (env: string | undefined, run: () => Promise<void>) => {
    const before = process.env.NODE_ENV;
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
    try {
      await run();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  };

  it('refuses to start with no token in production', async () => {
    await withEnv('production', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-prod-'));
      const prodCore = await WbCore.create({ dataDir: dir });
      try {
        await expect(buildApp({ core: prodCore })).rejects.toThrow(/WB_API_TOKEN/);
      } finally {
        prodCore.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('starts in production when a token is given', async () => {
    // The guard is about a *missing* token, not about production being special
    // — a deployment that is configured must not be blocked by the thing that
    // exists to protect an unconfigured one.
    await withEnv('production', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-prod-ok-'));
      const prodCore = await WbCore.create({ dataDir: dir });
      const prodApp = await buildApp({ core: prodCore, apiToken: TOKEN });
      try {
        expect((await prodApp.inject({ url: '/health' })).statusCode).toBe(200);
      } finally {
        await prodApp.close();
        prodCore.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('still opens without a token off production', async () => {
    // `wb serve` on a laptop. Taking this away would make the tool demand a
    // secret to draw a page for its single owner, which is the reason the open
    // default exists.
    await withEnv(undefined, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wb-dev-'));
      const devCore = await WbCore.create({ dataDir: dir });
      const devApp = await buildApp({ core: devCore });
      try {
        expect((await devApp.inject({ url: '/sites' })).statusCode).toBe(200);
      } finally {
        await devApp.close();
        devCore.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
