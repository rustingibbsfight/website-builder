import { runEve, type AgentTurn } from './agent.js';
import type { EveConfig } from './config.js';
import { SlackClient, toMrkdwn, type SlackMessage } from './slack.js';

export interface SlackEvent {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

/** Should Eve respond to this event at all? */
export function isActionableEvent(event: SlackEvent): boolean {
  if (event.bot_id || event.subtype) return false;
  if (event.type === 'app_mention') return true;
  return event.type === 'message' && event.channel_type === 'im';
}

/** Strip <@UXXXX> mentions and trim. */
export function cleanText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** Rebuild the agent conversation from a Slack thread (bot turns = assistant). */
export function threadToConversation(messages: SlackMessage[], latestText: string): AgentTurn[] {
  const turns: AgentTurn[] = messages
    .filter((m) => !m.subtype && m.text)
    .map((m) => ({
      role: m.bot_id ? ('assistant' as const) : ('user' as const),
      content: cleanText(m.text ?? ''),
    }))
    .filter((t) => t.content.length > 0);

  if (turns.length === 0) return [{ role: 'user', content: cleanText(latestText) }];
  // The API requires the first turn to be from the user.
  while (turns.length > 0 && turns[0]!.role === 'assistant') turns.shift();
  if (turns.length === 0 || turns[turns.length - 1]!.role !== 'user') {
    turns.push({ role: 'user', content: cleanText(latestText) });
  }
  return turns;
}

/** Full handling of one actionable Slack event: context → agent → threaded reply. */
export async function handleSlackEvent(config: EveConfig, event: SlackEvent): Promise<void> {
  const slack = new SlackClient(config.slackBotToken);
  const threadTs = event.thread_ts ?? event.ts;
  await slack.addReaction(event.channel, event.ts, 'eyes');

  try {
    let conversation: AgentTurn[];
    if (event.thread_ts) {
      const replies = await slack.threadReplies(event.channel, event.thread_ts);
      conversation = threadToConversation(replies, event.text ?? '');
    } else {
      conversation = [{ role: 'user', content: cleanText(event.text ?? '') }];
    }
    if (conversation.every((t) => t.content.trim() === '')) return;

    const result = await runEve(config, conversation);
    await slack.postMessage(event.channel, toMrkdwn(result.text), threadTs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await slack.postMessage(
      event.channel,
      `:warning: I hit an error and couldn't finish: \`${message.slice(0, 400)}\``,
      threadTs,
    );
  }
}
