import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WbCore } from '@wb/core';
import { buildApp } from '@wb/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EveConfig } from './config.js';
import { cleanText, isActionableEvent, threadToConversation } from './handle-event.js';
import { toMrkdwn, verifySlackSignature } from './slack.js';
import { buildTools } from './tools.js';
import { WbClient } from './wb-client.js';

describe('slack signature verification', () => {
  const secret = 'test-secret';
  const body = '{"type":"event_callback"}';
  const now = 1_700_000_000;
  const sign = (ts: number, b: string) =>
    `v0=${createHmac('sha256', secret).update(`v0:${ts}:${b}`).digest('hex')}`;

  it('accepts a valid signature', () => {
    expect(verifySlackSignature(secret, body, String(now), sign(now, body), now)).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets, and stale timestamps', () => {
    expect(verifySlackSignature(secret, `${body} `, String(now), sign(now, body), now)).toBe(false);
    expect(verifySlackSignature('other', body, String(now), sign(now, body), now)).toBe(false);
    const stale = now - 600;
    expect(verifySlackSignature(secret, body, String(stale), sign(stale, body), now)).toBe(false);
    expect(verifySlackSignature(secret, body, undefined, undefined, now)).toBe(false);
  });
});

describe('event filtering and thread mapping', () => {
  it('responds to mentions and DMs, ignores bots and subtypes', () => {
    const base = { channel: 'C1', ts: '1.0' };
    expect(isActionableEvent({ ...base, type: 'app_mention' })).toBe(true);
    expect(isActionableEvent({ ...base, type: 'message', channel_type: 'im' })).toBe(true);
    expect(isActionableEvent({ ...base, type: 'message', channel_type: 'channel' })).toBe(false);
    expect(isActionableEvent({ ...base, type: 'app_mention', bot_id: 'B1' })).toBe(false);
    expect(isActionableEvent({ ...base, type: 'message', channel_type: 'im', subtype: 'message_changed' })).toBe(false);
  });

  it('strips mentions and rebuilds conversations with correct roles', () => {
    expect(cleanText('<@U123> build me a site')).toBe('build me a site');
    const turns = threadToConversation(
      [
        { ts: '1', text: '<@U9> create a clinic site', user: 'U1' },
        { ts: '2', text: 'Created site abc123.', bot_id: 'B1' },
        { ts: '3', text: 'now make the primary color green', user: 'U1' },
      ],
      'now make the primary color green',
    );
    expect(turns).toEqual([
      { role: 'user', content: 'create a clinic site' },
      { role: 'assistant', content: 'Created site abc123.' },
      { role: 'user', content: 'now make the primary color green' },
    ]);
  });

  it('always yields a conversation starting with a user turn (API invariant)', () => {
    // Thread that (pathologically) starts with a bot message.
    const turns = threadToConversation(
      [
        { ts: '1', text: 'I did a thing.', bot_id: 'B1' },
        { ts: '2', text: 'ok do another', user: 'U1' },
      ],
      'ok do another',
    );
    expect(turns[0]!.role).toBe('user');
  });

  it('appends the latest text when the thread ends on a bot turn', () => {
    const turns = threadToConversation(
      [
        { ts: '1', text: 'make a site', user: 'U1' },
        { ts: '2', text: 'done', bot_id: 'B1' },
      ],
      'now publish it',
    );
    expect(turns[turns.length - 1]).toEqual({ role: 'user', content: 'now publish it' });
  });

  it('handles an empty thread by falling back to the latest message', () => {
    expect(threadToConversation([], '<@U1> hi')).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops subtype/empty messages from the reconstructed thread', () => {
    const turns = threadToConversation(
      [
        { ts: '1', text: 'build', user: 'U1' },
        { ts: '2', text: 'joined', user: 'U2', subtype: 'channel_join' },
        { ts: '3', text: '', user: 'U1' },
      ],
      'build',
    );
    expect(turns).toEqual([{ role: 'user', content: 'build' }]);
  });
});

describe('mrkdwn conversion', () => {
  it('converts bold, headings, and links', () => {
    expect(toMrkdwn('**done** with [the site](https://x.example/a)')).toBe(
      '*done* with <https://x.example/a|the site>',
    );
    expect(toMrkdwn('## Summary')).toBe('*Summary*');
  });
});

describe('eve tools against a real wb server', () => {
  let dataDir: string;
  let core: WbCore;
  let app: FastifyInstance;
  let baseUrl: string;

  const config: EveConfig = {
    wbApiUrl: '',
    slackBotToken: 'x',
    slackSigningSecret: 'x',
    model: 'claude-opus-4-8',
    deployAdapter: 'static',
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wb-eve-'));
    core = new WbCore({ dataDir });
    app = await buildApp({ core, openapi: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    config.wbApiUrl = baseUrl;
  });

  afterAll(async () => {
    await app.close();
    core.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const callTool = async (name: string, input: unknown): Promise<string> => {
    const tools = buildTools(new WbClient(baseUrl), config);
    const tool = tools.find((t) => t.name === name)!;
    // biome-ignore lint: test invokes the runner-facing function directly
    return (tool as { run: (input: never) => Promise<string> }).run(input as never);
  };

  it('runs the northstar flow: create → edit → publish', async () => {
    const templates = JSON.parse(await callTool('list_templates', {})) as Array<{ name: string }>;
    expect(templates[0]!.name).toBe('breakthrough-medical');

    const created = JSON.parse(
      await callTool('create_site', {
        name: 'Eve Test Clinic',
        template: 'breakthrough-medical',
        brand: { colors: { primary: '#446688' } },
      }),
    ) as { site: { id: string; theme: { colors: { primary: string } } }; pages: Array<{ id: string; slug: string }> };
    expect(created.site.theme.colors.primary).toBe('#446688');
    const siteId = created.site.id;

    const page = JSON.parse(await callTool('get_page', { siteId, page: 'index' })) as {
      tree: { id: string };
    };
    const edited = await callTool('edit_page', {
      siteId,
      page: 'index',
      ops: [
        {
          op: 'insert',
          parentId: page.tree.id,
          node: {
            type: 'section',
            layout: { direction: 'stack', padding: 'lg' },
            children: [{ type: 'heading', props: { text: 'Added by Eve', level: 2 } }],
          },
        },
      ],
    });
    expect(edited).toContain('Added by Eve');

    const published = JSON.parse(await callTool('publish_site', { siteId })) as {
      pageCount: number;
      files: string[];
    };
    expect(published.pageCount).toBe(4);
    expect(published.files).toContain('index.html');
  });

  it('returns readable errors for Claude to self-correct on', async () => {
    const error = await callTool('edit_page', {
      siteId: 'nope',
      page: 'index',
      ops: [{ op: 'remove', nodeId: 'x' }],
    });
    expect(error).toMatch(/^Error: /);
    expect(error).toContain('not found');
  });
});

describe('eve against a token-protected wb server', () => {
  it('sends the bearer token and fails cleanly without it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-eve-auth-'));
    const core = new WbCore({ dataDir });
    const app = await buildApp({ core, openapi: false, apiToken: 'sekrit' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const config: EveConfig = {
      wbApiUrl: baseUrl,
      wbApiToken: 'sekrit',
      slackBotToken: 'x',
      slackSigningSecret: 'x',
      model: 'claude-opus-4-8',
    };
    try {
      const withToken = buildTools(new WbClient(baseUrl, 'sekrit'), config);
      const ok = await (withToken.find((t) => t.name === 'list_templates') as {
        run: (i: never) => Promise<string>;
      }).run({} as never);
      expect(ok).toContain('breakthrough-medical');

      const without = buildTools(new WbClient(baseUrl), config);
      const denied = await (without.find((t) => t.name === 'list_templates') as {
        run: (i: never) => Promise<string>;
      }).run({} as never);
      expect(denied).toMatch(/^Error: .*unauthorized/);
    } finally {
      await app.close();
      core.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
