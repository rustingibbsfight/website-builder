import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { loadConfig } from '../../src/config.js';
import { handleSlackEvent, isActionableEvent, type SlackEvent } from '../../src/handle-event.js';
import { verifySlackSignature } from '../../src/slack.js';

// Raw body needed for signature verification.
export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const eveConfig = loadConfig();
  const rawBody = await readRawBody(req);

  if (
    !verifySlackSignature(
      eveConfig.slackSigningSecret,
      rawBody,
      req.headers['x-slack-request-timestamp'] as string | undefined,
      req.headers['x-slack-signature'] as string | undefined,
    )
  ) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const payload = JSON.parse(rawBody) as {
    type: string;
    challenge?: string;
    event?: SlackEvent;
  };

  // Slack app setup handshake.
  if (payload.type === 'url_verification') {
    res.status(200).json({ challenge: payload.challenge });
    return;
  }

  // Slack retries delivery if we take >3s; we ack instantly and work in the
  // background, so a retry means a duplicate — drop it.
  if (req.headers['x-slack-retry-num']) {
    res.status(200).json({ ok: true, note: 'retry ignored' });
    return;
  }

  if (payload.type === 'event_callback' && payload.event && isActionableEvent(payload.event)) {
    // Ack within Slack's 3s window; keep working after the response is sent.
    waitUntil(
      handleSlackEvent(eveConfig, payload.event).catch((err) => {
        console.error('eve: unhandled error', err);
      }),
    );
  }

  res.status(200).json({ ok: true });
}
