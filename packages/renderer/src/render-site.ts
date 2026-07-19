import { escapeHtml, type RenderCtx } from '@wb/components';
import { normalizeSlug, type Asset, type Page, type Site } from '@wb/schema';
import { renderCss, type CssTree } from './render-css.js';
import { lintPage, pageBodyClass, renderPage, type LintWarning } from './render-page.js';

export interface RenderSiteResult {
  /** path (relative to dist root) → file contents. Assets are copied by the caller. */
  files: Map<string, string>;
  warnings: LintWarning[];
}

export function makeAssetResolver(assets: Asset[]): RenderCtx['resolveAsset'] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return (ref) => {
    if (!ref) return '';
    if (ref.assetId) {
      const asset = byId.get(ref.assetId);
      return asset ? `/assets/${asset.path}` : '';
    }
    return ref.url ?? '';
  };
}

export function pagePath(slug: string): string {
  const s = normalizeSlug(slug);
  return s === '' ? 'index.html' : `${s}/index.html`;
}

export function renderSite(site: Site, pages: Page[], assets: Asset[]): RenderSiteResult {
  const resolveAsset = makeAssetResolver(assets);
  const files = new Map<string, string>();
  const warnings: LintWarning[] = [];

  const trees: CssTree[] = [];
  if (site.header) trees.push({ root: site.header, scope: '' });
  if (site.footer) trees.push({ root: site.footer, scope: '' });
  for (const page of pages) {
    trees.push({ root: page.tree, scope: `.${pageBodyClass(page.slug)} ` });
  }
  files.set('styles.css', renderCss(site, trees, resolveAsset));

  for (const page of pages) {
    files.set(pagePath(page.slug), renderPage(site, page, { resolveAsset }));
    warnings.push(...lintPage(site, page));
  }

  files.set('404.html', render404(site));
  files.set('robots.txt', robotsTxt(site));
  const sitemap = sitemapXml(site, pages);
  if (sitemap) files.set('sitemap.xml', sitemap);

  return { files, warnings };
}

function render404(site: Site): string {
  return `<!doctype html>
<html lang="${escapeHtml(site.settings.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — ${escapeHtml(site.theme.brandName)}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:70vh;gap:1rem;padding:2rem;text-align:center">
<h1 style="font-family:var(--font-heading)">Page not found</h1>
<p>The page you're looking for doesn't exist.</p>
<a class="wb-btn wb-btn-primary wb-btn-md" href="/">Back to home</a>
</main>
</body>
</html>
`;
}

function robotsTxt(site: Site): string {
  const base = site.settings.baseUrl?.replace(/\/$/, '');
  return `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ''}`;
}

function sitemapXml(site: Site, pages: Page[]): string | null {
  const base = site.settings.baseUrl?.replace(/\/$/, '');
  if (!base) return null;
  const urls = pages
    .filter((p) => !p.meta.noIndex)
    .map((p) => {
      const slug = normalizeSlug(p.slug);
      return `  <url><loc>${escapeHtml(base + (slug === '' ? '/' : `/${slug}/`))}</loc></url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
