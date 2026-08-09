import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore } from '@wb/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  loginBlocked,
  recordLoginFailure,
  type LoginAttempts,
} from './auth.js';

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

  it('rate-limits repeated failed logins with a 429, at the count it says', async () => {
    /**
     * Where, not merely that. "Somewhere in the first twenty" passes with the
     * threshold off by one in either direction — and both directions are wrong
     * in a way nobody would notice: one more attempt than intended handed to an
     * attacker, or the owner locked out one attempt early on their own laptop.
     */
    const attempt = (n: number) =>
      app.inject({ method: 'POST', url: '/auth/login', payload: { token: `wrong-${n}` } });

    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect((await attempt(i)).statusCode, `attempt ${i + 1}`).toBe(401);
    }
    expect((await attempt(LOGIN_MAX_FAILURES)).statusCode).toBe(429);
  });

  it('lets a correct token through, and clears the count that was building', async () => {
    // The half a limiter test usually leaves out: the counter is *cleared* on
    // success, so an owner who mistyped fourteen times is not one keystroke from
    // locking themselves out of their own API for five minutes.
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
      await app.inject({ method: 'POST', url: '/auth/login', payload: { token: 'wrong' } });
    }
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { token: TOKEN } })).statusCode).toBe(200);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { token: 'wrong' } });
      expect(res.statusCode, `attempt ${i + 1} after a success`).toBe(401);
    }
  });

  describe('the limiter, at the edges a route cannot reach', () => {
    const AT = 1_000_000;
    const full = (): LoginAttempts =>
      new Map([['1.2.3.4', { count: LOGIN_MAX_FAILURES, resetAt: AT + LOGIN_WINDOW_MS }]]);

    it('blocks at the threshold and not one below it', () => {
      const nearly: LoginAttempts = new Map([
        ['1.2.3.4', { count: LOGIN_MAX_FAILURES - 1, resetAt: AT + LOGIN_WINDOW_MS }],
      ]);
      expect(loginBlocked(nearly, '1.2.3.4', AT)).toBe(false);
      expect(loginBlocked(full(), '1.2.3.4', AT)).toBe(true);
    });

    it('holds the block through the last instant of the window and not past it', () => {
      // `now > resetAt` releases; on the boundary the window is still closed.
      // One tick either way is the difference between a limiter that expires
      // early and one that lingers, and neither is visible from the route.
      const end = AT + LOGIN_WINDOW_MS;
      expect(loginBlocked(full(), '1.2.3.4', end)).toBe(true);
      expect(loginBlocked(full(), '1.2.3.4', end + 1)).toBe(false);
    });

    it('keeps counting inside the window and starts over once it has passed', () => {
      const attempts = full();
      const end = AT + LOGIN_WINDOW_MS;

      recordLoginFailure(attempts, '1.2.3.4', end);
      expect(attempts.get('1.2.3.4')?.count).toBe(LOGIN_MAX_FAILURES + 1);

      recordLoginFailure(attempts, '1.2.3.4', end + 1);
      expect(attempts.get('1.2.3.4')).toEqual({ count: 1, resetAt: end + 1 + LOGIN_WINDOW_MS });
    });

    it('knows nothing about an address it has never seen', () => {
      expect(loginBlocked(new Map(), '9.9.9.9', AT)).toBe(false);
    });

    it('counts per address, so one attacker cannot lock everyone out', async () => {
      /**
       * The counter is keyed on `req.ip || 'unknown'`, and with that fallback
       * reached unconditionally every caller shares one bucket: fifteen wrong
       * guesses from anywhere would 429 the owner too. A limiter that turns into
       * a denial of service is worse than none, and every test above sends from
       * one address, which is exactly the fixture that cannot see it.
       */
      for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { token: 'wrong' },
          remoteAddress: '10.0.0.1',
        });
      }
      const blocked = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { token: 'wrong' },
        remoteAddress: '10.0.0.1',
      });
      expect(blocked.statusCode).toBe(429);

      const elsewhere = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { token: 'wrong' },
        remoteAddress: '10.0.0.2',
      });
      expect(elsewhere.statusCode).toBe(401);
    });
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

  it('marks the session cookie Secure in production, and not on plain-http dev', async () => {
    /**
     * The cookie carries the API token itself, so `Secure` is the difference
     * between a session that cannot cross a plaintext hop and one that will.
     * Nothing stood on it, and both ways of getting it wrong are silent: the
     * comparison inverted sets it in dev and clears it in production, and `&&`
     * in place of `||` clears it for every production deployment that terminates
     * TLS at a proxy — which is all of them.
     *
     * Off in ordinary dev, deliberately: a browser drops a `Secure` cookie on
     * plain-http localhost, so setting it always would make signing in locally
     * silently impossible.
     */
    const before = process.env.NODE_ENV;
    const cookieFor = async (env: string | undefined) => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      try {
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { token: TOKEN } });
        return login.headers['set-cookie'] as string;
      } finally {
        if (before === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = before;
      }
    };

    expect(await cookieFor('production')).toContain('Secure');
    expect(await cookieFor('test')).not.toContain('Secure');
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
