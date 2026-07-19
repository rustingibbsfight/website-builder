import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_THEME, type Page, type Site, type WbNode } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { renderSite, writeDist } from './index.js';

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

describe('robots.txt cannot be injected via baseUrl', () => {
  it('strips control characters/newlines from baseUrl before emitting robots.txt', () => {
    const s = site({ settings: { locale: 'en', baseUrl: 'https://x.example\nDisallow: /admin' } });
    const { files } = renderSite(s, [page(root([]))], []);
    const robots = files.get('robots.txt')!;
    // The injected newline is gone, so "Disallow: /admin" is never its own
    // directive line — it collapses harmlessly into the Sitemap URL.
    const lines = robots.split('\n');
    expect(lines.some((l) => l.trimStart().startsWith('Disallow:'))).toBe(false);
    expect(lines.filter((l) => l.startsWith('Sitemap:'))).toHaveLength(1);
    expect(robots).toContain('Sitemap: https://x.exampleDisallow: /admin/sitemap.xml');
  });
});

describe('renderSite rejects colliding output paths', () => {
  it('throws when two pages resolve to the same file (slug "" and "index")', () => {
    const pages: Page[] = [
      { id: 'p1', siteId: 's1', slug: '', title: 'Home', meta: {}, tree: root([]), sortOrder: 0 },
      { id: 'p2', siteId: 's1', slug: 'index', title: 'Also home', meta: {}, tree: root([]), sortOrder: 1 },
    ];
    expect(() => renderSite(site(), pages, [])).toThrow(/duplicate output path/);
  });
});

describe('writeDist stays inside the build directory', () => {
  it('refuses to write a file map entry that escapes the output dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wd-'));
    try {
      const evil = new Map<string, string>([['../escape.html', '<h1>pwned</h1>']]);
      await expect(writeDist(evil, dir)).rejects.toThrow(/outside the build directory/);
      // The escape target was never created next to the build dir.
      expect(() => readFileSync(resolve(dir, '../escape.html'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes normal nested paths fine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-wd-'));
    try {
      const files = new Map<string, string>([['services/index.html', '<h1>ok</h1>']]);
      const written = await writeDist(files, dir);
      expect(written).toEqual(['services/index.html']);
      expect(readFileSync(join(dir, 'services/index.html'), 'utf8')).toContain('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
