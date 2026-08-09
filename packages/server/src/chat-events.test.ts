import { describe, expect, it } from 'vitest';

import { changedBy, project, type ChatEvent } from './chat-events.js';
import { editorContext } from './chat-context.js';

/**
 * The transport's job is to be small and to be dull.
 *
 * `edit_page` returns the entire updated page tree and `get_page` returns
 * another; a relay that forwards eve's events verbatim ships a whole site into
 * a 360px panel on every edit. Everything here is about that, or about the two
 * ways a stream of NDJSON goes wrong.
 */

const line = (row: unknown) => `${JSON.stringify(row)}\n`;

/** A page tree of the size the real one reaches. */
const bigTree = {
  id: 'root',
  type: 'section',
  children: Array.from({ length: 200 }, (_, index) => ({
    id: `n${index}`,
    type: 'text',
    props: { text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4) },
  })),
};

describe('a tool result is summarised, not relayed', () => {
  it('does not ship the tree', () => {
    /**
     * Asserted on **serialised size**, not on the absence of a field. A test
     * that checked `result === undefined` would pass just as happily if the
     * tree moved to a differently named key, which is exactly what a refactor
     * does.
     */
    const raw = line({
      type: 'tool-output-available',
      name: 'edit_page',
      state: 'output-available',
      output: { slug: 'pricing', ops: [1, 2, 3], page: bigTree },
    });
    expect(raw.length).toBeGreaterThan(20_000);

    const { events } = project(raw);
    expect(JSON.stringify(events).length).toBeLessThan(500);
    expect(events[0]).toMatchObject({ kind: 'tool', name: 'edit_page', summary: { ops: 3, page: 'pricing' } });
  });

  it('keeps only the fields it can vouch for, and drops the summary with nothing left', () => {
    /**
     * Every field is copied under a `typeof` guard, and the guards had no test
     * — the fixtures all held well-formed results. Inverted, the summary either
     * loses a field it has or gains one it cannot describe, and either way what
     * reaches a 360px panel is decided by whatever eve happened to return.
     */
    const summaryOf = (name: string, output: unknown) => {
      const [event] = project(
        line({ type: 'tool-output-available', name, state: 'output-available', output }),
      ).events;
      return (event as Extract<ChatEvent, { kind: 'tool' }>).summary;
    };

    expect(summaryOf('add_asset', { assetId: 'a1', alt: 'A lighthouse', images: [1, 2] })).toEqual({
      assetId: 'a1',
      alt: 'A lighthouse',
      images: 2,
    });
    // Same tool, a result whose fields are the wrong shape: what it cannot
    // vouch for is left out rather than stringified into the feed.
    expect(summaryOf('add_asset', { assetId: 7, alt: { text: 'x' }, images: 'lots' })).toEqual({});

    expect(summaryOf('deploy_site', { url: 'https://example.com' })).toEqual({
      url: 'https://example.com',
    });
    expect(summaryOf('deploy_site', { url: null })).toBeUndefined();

    expect(summaryOf('add_page', { slug: 'pricing' })).toEqual({ page: 'pricing' });
    expect(summaryOf('add_page', { slug: 42 })).toBeUndefined();

    /**
     * Not an object at all. The early return is the only thing standing between
     * a bare string or a `null` and code that reads fields off it, and `null`
     * is the one that turns a missing guard into a thrown `TypeError` — which
     * on this path is the whole panel rather than one lost event.
     */
    expect(summaryOf('edit_page', 'done')).toBeUndefined();
    expect(summaryOf('edit_page', null)).toBeUndefined();
  });

  it('says nothing at all about a tool it does not know', () => {
    // The safe default for a projection whose whole job is to not ship a tree.
    // A tool added to eve tomorrow gets a worse feed entry, not a 400 KB one.
    const { events } = project(
      line({ type: 'tool-output-available', name: 'brand_new_tool', state: 'output-available', output: { tree: bigTree } }),
    );
    expect(events[0]).toEqual({ kind: 'tool', name: 'brand_new_tool', state: 'output-available' });
  });

  it('passes tool state through untouched', () => {
    // Liveness is the client's decision. Collapsing this to "running" here
    // would be answering it one layer too early.
    const { events } = project(line({ type: 'tool-input-available', name: 'edit_page', state: 'input-available' }));
    expect((events[0] as Extract<ChatEvent, { kind: 'tool' }>).state).toBe('input-available');
  });
});

describe('a stream that is cut mid-line', () => {
  it('advances the cursor only by what parsed', () => {
    /**
     * The failure that would be permanent. The cursor never goes backwards, so
     * counting a half-written line as consumed skips that event for the rest of
     * the conversation — and it would look like the agent silently missing a
     * step rather than like a transport bug.
     */
    const chunk = `${line({ type: 'text', text: 'one' })}${line({ type: 'text', text: 'two' })}{"type":"text","te`;
    const { events, consumed } = project(chunk);

    expect(events).toHaveLength(2);
    expect(consumed).toBe(2);
  });

  it('counts a whole line it could not parse', () => {
    // Whole but unreadable is eve saying something this version does not
    // understand — skipping it is right, and it *has* gone past.
    const { events, consumed } = project(`not json\n${line({ type: 'text', text: 'after' })}`);
    expect(events).toHaveLength(1);
    expect(consumed).toBe(2);
  });

  it('reads a bare `tool` event as well as the `tool-*` ones', () => {
    // Two spellings arrive from different eve versions and the check is an
    // `||` over both. Only the prefixed form was ever exercised, so the exact
    // `tool` case — the older one, and the one a downgrade would produce —
    // rested on nothing.
    expect(project(line({ type: 'tool', name: 'edit_page', state: 'output-available' })).events).toEqual([
      { kind: 'tool', name: 'edit_page', state: 'output-available' },
    ]);
    // A tool event with no name is not an event: there is nothing to draw and
    // nothing to key a reload off.
    expect(project(line({ type: 'tool', state: 'output-available' })).events).toEqual([]);
  });

  it('ends the turn on either spelling of the end', () => {
    for (const type of ['finish', 'done']) {
      expect(project(line({ type })).events, type).toEqual([{ kind: 'done' }]);
    }
  });

  it('drops a line that is not an object at all', () => {
    // `null` and a bare number are both valid JSON lines. Read as objects they
    // throw, and a throw here is the whole panel rather than one lost event.
    expect(project(`${line(null)}${line(42)}${line('hello')}`).events).toEqual([]);
    expect(project(line(null)).consumed).toBe(1);
  });

  it('drops an unknown event type rather than throwing', () => {
    // Eve is a dependency and will grow event types. Throwing here turns
    // somebody else's minor release into an outage in this app.
    expect(() => project(line({ type: 'reasoning-delta', delta: 'hmm' }))).not.toThrow();
    expect(project(line({ type: 'reasoning-delta', delta: 'hmm' })).events).toEqual([]);
  });
});

describe('what the editor has to refetch', () => {
  it('reports a finished edit, and ignores one still running', () => {
    // A canvas reloaded on `input-available` would refetch the page as it was
    // before the edit, then never refetch it again.
    const running = project(line({ type: 'tool-input-available', name: 'edit_page', state: 'input-available' }));
    expect(changedBy(running.events).page).toBe(false);

    const done = project(
      line({ type: 'tool-output-available', name: 'edit_page', state: 'output-available', output: { slug: 'x' } }),
    );
    expect(changedBy(done.events).page).toBe(true);
  });

  it('reloads the right thing for every tool that changes one', () => {
    /**
     * One row per tool, because each axis is an `||` over two or three names
     * and only the first name of the first axis was standing on anything. ANDed
     * instead of ORed, every axis needs *both* tools in one turn to fire — so
     * an agent that adds a page and stops leaves the outline showing the pages
     * that existed before, and nothing on screen says the list is stale.
     *
     * The `false` half of each row matters as much: a tool that flips two axes
     * is a canvas reload nobody asked for, on every turn.
     */
    const axes = { page: false, pages: false, theme: false, assets: false };
    const cases: Array<[string, keyof typeof axes]> = [
      ['edit_page', 'page'],
      ['update_page', 'page'],
      ['add_page', 'pages'],
      ['delete_page', 'pages'],
      ['set_theme', 'theme'],
      ['update_site', 'theme'],
      ['add_asset', 'assets'],
      ['delete_asset', 'assets'],
      ['request_image', 'assets'],
    ];

    for (const [name, axis] of cases) {
      const done = project(
        line({ type: 'tool-output-available', name, state: 'output-available', output: { slug: 'x' } }),
      );
      expect(changedBy(done.events), name).toEqual({ ...axes, [axis]: true });
    }
  });

  it('does not reload the canvas for a tool that changed nothing', () => {
    const read = project(
      line({ type: 'tool-output-available', name: 'get_page', state: 'output-available', output: { page: bigTree } }),
    );
    expect(changedBy(read.events)).toEqual({ page: false, pages: false, theme: false, assets: false });
  });
});

describe('the context the browser is not trusted to write', () => {
  it('names the open page so the agent stops asking which one', () => {
    const context = editorContext({
      site: { id: 'site_1', name: 'Acme' },
      page: { id: 'pg_2', slug: 'pricing', title: 'Pricing' },
    });
    expect(context).toContain('pg_2');
    expect(context).toContain('Do not ask which site or which page');
  });

  it('tells it they are watching, so it reports rather than describes', () => {
    const context = editorContext({ site: { id: 'site_1' } });
    expect(context).toMatch(/say what you changed/i);
    expect(context).toMatch(/never tell them to refresh/i);
  });

  it('holds nothing tree-sized, whatever it is handed', () => {
    /**
     * The other door into the same failure. A tree in every turn's context is
     * the payload `chat-events.ts` refuses to carry, arriving from the other
     * side — and it would be charged for on every model call rather than once.
     */
    const context = editorContext({
      site: { id: 'site_1', name: 'Acme' },
      page: { id: 'pg_2', slug: 'pricing', title: 'Pricing' },
      node: { id: 'n1', type: 'hero' },
    });
    expect(context.length).toBeLessThan(800);
    expect(context).not.toContain('children');
  });
});
