import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from './api';
import { parseMarkdown, type Span } from './chat/markdown';
import { describeElapsed, elapsedFor, isSlow } from './chat/cursor';
import { liveAt, STATUS_LABEL, toolStatus } from './chat/tool-status';
import type { ChatEvent, SiteChanged } from './types';

/**
 * Eve, beside the page she is changing.
 *
 * **Not a dialog**, which is the whole point: the reason to have this in the
 * editor rather than in Slack is watching the page change under you, and a
 * modal covers the thing you are watching. **Not a tab in the Inspector**
 * either — that would force a choice between "what did the agent just do" and
 * "what is this node's padding" at the one moment both are wanted.
 *
 * It **never applies an edit**. On a finished mutating tool it raises
 * `onSiteChanged` and the editor refetches what changed, pulling the same
 * levers `ThemeDialog.onSaved` already pulls. Mirroring the agent's ops into
 * local state would be a second implementation of "what the tree is now" while
 * the server already has the answer — and it is why the transport summarises
 * the tree out of the event in the first place. A client holding a tree gets
 * tempted.
 *
 * Polling, because polling is the only thing that survives a closed tab, a
 * locked phone, a cold start and a 60-second ceiling together. It stops when
 * the turn is not live, so an idle panel costs nothing.
 */

const IDLE_MS = 1_500;

export function ChatPanel({
  siteId,
  pageId,
  selectedNodeId,
  onSiteChanged,
  onClose,
}: {
  siteId: string;
  pageId?: string;
  selectedNodeId?: string;
  onSiteChanged: (changed: SiteChanged) => void;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * When this turn began, not how long it has run.
   *
   * A carried elapsed number is a snapshot from before the laptop slept; the
   * clock is read at render instead. See `chat/cursor.ts`.
   */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const cursor = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);

  /** Catch up from the cursor. Safe to call at any time; it only moves forward. */
  const poll = useCallback(async () => {
    try {
      const read = await api.pollChat(siteId, cursor.current);
      cursor.current = read.nextIndex;
      setNow(Date.now());
      if (read.events.length) {
        setEvents((prev) => [...prev, ...read.events]);
        // Decided here rather than sent by the server, so the editor is told
        // once per batch rather than once per event.
        const changed = summariseChanges(read.events);
        if (changed) onSiteChanged(changed);
      }
      setLive(read.live);
      if (!read.live) setStartedAt(null);
      setError(null);
    } catch (err) {
      // A failed poll is not a failed turn — the same rule the render side
      // states. Leave the panel as it is and try again on the next tick.
      setError((err as Error).message);
    }
  }, [siteId, onSiteChanged]);

  // Replay on open: the transcript is durable, so a reload comes back to the
  // conversation rather than to an empty box.
  useEffect(() => {
    cursor.current = 0;
    setEvents([]);
    void poll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void poll(), IDLE_MS);
    return () => clearInterval(timer);
  }, [live, poll]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [events.length]);

  const send = async () => {
    const message = draft.trim();
    if (!message || live) return;
    setDraft('');
    setEvents((prev) => [...prev, { kind: 'text', text: `**You:** ${message}` }]);
    setStartedAt(Date.now());
    setLive(true);
    try {
      await api.sendChat(siteId, {
        message,
        ...(pageId ? { pageId } : {}),
        ...(selectedNodeId ? { selectedNodeId } : {}),
      });
      void poll();
    } catch (err) {
      setError((err as Error).message);
      setLive(false);
      setStartedAt(null);
      // The words go back in the box. A failed send that also ate the message
      // is the one thing guaranteed to make somebody retype it from memory.
      setDraft(message);
    }
  };

  const elapsed = elapsedFor(startedAt, now);
  const lastLive = liveAt(events, live);

  return (
    <aside className="chat" aria-label="Chat with Eve">
      <header className="chat-head">
        <strong>Eve</strong>
        <span className="chat-head-right">
          {live && <span className="chat-elapsed">{describeElapsed(elapsed)}</span>}
          <button
            type="button"
            title="Start a new conversation about this site"
            onClick={() => {
              void api.resetChat(siteId).then(() => {
                cursor.current = 0;
                setEvents([]);
                setLive(false);
              });
            }}
          >
            New
          </button>
          <button type="button" onClick={onClose} aria-label="Close chat">
            ✕
          </button>
        </span>
      </header>

      <div className="chat-feed" ref={feedRef}>
        {events.map((event, index) => (
          <Line key={index} event={event} live={index === lastLive} />
        ))}
        {live && isSlow(elapsed) && (
          // A prompt to look, not a verdict. The turn may be seconds from
          // finishing, and declaring it stuck is how somebody cancels work
          // they have already paid for.
          <p className="chat-note">Still going. Long edits and images take a while.</p>
        )}
        {error && <p className="chat-error">{error}</p>}
      </div>

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={pageId ? 'Ask Eve to change this page…' : 'Ask Eve…'}
          rows={2}
          aria-label="Message"
        />
        <button type="submit" disabled={!draft.trim() || live}>
          {live ? '…' : 'Send'}
        </button>
      </form>
    </aside>
  );
}

function Line({ event, live }: { event: ChatEvent; live: boolean }) {
  if (event.kind === 'text') {
    return (
      <div className="chat-text">
        {parseMarkdown(event.text).map((spans, index) => (
          <p key={index}>{spans.map(renderSpan)}</p>
        ))}
      </div>
    );
  }
  if (event.kind === 'error') return <p className="chat-error">{event.message}</p>;
  if (event.kind === 'done') return null;

  const status = toolStatus(event, live);
  return (
    <p className={`chat-tool chat-tool-${status}`}>
      <code>{event.name}</code> <span>{STATUS_LABEL[status]}</span>
      {event.summary && <em>{describeSummary(event.summary)}</em>}
    </p>
  );
}

function renderSpan(span: Span, index: number) {
  if (span.kind === 'bold') return <strong key={index}>{span.text}</strong>;
  if (span.kind === 'code') return <code key={index}>{span.text}</code>;
  if (span.kind === 'link')
    return (
      <a key={index} href={span.href} target="_blank" rel="noreferrer noopener">
        {span.text}
      </a>
    );
  return <span key={index}>{span.text}</span>;
}

const describeSummary = (summary: Record<string, unknown>) =>
  Object.entries(summary)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(', ');

/**
 * What one batch of events changed, or nothing.
 *
 * The client half of `changedBy`: read off the *events*, never off a payload,
 * because the payload is what the transport refuses to carry.
 */
function summariseChanges(events: readonly ChatEvent[]): SiteChanged | null {
  const done = events.filter(
    (event): event is Extract<ChatEvent, { kind: 'tool' }> =>
      event.kind === 'tool' && /output|result|complete/i.test(event.state),
  );
  const names = new Set(done.map((event) => event.name));
  const changed: SiteChanged = {
    page: names.has('edit_page') || names.has('update_page'),
    pages: names.has('add_page') || names.has('delete_page'),
    theme: names.has('set_theme') || names.has('update_site'),
    assets: names.has('add_asset') || names.has('delete_asset') || names.has('request_image'),
  };
  return Object.values(changed).some(Boolean) ? changed : null;
}
