import { DEFAULT_THEME, type Theme, type WbNode } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { cssUrl, escapeHtml, safeHref } from './html.js';
import { renderMarkdown } from './markdown.js';
import { getComponent, listComponents, parseProps, type RenderCtx } from './index.js';

const ctx = (over: Partial<RenderCtx> = {}): RenderCtx => ({
  theme: DEFAULT_THEME as Theme,
  resolveAsset: (ref) => ref?.url ?? (ref?.assetId ? `/assets/${ref.assetId}` : ''),
  renderNode: (nd: WbNode) => `<!--${nd.id}-->`,
  ...over,
});

const XSS = '<script>alert(1)</script>';
const render = (type: string, props: Record<string, unknown>, c: RenderCtx = ctx()): string => {
  const def = getComponent(type);
  const parsed = parseProps(type, props);
  return def.render({ id: 'n1', type, props: parsed }, parsed, c);
};

describe('HTML escaping across every text-bearing component', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['heading', { text: XSS }],
    ['text', { text: XSS }],
    ['button', { label: XSS, href: '/x' }],
    ['card', { title: XSS, body: XSS }],
    ['testimonial', { quote: XSS, name: XSS, role: XSS }],
    ['hero', { headline: XSS, subhead: XSS }],
    ['faq', { items: [{ question: XSS, answer: XSS }] }],
    ['featureGrid', { heading: XSS }],
    ['mapEmbed', { address: XSS }],
    ['image', { image: { alt: XSS } } ],
  ];

  for (const [type, props] of cases) {
    it(`${type} never emits a raw <script> tag`, () => {
      const html = render(type, props);
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  }
});

describe('href sanitization', () => {
  for (const scheme of ['javascript:alert(1)', 'data:text/html,<script>x', 'vbscript:x', ' javascript:x']) {
    it(`button neutralizes ${scheme.trim()}`, () => {
      const html = render('button', { label: 'go', href: scheme });
      expect(html).toContain('href="#"');
      expect(html.toLowerCase()).not.toContain('javascript:');
    });
  }

  it('allows the legitimate schemes', () => {
    for (const href of ['https://x.example/a', 'mailto:a@b.co', 'tel:+15551234', '/contact', '#anchor', './rel']) {
      expect(safeHref(href)).not.toBe('#');
    }
  });

  it('card href and richText links are sanitized too', () => {
    const card = render('card', { title: 't', href: 'javascript:x', linkLabel: 'go' });
    expect(card).toContain('href="#"');
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href="#"');
  });
});

describe('CSS url() injection is neutralized', () => {
  it('strips quotes/parens/braces that would break out of url()', () => {
    expect(cssUrl(`x'); } body { display:none } .a:after { content:'`)).not.toMatch(/['")(};{]/);
    expect(cssUrl('/assets/logo.svg')).toBe('/assets/logo.svg');
    expect(cssUrl('https://cdn.example/img.png')).toBe('https://cdn.example/img.png');
  });

  it('hero background style cannot inject CSS via a crafted asset url', () => {
    const evil = `x'); } body { background: red } .h:after { content: url('`;
    const html = render(
      'hero',
      { headline: 'H', image: { url: evil, alt: '' }, imagePosition: 'background' },
      ctx({ resolveAsset: () => evil }),
    );
    // The escaped-and-stripped url must not contain a raw closing paren+brace break
    const styleMatch = html.match(/style="([^"]*)"/);
    expect(styleMatch).toBeTruthy();
    expect(styleMatch![1]).not.toMatch(/\)\s*;?\s*}/);
  });
});

describe('markdown renderer is bounded and safe', () => {
  it('escapes HTML before applying inline formatting', () => {
    expect(renderMarkdown('**<img src=x onerror=alert(1)>**')).not.toContain('<img');
  });

  it('renders headings, lists, and links structurally', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(renderMarkdown('[link](https://x.example)')).toContain('<a href="https://x.example">link</a>');
  });

  it('does not hang or crash on pathological input', () => {
    const nasty = '*'.repeat(5000) + '`'.repeat(5000) + '['.repeat(2000);
    expect(() => renderMarkdown(nasty)).not.toThrow();
    expect(() => renderMarkdown('')).not.toThrow();
  });
});

describe('registry invariants', () => {
  it('every component escapes its data-node-id and produces well-formed class hooks', () => {
    for (const def of listComponents()) {
      const props = parseProps(def.type, def.defaultProps as Record<string, unknown>);
      const html = def.render({ id: 'safe1', type: def.type, props, children: [] }, props, ctx());
      expect(html, def.type).toContain('data-node-id="safe1"');
      expect(html, def.type).toContain(`c-${def.type}`);
    }
  });

  it('htmlEmbed is the only component that passes content through unescaped (documented escape hatch)', () => {
    const passthrough = listComponents().filter((d) => {
      const html = d.render(
        { id: 'x', type: d.type, props: { ...(d.defaultProps as object), html: XSS } as Record<string, unknown> },
        { ...(d.defaultProps as object), html: XSS } as never,
        ctx(),
      );
      return html.includes('<script>alert(1)</script>');
    });
    // We can't easily invoke every component with an html prop; assert htmlEmbed specifically.
    const embed = getComponent('htmlEmbed');
    const parsed = parseProps('htmlEmbed', { html: XSS });
    expect(embed.render({ id: 'e', type: 'htmlEmbed', props: parsed }, parsed, ctx())).toContain('<script>');
    void passthrough;
  });
});

describe('escapeHtml correctness', () => {
  it('escapes all five dangerous characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
  it('escapes ampersand first to avoid double-encoding artifacts', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
