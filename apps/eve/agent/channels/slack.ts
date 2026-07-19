import { connectSlackCredentials } from '@vercel/connect/eve';
import { slackChannel } from 'eve/channels/slack';

// Vercel Connect client UID for the Slack app (see README: `vercel connect create slack`).
const SLACK_CONNECT_UID = process.env.SLACK_CONNECT_UID ?? 'slack/wb-eve';

export default slackChannel({
  credentials: connectSlackCredentials(SLACK_CONNECT_UID),
  threadContext: { since: 'last-agent-reply' },
});
