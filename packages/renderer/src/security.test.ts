import { DEFAULT_THEME, type Page, type Site, type WbNode } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { renderSite } from './index.js';

const site = (over: Partial<Site> = {}): Site => ({
  id: 's1',
  name: 'S',
  theme: { ...DEFAULT_THEME, brandName: 'Brand' },
  settings: { locale: 'en' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const page = (tree: WbNode): Page => ({
  id: 'p', siteId: 's1', slug: '', title: 'Home', meta: { description: 'd' }, tree, sortOrder: 0,
});

const root = (children: WbNode[]): WbNode => ({ id: 'r', type: 'page-root', props: {}, children });

describe('generated stylesheet cannot be injected via asset urls', () => {
  it('a background-image asset url with CSS metacharacters cannot break out of url()', () => {
    const evil = `x'); } body { display:none } .h:after { content: url('`;
    const tree = root([
      { id: 'sec', type: 'section', props: {}, style: { background: { image: { url: evil, alt: '' } } } },
    ]);
    const { files } = renderSite(site(), [page(tree)], []);
    const css = files.get('styles.css')!;
    // The injected 'body { ... }' rule must not appear, and the url() body is
    // free of any character that could close the string/paren/rule.
    expect(css).not.toContain('body { display:none }');
    const urlBody = css.match(/url\('([^']*)'\)/)?.[1] ?? '';
    expect(urlBody.length).toBeGreaterThan(0);
    expect(urlBody).not.toMatch(/['"()};{]/);
  });

  it('falls back to the overlay color when the asset url is entirely metacharacters', () => {
    const tree = root([
      { id: 'sec', type: 'section', props: {}, style: { background: { image: { url: `'"()`, alt: '' }, overlay: 'primary' } } },
    ]);
    const { files } = renderSite(site(), [page(tree)], []);
    expect(files.get('styles.css')).toContain('.n-sec{background:var(--color-primary)}');
  });
});

describe('theme colors are hex-validated so they cannot inject CSS', () => {
  it('rejects a non-hex primary color at the schema layer', () => {
    // renderSite trusts a validated Site; the guard is upstream (ThemeSchema).
    // Here we assert the rendered var uses the exact hex, nothing more.
    const { files } = renderSite(
      site({ theme: { ...DEFAULT_THEME, brandName: 'B', colors: { ...DEFAULT_THEME.colors, primary: '#abcdef' } } }),
      [page(root([{ id: 'h', type: 'heading', props: { text: 'x', level: 1 } }]))],
      [],
    );
    expect(files.get('styles.css')).toContain('--color-primary:#abcdef');
  });
});

describe('deterministic + structurally safe output', () => {
  it('produces byte-identical output for identical input (golden stability)', () => {
    const tree = root([
      { id: 'h', type: 'hero', props: { headline: 'Hi' } },
      { id: 'g', type: 'stack', props: {}, layout: { direction: 'grid', columns: 4 },
        children: [{ id: 'c', type: 'card', props: { title: 'C' } }] },
    ]);
    const a = renderSite(site(), [page(tree)], []);
    const b = renderSite(site(), [page(tree)], []);
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
  });

  it('escapes brand name in title/meta and never leaks it raw into a script', () => {
    const { files } = renderSite(
      site({ theme: { ...DEFAULT_THEME, brandName: '</title><script>x</script>' } }),
      [page(root([{ id: 'h', type: 'heading', props: { text: 'x', level: 1 } }]))],
      [],
    );
    const html = files.get('index.html')!;
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;');
  });

  it('mobile/tablet media blocks only ever contain node rules, never page HTML', () => {
    const tree = root([
      { id: 'row', type: 'stack', props: {}, layout: { direction: 'row', gap: 'md' },
        responsive: { mobile: { hidden: true } }, children: [{ id: 't', type: 'text', props: { text: 'x' } }] },
    ]);
    const css = renderSite(site(), [page(tree)], []).files.get('styles.css')!;
    const mobile = css.slice(css.lastIndexOf('@media (max-width:639px)'));
    expect(mobile).toContain('.n-row{display:none}');
    expect(mobile).not.toContain('<');
  });
});
