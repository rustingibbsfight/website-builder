import { describe, expect, it } from 'vitest';
import { applyOps, OpsError, type TreeOp } from './ops.js';
import { collectIds, findNode, materializeNode, validateTreeStructure } from './tree.js';
import type { WbNode } from './node.js';

const tree = (): WbNode => ({
  id: 'root',
  type: 'page-root',
  props: {},
  children: [
    {
      id: 'sec1',
      type: 'section',
      props: {},
      layout: { direction: 'stack', gap: 'md' },
      children: [
        { id: 'h1', type: 'heading', props: { text: 'Hello' } },
        { id: 'p1', type: 'text', props: { text: 'World' } },
      ],
    },
    { id: 'sec2', type: 'section', props: {}, children: [] },
  ],
});

describe('applyOps', () => {
  it('inserts with auto-assigned ids', () => {
    const next = applyOps(tree(), [
      { op: 'insert', parentId: 'sec2', node: { type: 'button', props: { label: 'Go' } } },
    ]);
    const sec2 = findNode(next, 'sec2')!;
    expect(sec2.children).toHaveLength(1);
    expect(sec2.children![0]!.id).toMatch(/^[0-9a-z]{10}$/);
    expect(validateTreeStructure(next)).toEqual([]);
  });

  it('inserts at an index', () => {
    const next = applyOps(tree(), [
      { op: 'insert', parentId: 'sec1', index: 0, node: { id: 'img1', type: 'image', props: {} } },
    ]);
    expect(findNode(next, 'sec1')!.children!.map((c) => c.id)).toEqual(['img1', 'h1', 'p1']);
  });

  it('updates by shallow merge', () => {
    const next = applyOps(tree(), [
      { op: 'update', nodeId: 'h1', props: { level: 2 }, style: { color: 'primary' } },
    ]);
    const h1 = findNode(next, 'h1')!;
    expect(h1.props).toEqual({ text: 'Hello', level: 2 });
    expect(h1.style).toEqual({ color: 'primary' });
  });

  it('moves nodes between parents', () => {
    const next = applyOps(tree(), [{ op: 'move', nodeId: 'p1', parentId: 'sec2', index: 0 }]);
    expect(findNode(next, 'sec1')!.children!.map((c) => c.id)).toEqual(['h1']);
    expect(findNode(next, 'sec2')!.children!.map((c) => c.id)).toEqual(['p1']);
  });

  it('reorders within the same parent without overshooting (index is caller-relative)', () => {
    // A container [a, b, c]; `index` is a slot as the caller sees it (with the
    // moving node still present) — the drop indicator between two children.
    const abc = (): WbNode => ({
      id: 'root',
      type: 'page-root',
      props: {},
      children: [
        { id: 'a', type: 'text', props: { text: 'A' } },
        { id: 'b', type: 'text', props: { text: 'B' } },
        { id: 'c', type: 'text', props: { text: 'C' } },
      ],
    });
    const order = (t: WbNode) => t.children!.map((n) => n.id);

    // Move A down to the slot between B and C → B, A, C (not B, C, A).
    expect(order(applyOps(abc(), [{ op: 'move', nodeId: 'a', parentId: 'root', index: 2 }]))).toEqual([
      'b',
      'a',
      'c',
    ]);
    // Move C up to the slot between A and B → A, C, B.
    expect(order(applyOps(abc(), [{ op: 'move', nodeId: 'c', parentId: 'root', index: 1 }]))).toEqual([
      'a',
      'c',
      'b',
    ]);
    // Move A to the very end.
    expect(order(applyOps(abc(), [{ op: 'move', nodeId: 'a', parentId: 'root', index: 3 }]))).toEqual([
      'b',
      'c',
      'a',
    ]);
    // No-op: move A to its own slot 0 stays put.
    expect(order(applyOps(abc(), [{ op: 'move', nodeId: 'a', parentId: 'root', index: 0 }]))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('rejects moving a node into its own descendant', () => {
    expect(() => applyOps(tree(), [{ op: 'move', nodeId: 'sec1', parentId: 'h1', index: 0 }])).toThrow(
      /own descendant/,
    );
  });

  it('removes nodes but never the root', () => {
    const next = applyOps(tree(), [{ op: 'remove', nodeId: 'sec2' }]);
    expect(next.children!.map((c) => c.id)).toEqual(['sec1']);
    expect(() => applyOps(tree(), [{ op: 'remove', nodeId: 'root' }])).toThrow(/root/);
  });

  it('replaces a subtree', () => {
    const next = applyOps(tree(), [
      { op: 'replace', nodeId: 'p1', node: { type: 'divider', props: {} } },
    ]);
    expect(findNode(next, 'sec1')!.children![1]!.type).toBe('divider');
  });

  it('is atomic: a failing op leaves the original untouched and names the op index', () => {
    const original = tree();
    const ops: TreeOp[] = [
      { op: 'update', nodeId: 'h1', props: { text: 'Changed' } },
      { op: 'remove', nodeId: 'nope' },
    ];
    let caught: unknown;
    try {
      applyOps(original, ops);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpsError);
    expect((caught as OpsError).opIndex).toBe(1);
    expect(findNode(original, 'h1')!.props.text).toBe('Hello');
  });

  it('runs the validateNode hook on inserted subtrees', () => {
    expect(() =>
      applyOps(
        tree(),
        [{ op: 'insert', parentId: 'sec2', node: { type: 'bogus', props: {} } }],
        {
          validateNode: (node) => {
            if (node.type === 'bogus') throw new Error('unknown component "bogus"');
          },
        },
      ),
    ).toThrow(/unknown component/);
  });

  it('respects isContainer hook', () => {
    expect(() =>
      applyOps(tree(), [{ op: 'insert', parentId: 'h1', node: { type: 'text', props: {} } }], {
        isContainer: (t) => t !== 'heading',
      }),
    ).toThrow(/not a container/);
  });

  it('avoids id collisions when inserting subtrees with taken ids', () => {
    const next = applyOps(tree(), [
      { op: 'insert', parentId: 'sec2', node: { id: 'h1', type: 'heading', props: {} } },
    ]);
    expect(validateTreeStructure(next)).toEqual([]);
    expect(collectIds(next).size).toBe(6);
  });
});

describe('materializeNode', () => {
  it('deep-assigns ids', () => {
    const node = materializeNode(
      { type: 'section', children: [{ type: 'text' }, { type: 'text' }] },
      new Set(),
    );
    expect(node.id).toBeTruthy();
    expect(node.children).toHaveLength(2);
    expect(node.children![0]!.id).not.toBe(node.children![1]!.id);
  });
});
