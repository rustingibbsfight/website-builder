import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const SESSION_COOKIE = 'wb_session';

/**
 * Paths reachable without a token: health probe, the login flow, and the
 * editor's static shell (the SPA renders the token gate itself; all data
 * routes it calls stay protected). Exact-or-slash matching so e.g.
 * /healthz or /editorx would not inherit openness.
 */
function isOpenPath(path: string): boolean {
  return (
    path === '/health' ||
    path === '/editor' ||
    path.startsWith('/editor/') ||
    path === '/auth' ||
    path.startsWith('/auth/')
  );
}

function tokenMatches(expected: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Token auth for the wb API. When `apiToken` is set, every route (except
 * /health and /auth/*) requires one of:
 *   - `Authorization: Bearer <token>` or `x-api-key: <token>` (API clients), or
 *   - the HttpOnly session cookie set by POST /auth/login (browser editor +
 *     preview iframe, which cannot attach headers to document/asset requests).
 * When `apiToken` is undefined the API stays open (local development).
 */
export async function registerAuth(app: FastifyInstance, apiToken: string | undefined): Promise<void> {
  await app.register(cookie);

  app.get('/auth/me', async (req) => {
    if (!apiToken) return { authRequired: false, authenticated: true };
    const authenticated =
      tokenMatches(apiToken, bearerOf(req.headers.authorization)) ||
      tokenMatches(apiToken, req.headers['x-api-key'] as string | undefined) ||
      tokenMatches(apiToken, req.cookies[SESSION_COOKIE]);
    return { authRequired: true, authenticated };
  });

  app.post(
    '/auth/login',
    { schema: { body: z.object({ token: z.string().min(1) }).strict() } },
    async (req, reply) => {
      if (!apiToken) return { ok: true, note: 'auth is not enabled on this server' };
      const { token } = req.body as { token: string };
      if (!tokenMatches(apiToken, token)) {
        return reply.status(401).send({ error: 'invalid token' });
      }
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
      return { ok: true };
    },
  );

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  if (!apiToken) return;

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (isOpenPath(path)) return;
    const ok =
      tokenMatches(apiToken, bearerOf(req.headers.authorization)) ||
      tokenMatches(apiToken, req.headers['x-api-key'] as string | undefined) ||
      tokenMatches(apiToken, req.cookies[SESSION_COOKIE]);
    if (!ok) {
      return reply
        .status(401)
        .send({ error: 'unauthorized — pass Authorization: Bearer <token>, x-api-key, or log in at /auth/login' });
    }
  });
}

function bearerOf(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}
