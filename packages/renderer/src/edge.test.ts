import { DEFAULT_THEME, materializeNode, n, type Page, type Site, type WbNode } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { renderSite } from './index.js';

const site = (over: Partial<Site> = {}): Site => ({
  id: 's1',
  name: 'Edge',
  theme: { ...DEFAULT_THEME, brandName: 'Edge Co' },
  settings: { locale: 'en' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const page = (tree: WbNode, over: Partial<Page> = {}): Page => ({
  id: 'p', siteId: 's1', slug: '', title: 'Home', meta: { description: 'd' }, tree, sortOrder: 0, ...over,
});

const root = (children: WbNode[] = []): WbNode => materializeNode(n('page-root', {}, {}, children.map((c) => c as never)) as never, new Set());

describe('renderer edge cases', () => {
  it('renders an empty page (page-root with no children) without crashing', () => {
    const { files } = renderSite(site(), [page({ id: 'r', type: 'page-root', props: {}, children: [] })], []);
    expect(files.get('index.html')).toContain('<main');
    expect(files.get('index.html')).toContain('</main>');
  });

  it('renders a featureGrid with no card children (empty grid)', () => {
    const tree: WbNode = { id: 'r', type: 'page-root', props: {}, children: [
      { id: 'fg', type: 'featureGrid', props: { heading: 'Empty' }, children: [] },
    ] };
    const html = renderSite(site(), [page(tree)], []).files.get('index.html')!;
    expect(html).toContain('wb-fg-grid');
    expect(html).toContain('Empty');
  });

  it('grid with columns=1 does NOT emit a mobile 1-col collapse (already 1)', () => {
    const tree: WbNode = { id: 'r', type: 'page-root', props: {}, children: [
      { id: 'g', type: 'stack', props: {}, layout: { direction: 'grid', columns: 1 }, children: [] },
    ] };
    const css = renderSite(site(), [page(tree)], []).files.get('styles.css')!;
    const mobile = css.slice(css.lastIndexOf('@media (max-width:639px)'));
    expect(mobile).not.toContain('.n-g{grid-template-columns:1fr}');
  });

  it('respects an explicit mobile row direction override (no auto-stack)', () => {
    const tree: WbNode = { id: 'r', type: 'page-root', props: {}, children: [
      { id: 'row', type: 'stack', props: {}, layout: { direction: 'row', gap: 'md' },
        responsive: { mobile: { layout: { direction: 'row' } } }, children: [] },
    ] };
    const css = renderSite(site(), [page(tree)], []).files.get('styles.css')!;
    const mobile = css.slice(css.lastIndexOf('@media (max-width:639px)'));
    // explicit mobile direction:row is emitted; the auto flex-direction:column is NOT
    expect(mobile).not.toContain('.n-row{flex-direction:column}');
  });

  it('per-side padding object renders all four sides with 0 for unset', () => {
    const tree: WbNode = { id: 'r', type: 'page-root', props: {}, children: [
      { id: 'b', type: 'stack', props: {}, layout: { direction: 'stack', padding: { top: 'lg', bottom: 'sm' } }, children: [] },
    ] };
    const css = renderSite(site(), [page(tree)], []).files.get('styles.css')!;
    expect(css).toContain('padding:var(--space-lg) 0 var(--space-sm) 0');
  });

  it('background image with an overlay but empty url falls back to the overlay color', () => {
    const tree: WbNode = { id: 'r', type: 'page-root', props: {}, children: [
      { id: 's', type: 'section', props: {}, style: { background: { image: { url: '', alt: '' }, overlay: 'primary' } }, children: [] },
    ] };
    const css = renderSite(site(), [page(tree)], []).files.get('styles.css')!;
    expect(css).toContain('.n-s{background:var(--color-primary)}');
    expect(css).not.toContain("url('')");
  });

  it('handles a page with hidden-on-both-breakpoints node', () => {
    const tree: WbNode = { id: 'r', type: 'page-root', props: {}, children: [
      { id: 'x', type: 'text', props: { text: 'hi' }, responsive: { tablet: { hidden: true }, mobile: { hidden: true } } },
    ] };
    const css = renderSite(site(), [page(tree)], []).files.get('styles.css')!;
    expect(css.slice(css.lastIndexOf('@media (max-width:1023px)'), css.lastIndexOf('@media (max-width:639px)'))).toContain('.n-x{display:none}');
    expect(css.slice(css.lastIndexOf('@media (max-width:639px)'))).toContain('.n-x{display:none}');
  });

  it('renders multiple pages sharing one stylesheet with scoped selectors', () => {
    // Nodes with styling so per-node rules (and their page scope) appear in CSS.
    const home = { id: 'rh', type: 'page-root', props: {}, children: [
      { id: 'h1', type: 'heading', props: { text: 'Home', level: 1, align: 'center' } },
    ] } as WbNode;
    const about = { id: 'ra', type: 'page-root', props: {}, children: [
      { id: 'sec', type: 'section', props: {}, style: { background: 'surface' }, children: [] },
    ] } as WbNode;
    const { files } = renderSite(site(), [page(home), page(about, { id: 'pa', slug: 'about', title: 'About' })], []);
    const css = files.get('styles.css')!;
    expect(css).toContain('.wb-page-home .n-h1');
    expect(css).toContain('.wb-page-about .n-sec');
    // and each page's body carries its scope class
    expect(files.get('index.html')).toContain('class="wb-page-home"');
    expect(files.get('about/index.html')).toContain('class="wb-page-about"');
  });

  it('escapes a javascript: ogImage/href and never emits raw script in head', () => {
    const s = site({ settings: { locale: 'en', baseUrl: 'https://x.example', favicon: 'nonexistent-asset' } });
    const p = page({ id: 'r', type: 'page-root', props: {}, children: [
      { id: 'h', type: 'heading', props: { text: 'T', level: 1 } },
    ] }, { meta: { description: '</title><script>x</script>', ogImage: 'https://evil"onerror="x' } });
    const html = renderSite(s, [p], []).files.get('index.html')!;
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('onerror="x"');
  });

  it('emits SEO/OG/Twitter head tags from page meta, with fallbacks', () => {
    const s = site({ settings: { locale: 'en', baseUrl: 'https://clinic.example' } });
    const p = page({ id: 'r', type: 'page-root', props: {}, children: [
      { id: 'h', type: 'heading', props: { text: 'T', level: 1 } },
    ] }, {
      meta: {
        title: 'Custom SEO Title',
        description: 'Meta desc.',
        ogImage: 'https://clinic.example/share.png',
        // ogTitle/ogDescription omitted → fall back to title/description
      },
    });
    const html = renderSite(s, [p], []).files.get('index.html')!;
    expect(html).toContain('<title>Custom SEO Title</title>');
    expect(html).toContain('<meta name="description" content="Meta desc.">');
    expect(html).toContain('<meta property="og:title" content="Custom SEO Title">');
    expect(html).toContain('<meta property="og:description" content="Meta desc.">');
    expect(html).toContain('<meta property="og:url" content="https://clinic.example/">');
    expect(html).toContain('<meta property="og:image" content="https://clinic.example/share.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="twitter:image" content="https://clinic.example/share.png">');
    expect(html).toContain('<link rel="canonical" href="https://clinic.example/">');
  });

  it('emits pure-CSS :hover and :focus-visible rules for interactive states', () => {
    const p = page({ id: 'r', type: 'page-root', props: {}, children: [
      {
        id: 'btn',
        type: 'button',
        props: { label: 'Go', href: '/x' },
        style: { background: 'primary', hover: { background: 'accent', shadow: 'lg' }, focus: { color: 'white' } },
      },
    ] });
    const css = renderSite(site(), [p], []).files.get('styles.css')!;
    expect(css).toContain('.n-btn:hover{');
    expect(css).toContain('.n-btn:focus-visible{');
    // a transition is added so the hover animates, and it stays zero-JS
    expect(css).toMatch(/\.n-btn\{[^}]*transition:/);
    expect(css).not.toMatch(/<script|onmouse/i);
  });

  it('honors noindex, explicit twitterCard, and social-only overrides', () => {
    const p = page({ id: 'r', type: 'page-root', props: {}, children: [] }, {
      meta: { description: 'd', ogTitle: 'Social T', ogDescription: 'Social D', twitterCard: 'summary', noIndex: true },
    });
    const html = renderSite(site(), [p], []).files.get('index.html')!;
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<meta property="og:title" content="Social T">');
    expect(html).toContain('<meta property="og:description" content="Social D">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    // no baseUrl → no canonical / og:url
    expect(html).not.toContain('rel="canonical"');
  });

  it('is deterministic across renders for a complex tree', () => {
    const tree: WbNode = { id: 'r', type: 'page-root', props: {}, children: [
      { id: 'hero', type: 'hero', props: { headline: 'Hi', primaryCta: { label: 'Go', href: '/x' } } },
      { id: 'g', type: 'featureGrid', props: { heading: 'S' }, children: [
        { id: 'c1', type: 'card', props: { title: 'A' } },
        { id: 'c2', type: 'card', props: { title: 'B' } },
      ] },
      { id: 'faq', type: 'faq', props: { items: [{ question: 'q', answer: 'a' }] } },
    ] };
    const a = renderSite(site(), [page(tree)], []);
    const b = renderSite(site(), [page(tree)], []);
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
  });
});
