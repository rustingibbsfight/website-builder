import { DEFAULT_THEME, type Page, type Site } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { ogFallbackPath, ogFallbackSvg, OG_HEIGHT, OG_WIDTH } from './og-image.js';
import { renderPage } from './render-page.js';
import { renderSite } from './render-site.js';

const site = (over: Partial<Site> = {}): Site => ({
  id: 'site1',
  name: 'Test Site',
  theme: { ...DEFAULT_THEME, brandName: 'Testers', colors: { ...DEFAULT_THEME.colors, primary: '#5b4ee6', secondary: '#14142b', accent: '#17c0a8' } },
  settings: { locale: 'en', baseUrl: 'https://example.com' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const page = (slug: string, meta: Page['meta'] = { description: 'A test page.' }): Page => ({
  id: `pg-${slug || 'home'}`,
  siteId: 'site1',
  slug,
  title: slug === '' ? 'Home' : slug,
  meta,
  tree: { id: 'r', type: 'page-root', props: {}, children: [] },
  sortOrder: 0,
});

const resolveAsset = () => '';

describe('OG fallback image', () => {
  it('renders a 1200×630 SVG with the brand name and page title', () => {
    const svg = ogFallbackSvg(site(), { ...page('pricing'), title: 'Pricing', meta: {} });
    expect(svg).toContain('<svg');
    expect(svg).toContain(`width="${OG_WIDTH}"`);
    expect(svg).toContain(`height="${OG_HEIGHT}"`);
    expect(svg).toContain('Testers');
    expect(svg).toContain('Pricing');
    // Uses the theme colors in the gradient.
    expect(svg).toContain('#5b4ee6');
    expect(svg).toContain('#14142b');
  });

  it('prefers ogTitle > title > page.title for the headline', () => {
    const svg = ogFallbackSvg(site(), page('x', { ogTitle: 'Social Headline', title: 'Doc Title' }));
    expect(svg).toContain('Social Headline');
    expect(svg).not.toContain('Doc Title');
  });

  it('wraps long titles and ellipsises overflow (no raw overflow off-canvas)', () => {
    const long = 'This is an extremely long page title that will not fit on a single line and must wrap across several lines before finally being truncated with an ellipsis';
    const svg = ogFallbackSvg(site(), page('x', { title: long }));
    const tspans = svg.match(/<tspan/g) ?? [];
    expect(tspans.length).toBeGreaterThan(1);
    expect(tspans.length).toBeLessThanOrEqual(3);
    expect(svg).toContain('…');
  });

  it('escapes title text — no HTML/SVG injection', () => {
    const svg = ogFallbackSvg(site(), page('x', { title: '<script>alert(1)</script>' }));
    expect(svg).not.toContain('<script>alert');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('path is og/index.svg for home and og/<slug>.svg otherwise', () => {
    expect(ogFallbackPath(page(''))).toBe('og/index.svg');
    expect(ogFallbackPath(page('pricing'))).toBe('og/pricing.svg');
  });

  it('renderSite writes a fallback card per page without an explicit image', () => {
    const { files } = renderSite(site(), [page(''), page('pricing')], []);
    expect(files.has('og/index.svg')).toBe(true);
    expect(files.has('og/pricing.svg')).toBe(true);
  });

  it('renderSite does NOT write a fallback when the page sets its own ogImage', () => {
    const { files } = renderSite(site(), [page('promo', { ogImage: 'https://cdn.example/x.png' })], []);
    expect(files.has('og/promo.svg')).toBe(false);
  });

  it('head references the absolute fallback URL when no explicit image', () => {
    const html = renderPage(site(), page('pricing'), { resolveAsset });
    expect(html).toContain('<meta property="og:image" content="https://example.com/og/pricing.svg">');
    expect(html).toContain('<meta name="twitter:image" content="https://example.com/og/pricing.svg">');
    // A large branded card warrants the large-image Twitter card.
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it('head uses the explicit image (not the fallback) when one is set', () => {
    const html = renderPage(site(), page('promo', { ogImage: 'https://cdn.example/x.png' }), { resolveAsset });
    expect(html).toContain('<meta property="og:image" content="https://cdn.example/x.png">');
    expect(html).not.toContain('og/promo.svg');
  });
});
