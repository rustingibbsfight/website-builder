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
  core = new WbCore({ dataDir });
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
    const site = core.createSiteFromTemplate('breakthrough-medical');
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
