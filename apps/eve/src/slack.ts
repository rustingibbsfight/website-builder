import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verify a Slack request signature (v0 HMAC-SHA256, 5-minute replay window). */
export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 60 * 5) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

export class SlackClient {
  constructor(private token: string) {}

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) throw new Error(`slack ${method} failed: ${data.error ?? res.status}`);
    return data;
  }

  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string }> {
    return this.call('chat.postMessage', {
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
    });
  }

  addReaction(channel: string, timestamp: string, name: string): Promise<unknown> {
    return this.call('reactions.add', { channel, timestamp, name }).catch(() => ({}));
  }

  async threadReplies(channel: string, threadTs: string, limit = 30): Promise<SlackMessage[]> {
    const data = await this.call<{ messages: SlackMessage[] }>('conversations.replies', {
      channel,
      ts: threadTs,
      limit,
    });
    return data.messages ?? [];
  }
}

/** Minimal markdown → Slack mrkdwn: bold, headings, links. */
export function toMrkdwn(text: string): string {
  return text
    .replace(/^#{1,4}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>');
}
