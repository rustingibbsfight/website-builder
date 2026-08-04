/**
 * Telling somebody a message arrived.
 *
 * Without this, a contact form is a hole in the ground: the visitor gets a
 * thank-you page, the row lands in the database, and nothing else happens until
 * a person thinks to go and look. For a clinic that is worse than a form which
 * is visibly broken — a prospective patient believes they have been in touch,
 * and nobody has read a word of it.
 *
 * Two rules shape everything here.
 *
 * **A notification must never cost a submission.** The message is already
 * stored by the time any of this runs, and it stays readable in the editor and
 * through the API whatever happens next. So every failure is swallowed and
 * logged, and every call is bounded by a timeout — an unreachable Slack must
 * not leave a visitor watching a spinner, and it must certainly not turn into
 * an error page that makes them submit again.
 *
 * **Everything in a submission is attacker-controlled.** It arrives on a public,
 * unauthenticated endpoint. Slack text is escaped, and mail goes out as
 * `text/plain` rather than HTML — not because HTML would be hard, but because
 * plain text has nothing to inject into.
 */

export interface SubmissionNotice {
  siteId: string;
  siteName: string;
  formId: string;
  data: Record<string, string>;
  createdAt: string;
  /** Where a human can read the rest of them. */
  reviewUrl?: string;
}

export interface SubmissionNotifier {
  readonly name: string;
  notify(notice: SubmissionNotice): Promise<void>;
}

/** Long enough for a healthy API, short enough that a sick one isn't the
 *  visitor's problem. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Field values are capped at 5000 chars on the way in; a notification is a
 *  nudge to go and read it, not the archive. */
const PREVIEW_CHARS = 500;

function preview(value: string): string {
  const flat = value.replace(/\r\n?/g, '\n').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

function lines(notice: SubmissionNotice): Array<[string, string]> {
  return Object.entries(notice.data).map(([k, v]) => [k, preview(String(v))]);
}

/** Slack's mrkdwn has exactly three characters that need escaping. A message
 *  body containing `<!channel>` must arrive as text, not as a ping. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    // A credential-bearing request must not follow a redirect.
    redirect: 'error',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${detail.slice(0, 200)}`);
  }
}

export interface SlackNotifierConfig {
  webhookUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Posts to a Slack incoming webhook — the channel is chosen when the webhook
 *  is created, so nothing here needs to know or store a channel id. */
export class SlackWebhookNotifier implements SubmissionNotifier {
  readonly name = 'slack';
  constructor(private cfg: SlackNotifierConfig) {}

  async notify(notice: SubmissionNotice): Promise<void> {
    const body = lines(notice)
      .map(([k, v]) => `*${escapeSlack(k)}:* ${escapeSlack(v)}`)
      .join('\n');
    const header = `:envelope: New message via *${escapeSlack(notice.siteName)}* (form \`${escapeSlack(notice.formId)}\`)`;
    const footer = notice.reviewUrl ? `\n<${notice.reviewUrl}|Read them all>` : '';
    await postJson(
      this.cfg.webhookUrl,
      { text: `${header}\n${body || '_(empty submission)_'}${footer}` },
      {},
      this.cfg.fetchFn ?? fetch,
      this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }
}

export interface EmailNotifierConfig {
  apiKey: string;
  from: string;
  to: string[];
  replyToField?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sends through Resend's HTTP API — one POST, no SMTP connection to keep alive,
 * which is the only shape that works from a serverless function.
 *
 * The body is `text`, never `html`: every value in it was typed by a stranger.
 */
export class ResendEmailNotifier implements SubmissionNotifier {
  readonly name = 'email';
  constructor(private cfg: EmailNotifierConfig) {}

  async notify(notice: SubmissionNotice): Promise<void> {
    const body = [
      `New message via ${notice.siteName} (form: ${notice.formId})`,
      `Received: ${notice.createdAt}`,
      '',
      ...lines(notice).map(([k, v]) => `${k}: ${v}`),
      ...(notice.reviewUrl ? ['', `Read them all: ${notice.reviewUrl}`] : []),
    ].join('\n');

    // Replying to the notification should reach the person who wrote in, when
    // they left an address that looks like one. A malformed value is dropped
    // rather than passed through — it would bounce the whole send.
    // A *bare* address and nothing else. The excluded characters are the ones
    // that turn a value into display-name syntax (`Name <a@b>`) or a second
    // recipient — neither of which should ride in from a public form.
    const BARE_ADDRESS = /^[^@\s<>,;:"]+@[^@\s<>,;:".]+\.[^@\s<>,;:"]+$/;
    const candidate = notice.data[this.cfg.replyToField ?? 'email']?.trim();
    const replyTo = candidate && BARE_ADDRESS.test(candidate) ? candidate : undefined;

    await postJson(
      'https://api.resend.com/emails',
      {
        from: this.cfg.from,
        to: this.cfg.to,
        subject: `New message via ${notice.siteName}`,
        text: body,
        ...(replyTo ? { reply_to: replyTo } : {}),
      },
      { authorization: `Bearer ${this.cfg.apiKey}` },
      this.cfg.fetchFn ?? fetch,
      this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  }
}

/**
 * Run every notifier, and let none of them break the others or the caller.
 *
 * `allSettled` rather than `all`: Slack being down is not a reason for the
 * email not to go, and neither is a reason for the visitor to see an error for
 * a message that was stored successfully.
 */
export async function notifyAll(
  notifiers: readonly SubmissionNotifier[],
  notice: SubmissionNotice,
): Promise<void> {
  if (!notifiers.length) return;
  const results = await Promise.allSettled(notifiers.map((n) => n.notify(notice)));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      // Logged, not thrown. The message is already saved; this is the alert
      // failing, not the capture.
      console.error(`[wb] ${notifiers[i]!.name} submission notification failed:`, result.reason);
    }
  });
}

/**
 * Build the configured notifiers from the environment.
 *
 * Absent configuration means no notifications, not an error: a self-hosted wb
 * with no Slack and no mail provider is a normal way to run this, and the
 * messages are still captured and readable.
 */
export function createSubmissionNotifiers(env: NodeJS.ProcessEnv = process.env): SubmissionNotifier[] {
  const notifiers: SubmissionNotifier[] = [];

  if (env.WB_NOTIFY_SLACK_WEBHOOK) {
    notifiers.push(new SlackWebhookNotifier({ webhookUrl: env.WB_NOTIFY_SLACK_WEBHOOK }));
  }

  const to = (env.WB_NOTIFY_EMAIL_TO ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (env.RESEND_API_KEY && to.length) {
    notifiers.push(
      new ResendEmailNotifier({
        apiKey: env.RESEND_API_KEY,
        // Resend requires a verified sender; there is no safe guess, so a
        // missing one is a missing notifier rather than a send that fails at
        // the provider on every single submission.
        from: env.WB_NOTIFY_EMAIL_FROM ?? '',
        to,
      }),
    );
    if (!env.WB_NOTIFY_EMAIL_FROM) {
      notifiers.pop();
      console.error('[wb] WB_NOTIFY_EMAIL_TO is set but WB_NOTIFY_EMAIL_FROM is not — email notifications are off');
    }
  }

  return notifiers;
}
