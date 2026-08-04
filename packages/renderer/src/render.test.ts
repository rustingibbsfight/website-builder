import { DEFAULT_THEME, type Page, type Site, type WbNode } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { lintPage, renderSite, styleRules } from './index.js';

const site = (over: Partial<Site> = {}): Site => ({
  id: 'site1',
  name: 'Test Site',
  theme: { ...DEFAULT_THEME, brandName: 'Testers' },
  settings: { locale: 'en', baseUrl: 'https://example.com' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  header: {
    id: 'hdr1',
    type: 'header',
    props: { links: [{ label: 'Home', href: '/' }], cta: { label: 'Book', href: '/contact' } },
  },
  footer: { id: 'ftr1', type: 'footer', props: { legal: '© 2026 Testers' } },
  ...over,
});

const homeTree: WbNode = {
  id: 'root1',
  type: 'page-root',
  props: {},
  children: [
    {
      id: 'hero1',
      type: 'hero',
      props: {
        headline: 'Big Headline',
        subhead: 'Something supportive.',
        primaryCta: { label: 'Go', href: '/contact' },
      },
    },
    {
      id: 'grid1',
      type: 'stack',
      props: {},
      layout: { direction: 'grid', columns: 3, gap: 'lg', padding: 'xl', maxWidth: 'wide' },
      children: [
        { id: 'c1', type: 'card', props: { title: 'One' } },
        { id: 'c2', type: 'card', props: { title: 'Two' } },
        { id: 'c3', type: 'card', props: { title: 'Three' } },
      ],
    },
    {
      id: 'row1',
      type: 'stack',
      props: {},
      layout: { direction: 'row', gap: 'md' },
      responsive: { tablet: { layout: { gap: 'sm' } } },
      children: [{ id: 't1', type: 'text', props: { text: 'hi' } }],
    },
  ],
};

const page = (slug: string, tree: WbNode = homeTree): Page => ({
  id: `pg-${slug || 'home'}`,
  siteId: 'site1',
  slug,
  title: slug === '' ? 'Home' : slug,
  meta: { description: 'A test page.' },
  tree,
  sortOrder: 0,
});

describe('renderSite', () => {
  it('emits pages at clean urls plus css/robots/sitemap/404', () => {
    const { files } = renderSite(site(), [page(''), page('services')], []);
    expect([...files.keys()].sort()).toEqual([
      '404.html',
      'index.html',
      // Auto-generated branded OG fallback cards (one per page, no explicit image).
      'og/index.svg',
      'og/services.svg',
      'robots.txt',
      'services/index.html',
      'sitemap.xml',
      'styles.css',
    ]);
  });

  it('renders a complete, linked html document', () => {
    const { files } = renderSite(site(), [page('')], []);
    const html = files.get('index.html')!;
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Testers — Home</title>');
    expect(html).toContain('link rel="stylesheet" href="/styles.css"');
    expect(html).toContain('Big Headline');
    expect(html).toContain('class="wb-page-home"');
    expect(html).toContain('rel="canonical" href="https://example.com/"');
    expect(html).toContain('© 2026 Testers');
    expect(html).not.toContain('<script>'); // zero JS without videoEmbed
  });

  it('generates theme custom properties and per-node layout css', () => {
    const { files } = renderSite(site(), [page('')], []);
    const css = files.get('styles.css')!;
    expect(css).toContain('--color-primary:#2563eb');
    expect(css).toContain('--space-md:16px');
    expect(css).toContain('.wb-page-home .n-grid1{display:grid;grid-template-columns:repeat(3,1fr)');
    expect(css).toContain('max-width:1200px');
  });

  it('auto-collapses grids and stacks rows at breakpoints (responsive by construction)', () => {
    const { files } = renderSite(site(), [page('')], []);
    const css = files.get('styles.css')!;
    const tabletBlock = css.slice(css.lastIndexOf('@media (max-width:1023px)'), css.lastIndexOf('@media (max-width:639px)'));
    const mobileBlock = css.slice(css.lastIndexOf('@media (max-width:639px)'));
    expect(tabletBlock).toContain('.n-grid1{grid-template-columns:repeat(2,1fr)}');
    expect(mobileBlock).toContain('.n-grid1{grid-template-columns:1fr}');
    expect(mobileBlock).toContain('.n-row1{flex-direction:column}');
    expect(tabletBlock).toContain('.n-row1{gap:var(--space-sm)}');
  });

  it('respects explicit responsive overrides instead of auto-collapse', () => {
    const tree: WbNode = {
      ...homeTree,
      children: [
        {
          id: 'g2',
          type: 'stack',
          props: {},
          layout: { direction: 'grid', columns: 4 },
          responsive: { tablet: { layout: { columns: 3 } }, mobile: { layout: { columns: 2 } } },
        },
      ],
    };
    const { files } = renderSite(site(), [page('', tree)], []);
    const css = files.get('styles.css')!;
    const tabletBlock = css.slice(css.lastIndexOf('@media (max-width:1023px)'), css.lastIndexOf('@media (max-width:639px)'));
    expect(tabletBlock).toContain('.n-g2{grid-template-columns:repeat(3,1fr)}');
    expect(tabletBlock).not.toContain('.n-g2{grid-template-columns:repeat(2,1fr)}');
  });

  it('injects the video facade script only when a videoEmbed exists', () => {
    const tree: WbNode = {
      ...homeTree,
      children: [
        { id: 'v1', type: 'videoEmbed', props: { url: 'https://youtu.be/abc12345', title: 'Tour' } },
      ],
    };
    const { files } = renderSite(site(), [page('', tree)], []);
    expect(files.get('index.html')).toContain('wb-video-facade');
    expect(files.get('index.html')).toContain('<script>');
  });

  it('resolves assets by id to /assets/ paths', () => {
    const tree: WbNode = {
      ...homeTree,
      children: [
        { id: 'i1', type: 'image', props: { image: { assetId: 'as1', alt: 'Logo' } } },
      ],
    };
    const { files } = renderSite(
      site(),
      [page('', tree)],
      [{ id: 'as1', siteId: 'site1', filename: 'logo.svg', mime: 'image/svg+xml', path: 'logo.svg' }],
    );
    expect(files.get('index.html')).toContain('src="/assets/logo.svg"');
  });

  it('deterministic output: same input renders byte-identical', () => {
    const a = renderSite(site(), [page(''), page('about')], []);
    const b = renderSite(site(), [page(''), page('about')], []);
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
  });
});

describe('symbols (#26)', () => {
  const symDef: WbNode = { id: 'sym-h', type: 'heading', props: { text: 'Shared CTA', level: 2 } };
  const withInstances = (): WbNode => ({
    id: 'root1',
    type: 'page-root',
    props: {},
    children: [
      { id: 'i1', type: 'symbolInstance', props: { symbolId: 'cta' } },
      { id: 'i2', type: 'symbolInstance', props: { symbolId: 'cta' } },
    ],
  });

  it('inlines a symbol definition at every instance (published, no data-node-id)', () => {
    const { files } = renderSite(site({ symbols: { cta: symDef } }), [page('', withInstances())], []);
    const html = files.get('index.html')!;
    // Both instances resolved to the shared heading text.
    expect(html.match(/Shared CTA/g)?.length).toBe(2);
    // Publish output inlines the definition (no symbolInstance wrapper markup).
    expect(html).not.toContain('c-symbolInstance');
    // The definition's CSS is emitted (heading base class present).
    expect(files.get('styles.css')).toContain('.c-heading');
  });

  it('editing the definition updates all instances (single source of truth)', () => {
    const edited: WbNode = { ...symDef, props: { text: 'New Copy', level: 2 } };
    const { files } = renderSite(site({ symbols: { cta: edited } }), [page('', withInstances())], []);
    const html = files.get('index.html')!;
    expect(html.match(/New Copy/g)?.length).toBe(2);
    expect(html).not.toContain('Shared CTA');
  });

  it('re-ids the definition per instance so element ids + per-node CSS do not collide', () => {
    // gallery (`:target` ids) and tabs (radio `id`/`name` + per-node `:checked` CSS)
    // both rely on page-unique node ids; instancing must keep them distinct.
    const def: WbNode = {
      id: 's',
      type: 'section',
      props: {},
      children: [
        { id: 'g', type: 'gallery', props: { lightbox: true, images: [{ url: '/a.jpg', alt: 'A' }] } },
        { id: 't', type: 'tabs', props: { tabs: [{ label: 'One', body: 'a' }, { label: 'Two', body: 'b' }] } },
      ],
    };
    const tree: WbNode = {
      id: 'root1',
      type: 'page-root',
      props: {},
      children: [
        { id: 'i1', type: 'symbolInstance', props: { symbolId: 's' } },
        { id: 'i2', type: 'symbolInstance', props: { symbolId: 's' } },
      ],
    };
    const { files } = renderSite(site({ symbols: { s: def } }), [page('', tree)], []);
    const html = files.get('index.html')!;
    const css = files.get('styles.css')!;
    // Gallery lightbox + tabs radio ids are distinct per instance (no collision).
    expect(html).toContain('id="wb-lb-i1_g-0"');
    expect(html).toContain('id="wb-lb-i2_g-0"');
    expect(html).toContain('id="wb-tabs-i1_t-0"');
    expect(html).toContain('id="wb-tabs-i2_t-0"');
    // Per-node CSS targets the same re-id'd ids (HTML and CSS stay in sync).
    expect(css).toContain('#wb-tabs-i1_t-0:checked');
    expect(css).toContain('#wb-tabs-i2_t-0:checked');
  });

  it('missing symbol renders nothing in publish; is cycle-safe', () => {
    const cyclic: WbNode = { id: 'sa', type: 'symbolInstance', props: { symbolId: 'a' } };
    const tree: WbNode = {
      id: 'r',
      type: 'page-root',
      props: {},
      children: [
        { id: 'm', type: 'symbolInstance', props: { symbolId: 'nope' } },
        { id: 'c', type: 'symbolInstance', props: { symbolId: 'a' } },
      ],
    };
    // 'a' references itself → must terminate, not hang.
    const { files } = renderSite(site({ symbols: { a: cyclic } }), [page('', tree)], []);
    const home = files.get('index.html')!;
    // A hero/h1 is absent here; that's fine — we only assert it rendered + is finite.
    expect(typeof home).toBe('string');
    expect(home).not.toContain('c-symbolInstance'); // nothing resolved, nothing inlined
  });
});

describe('styleRules — borders', () => {
  const noAsset = () => '';
  it('emits a single `border` when no sides (all four)', () => {
    const rules = styleRules({ border: { color: '#ff0000', width: 2 } }, noAsset);
    expect(rules).toContain('border:2px solid #ff0000');
  });
  it('emits per-side `border-<side>` when sides is a subset', () => {
    const rules = styleRules({ border: { color: 'primary', sides: ['top', 'bottom'] } }, noAsset);
    expect(rules).toContain('border-top:1px solid var(--color-primary)');
    expect(rules).toContain('border-bottom:1px solid var(--color-primary)');
    expect(rules.some((r) => r.startsWith('border:'))).toBe(false);
    expect(rules.some((r) => r.startsWith('border-left'))).toBe(false);
  });
  it('collapses to a single `border` when all four sides are listed', () => {
    const rules = styleRules({ border: { color: '#000000', sides: ['top', 'right', 'bottom', 'left'] } }, noAsset);
    expect(rules).toContain('border:1px solid #000000');
    expect(rules.some((r) => r.startsWith('border-'))).toBe(false);
  });
});

describe('lintPage', () => {
  it('warns on missing h1, missing description, missing alt', () => {
    const tree: WbNode = {
      id: 'r1',
      type: 'page-root',
      props: {},
      children: [{ id: 'i1', type: 'image', props: { image: { alt: '' } } }],
    };
    const p: Page = { id: 'p1', siteId: 's', slug: 'x', title: 'X', meta: {}, tree, sortOrder: 0 };
    const warnings = lintPage(site(), p).map((w) => w.message);
    expect(warnings.some((m) => m.includes('no h1'))).toBe(true);
    expect(warnings.some((m) => m.includes('no meta description'))).toBe(true);
    expect(warnings.some((m) => m.includes('no alt text'))).toBe(true);
  });

  describe('contact forms that post nowhere', () => {
    const pageWith = (props: Record<string, unknown>): Page => ({
      id: 'p1',
      siteId: 's',
      slug: 'contact',
      title: 'Contact',
      meta: { description: 'd' },
      sortOrder: 0,
      tree: {
        id: 'r1',
        type: 'page-root',
        props: {},
        children: [
          { id: 'h1', type: 'heading', props: { level: 1, text: 'Contact' } },
          { id: 'form1', type: 'contactForm', props },
        ],
      },
    });
    const warn = (props: Record<string, unknown>, over: Partial<Site> = {}) =>
      lintPage(site(over), pageWith(props)).map((w) => w.message);

    it('warns when a form has no action, no netlify, and no wb storage', () => {
      // The default props: it renders `<form method="POST">`, which posts to the
      // static page itself and is discovered by whoever filled it in.
      const messages = warn({ store: false });
      expect(messages.some((m) => m.includes('form1') && m.includes('nowhere to post'))).toBe(true);
    });

    it('warns when storage is on but the site has no formEndpoint', () => {
      const messages = warn({ store: true });
      expect(messages.some((m) => m.includes('formEndpoint'))).toBe(true);
    });

    it('is quiet when the form actually has somewhere to go', () => {
      const endpoint = { settings: { locale: 'en', formEndpoint: 'https://wb-api-gold.vercel.app' } };
      for (const [props, over] of [
        [{ store: true }, endpoint],
        [{ store: false, action: 'https://formspree.io/f/abc' }, {}],
        [{ store: false, netlifyForms: true }, {}],
      ] as Array<[Record<string, unknown>, Partial<Site>]>) {
        expect(warn(props, over).some((m) => m.includes('form1')), JSON.stringify(props)).toBe(false);
      }
    });
  });
});
