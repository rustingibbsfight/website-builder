import { describe, expect, it } from 'vitest';
import { applyOps, n, OpsError, type TreeOp } from './ops.js';
import { collectIds, findNode, findParent, isDescendant, materializeNode, validateTreeStructure, walk } from './tree.js';
import { NodeInputSchema, NodeSchema, type WbNode } from './node.js';
import { normalizeSlug, SLUG_RE } from './site.js';
import { radiusPx, spacingPx } from './theme.js';

const tree = (): WbNode => ({
  id: 'root',
  type: 'page-root',
  props: {},
  children: [
    { id: 'a', type: 'section', props: {}, children: [
      { id: 'a1', type: 'text', props: {} },
      { id: 'a2', type: 'text', props: {} },
    ] },
    { id: 'b', type: 'section', props: {}, children: [] },
  ],
});

describe('applyOps — atomicity under partial failure', () => {
  it('rolls back every op when a later op fails, no matter how many succeeded', () => {
    const original = tree();
    const ops: TreeOp[] = [
      { op: 'insert', parentId: 'b', node: { type: 'text', props: {} } },
      { op: 'update', nodeId: 'a1', props: { text: 'x' } },
      { op: 'move', nodeId: 'a2', parentId: 'b', index: 0 },
      { op: 'remove', nodeId: 'ghost' }, // fails here
    ];
    let err: unknown;
    try {
      applyOps(original, ops);
    } catch (e) {
      err = e;
    }
    expect((err as OpsError).opIndex).toBe(3);
    // original completely untouched — deep equality with a fresh tree
    expect(original).toEqual(tree());
  });

  it('never mutates the input tree object even on success (returns a new tree)', () => {
    const input = tree();
    const snapshot = structuredClone(input);
    const out = applyOps(input, [{ op: 'update', nodeId: 'a', props: { x: 1 } }]);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
  });
});

describe('applyOps — move edge cases', () => {
  it('rejects moving a node into itself', () => {
    expect(() => applyOps(tree(), [{ op: 'move', nodeId: 'a', parentId: 'a', index: 0 }])).toThrow(/itself|descendant/);
  });

  it('rejects moving a node into a deep descendant', () => {
    expect(() => applyOps(tree(), [{ op: 'move', nodeId: 'a', parentId: 'a1', index: 0 }])).toThrow(/descendant/);
  });

  it('reorders within the same parent correctly (move first child to the end)', () => {
    const out = applyOps(tree(), [{ op: 'move', nodeId: 'a1', parentId: 'a', index: 2 }]);
    expect(findNode(out, 'a')!.children!.map((c) => c.id)).toEqual(['a2', 'a1']);
  });

  it('clamps an out-of-range move index to the end rather than dropping the node', () => {
    const out = applyOps(tree(), [{ op: 'move', nodeId: 'a1', parentId: 'b', index: 999 }]);
    expect(findNode(out, 'b')!.children!.map((c) => c.id)).toEqual(['a1']);
    expect(collectIds(out).size).toBe(collectIds(tree()).size); // nothing lost
  });

  it('cannot move the root', () => {
    expect(() => applyOps(tree(), [{ op: 'move', nodeId: 'root', parentId: 'a', index: 0 }])).toThrow();
  });
});

describe('applyOps — insert/replace id hygiene', () => {
  it('assigns fresh ids to a whole inserted subtree and never collides', () => {
    const out = applyOps(tree(), [
      { op: 'insert', parentId: 'b', node: n('section', {}, {}, [
        n('text'), n('text'), n('stack', {}, {}, [n('text')]),
      ]) },
    ]);
    expect(validateTreeStructure(out)).toEqual([]);
    const ids = [...collectIds(out)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renames a colliding supplied id rather than corrupting the tree', () => {
    const out = applyOps(tree(), [
      { op: 'insert', parentId: 'b', node: { id: 'a', type: 'text', props: {} } },
    ]);
    expect(validateTreeStructure(out)).toEqual([]);
    // original 'a' still present, the new node got a different id
    const parentOfB = findNode(out, 'b')!;
    expect(parentOfB.children![0]!.id).not.toBe('a');
  });

  it('replace keeps sibling order and swaps only the target', () => {
    const out = applyOps(tree(), [{ op: 'replace', nodeId: 'a1', node: { type: 'divider', props: {} } }]);
    const kids = findNode(out, 'a')!.children!;
    expect(kids.map((c) => c.type)).toEqual(['divider', 'text']);
  });

  it('cannot replace the root', () => {
    expect(() => applyOps(tree(), [{ op: 'replace', nodeId: 'root', node: { type: 'section', props: {} } }])).toThrow(/root/);
  });
});

describe('applyOps — update merge semantics', () => {
  it('shallow-merges props and deletes keys set to null', () => {
    const t: WbNode = { id: 'root', type: 'page-root', props: {}, children: [
      { id: 'h', type: 'heading', props: { text: 'Hi', level: 2, size: 'lg' } },
    ] };
    const out = applyOps(t, [{ op: 'update', nodeId: 'h', props: { level: 1, size: null } }]);
    expect(findNode(out, 'h')!.props).toEqual({ text: 'Hi', level: 1 });
  });

  it('drops a layout object entirely when every key is cleared', () => {
    const t: WbNode = { id: 'root', type: 'page-root', props: {}, children: [
      { id: 's', type: 'section', props: {}, layout: { direction: 'grid', gap: 'md' } },
    ] };
    const out = applyOps(t, [{ op: 'update', nodeId: 's', layout: { direction: null, gap: null } }]);
    expect(findNode(out, 's')!.layout).toBeUndefined();
  });

  it('rejects an unknown layout key via schema validation', () => {
    const t: WbNode = { id: 'root', type: 'page-root', props: {}, children: [
      { id: 's', type: 'section', props: {}, layout: { direction: 'stack' } },
    ] };
    expect(() => applyOps(t, [{ op: 'update', nodeId: 's', layout: { bogus: 'x' } }])).toThrow();
  });

  it('clears responsive overrides when set to null', () => {
    const t: WbNode = { id: 'root', type: 'page-root', props: {}, children: [
      { id: 's', type: 'section', props: {}, responsive: { mobile: { hidden: true } } },
    ] };
    const out = applyOps(t, [{ op: 'update', nodeId: 's', responsive: null }]);
    expect(findNode(out, 's')!.responsive).toBeUndefined();
  });
});

describe('applyOps — hook enforcement', () => {
  it('bubbles a validateNode rejection with the failing op index', () => {
    let err: unknown;
    try {
      applyOps(tree(), [
        { op: 'insert', parentId: 'b', node: { type: 'text', props: {} } },
        { op: 'insert', parentId: 'b', node: { type: 'evil', props: {} } },
      ], { validateNode: (nd) => { if (nd.type === 'evil') throw new Error('nope'); } });
    } catch (e) {
      err = e;
    }
    expect((err as OpsError).opIndex).toBe(1);
  });

  it('rejects inserting into a non-container per isContainer hook', () => {
    expect(() =>
      applyOps(tree(), [{ op: 'insert', parentId: 'a1', node: { type: 'text', props: {} } }], {
        isContainer: (type) => type === 'section' || type === 'page-root',
      }),
    ).toThrow(/not a container/);
  });
});

describe('tree utilities', () => {
  it('walk visits every node exactly once with correct parent/index', () => {
    const seen: Array<[string, string | null, number]> = [];
    walk(tree(), (nd, parent, i) => seen.push([nd.id, parent?.id ?? null, i]));
    expect(seen).toEqual([
      ['root', null, 0],
      ['a', 'root', 0],
      ['a1', 'a', 0],
      ['a2', 'a', 1],
      ['b', 'root', 1],
    ]);
  });

  it('isDescendant is transitive and excludes self', () => {
    const t = tree();
    expect(isDescendant(findNode(t, 'a')!, 'a1')).toBe(true);
    expect(isDescendant(findNode(t, 'root')!, 'a1')).toBe(true);
    expect(isDescendant(findNode(t, 'a')!, 'a')).toBe(false);
    expect(isDescendant(findNode(t, 'a')!, 'b')).toBe(false);
  });

  it('findParent returns null for the root and the correct slot otherwise', () => {
    const t = tree();
    expect(findParent(t, 'root')).toBeNull();
    expect(findParent(t, 'a2')).toMatchObject({ index: 1 });
  });

  it('validateTreeStructure flags duplicate ids', () => {
    const dup: WbNode = { id: 'root', type: 'page-root', props: {}, children: [
      { id: 'x', type: 'text', props: {} },
      { id: 'x', type: 'text', props: {} },
    ] };
    expect(validateTreeStructure(dup).some((p) => /duplicate/.test(p.message))).toBe(true);
  });

  it('materializeNode is deterministic in structure and unique in ids across calls', () => {
    const a = materializeNode(n('section', {}, {}, [n('text'), n('text')]), new Set());
    const b = materializeNode(n('section', {}, {}, [n('text'), n('text')]), new Set());
    expect(a.children).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
  });
});

describe('schema recursion + slugs + theme scales', () => {
  it('NodeSchema parses a deeply nested valid tree and rejects a bad node', () => {
    const deep = n('page-root', {}, {}, [n('section', {}, {}, [n('stack', {}, {}, [n('text', { text: 'x' })])])]);
    const withIds = materializeNode(deep, new Set());
    expect(() => NodeSchema.parse(withIds)).not.toThrow();
    expect(() => NodeSchema.parse({ id: 'x', props: {} })).toThrow(); // missing type
  });

  it('rejects injection-unsafe node ids (id is interpolated into HTML/CSS)', () => {
    // These would break out of a class value / attribute / CSS selector.
    for (const badId of ['a"><script>', 'x" onmouseover="y', 'a}body{display:none', 'has space', 'a<b', "a'b"]) {
      expect(() => NodeInputSchema.parse({ id: badId, type: 'heading', props: { text: 'x' } }), badId).toThrow();
      expect(() => NodeSchema.parse({ id: badId, type: 'heading', props: {} }), badId).toThrow();
    }
    // Safe ids (generated form + hand-authored hyphen/underscore) are accepted.
    for (const okId of ['abc123', 'sym-h', 'page_root', 'A1_b-2']) {
      expect(() => NodeInputSchema.parse({ id: okId, type: 'heading', props: { text: 'x' } }), okId).not.toThrow();
    }
  });

  it('normalizeSlug maps index→home and SLUG_RE rejects junk', () => {
    expect(normalizeSlug('index')).toBe('');
    expect(SLUG_RE.test('good-slug-2')).toBe(true);
    for (const bad of ['Bad', 'has space', 'trailing-', '-leading', 'UPPER', 'sl/ash', '..']) {
      expect(SLUG_RE.test(bad), bad).toBe(false);
    }
  });

  it('spacing and radius scales are monotonic and complete', () => {
    const s = spacingPx(8);
    expect(s.none).toBe(0);
    expect(s.xs!).toBeLessThan(s.sm!);
    expect(s['2xl']!).toBeGreaterThan(s.xl!);
    for (const scale of ['sharp', 'soft', 'round'] as const) {
      const r = radiusPx(scale);
      expect(Object.keys(r)).toEqual(['none', 'sm', 'md', 'lg', 'full']);
    }
  });
});
