import type { Theme, WbNode } from '@wb/schema';
import { DEFAULT_THEME } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import {
  componentJsonSchema,
  getComponent,
  listComponents,
  parseProps,
  validateNodeAgainstRegistry,
  type RenderCtx,
} from './index.js';

const ctx: RenderCtx = {
  theme: DEFAULT_THEME as Theme,
  resolveAsset: (ref) => ref?.url ?? (ref?.assetId ? `/assets/${ref.assetId}` : ''),
  renderNode: (node: WbNode) => `<!--child:${node.id}-->`,
};

describe('component registry', () => {
  it('registers all 23 components', () => {
    expect(listComponents().length).toBe(23);
  });

  it('every component validates its own defaultProps and renders them', () => {
    for (const def of listComponents()) {
      const props = parseProps(def.type, def.defaultProps as Record<string, unknown>);
      const node: WbNode = { id: 'test123456', type: def.type, props, children: [] };
      const html = def.render(node, props, ctx);
      expect(html, def.type).toContain(`n-test123456`);
      expect(html, def.type).toContain('data-node-id="test123456"');
    }
  });

  it('produces agent-readable validation errors', () => {
    expect(() => parseProps('heading', { text: '', level: 9 })).toThrow(/text.*level|level|text/);
    try {
      parseProps('button', { label: 'x' });
    } catch (err) {
      expect(String(err)).toMatch(/href/);
    }
  });

  it('rejects unknown component types with the list of valid ones', () => {
    expect(() => getComponent('sparkles')).toThrow(/valid types:.*heading/);
  });

  it('enforces allowedChildren', () => {
    const node: WbNode = {
      id: 'fg1',
      type: 'featureGrid',
      props: {},
      children: [{ id: 'b1', type: 'button', props: { label: 'x', href: '/' } }],
    };
    expect(() => validateNodeAgainstRegistry(node)).toThrow(/only allows children/);
  });

  it('rejects children on non-containers', () => {
    const node: WbNode = {
      id: 'h1',
      type: 'heading',
      props: { text: 'x' },
      children: [{ id: 'c1', type: 'text', props: { text: 'y' } }],
    };
    expect(() => validateNodeAgainstRegistry(node)).toThrow(/not a container/);
  });

  it('exports JSON Schema with descriptions for agent discovery', () => {
    const schema = componentJsonSchema('hero') as { properties?: Record<string, { description?: string }> };
    expect(schema.properties?.headline?.description).toBeTruthy();
  });

  it('escapes HTML in text props', () => {
    const def = getComponent('heading');
    const props = parseProps('heading', { text: '<script>alert(1)</script>' });
    const html = def.render({ id: 'x1', type: 'heading', props }, props, ctx);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('sanitizes unsafe hrefs', () => {
    const def = getComponent('button');
    // eslint-disable-next-line no-script-url
    const props = parseProps('button', { label: 'x', href: 'javascript:alert(1)' });
    const html = def.render({ id: 'x2', type: 'button', props }, props, ctx);
    expect(html).toContain('href="#"');
  });
});
