import {
  escapeHtml,
  getComponent,
  parseProps,
  VIDEO_FACADE_JS,
  type RenderCtx,
} from '@wb/components';
import { normalizeSlug, walk, type Page, type Site, type WbNode } from '@wb/schema';
import { ogFallbackPath } from './og-image.js';

export interface RenderPageOptions {
  resolveAsset: RenderCtx['resolveAsset'];
  /** Extra HTML injected before </body> (preview editor hooks). */
  bodyExtra?: string;
  /**
   * CSP nonce for the renderer's own trusted inline scripts (the video facade).
   * When set, the preview serves a strict `script-src 'nonce-…'` CSP so that an
   * htmlEmbed's injected <script> — which never carries the nonce — cannot run.
   * Omitted for static publish (no CSP there; the caller injects the nonce into
   * any bodyExtra script itself).
   */
  nonce?: string;
}

export function pageBodyClass(slug: string): string {
  return `wb-page-${normalizeSlug(slug) === '' ? 'home' : normalizeSlug(slug)}`;
}

export function renderNodeHtml(node: WbNode, ctx: RenderCtx): string {
  if (node.type === 'symbolInstance') return renderSymbolInstance(node, ctx);
  const def = getComponent(node.type);
  const props = parseProps(node.type, node.props);
  return def.render(node, props, ctx);
}

/**
 * Deep-clone a subtree, prefixing every node id (#26). Symbol definitions are
 * shared, so each instance must render with distinct ids — otherwise element
 * ids/names inside the definition (gallery `:target`, tabs/accordion radio
 * `name`s, form field ids) collide across instances on the same page and break
 * the CSS-only interactivity. Deterministic, so HTML and CSS ids match.
 */
export function reIdSubtree(node: WbNode, prefix: string): WbNode {
  return {
    ...node,
    id: prefix + node.id,
    children: node.children?.map((c) => reIdSubtree(c, prefix)),
  };
}

/**
 * Resolve a symbol instance to its definition subtree (#26). Publish inlines the
 * resolved HTML; the editor preview wraps it as one selectable unit (inner
 * data-node-ids stripped) so you edit the definition, not the instance. Missing
 * symbols and cycles degrade to nothing (publish) or a placeholder (preview).
 * The definition is re-id'd per instance so multiple instances don't collide.
 */
function renderSymbolInstance(node: WbNode, ctx: RenderCtx): string {
  const symId = String((node.props as { symbolId?: unknown })?.symbolId ?? '');
  const def = symId ? ctx.symbols?.[symId] : undefined;
  const stack = ctx.symbolStack ?? [];
  if (!def || stack.includes(symId)) {
    if (!ctx.preview) return '';
    const label = !def ? 'Missing symbol' : 'Symbol cycle';
    return `<div class="c-symbolInstance n-${node.id}" data-node-id="${node.id}"><div class="wb-sym-missing">${label}${
      symId ? `: ${escapeHtml(symId)}` : ''
    }</div></div>`;
  }
  const innerCtx: RenderCtx = { ...ctx, symbolStack: [...stack, symId] };
  innerCtx.renderNode = (n) => renderNodeHtml(n, innerCtx);
  let inner = renderNodeHtml(reIdSubtree(def, `${node.id}_`), innerCtx);
  if (ctx.preview) {
    inner = inner.replace(/ data-node-id="[^"]*"/g, '');
    return `<div class="c-symbolInstance n-${node.id}" data-node-id="${node.id}" data-symbol="${escapeHtml(symId)}">${inner}</div>`;
  }
  return inner;
}

function headHtml(site: Site, page: Page, resolveAsset: RenderCtx['resolveAsset']): string {
  const brand = site.theme.brandName;
  const slug = normalizeSlug(page.slug);
  const defaultTitle = slug === '' ? `${brand} — ${page.title}` : `${page.title} — ${brand}`;
  // Per-page overrides (see PageMetaSchema) fall back sensibly: title → default,
  // og:title → title, og:description → description.
  const title = page.meta.title || defaultTitle;
  const description = page.meta.description;
  const ogTitle = page.meta.ogTitle || title;
  const ogDescription = page.meta.ogDescription || description;
  const lines = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
  ];
  if (description) {
    lines.push(`<meta name="description" content="${escapeHtml(description)}">`);
  }
  if (page.meta.noIndex) lines.push('<meta name="robots" content="noindex">');

  const base = site.settings.baseUrl?.replace(/\/$/, '');
  const path = slug === '' ? '/' : `/${slug}/`;
  // Resolve the OG image to an absolute URL where possible (crawlers need it).
  // With no explicit image, fall back to the auto-generated branded card that
  // renderSite writes at og/<slug>.svg (kept in lockstep with that condition).
  let ogImage = '';
  if (page.meta.ogImage) {
    ogImage = page.meta.ogImage.startsWith('http')
      ? page.meta.ogImage
      : (base ?? '') + resolveAsset({ assetId: page.meta.ogImage });
  } else {
    ogImage = `${base ?? ''}/${ogFallbackPath(page)}`;
  }

  lines.push(`<meta property="og:title" content="${escapeHtml(ogTitle)}">`);
  if (ogDescription) {
    lines.push(`<meta property="og:description" content="${escapeHtml(ogDescription)}">`);
  }
  lines.push('<meta property="og:type" content="website">');
  if (base) lines.push(`<meta property="og:url" content="${escapeHtml(base + path)}">`);
  if (ogImage) lines.push(`<meta property="og:image" content="${escapeHtml(ogImage)}">`);

  // Twitter card mirrors the OG data.
  const twitterCard = page.meta.twitterCard ?? (ogImage ? 'summary_large_image' : 'summary');
  lines.push(`<meta name="twitter:card" content="${twitterCard}">`);
  lines.push(`<meta name="twitter:title" content="${escapeHtml(ogTitle)}">`);
  if (ogDescription) lines.push(`<meta name="twitter:description" content="${escapeHtml(ogDescription)}">`);
  if (ogImage) lines.push(`<meta name="twitter:image" content="${escapeHtml(ogImage)}">`);

  if (base) {
    lines.push(`<link rel="canonical" href="${escapeHtml(base + path)}">`);
  }
  if (site.settings.favicon) {
    const href = site.settings.favicon.startsWith('http')
      ? site.settings.favicon
      : resolveAsset({ assetId: site.settings.favicon });
    lines.push(`<link rel="icon" href="${escapeHtml(href)}">`);
  }
  lines.push('<link rel="stylesheet" href="/styles.css">');
  return lines.join('\n');
}

export function renderPage(site: Site, page: Page, opts: RenderPageOptions): string {
  const ctx: RenderCtx = {
    theme: site.theme,
    resolveAsset: opts.resolveAsset,
    renderNode: (node) => renderNodeHtml(node, ctx),
    siteId: site.id,
    // Where stored-submission forms POST (the wb-api base). Configurable per
    // site so the static output isn't hard-coded to one API host. (#27)
    formEndpoint: site.settings.formEndpoint,
    symbols: site.symbols,
  };

  let usesVideo = false;
  for (const root of [site.header, page.tree, site.footer]) {
    if (root) walk(root, (n) => { if (n.type === 'videoEmbed') usesVideo = true; });
  }

  const header = site.header ? renderNodeHtml(site.header, ctx) : '';
  const main = renderNodeHtml(page.tree, ctx);
  const footer = site.footer ? renderNodeHtml(site.footer, ctx) : '';
  const nonceAttr = opts.nonce ? ` nonce="${escapeHtml(opts.nonce)}"` : '';
  const script = usesVideo ? `<script${nonceAttr}>${VIDEO_FACADE_JS}</script>` : '';

  return `<!doctype html>
<html lang="${escapeHtml(site.settings.locale)}">
<head>
${headHtml(site, page, opts.resolveAsset)}
</head>
<body class="${pageBodyClass(page.slug)}">
${header}
${main}
${footer}
${script}${opts.bodyExtra ?? ''}
</body>
</html>
`;
}

export interface LintWarning {
  page: string;
  message: string;
}

/** Publish-time lint: SEO/accessibility warnings (never errors). */
export function lintPage(site: Site, page: Page): LintWarning[] {
  const warnings: LintWarning[] = [];
  const slug = normalizeSlug(page.slug) || '(home)';
  let h1Count = 0;
  walk(page.tree, (n) => {
    if (n.type === 'hero') h1Count += 1;
    if (n.type === 'heading' && n.props.level === 1) h1Count += 1;
    if (n.type === 'image') {
      const img = n.props.image as { alt?: string } | undefined;
      if (!img?.alt) warnings.push({ page: slug, message: `image node ${n.id} has no alt text` });
    }
    // A form with nowhere to post is the worst kind of broken: it renders
    // perfectly, and the only person who finds out is the one who filled it in
    // and watched the browser POST to a static file. Mirrors the effective
    // action `contactForm.render` computes — keep the two in step.
    if (n.type === 'contactForm') {
      const p = n.props as { store?: boolean; action?: string; netlifyForms?: boolean };
      const storedHere = Boolean(p.store) && Boolean(site.settings.formEndpoint);
      if (!storedHere && !p.action && !p.netlifyForms) {
        warnings.push({
          page: slug,
          message: p.store
            ? `form ${n.id} stores submissions in wb but the site has no formEndpoint setting — submissions go nowhere (set settings.formEndpoint to the wb API base URL)`
            : `form ${n.id} has nowhere to post — submissions go nowhere (set store:true with the site's formEndpoint, or give it an action URL)`,
        });
      }
    }
  });
  if (h1Count === 0) warnings.push({ page: slug, message: 'page has no h1 (add a hero or a level-1 heading)' });
  if (h1Count > 1) warnings.push({ page: slug, message: `page has ${h1Count} h1 elements (keep exactly one)` });
  if (!page.meta.description) warnings.push({ page: slug, message: 'page has no meta description' });
  return warnings;
}
