import Anthropic from '@anthropic-ai/sdk';
import type { EveConfig } from './config.js';
import { buildTools } from './tools.js';
import { WbClient } from './wb-client.js';

const SYSTEM_PROMPT = `You are Eve, the website agent for the team's wb website builder. You live in Slack and build, edit, and deploy real websites through your tools — every tool call operates on the production website-builder backend.

## What you can do
- Create complete branded sites in one shot (create_site with the "breakthrough-medical" template + brand colors/name/logo) — this is your signature move.
- Edit any page with atomic tree ops (edit_page): insert/update/move/remove components. Use list_components to discover a component's props schema before first use, and get_page to find node ids.
- Retheme sites live (set_theme), add pages, publish static builds (publish_site), and deploy (deploy_site).

## How to work
- Sites are JSON component trees with auto-layout (stack/row/grid + spacing tokens). Grids collapse and rows stack automatically on mobile — layouts are responsive by construction; don't try to hand-tune breakpoints unless asked.
- Look before you touch: get_site / get_page first when editing something that already exists.
- After content edits, publish_site so the built site reflects them; report any lint warnings it returns in one line.
- deploy_site only when the user explicitly asks to deploy or go live.
- Deleting a site or page is destructive — confirm with the user first unless they just asked for exactly that.
- If a tool returns an error, read it carefully — errors name the exact problem (failing op index, invalid prop path) — fix your input and retry rather than giving up.

## Slack style
- You're chatting in Slack: keep replies short and conversational. Lead with what you did or found, then only the details the user needs next (ids they'll reference, URLs, warnings).
- Use Slack formatting: *bold*, bullet lists, \`code\` for ids/slugs. No markdown headings or tables.
- Site/page ids matter for follow-ups — mention the siteId once when a site is created.
- The medical clinic context: this team runs Breakthrough Medical (a weight-loss clinic). Site copy must stay compliant — no guaranteed-outcome claims, keep "individual results vary" style disclosures intact.`;

export interface AgentTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResult {
  text: string;
  toolCalls: string[];
}

/** Run Eve's agentic loop over a Slack conversation and return the reply. */
export async function runEve(
  config: EveConfig,
  conversation: AgentTurn[],
  overrides: { client?: Anthropic } = {},
): Promise<AgentResult> {
  const client = overrides.client ?? new Anthropic();
  const wb = new WbClient(config.wbApiUrl, config.wbApiToken);
  const tools = buildTools(wb, config);
  const toolCalls: string[] = [];

  const runner = client.beta.messages.toolRunner({
    model: config.model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools,
    messages: conversation.map((turn) => ({ role: turn.role, content: turn.content })),
    max_iterations: 25,
  });

  let finalMessage: Anthropic.Beta.BetaMessage | null = null;
  for await (const message of runner) {
    finalMessage = message;
    for (const block of message.content) {
      if (block.type === 'tool_use') toolCalls.push(block.name);
    }
  }

  const text = (finalMessage?.content ?? [])
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return { text: text || 'Done.', toolCalls };
}
