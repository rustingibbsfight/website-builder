import type { WbNode } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { treeOutline } from './outline.js';

describe('treeOutline', () => {
  it('indents by depth and annotates layout + node ids', () => {
    const tree: WbNode = {
      id: 'root',
      type: 'page-root',
      props: {},
      children: [
        {
          id: 'grid1',
          type: 'featureGrid',
          props: { heading: 'Services' },
          layout: { direction: 'grid', columns: 3 },
          children: [{ id: 'c1', type: 'card', props: { title: 'One' } }],
        },
      ],
    };
    const out = treeOutline(tree);
    const lines = out.split('\n');
    expect(lines[0]).toBe('root page-root');
    expect(lines[1]).toContain('grid1 featureGrid');
    expect(lines[1]).toContain('[grid 3col]');
    expect(lines[2]!.startsWith('    ')).toBe(true); // depth-2 indent
    expect(lines[2]).toContain('c1 card "One"');
  });

  it('truncates long text and marks responsive nodes', () => {
    const long = 'x'.repeat(80);
    const tree: WbNode = {
      id: 'r',
      type: 'page-root',
      props: {},
      children: [
        { id: 'h', type: 'heading', props: { text: long }, responsive: { mobile: { hidden: true } } },
        { id: 'f', type: 'faq', props: { items: [{ question: 'q', answer: 'a' }, { question: 'q2', answer: 'a2' }] } },
      ],
    };
    const out = treeOutline(tree);
    expect(out).toContain('…');
    expect(out).not.toContain(long);
    expect(out).toContain('{responsive}');
    expect(out).toContain('(2 items)');
  });

  it('handles a bare root with no children', () => {
    expect(treeOutline({ id: 'r', type: 'page-root', props: {} })).toBe('r page-root');
  });
});
