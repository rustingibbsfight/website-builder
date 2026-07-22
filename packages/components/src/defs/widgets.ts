import { AssetRefSchema } from '@wb/schema';
import { z } from 'zod';
import { escapeHtml, safeHref } from '../html.js';
import type { ComponentDef } from '../registry.js';
import { el, wbInner } from './shared.js';

/**
 * Widget batch — self-contained, zero-JavaScript composites. Every one renders
 * to static HTML/CSS (any interactivity is CSS-only), stays responsive by
 * construction, and is escape-by-default. Being in the registry makes each
 * available identically to agents (MCP `list_components` / REST `/components`),
 * the CLI, and the visual editor's palette + auto-generated Inspector form.
 */

// ── Stat row ─────────────────────────────────────────────────────────────────
const statRowProps = z
  .object({
    heading: z.string().optional().describe('Optional heading above the stats'),
    stats: z
      .array(
        z
          .object({
            value: z.string().min(1).describe('The big number, e.g. "10,000+" or "98%"'),
            label: z.string().min(1).describe('Short label under the value'),
            description: z.string().optional().describe('Optional extra line of context'),
          })
          .strict(),
      )
      .min(1)
      .describe('The metrics to show, side by side'),
  })
  .strict();

export const statRow: ComponentDef<z.infer<typeof statRowProps>> = {
  type: 'statRow',
  title: 'Stat row',
  description: 'A row of headline metrics (big number + label). Wraps to fewer columns on small screens.',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: statRowProps,
  defaultProps: {
    stats: [
      { value: '10k+', label: 'Patients seen' },
      { value: '4.9★', label: 'Average rating' },
      { value: '24/7', label: 'Support' },
    ],
  },
  render: (node, props) => {
    const items = props.stats
      .map(
        (s) =>
          `<div class="wb-stat"><div class="wb-stat-value">${escapeHtml(s.value)}</div><div class="wb-stat-label">${escapeHtml(
            s.label,
          )}</div>${s.description ? `<p class="wb-stat-desc">${escapeHtml(s.description)}</p>` : ''}</div>`,
      )
      .join('');
    return el(
      'section',
      node,
      wbInner(
        `${props.heading ? `<h2 class="wb-stat-head">${escapeHtml(props.heading)}</h2>` : ''}<div class="wb-stat-grid">${items}</div>`,
      ),
    );
  },
  baseCss: `.c-statRow .wb-inner{max-width:1100px;margin:0 auto;padding:var(--space-xl) var(--space-md)}
.wb-stat-head{font-family:var(--font-heading);font-size:clamp(1.5rem,3.2vw,2.1rem);text-align:center;margin:0 0 var(--space-lg)}
.wb-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:var(--space-lg);text-align:center}
.wb-stat-value{font-family:var(--font-heading);font-size:clamp(2.2rem,5vw,3.2rem);line-height:1;color:var(--color-primary);font-variant-numeric:tabular-nums}
.wb-stat-label{margin-top:.4rem;font-weight:600}
.wb-stat-desc{margin:.35rem 0 0;color:var(--color-textMuted);font-size:.92rem;line-height:1.5}`,
};

// ── Logo wall ────────────────────────────────────────────────────────────────
const logoWallProps = z
  .object({
    heading: z.string().optional().describe('e.g. "As seen in" or "Trusted by"'),
    logos: z
      .array(
        z
          .object({
            name: z.string().min(1).describe('Company name — shown as text if no image, and used as alt text'),
            image: AssetRefSchema.optional().describe('Logo image (falls back to the name as text)'),
            href: z.string().optional().describe('Optional link'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const logoWall: ComponentDef<z.infer<typeof logoWallProps>> = {
  type: 'logoWall',
  title: 'Logo wall',
  description: 'A strip of partner/press logos (image or text), muted until hover. Wraps responsively.',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: logoWallProps,
  defaultProps: {
    heading: 'Trusted by',
    logos: [{ name: 'Acme' }, { name: 'Globex' }, { name: 'Initech' }, { name: 'Umbrella' }],
  },
  render: (node, props, ctx) => {
    const items = props.logos
      .map((l) => {
        const url = l.image ? ctx.resolveAsset(l.image) : '';
        const inner = url
          ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(l.image?.alt ?? l.name)}" loading="lazy">`
          : `<span class="wb-logo-text">${escapeHtml(l.name)}</span>`;
        return l.href
          ? `<a class="wb-logo" href="${safeHref(l.href)}" rel="noopener">${inner}</a>`
          : `<span class="wb-logo">${inner}</span>`;
      })
      .join('');
    return el(
      'section',
      node,
      wbInner(
        `${props.heading ? `<p class="wb-logo-head">${escapeHtml(props.heading)}</p>` : ''}<div class="wb-logo-row">${items}</div>`,
      ),
    );
  },
  baseCss: `.c-logoWall .wb-inner{max-width:1100px;margin:0 auto;padding:var(--space-lg) var(--space-md)}
.wb-logo-head{text-align:center;text-transform:uppercase;letter-spacing:.08em;font-size:.8rem;font-weight:600;color:var(--color-textMuted);margin:0 0 var(--space-md)}
.wb-logo-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:var(--space-lg) var(--space-2xl)}
.wb-logo{display:inline-flex;align-items:center;opacity:.65;transition:opacity .15s ease}
.wb-logo:hover{opacity:1}
.wb-logo img{max-height:38px;width:auto;display:block;filter:grayscale(1);transition:filter .15s ease}
.wb-logo:hover img{filter:grayscale(0)}
.wb-logo-text{font-family:var(--font-heading);font-size:1.35rem;font-weight:700;color:var(--color-text)}`,
};

// ── Pricing table ────────────────────────────────────────────────────────────
const pricingTableProps = z
  .object({
    heading: z.string().optional(),
    subhead: z.string().optional(),
    plans: z
      .array(
        z
          .object({
            name: z.string().min(1).describe('Plan name, e.g. "Starter"'),
            price: z.string().min(1).describe('Price text, e.g. "$29" or "Free"'),
            period: z.string().optional().describe('e.g. "/month"'),
            description: z.string().optional(),
            features: z.array(z.string().min(1)).min(1).describe('Bulleted feature list'),
            cta: z
              .object({ label: z.string().min(1), href: z.string().min(1) })
              .strict()
              .optional()
              .describe('Call-to-action button'),
            highlighted: z.boolean().default(false).describe('Visually emphasise this plan'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const pricingTable: ComponentDef<z.infer<typeof pricingTableProps>> = {
  type: 'pricingTable',
  title: 'Pricing table',
  description: 'Side-by-side pricing plans with feature lists and CTAs. Collapses to one column on mobile.',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: pricingTableProps,
  defaultProps: {
    plans: [
      { name: 'Basic', price: '$0', period: '/mo', features: ['One project', 'Community support'], highlighted: false },
      {
        name: 'Pro',
        price: '$29',
        period: '/mo',
        features: ['Unlimited projects', 'Priority support', 'Custom domain'],
        cta: { label: 'Choose Pro', href: '#' },
        highlighted: true,
      },
    ],
  },
  render: (node, props) => {
    const plans = props.plans
      .map((p) => {
        const features = p.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
        const cta = p.cta
          ? `<a class="wb-btn ${p.highlighted ? 'wb-btn-primary' : 'wb-btn-ghost'} wb-btn-md wb-plan-cta" href="${safeHref(
              p.cta.href,
            )}">${escapeHtml(p.cta.label)}</a>`
          : '';
        return `<div class="wb-plan${p.highlighted ? ' wb-plan-hl' : ''}">${
          p.highlighted ? '<div class="wb-plan-badge">Popular</div>' : ''
        }<h3 class="wb-plan-name">${escapeHtml(p.name)}</h3><div class="wb-plan-price">${escapeHtml(p.price)}${
          p.period ? `<span class="wb-plan-period">${escapeHtml(p.period)}</span>` : ''
        }</div>${p.description ? `<p class="wb-plan-desc">${escapeHtml(p.description)}</p>` : ''}<ul class="wb-plan-features">${features}</ul>${cta}</div>`;
      })
      .join('');
    const head =
      props.heading || props.subhead
        ? `<div class="wb-pricing-head">${props.heading ? `<h2>${escapeHtml(props.heading)}</h2>` : ''}${
            props.subhead ? `<p>${escapeHtml(props.subhead)}</p>` : ''
          }</div>`
        : '';
    return el('section', node, wbInner(`${head}<div class="wb-pricing-grid">${plans}</div>`));
  },
  baseCss: `.c-pricingTable .wb-inner{max-width:1100px;margin:0 auto;padding:var(--space-xl) var(--space-md)}
.wb-pricing-head{text-align:center;max-width:60ch;margin:0 auto var(--space-lg)}
.wb-pricing-head h2{font-family:var(--font-heading);font-size:clamp(1.6rem,3.5vw,2.3rem);margin:0 0 .5rem}
.wb-pricing-head p{color:var(--color-textMuted);font-size:1.1rem;margin:0}
.wb-pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--space-lg);align-items:start}
.wb-plan{position:relative;display:flex;flex-direction:column;gap:.75rem;background:var(--color-background);border:1px solid color-mix(in srgb, var(--color-text) 12%, transparent);border-radius:var(--radius-lg);padding:var(--space-lg)}
.wb-plan-hl{border-color:var(--color-primary);box-shadow:0 12px 32px -16px color-mix(in srgb, var(--color-primary) 60%, transparent)}
.wb-plan-badge{position:absolute;top:-.7rem;right:var(--space-lg);background:var(--color-primary);color:#fff;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.2rem .6rem;border-radius:999px}
.wb-plan-name{font-family:var(--font-heading);font-size:1.25rem;margin:0}
.wb-plan-price{font-family:var(--font-heading);font-size:2.4rem;line-height:1;font-variant-numeric:tabular-nums}
.wb-plan-period{font-size:1rem;color:var(--color-textMuted);font-family:var(--font-body)}
.wb-plan-desc{margin:0;color:var(--color-textMuted);font-size:.92rem;line-height:1.5}
.wb-plan-features{list-style:none;margin:.25rem 0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.wb-plan-features li{padding-left:1.5rem;position:relative;line-height:1.5}
.wb-plan-features li::before{content:'✓';position:absolute;left:0;color:var(--color-primary);font-weight:700}
.wb-plan-cta{margin-top:auto;text-align:center}`,
};

// ── Gallery (CSS-only lightbox) ──────────────────────────────────────────────
const galleryProps = z
  .object({
    heading: z.string().optional(),
    columns: z.number().int().min(2).max(4).default(3).describe('Columns on desktop (collapses on smaller screens)'),
    lightbox: z.boolean().default(true).describe('Click a thumbnail to view it full-size (CSS-only, no JavaScript)'),
    images: z.array(AssetRefSchema).min(1).describe('Images to display in the grid'),
  })
  .strict();

export const gallery: ComponentDef<z.infer<typeof galleryProps>> = {
  type: 'gallery',
  title: 'Gallery',
  description: 'A responsive image grid with an optional CSS-only lightbox (zero JavaScript).',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: galleryProps,
  defaultProps: { columns: 3, lightbox: true, images: [{ alt: 'Add an image' }] },
  render: (node, props, ctx) => {
    const tiles = props.images
      .map((img, i) => {
        const url = ctx.resolveAsset(img);
        const alt = escapeHtml(img.alt ?? '');
        const picture = `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy">`;
        if (!props.lightbox) return `<figure class="wb-gal-tile">${picture}</figure>`;
        const id = `wb-lb-${node.id}-${i}`;
        // CSS-only lightbox: the thumbnail links to a :target overlay; the overlay
        // (and its backdrop) links back to '#' to close. No JavaScript.
        return `<a class="wb-gal-tile" href="#${id}">${picture}</a><a class="wb-gal-lb" id="${id}" href="#" aria-label="Close image"><img src="${escapeHtml(
          url,
        )}" alt="${alt}"></a>`;
      })
      .join('');
    return el(
      'section',
      node,
      wbInner(`${props.heading ? `<h2 class="wb-gal-head">${escapeHtml(props.heading)}</h2>` : ''}<div class="wb-gal-grid">${tiles}</div>`),
    );
  },
  baseCss: `.c-gallery .wb-inner{max-width:1100px;margin:0 auto;padding:var(--space-xl) var(--space-md)}
.wb-gal-head{font-family:var(--font-heading);font-size:clamp(1.6rem,3.5vw,2.3rem);text-align:center;margin:0 0 var(--space-lg)}
.wb-gal-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-sm)}
.wb-gal-tile{display:block;margin:0;overflow:hidden;border-radius:var(--radius-md);aspect-ratio:1/1}
.wb-gal-tile img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s ease}
a.wb-gal-tile:hover img{transform:scale(1.04)}
.wb-gal-lb{position:fixed;inset:0;z-index:9998;display:none;align-items:center;justify-content:center;background:rgb(0 0 0 / .85);padding:var(--space-lg)}
.wb-gal-lb:target{display:flex}
.wb-gal-lb img{max-width:92vw;max-height:90vh;width:auto;height:auto;object-fit:contain;border-radius:var(--radius-sm)}
@media (max-width:1023px){.wb-gal-grid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:479px){.wb-gal-grid{grid-template-columns:1fr}}`,
  nodeCss: (_n, props, sel) =>
    props.columns && props.columns !== 3
      ? `@media (min-width:1024px){${sel} .wb-gal-grid{grid-template-columns:repeat(${props.columns},1fr)}}`
      : '',
};

// ── Accordion (native <details>, CSS-only) ───────────────────────────────────
const accordionProps = z
  .object({
    heading: z.string().optional().describe('Optional heading above the accordion'),
    exclusive: z
      .boolean()
      .default(false)
      .describe('Only one panel open at a time (native, no JavaScript). Otherwise panels open independently.'),
    items: z
      .array(
        z
          .object({
            title: z.string().min(1).describe('The clickable row label'),
            body: z.string().min(1).describe('Panel content (plain text)'),
            open: z.boolean().default(false).describe('Start expanded'),
          })
          .strict(),
      )
      .min(1)
      .describe('Collapsible rows'),
  })
  .strict();

export const accordion: ComponentDef<z.infer<typeof accordionProps>> = {
  type: 'accordion',
  title: 'Accordion',
  description: 'Collapsible content rows built on native <details> — zero JavaScript. Optionally single-open (exclusive).',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: accordionProps,
  defaultProps: {
    exclusive: false,
    items: [
      { title: 'What is included?', body: 'Everything you need to get started, with no hidden extras.', open: true },
      { title: 'Can I change later?', body: 'Yes — upgrade, downgrade, or cancel at any time.', open: false },
    ],
  },
  render: (node, props) => {
    // `name` on <details> makes a group mutually exclusive (native HTML, no JS).
    const groupName = props.exclusive ? ` name="wb-acc-${escapeHtml(node.id)}"` : '';
    const rows = props.items
      .map(
        (it) =>
          `<details class="wb-acc-item"${it.open ? ' open' : ''}${groupName}><summary class="wb-acc-summary">${escapeHtml(
            it.title,
          )}<span class="wb-acc-icon" aria-hidden="true"></span></summary><div class="wb-acc-body"><p>${escapeHtml(
            it.body,
          )}</p></div></details>`,
      )
      .join('');
    return el(
      'section',
      node,
      wbInner(
        `${props.heading ? `<h2 class="wb-acc-head">${escapeHtml(props.heading)}</h2>` : ''}<div class="wb-acc-list">${rows}</div>`,
      ),
    );
  },
  baseCss: `.c-accordion .wb-inner{max-width:820px;margin:0 auto;padding:var(--space-xl) var(--space-md)}
.wb-acc-head{font-family:var(--font-heading);font-size:clamp(1.6rem,3.5vw,2.3rem);text-align:center;margin:0 0 var(--space-lg)}
.wb-acc-list{display:flex;flex-direction:column;gap:.6rem}
.wb-acc-item{border:1px solid color-mix(in srgb, var(--color-text) 12%, transparent);border-radius:var(--radius-md);background:var(--color-background);overflow:hidden}
.wb-acc-summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:var(--space-md) var(--space-lg);font-family:var(--font-heading);font-size:1.05rem;font-weight:600}
.wb-acc-summary::-webkit-details-marker{display:none}
.wb-acc-icon{flex:none;width:.7rem;height:.7rem;border-right:2px solid var(--color-primary);border-bottom:2px solid var(--color-primary);transform:rotate(45deg);transition:transform .18s ease}
.wb-acc-item[open] .wb-acc-icon{transform:rotate(-135deg)}
.wb-acc-body{padding:0 var(--space-lg) var(--space-md)}
.wb-acc-body p{margin:0;color:var(--color-textMuted);line-height:1.6}`,
};

// ── Tabs (CSS-only radio-hack) ───────────────────────────────────────────────
const tabsProps = z
  .object({
    heading: z.string().optional().describe('Optional heading above the tabs'),
    tabs: z
      .array(
        z
          .object({
            label: z.string().min(1).describe('Tab label'),
            body: z.string().min(1).describe('Panel content (plain text)'),
          })
          .strict(),
      )
      .min(2)
      .max(6)
      .describe('Tabs, shown side by side'),
  })
  .strict();

export const tabs: ComponentDef<z.infer<typeof tabsProps>> = {
  type: 'tabs',
  title: 'Tabs',
  description: 'Tabbed panels with a CSS-only radio switch — zero JavaScript. The first tab is selected by default.',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: tabsProps,
  defaultProps: {
    tabs: [
      { label: 'Overview', body: 'A quick summary of what this does and why it matters.' },
      { label: 'Details', body: 'The specifics — how it works and what to expect.' },
    ],
  },
  render: (node, props) => {
    // Radio inputs (one group per node) drive which panel shows via :checked —
    // no JavaScript. Radios, the tab list, and the panels are siblings so the
    // per-node CSS can map "Nth radio checked" → "Nth label active / Nth panel".
    const name = `wb-tabs-${escapeHtml(node.id)}`;
    const radios = props.tabs
      .map((_t, i) => `<input class="wb-tab-radio" type="radio" name="${name}" id="${name}-${i}"${i === 0 ? ' checked' : ''}>`)
      .join('');
    const labels = props.tabs
      .map((t, i) => `<label class="wb-tab" for="${name}-${i}">${escapeHtml(t.label)}</label>`)
      .join('');
    const panels = props.tabs
      .map((t) => `<div class="wb-tabpanel"><p>${escapeHtml(t.body)}</p></div>`)
      .join('');
    return el(
      'section',
      node,
      wbInner(
        `${props.heading ? `<h2 class="wb-tabs-head">${escapeHtml(props.heading)}</h2>` : ''}<div class="wb-tabs">${radios}<div class="wb-tablist" role="tablist">${labels}</div><div class="wb-tabpanels">${panels}</div></div>`,
      ),
    );
  },
  baseCss: `.c-tabs .wb-inner{max-width:900px;margin:0 auto;padding:var(--space-xl) var(--space-md)}
.wb-tabs-head{font-family:var(--font-heading);font-size:clamp(1.6rem,3.5vw,2.3rem);text-align:center;margin:0 0 var(--space-lg)}
.wb-tabs{position:relative}
.wb-tab-radio{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.wb-tablist{display:flex;flex-wrap:wrap;gap:.25rem;border-bottom:2px solid color-mix(in srgb, var(--color-text) 12%, transparent);margin-bottom:var(--space-lg)}
.wb-tab{cursor:pointer;padding:.6rem 1rem;font-family:var(--font-heading);font-weight:600;color:var(--color-textMuted);border-bottom:2px solid transparent;margin-bottom:-2px;transition:color .15s ease,border-color .15s ease}
.wb-tab:hover{color:var(--color-text)}
.wb-tab-radio:focus-visible + .wb-tablist .wb-tab{outline:2px solid var(--color-primary);outline-offset:2px}
.wb-tabpanel{display:none;line-height:1.6}
.wb-tabpanel p{margin:0;color:var(--color-textMuted)}`,
  // Map the Nth checked radio to the Nth label's active state and Nth panel.
  nodeCss: (node, props, sel) => {
    const name = `wb-tabs-${node.id}`;
    return props.tabs
      .map(
        (_t, i) =>
          `${sel} #${name}-${i}:checked ~ .wb-tablist .wb-tab:nth-of-type(${i + 1}){color:var(--color-primary);border-bottom-color:var(--color-primary)}` +
          `${sel} #${name}-${i}:checked ~ .wb-tabpanels .wb-tabpanel:nth-of-type(${i + 1}){display:block}`,
      )
      .join('\n');
  },
};

export const widgetDefs = [statRow, logoWall, pricingTable, gallery, accordion, tabs];
