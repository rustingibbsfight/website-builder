import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WbCore } from './core.js';
import {
  createSubmissionNotifiers,
  notifyAll,
  ResendEmailNotifier,
  SlackWebhookNotifier,
  type SubmissionNotice,
  type SubmissionNotifier,
} from './notify.js';

const notice = (over: Partial<SubmissionNotice> = {}): SubmissionNotice => ({
  siteId: 's1',
  siteName: 'Breakthrough Medical',
  formId: 'contact',
  data: { name: 'Dana', email: 'dana@example.com', message: 'Do you take my insurance?' },
  createdAt: '2026-08-04T10:00:00Z',
  reviewUrl: 'https://wb-api-gold.vercel.app/editor/',
  ...over,
});

function capture(status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(init!.body as string) });
    return new Response(status === 200 ? '{}' : 'nope', { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('SlackWebhookNotifier', () => {
  it('posts the fields to the webhook', async () => {
    const { calls, fetchFn } = capture();
    await new SlackWebhookNotifier({ webhookUrl: 'https://hooks.slack.com/services/T/B/x', fetchFn }).notify(notice());

    expect(calls[0]!.url).toBe('https://hooks.slack.com/services/T/B/x');
    const text = calls[0]!.body.text as string;
    expect(text).toContain('Breakthrough Medical');
    expect(text).toContain('*message:* Do you take my insurance?');
    expect(text).toContain('<https://wb-api-gold.vercel.app/editor/|Read them all>');
  });

  it('escapes mrkdwn so a submission cannot ping the channel or forge a link', async () => {
    const { calls, fetchFn } = capture();
    await new SlackWebhookNotifier({ webhookUrl: 'https://hooks.slack.com/x', fetchFn }).notify(
      notice({ data: { message: '<!channel> <https://evil.example|click here> & more' } }),
    );

    const text = calls[0]!.body.text as string;
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).toContain('&amp; more');
    // The only unescaped angle brackets left are the ones this code wrote.
    expect(text).not.toContain('<https://evil.example');
  });

  it('truncates a very long field rather than posting a wall of text', async () => {
    const { calls, fetchFn } = capture();
    await new SlackWebhookNotifier({ webhookUrl: 'https://hooks.slack.com/x', fetchFn }).notify(
      notice({ data: { message: 'x'.repeat(5000) } }),
    );
    const text = calls[0]!.body.text as string;
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(1000);
  });
});

describe('ResendEmailNotifier', () => {
  it('sends plain text with the submitter as reply-to', async () => {
    const { calls, fetchFn } = capture();
    await new ResendEmailNotifier({
      apiKey: 'ak_1',
      from: 'site@fightweightgain.com',
      to: ['front-desk@fightweightgain.com'],
      fetchFn,
    }).notify(notice());

    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer ak_1');
    const body = calls[0]!.body as { text: string; html?: string; reply_to?: string; subject: string };
    // Plain text only — every value in it was typed by a stranger, and text has
    // nothing to inject into.
    expect(body.html).toBeUndefined();
    expect(body.text).toContain('message: Do you take my insurance?');
    expect(body.subject).toContain('Breakthrough Medical');
    expect(body.reply_to).toBe('dana@example.com');
  });

  it('drops a reply-to that is not an address, rather than bouncing the send', async () => {
    const { calls, fetchFn } = capture();
    const notifier = new ResendEmailNotifier({ apiKey: 'k', from: 'a@b.com', to: ['c@d.com'], fetchFn });
    for (const bad of ['not an email', '', 'a@b', '<script>@x.com', 'a@b.com, evil@x.com', 'Name <a@b.com>']) {
      await notifier.notify(notice({ data: { email: bad } }));
    }
    expect(calls.every((c) => (c.body as { reply_to?: string }).reply_to === undefined)).toBe(true);
  });
});

describe('notifyAll', () => {
  it('runs every notifier and never throws when one fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    const ok: SubmissionNotifier = { name: 'ok', notify: async () => void ran.push('ok') };
    const bad: SubmissionNotifier = {
      name: 'bad',
      notify: async () => {
        throw new Error('slack is down');
      },
    };

    // Slack being down is not a reason for the email not to go, and neither is
    // a reason for the visitor to see an error for a message that was stored.
    await expect(notifyAll([bad, ok], notice())).resolves.toBeUndefined();
    expect(ran).toEqual(['ok']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('createSubmissionNotifiers', () => {
  it('builds only what is configured', () => {
    expect(createSubmissionNotifiers({})).toEqual([]);
    expect(createSubmissionNotifiers({ WB_NOTIFY_SLACK_WEBHOOK: 'https://hooks.slack.com/x' })).toHaveLength(1);
    expect(
      createSubmissionNotifiers({
        WB_NOTIFY_SLACK_WEBHOOK: 'https://hooks.slack.com/x',
        RESEND_API_KEY: 'k',
        WB_NOTIFY_EMAIL_TO: 'a@b.com, c@d.com',
        WB_NOTIFY_EMAIL_FROM: 'site@b.com',
      }).map((n) => n.name),
    ).toEqual(['slack', 'email']);
  });

  it('refuses to build an email notifier with no verified sender', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Resend rejects a send with no `from`, so this would fail at the provider
    // on every single submission — silently, since notifications are
    // best-effort. Better to be off and say so once.
    expect(createSubmissionNotifiers({ RESEND_API_KEY: 'k', WB_NOTIFY_EMAIL_TO: 'a@b.com' })).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('WbCore.createSubmission', () => {
  it('notifies on a new submission, and stores it even when every notifier fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'wb-notify-'));
    const seen: SubmissionNotice[] = [];
    const core = await WbCore.create({
      dataDir: dir,
      publicUrl: 'https://wb-api-gold.vercel.app',
      notifiers: [
        { name: 'spy', notify: async (n) => void seen.push(n) },
        {
          name: 'broken',
          notify: async () => {
            throw new Error('down');
          },
        },
      ],
    });
    try {
      const site = await core.createSite('Clinic');
      const rec = await core.createSubmission(site.id, 'contact', { name: 'Dana', message: 'Hello' });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        siteId: site.id,
        siteName: 'Clinic',
        formId: 'contact',
        data: { name: 'Dana', message: 'Hello' },
        reviewUrl: 'https://wb-api-gold.vercel.app/editor/',
      });
      // The capture is what matters; the alert failing must not lose it.
      expect((await core.listSubmissions(site.id)).map((s) => s.id)).toContain(rec.id);
    } finally {
      core.close();
      rmSync(dir, { recursive: true, force: true });
      err.mockRestore();
    }
  });
});
