import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { project, type ChatEvent } from './chat-events.js';
import { editorContext } from './chat-context.js';

/**
 * The editor's chat with Eve, relayed through wb-api.
 *
 * Eve is Slack-only today: `apps/eve/agent/channels/eve.ts` refuses browser
 * requests by design, and it should keep refusing them. Opening a second door
 * into that channel for one caller is exactly the kind of thing that ends up
 * weaker than the first door. So the browser talks to wb-api — same origin,
 * already authenticated by the `wb_session` cookie it holds anyway — and
 * wb-api talks to eve.
 *
 * **Two routes, and polling rather than a socket.** Polling is the only shape
 * that survives all four of: a 60-second serverless ceiling, a closed tab, a
 * locked phone, and a cold start. A socket has to answer every one of those
 * separately and has no reconnect story at all; the cost of polling is a
 * request every couple of seconds while a turn is live, which is nothing.
 *
 * - `POST /sites/:siteId/chat` — **does not wait for the turn.** It posts to
 *   eve, reads far enough to learn the session id, abandons the body and
 *   returns 202. The turn keeps running on eve's side, so wb-api's own
 *   `maxDuration` bounds a relay leg rather than the work.
 * - `GET /sites/:siteId/chat?since=N` — the reconnect. Relays eve's durable
 *   stream from a cursor, projects it small, returns JSON, closes.
 *
 * `nextIndex` never goes backwards. Everything the client does is built on
 * that: it is the resume point after a reload, and a cursor that could move
 * back would replay a turn it had already drawn.
 */

const SiteChatParams = z.object({ siteId: z.string() });

/**
 * How long a relay leg may take.
 *
 * Well inside the route's own budget, so a slow eve comes back as a sentence
 * rather than as a gateway timeout the browser has to guess at.
 */
const RELAY_TIMEOUT_MS = 20_000;
const POST_BUDGET_MS = 10_000;

function eveBase(): string {
  const url = process.env.WB_EVE_URL;
  if (!url) throw new Error('WB_EVE_URL is not set — point it at the deployed wb-eve agent.');
  return url.replace(/\/$/, '');
}

/**
 * How wb-api authenticates to eve.
 *
 * A bearer when one is configured; nothing otherwise, which is the local case —
 * eve's `localDev()` opens the channel on localhost. Deliberately not the
 * browser's cookie: the browser is authenticated to *wb-api*, and forwarding a
 * user credential onward is how a proxy becomes a confused deputy.
 */
function eveHeaders(): Record<string, string> {
  const token = process.env.WB_EVE_TOKEN;
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export interface ChatDeps {
  /** Injected so the routes are testable without an agent. Mirrors `notify.ts`. */
  fetch?: typeof globalThis.fetch;
}

export async function registerChat(app: FastifyInstance, core: any, deps: ChatDeps = {}): Promise<void> {
  const doFetch = deps.fetch ?? globalThis.fetch;

  app.post(
    '/sites/:siteId/chat',
    {
      schema: {
        params: SiteChatParams,
        body: z.object({
          message: z.string().min(1),
          pageId: z.string().optional(),
          selectedNodeId: z.string().optional(),
        }),
      },
    },
    async (req: any, reply: any) => {
      const { siteId } = req.params;
      const site = await core.getSite(siteId);

      /**
       * The browser named ids; the server resolves them.
       *
       * The client sends `pageId` and nothing else about the page — no slug, no
       * title. Those are looked up here, so the worst a tampered client can do
       * is name a page belonging to another site, which this scoping refuses,
       * or one that does not exist, which yields a shorter context.
       */
      let page: { id: string; slug?: string; title?: string } | null = null;
      if (req.body.pageId) {
        const found = await core.getPage(siteId, req.body.pageId).catch(() => null);
        if (found) page = { id: found.id, slug: found.slug, title: found.title };
      }

      const context = editorContext({
        site: { id: site.id, name: site.name },
        page,
        node: req.body.selectedNodeId ? { id: req.body.selectedNodeId } : null,
      });

      const existing = await core.chatSessions.get(siteId);
      const budget = AbortSignal.timeout(POST_BUDGET_MS);

      let response: Response;
      try {
        response = await doFetch(`${eveBase()}/eve/v1/session${existing ? `/${existing}` : ''}`, {
          method: 'POST',
          headers: eveHeaders(),
          body: JSON.stringify({ message: req.body.message, clientContext: context }),
          signal: budget,
          // A credential-bearing request must not follow a redirect.
          redirect: 'error',
        });
      } catch (error) {
        return reply.code(502).send({
          error: `Could not reach the agent: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      if (!response.ok) {
        return reply.code(502).send({ error: `The agent refused the turn (${response.status}).` });
      }

      const sessionId = response.headers.get('x-eve-session') ?? existing ?? '';
      if (!sessionId) {
        return reply.code(502).send({ error: 'The agent did not name a session.' });
      }
      /**
       * The body is deliberately abandoned.
       *
       * Reading it to the end is waiting for the turn, which is the thing this
       * route exists not to do. The turn continues on eve regardless — that is
       * the property the whole "202 and let go" shape rests on, and it is worth
       * verifying against a deployment before trusting it.
       */
      void response.body?.cancel().catch(() => {});

      const claimed = await core.chatSessions.claim(siteId, sessionId, new Date().toISOString());
      return reply.code(202).send({ sessionId: claimed, live: true });
    },
  );

  app.get(
    '/sites/:siteId/chat',
    { schema: { params: SiteChatParams, querystring: z.object({ since: z.coerce.number().int().min(0).default(0) }) } },
    async (req: any, reply: any) => {
      const { siteId } = req.params;
      await core.getSite(siteId);

      const sessionId = await core.chatSessions.get(siteId);
      // No conversation yet is not an error — it is the state every site starts
      // in, and a 404 here would make the panel look broken on first open.
      if (!sessionId) {
        return { events: [] as ChatEvent[], nextIndex: 0, live: false };
      }

      const since = req.query.since;
      let response: Response;
      try {
        response = await doFetch(
          `${eveBase()}/eve/v1/session/${encodeURIComponent(sessionId)}/stream` +
            `?startIndex=${since}&includeTailIndex=1`,
          { headers: eveHeaders(), signal: AbortSignal.timeout(RELAY_TIMEOUT_MS), redirect: 'error' },
        );
      } catch (error) {
        return reply.code(502).send({
          error: `Could not read the agent's log: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (!response.ok) {
        return reply.code(502).send({ error: `The agent's log could not be read (${response.status}).` });
      }

      const { events, consumed } = project(await response.text());

      /**
       * How far behind we are, and the rule that has to be copied exactly.
       *
       * ComfyStudio's `session-watch.ts` states it: a **missing or unreadable
       * tail-index header means "not behind", never zero-and-therefore-behind**.
       * An older eve, a proxy that strips headers and a retired session all
       * arrive here identically, and inventing a backlog from any of them puts
       * "the agent is still working" on screen for ever.
       */
      const header = response.headers.get('x-eve-tail-index');
      const tail = header === null || Number.isNaN(Number(header)) ? null : Number(header);
      const nextIndex = since + consumed;

      return {
        events,
        nextIndex,
        ...(tail === null ? {} : { tailIndex: tail }),
        live: tail === null ? false : tail > nextIndex,
      };
    },
  );

  /** Start again. The old transcript stays in eve's log; this forgets the pointer. */
  app.delete('/sites/:siteId/chat', { schema: { params: SiteChatParams } }, async (req: any, reply: any) => {
    await core.getSite(req.params.siteId);
    await core.chatSessions.clear(req.params.siteId);
    return reply.code(204).send();
  });
}
