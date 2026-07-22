import { z } from 'zod';
import { escapeHtml, safeHref } from '../html.js';
import type { ComponentDef, RenderCtx } from '../registry.js';
import { CtaSchema, el, LinkSchema, wbInner } from './shared.js';

function logoHtml(ctx: RenderCtx): string {
  const url = ctx.theme.logo ? ctx.resolveAsset(ctx.theme.logo) : '';
  const name = escapeHtml(ctx.theme.brandName);
  return url
    ? `<a class="wb-logo" href="/"><img src="${escapeHtml(url)}" alt="${name}"></a>`
    : `<a class="wb-logo wb-logo-text" href="/">${name}</a>`;
}

const headerProps = z
  .object({
    links: z.array(LinkSchema).default([]).describe('Navigation links'),
    cta: CtaSchema.optional().describe('Prominent call-to-action button on the right'),
    showLogo: z.boolean().default(true),
    sticky: z.boolean().default(true).describe('Keep the header pinned while scrolling'),
  })
  .strict();

export const header: ComponentDef<z.infer<typeof headerProps>> = {
  type: 'header',
  title: 'Header',
  description:
    'Site header with logo, navigation links, and optional CTA. Collapses to a CSS-only hamburger menu on mobile.',
  category: 'chrome',
  isContainer: false,
  propsSchema: headerProps,
  defaultProps: { links: [], showLogo: true, sticky: true },
  layoutTarget: 'inner',
  render: (node, props, ctx) => {
    const links = props.links
      .map((l) => `<a href="${safeHref(l.href)}">${escapeHtml(l.label)}</a>`)
      .join('');
    const cta = props.cta
      ? `<a class="wb-btn wb-btn-primary wb-btn-sm wb-header-cta" href="${safeHref(props.cta.href)}">${escapeHtml(props.cta.label)}</a>`
      : '';
    const inner = wbInner(
      `${props.showLogo ? logoHtml(ctx) : ''}
<input type="checkbox" id="wb-nav-toggle" class="wb-nav-toggle" aria-hidden="true">
<label for="wb-nav-toggle" class="wb-nav-burger" aria-label="Open menu"><span></span><span></span><span></span></label>
<nav class="wb-nav" aria-label="Main">${links}${cta}</nav>`,
    );
    return el('header', node, inner, { class: props.sticky ? 'wb-sticky' : '' });
  },
  baseCss: `.c-header{background:var(--color-background);border-bottom:1px solid color-mix(in srgb, var(--color-text) 10%, transparent);z-index:50}
.c-header.wb-sticky{position:sticky;top:0}
.c-header .wb-inner{display:flex;align-items:center;justify-content:space-between;gap:var(--space-md);padding:var(--space-sm) var(--space-md);max-width:1200px;margin:0 auto}
.wb-logo{display:flex;align-items:center;text-decoration:none}
.wb-logo img{height:44px;width:auto;display:block}
.wb-logo-text{font-family:var(--font-heading);font-weight:700;font-size:1.3rem;color:var(--color-secondary)}
.wb-nav{display:flex;align-items:center;gap:var(--space-md)}
.wb-nav a{color:var(--color-text);text-decoration:none;font-weight:500}
.wb-nav a:hover{color:var(--color-primary)}
.wb-nav a.wb-header-cta{color:#fff}
.wb-nav-toggle{display:none}
.wb-nav-burger{display:none;cursor:pointer;flex-direction:column;gap:5px;padding:8px}
.wb-nav-burger span{display:block;width:24px;height:2px;background:var(--color-text);transition:transform .2s}
@media (max-width:1023px){
.wb-nav-burger{display:flex}
.wb-nav{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;align-items:stretch;background:var(--color-background);padding:var(--space-md);border-bottom:1px solid color-mix(in srgb, var(--color-text) 10%, transparent);box-shadow:0 8px 16px rgb(0 0 0 / .08)}
.wb-nav a{padding:.5rem 0}
.wb-nav-toggle:checked~.wb-nav{display:flex}
.c-header{position:relative}
.c-header .wb-inner{position:relative}
.wb-nav-toggle:checked~.wb-nav-burger span:nth-child(1){transform:translateY(7px) rotate(45deg)}
.wb-nav-toggle:checked~.wb-nav-burger span:nth-child(2){opacity:0}
.wb-nav-toggle:checked~.wb-nav-burger span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}
}`,
};

const footerProps = z
  .object({
    columns: z
      .array(z.object({ heading: z.string(), links: z.array(LinkSchema) }).strict())
      .default([])
      .describe('Link columns'),
    about: z.string().optional().describe('Short blurb shown under the logo'),
    legal: z.string().optional().describe('Copyright/legal line, e.g. "© 2026 Acme LLC"'),
    showLogo: z.boolean().default(true),
  })
  .strict();

export const footer: ComponentDef<z.infer<typeof footerProps>> = {
  type: 'footer',
  title: 'Footer',
  description: 'Site footer with logo/blurb, link columns, and a legal line.',
  category: 'chrome',
  isContainer: false,
  propsSchema: footerProps,
  defaultProps: { columns: [], showLogo: true },
  layoutTarget: 'inner',
  render: (node, props, ctx) => {
    const cols = props.columns
      .map(
        (c) =>
          `<div class="wb-footer-col"><h3>${escapeHtml(c.heading)}</h3>${c.links
            .map((l) => `<a href="${safeHref(l.href)}">${escapeHtml(l.label)}</a>`)
            .join('')}</div>`,
      )
      .join('');
    // Always a text wordmark here: image logos rarely survive on dark footers.
    const brand = `<div class="wb-footer-brand">${
      props.showLogo
        ? `<a class="wb-logo wb-logo-text" href="/">${escapeHtml(ctx.theme.brandName)}</a>`
        : ''
    }${props.about ? `<p>${escapeHtml(props.about)}</p>` : ''}</div>`;
    const legal = props.legal ? `<div class="wb-footer-legal">${escapeHtml(props.legal)}</div>` : '';
    return el('footer', node, wbInner(`<div class="wb-footer-grid">${brand}${cols}</div>${legal}`));
  },
  baseCss: `.c-footer{background:var(--color-secondary);color:#fff;margin-top:auto}
.c-footer .wb-inner{max-width:1200px;margin:0 auto;padding:var(--space-xl) var(--space-md) var(--space-lg)}
.wb-footer-grid{display:grid;grid-template-columns:2fr repeat(auto-fit,minmax(140px,1fr));gap:var(--space-lg)}
.wb-footer-brand p{color:color-mix(in srgb, #fff 70%, transparent);margin:.75rem 0 0;max-width:32ch;line-height:1.6}
.c-footer .wb-logo-text{color:#fff}
.wb-footer-col h3{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;margin:0 0 .75rem;color:color-mix(in srgb, #fff 60%, transparent)}
.wb-footer-col a{display:block;color:#fff;text-decoration:none;padding:.2rem 0;opacity:.9}
.wb-footer-col a:hover{opacity:1;text-decoration:underline}
.wb-footer-legal{margin-top:var(--space-lg);padding-top:var(--space-md);border-top:1px solid color-mix(in srgb, #fff 15%, transparent);font-size:.85rem;color:color-mix(in srgb, #fff 60%, transparent)}
@media (max-width:639px){.wb-footer-grid{grid-template-columns:1fr}}`,
};

// ── Symbol instance ──────────────────────────────────────────────────────────
// A placeholder that renders a reusable symbol definition (site.symbols[symbolId]).
// The renderer intercepts this type and inlines the resolved subtree, so this
// render() is only a fallback (e.g. when symbols aren't in context).
const symbolInstanceProps = z
  .object({
    // Empty is allowed so the default props validate; the renderer treats an
    // empty/unknown id as a missing symbol (renders nothing / a placeholder).
    symbolId: z.string().default('').describe('Id of the site symbol to render here'),
  })
  .strict();

export const symbolInstance: ComponentDef<z.infer<typeof symbolInstanceProps>> = {
  type: 'symbolInstance',
  title: 'Symbol',
  description: 'Renders a reusable symbol defined once at the site level; edit the definition to update every instance.',
  category: 'layout',
  isContainer: false,
  propsSchema: symbolInstanceProps,
  defaultProps: { symbolId: '' },
  render: (node, props) =>
    el('div', node, `<!-- symbol ${escapeHtml(props.symbolId)} (resolved by the renderer) -->`),
  baseCss: `.wb-sym-missing{padding:var(--space-md);text-align:center;color:var(--color-textMuted);border:1px dashed color-mix(in srgb, var(--color-text) 30%, transparent);border-radius:var(--radius-sm);font-size:.9rem}`,
};

export const chromeDefs = [header, footer, symbolInstance];
