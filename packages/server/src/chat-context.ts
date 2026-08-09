/**
 * What the agent is told about where the person is standing.
 *
 * Delivered as eve `clientContext` — rendered for that model call and never
 * written into durable history. The same rule ComfyStudio's `composeContext`
 * follows, and for the same reason: which page is open changes with every
 * click, and a fact that changes constantly must not be baked into a transcript
 * where nothing in the conversation can correct it. A stale "you are on the
 * pricing page" is worse than no line at all.
 *
 * **The browser names ids; the server resolves them.** The client sends
 * `{pageId, selectedNodeId}` and nothing else — no slug, no title, no node
 * type. Those are looked up here from the database.
 *
 * That is not ceremony. A client that echoed the title back would be handing
 * the agent a string the browser chose, in a place the agent reads as fact, and
 * this text sits *above* the user's message in a prompt. Resolving it server
 * side means the worst a tampered client can do is name an id that belongs to
 * another site — which is checked — or one that does not exist, which produces
 * a shorter context and nothing else.
 *
 * And **never the tree**. The agent has `get_page` and can ask; a tree in every
 * turn's context is the transcript-sized payload `chat-events.ts` exists to
 * avoid, arriving through the other door.
 */

export interface ContextInput {
  site: { id: string; name?: string };
  page?: { id: string; slug?: string; title?: string } | null;
  node?: { id: string; type?: string } | null;
}

/**
 * The context lines, or nothing at all.
 *
 * Nothing when there is nothing worth saying: a context that is only "you are
 * on a site" is tokens spent on every turn to tell the agent something its
 * tools already report.
 */
export function editorContext(input: ContextInput): string {
  const lines: string[] = [];

  lines.push(
    `The user is in the visual editor for site \`${input.site.id}\`${
      input.site.name ? ` ("${input.site.name}")` : ''
    }.`,
  );

  if (input.page) {
    const named = [input.page.title, input.page.slug ? `/${input.page.slug}` : null]
      .filter(Boolean)
      .join(' ');
    lines.push(
      `They have the page \`${input.page.id}\`${named ? ` (${named})` : ''} open on screen right now.`,
    );
    // The half that stops the agent asking. Without it every turn begins with
    // "which page?", which the user can see the answer to and cannot understand
    // why they are being asked.
    lines.push('Assume that page unless they say otherwise. Do not ask which site or which page.');
  }

  if (input.node) {
    lines.push(
      `They have selected the \`${input.node.type ?? 'unknown'}\` node \`${input.node.id}\`.` +
        ' "this", "it" and "here" most likely mean that node.',
    );
  }

  lines.push(
    'They are looking at the page while you work: say what you changed, not what it looks like.' +
      ' The canvas reloads itself — never tell them to refresh.',
  );

  return lines.join('\n');
}
