import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown, safeHref } from './markdown';
import { describeElapsed, elapsedFor, isSlow, SLOW_AFTER_MS } from './cursor';
import { liveAt, STATUS_LABEL, toolStatus } from './tool-status';
import type { ChatEvent } from '../types';

/**
 * The three judgements the panel makes, tested away from the panel.
 *
 * Each is a rule this codebase has already got wrong somewhere else — a tool
 * call that pulses "running" for ever, an elapsed time that stopped when the
 * laptop slept, a link that came from a model. They are pure functions here
 * precisely so the rule can be asserted rather than clicked at.
 */

const tool = (state: string): ChatEvent => ({ kind: 'tool', name: 'edit_page', state });

describe('a tool call that never returned', () => {
  it('is interrupted, never failed', () => {
    /**
     * The rule ComfyStudio states for a render, and it transfers exactly: a
     * `deploy_site` killed after it pushed really did push, and calling that
     * "failed" invites doing it twice. `interrupted` says the honest thing —
     * nobody knows — and the honest thing is what stops the second deploy.
     */
    expect(toolStatus(tool('input-available'), false)).toBe('interrupted');
    expect(STATUS_LABEL.interrupted).toMatch(/may have run/);
  });

  it('is running only while the turn still is', () => {
    // The transcript is durable and liveness is not in it. Reading the log
    // literally is what draws a pulsing dot on every reload, for ever.
    expect(toolStatus(tool('input-available'), true)).toBe('running');
  });

  it('lets only the last event be live', () => {
    const events = [tool('output-available'), tool('input-available')];
    expect(liveAt(events, true)).toBe(1);
    // A reload lands here: nothing is live, so nothing pulses.
    expect(liveAt(events, false)).toBe(-1);
  });

  it('reads a finished or failed call from its state', () => {
    expect(toolStatus(tool('output-available'), true)).toBe('done');
    expect(toolStatus(tool('output-error'), true)).toBe('failed');
  });
});

describe('how long this has been going', () => {
  it('is derived from the clock, never carried', () => {
    /**
     * A laptop that sleeps and a phone that locks both suspend timers, so a
     * carried number is a snapshot from before the lid closed — the panel would
     * confidently report "12s" over a turn that started an hour ago.
     */
    expect(elapsedFor(1_000, 4_000)).toBe(3_000);
    expect(elapsedFor(null, 4_000)).toBe(0);
    // A clock that went backwards (NTP, a sleep) reads as zero, not negative.
    expect(elapsedFor(9_000, 4_000)).toBe(0);
  });

  it('says something only once it is worth remarking on', () => {
    // And it is a prompt to look, not a verdict: the turn may be seconds from
    // done, and declaring it stuck is how somebody cancels paid-for work.
    expect(isSlow(SLOW_AFTER_MS - 1)).toBe(false);
    expect(isSlow(SLOW_AFTER_MS)).toBe(true);
  });

  it('reads as a duration rather than a number of milliseconds', () => {
    expect(describeElapsed(9_000)).toBe('9s');
    expect(describeElapsed(75_000)).toBe('1m 15s');
  });
});

describe('what the agent wrote', () => {
  it('keeps the words of a link it will not follow', () => {
    /**
     * The href is a model's output. A rejected one loses its link and keeps its
     * text: text disappearing is how somebody comes to distrust the whole feed,
     * and the link was far likelier a mistake than an attack.
     */
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>')).toBeNull();
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('/sites/1')).toBe('/sites/1');

    const spans = parseInline('see [the page](javascript:alert(1)) now');
    expect(spans.some((span) => span.kind === 'link')).toBe(false);
    expect(spans.map((span) => span.text).join('')).toContain('the page');
  });

  it('emits spans rather than markup', () => {
    // Nothing here can become HTML: the component renders these as elements,
    // so there is no `dangerouslySetInnerHTML` in the panel at all.
    const spans = parseInline('**done** — see `edit_page`');
    expect(spans).toContainEqual({ kind: 'bold', text: 'done' });
    expect(spans).toContainEqual({ kind: 'code', text: 'edit_page' });
    expect(JSON.stringify(spans)).not.toContain('<');
  });

  it('splits paragraphs, because a turn arrives as one blob otherwise', () => {
    expect(parseMarkdown('one\n\ntwo')).toHaveLength(2);
  });
});
