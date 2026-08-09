/**
 * Eve's event stream, projected down to what a 360px panel can hold.
 *
 * This is the load-bearing piece of the chat transport, and the reason is a
 * number: `edit_page` returns the **entire updated page tree**, and `get_page`
 * returns another one. A transport that relays eve's events verbatim therefore
 * ships a whole site's tree into the browser on every edit, and a conversation
 * that makes six edits ships six of them. It is ComfyStudio's 1.9 MB base64
 * lesson in a quieter form — there, one tool result made a single event large
 * enough to hang the chat page.
 *
 * So a tool result is **summarised**, not forwarded. `edit_page` becomes
 * `{ops: 3, page: 'pricing'}`: enough to say what happened, nothing that could
 * be mistaken for state. That second half matters as much as the byte count —
 * a client holding a tree will sooner or later be tempted to apply it, and then
 * there are two implementations of "what the tree is now" while the server
 * already has the answer.
 *
 * Tool **state** passes through verbatim, because liveness is decided in the
 * client and a transport that collapsed `input-available` into "running" would
 * be making that decision here, one layer too early.
 *
 * Two refusals, both tested:
 *
 * - **An unknown event type is dropped, never thrown on.** Eve is a dependency
 *   and will grow event types; a transport that 500s on one it has not seen
 *   turns somebody else's minor release into an outage here.
 * - **A truncated final line advances the cursor only by what parsed.** The
 *   stream is NDJSON over a connection that can be cut mid-line. Counting the
 *   partial line as consumed would skip the event it belongs to, permanently,
 *   because the cursor never goes backwards.
 */

export type ChatEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; state: string; summary?: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

/** Tools that change the site, so the canvas has to catch up when one finishes. */
const MUTATING = new Set([
  'edit_page',
  'update_page',
  'add_page',
  'delete_page',
  'set_theme',
  'add_asset',
  'delete_asset',
  'update_site',
  'request_image',
]);

export const isMutating = (name: string) => MUTATING.has(name);

/**
 * What a tool result is worth saying, per tool.
 *
 * Everything not named here is reduced to nothing at all rather than passed
 * through — the safe default for a projection whose whole job is to not ship
 * a tree. A tool added to eve tomorrow says only its name and its state, which
 * is a worse feed entry and not a 400 KB one.
 */
function summarise(name: string, result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const row = result as Record<string, unknown>;

  switch (name) {
    case 'edit_page':
    case 'update_page':
      return {
        ...(typeof row.slug === 'string' ? { page: row.slug } : {}),
        ...(Array.isArray(row.ops) ? { ops: row.ops.length } : {}),
      };
    case 'add_page':
    case 'delete_page':
      return typeof row.slug === 'string' ? { page: row.slug } : undefined;
    case 'request_image':
    case 'add_asset':
      return {
        ...(typeof row.assetId === 'string' ? { assetId: row.assetId } : {}),
        ...(typeof row.alt === 'string' ? { alt: row.alt } : {}),
        ...(Array.isArray(row.images) ? { images: row.images.length } : {}),
      };
    case 'deploy_site':
    case 'publish_site':
      return typeof row.url === 'string' ? { url: row.url } : undefined;
    default:
      return undefined;
  }
}

export interface Projected {
  events: ChatEvent[];
  /** How many *whole* lines were consumed. The caller adds this to its cursor. */
  consumed: number;
}

/**
 * One chunk of NDJSON, as events.
 *
 * `consumed` is deliberately not `lines.length`: a chunk ending mid-line has a
 * final fragment that is not an event yet, and telling the caller otherwise
 * loses it for good.
 */
export function project(ndjson: string): Projected {
  const lines = ndjson.split('\n');
  /**
   * Everything but the last element, in both cases, for two different reasons.
   *
   * A chunk ending in a newline splits to a final empty string — nothing to
   * consume. A chunk cut mid-line splits to a final *fragment* — not an event
   * yet, and it must not be counted, because the cursor never goes backwards
   * and counting it would skip that event permanently.
   *
   * The two cases arriving at the same index is a coincidence worth writing
   * down rather than a rule; a reader who assumes it is a rule will "simplify"
   * the truncation case away.
   */
  const usable = lines.slice(0, -1);

  const events: ChatEvent[] = [];
  let consumed = 0;

  for (const line of usable) {
    consumed += 1;
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A line that is whole but not JSON is eve saying something this version
      // does not understand. Skipping it is the same judgement as an unknown
      // type, and it has still been consumed.
      continue;
    }
    const event = toEvent(parsed);
    if (event) events.push(event);
  }

  return { events, consumed };
}

function toEvent(raw: unknown): ChatEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const type = String(row.type ?? '');

  if (type === 'text' || type === 'text-delta') {
    const text = typeof row.text === 'string' ? row.text : typeof row.delta === 'string' ? row.delta : '';
    return text ? { kind: 'text', text } : null;
  }

  if (type === 'tool' || type.startsWith('tool-')) {
    const name = String(row.name ?? row.toolName ?? '');
    if (!name) return null;
    return {
      kind: 'tool',
      name,
      // Verbatim: whether this counts as live is the client's decision, and a
      // transport that answered it here would be one layer too early.
      state: String(row.state ?? type),
      ...(summarise(name, row.output ?? row.result) ? { summary: summarise(name, row.output ?? row.result) } : {}),
    };
  }

  if (type === 'error') {
    return { kind: 'error', message: String(row.message ?? 'The agent hit an error.') };
  }

  if (type === 'finish' || type === 'done') return { kind: 'done' };

  // Everything else is dropped. Eve will grow event types, and a transport that
  // threw on an unfamiliar one turns somebody else's minor release into an
  // outage here.
  return null;
}

/**
 * Which parts of the site a finished turn touched.
 *
 * Read from the *events*, not from a tool's payload, because the payload is
 * exactly what this module refuses to carry. The editor uses it to refetch what
 * changed — the levers `ThemeDialog.onSaved` already pulls — rather than
 * applying anything the agent sent.
 */
export function changedBy(events: readonly ChatEvent[]): {
  page: boolean;
  pages: boolean;
  theme: boolean;
  assets: boolean;
} {
  const finished = events.filter(
    (event): event is Extract<ChatEvent, { kind: 'tool' }> =>
      event.kind === 'tool' && /output|result|complete/i.test(event.state) && isMutating(event.name),
  );
  const names = new Set(finished.map((event) => event.name));
  return {
    page: names.has('edit_page') || names.has('update_page'),
    pages: names.has('add_page') || names.has('delete_page'),
    theme: names.has('set_theme') || names.has('update_site'),
    assets: names.has('add_asset') || names.has('delete_asset') || names.has('request_image'),
  };
}
