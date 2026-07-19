import { AssetRefSchema } from '@wb/schema';
import { z } from 'zod';
import { cssUrl, escapeHtml, safeHref } from '../html.js';
import type { ComponentDef } from '../registry.js';
import { CtaSchema, el, renderChildren, wbInner } from './shared.js';

const heroProps = z
  .object({
    headline: z.string().min(1).describe('Big headline (renders as the page h1)'),
    subhead: z.string().optional().describe('Supporting sentence under the headline'),
    primaryCta: CtaSchema.optional(),
    secondaryCta: CtaSchema.optional(),
    image: AssetRefSchema.optional().describe('Hero image'),
    imagePosition: z
      .enum(['right', 'left', 'background', 'none'])
      .default('right')
      .describe('Image beside the text, behind it, or absent'),
  })
  .strict();

export const hero: ComponentDef<z.infer<typeof heroProps>> = {
  type: 'hero',
  title: 'Hero',
  description: 'Large opening banner: headline, subhead, CTA buttons, and an optional image. Stacks on mobile.',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: heroProps,
  defaultProps: { headline: 'Welcome', imagePosition: 'right' },
  render: (node, props, ctx) => {
    const ctas =
      props.primaryCta || props.secondaryCta
        ? `<div class="wb-hero-ctas">${[
            props.primaryCta &&
              `<a class="wb-btn wb-btn-primary wb-btn-lg" href="${safeHref(props.primaryCta.href)}">${escapeHtml(props.primaryCta.label)}</a>`,
            props.secondaryCta &&
              `<a class="wb-btn wb-btn-ghost wb-btn-lg" href="${safeHref(props.secondaryCta.href)}">${escapeHtml(props.secondaryCta.label)}</a>`,
          ]
            .filter(Boolean)
            .join('')}</div>`
        : '';
    const copy = `<div class="wb-hero-copy"><h1>${escapeHtml(props.headline)}</h1>${
      props.subhead ? `<p class="wb-hero-subhead">${escapeHtml(props.subhead)}</p>` : ''
    }${ctas}</div>`;
    const imgUrl = props.image ? ctx.resolveAsset(props.image) : '';
    const media =
      imgUrl && (props.imagePosition === 'right' || props.imagePosition === 'left')
        ? `<div class="wb-hero-media"><img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(props.image?.alt ?? '')}"></div>`
        : '';
    const bgUrl = cssUrl(imgUrl);
    const isBg = Boolean(bgUrl) && props.imagePosition === 'background';
    const cls = `wb-hero-${props.imagePosition}${isBg ? ' wb-hero-hasbg' : ''}`;
    return el('section', node, wbInner(`${copy}${media}`), {
      class: cls,
      attrs: isBg
        ? { style: `background-image:linear-gradient(rgb(0 0 0/.5),rgb(0 0 0/.5)),url('${bgUrl}')` }
        : {},
    });
  },
  baseCss: `.c-hero .wb-inner{display:flex;align-items:center;gap:var(--space-2xl);max-width:1200px;margin:0 auto;padding:var(--space-2xl) var(--space-md)}
.c-hero.wb-hero-left .wb-inner{flex-direction:row-reverse}
.wb-hero-copy{flex:1 1 0;display:flex;flex-direction:column;gap:var(--space-md)}
.wb-hero-copy h1{font-family:var(--font-heading);font-size:clamp(2.1rem,5vw,3.4rem);line-height:1.1;margin:0}
.wb-hero-subhead{font-size:1.25rem;line-height:1.6;color:var(--color-textMuted);margin:0;max-width:48ch}
.wb-hero-ctas{display:flex;gap:var(--space-sm);flex-wrap:wrap}
.wb-hero-media{flex:1 1 0;min-width:0}
.wb-hero-media img{width:100%;height:auto;display:block;border-radius:var(--radius-lg)}
.c-hero.wb-hero-background{position:relative}
@media (max-width:639px){.c-hero .wb-inner{flex-direction:column;gap:var(--space-lg)}.c-hero.wb-hero-left .wb-inner{flex-direction:column}}`,
  nodeCss: (_n, props, sel) => {
    if (props.imagePosition !== 'background' || !props.image) return '';
    return `${sel}.wb-hero-hasbg{background-size:cover;background-position:center}\n${sel} .wb-hero-copy{color:#fff}\n${sel} .wb-hero-subhead{color:rgb(255 255 255 / .85)}`;
  },
};

const featureGridProps = z
  .object({
    heading: z.string().optional().describe('Section heading above the grid'),
    subhead: z.string().optional(),
  })
  .strict();

export const featureGrid: ComponentDef<z.infer<typeof featureGridProps>> = {
  type: 'featureGrid',
  title: 'Feature grid',
  description:
    'Heading + a responsive grid of cards. Add card children. Defaults to 3 columns, collapsing to 2 (tablet) and 1 (mobile).',
  category: 'composite',
  isContainer: true,
  allowedChildren: ['card', 'testimonial', 'stack', 'image'],
  layoutTarget: 'inner',
  propsSchema: featureGridProps,
  defaultProps: {},
  render: (node, props, ctx) => {
    const head =
      props.heading || props.subhead
        ? `<div class="wb-fg-head">${props.heading ? `<h2>${escapeHtml(props.heading)}</h2>` : ''}${
            props.subhead ? `<p>${escapeHtml(props.subhead)}</p>` : ''
          }</div>`
        : '';
    return el('section', node, wbInner(`${head}<div class="wb-fg-grid">${renderChildren(node, ctx)}</div>`));
  },
  baseCss: `.c-featureGrid .wb-inner{max-width:1200px;margin:0 auto;padding:var(--space-xl) var(--space-md)}
.wb-fg-head{text-align:center;max-width:60ch;margin:0 auto var(--space-lg)}
.wb-fg-head h2{font-family:var(--font-heading);font-size:clamp(1.6rem,3.5vw,2.3rem);margin:0 0 .5rem}
.wb-fg-head p{color:var(--color-textMuted);font-size:1.1rem;line-height:1.6;margin:0}
.wb-fg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-lg)}
@media (max-width:1023px){.wb-fg-grid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:639px){.wb-fg-grid{grid-template-columns:1fr}}`,
};

const cardProps = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    href: z.string().optional().describe('Makes the whole card a link'),
    linkLabel: z.string().optional().describe('Text for the link at the card bottom'),
    image: AssetRefSchema.optional().describe('Image at the top of the card'),
    icon: z.string().optional().describe('Emoji or short glyph shown above the title'),
  })
  .strict();

export const card: ComponentDef<z.infer<typeof cardProps>> = {
  type: 'card',
  title: 'Card',
  description: 'A card with optional image/icon, title, body, and link. Use inside featureGrid or grid.',
  category: 'composite',
  isContainer: false,
  propsSchema: cardProps,
  defaultProps: { title: 'Card title' },
  render: (node, props, ctx) => {
    const imgUrl = props.image ? ctx.resolveAsset(props.image) : '';
    const img = imgUrl
      ? `<img class="wb-card-img" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(props.image?.alt ?? '')}" loading="lazy">`
      : '';
    const icon = props.icon ? `<div class="wb-card-icon" aria-hidden="true">${escapeHtml(props.icon)}</div>` : '';
    const link =
      props.href && props.linkLabel
        ? `<span class="wb-card-link">${escapeHtml(props.linkLabel)} →</span>`
        : '';
    const inner = `${img}<div class="wb-card-body">${icon}<h3>${escapeHtml(props.title)}</h3>${
      props.body ? `<p>${escapeHtml(props.body)}</p>` : ''
    }${link}</div>`;
    return props.href
      ? el('a', node, inner, { attrs: { href: safeHref(props.href) } })
      : el('div', node, inner);
  },
  baseCss: `.c-card{display:flex;flex-direction:column;background:var(--color-background);border:1px solid color-mix(in srgb, var(--color-text) 10%, transparent);border-radius:var(--radius-lg);overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgb(0 0 0 / .05)}
a.c-card{transition:box-shadow .15s ease,transform .15s ease}
a.c-card:hover{box-shadow:0 8px 24px rgb(0 0 0 / .1);transform:translateY(-2px)}
.wb-card-img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
.wb-card-body{padding:var(--space-md);display:flex;flex-direction:column;gap:.5rem;flex:1}
.wb-card-icon{font-size:1.8rem;line-height:1}
.wb-card-body h3{font-family:var(--font-heading);font-size:1.2rem;margin:0}
.wb-card-body p{margin:0;color:var(--color-textMuted);line-height:1.6;flex:1}
.wb-card-link{color:var(--color-primary);font-weight:600;font-size:.95rem}`,
};

const testimonialProps = z
  .object({
    quote: z.string().min(1),
    name: z.string().min(1),
    role: z.string().optional().describe('e.g. "Patient since 2024"'),
    photo: AssetRefSchema.optional(),
  })
  .strict();

export const testimonial: ComponentDef<z.infer<typeof testimonialProps>> = {
  type: 'testimonial',
  title: 'Testimonial',
  description: 'A quote with attribution (name, role, optional photo).',
  category: 'composite',
  isContainer: false,
  propsSchema: testimonialProps,
  defaultProps: { quote: 'Wonderful!', name: 'A. Customer' },
  render: (node, props, ctx) => {
    const photoUrl = props.photo ? ctx.resolveAsset(props.photo) : '';
    const photo = photoUrl
      ? `<img class="wb-tst-photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(props.photo?.alt ?? props.name)}" loading="lazy">`
      : '';
    return el(
      'figure',
      node,
      `<blockquote>“${escapeHtml(props.quote)}”</blockquote>
<figcaption>${photo}<div><strong>${escapeHtml(props.name)}</strong>${
        props.role ? `<span>${escapeHtml(props.role)}</span>` : ''
      }</div></figcaption>`,
    );
  },
  baseCss: `.c-testimonial{margin:0;background:var(--color-surface);border-radius:var(--radius-lg);padding:var(--space-lg);display:flex;flex-direction:column;gap:var(--space-md)}
.c-testimonial blockquote{margin:0;font-size:1.05rem;line-height:1.65;font-style:italic}
.c-testimonial figcaption{display:flex;align-items:center;gap:.75rem}
.wb-tst-photo{width:44px;height:44px;border-radius:9999px;object-fit:cover}
.c-testimonial figcaption div{display:flex;flex-direction:column}
.c-testimonial figcaption span{color:var(--color-textMuted);font-size:.85rem}`,
};

const faqProps = z
  .object({
    heading: z.string().optional(),
    items: z
      .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }).strict())
      .min(1)
      .describe('Question/answer pairs'),
  })
  .strict();

export const faq: ComponentDef<z.infer<typeof faqProps>> = {
  type: 'faq',
  title: 'FAQ',
  description: 'Accordion of questions and answers (native <details>, zero JavaScript).',
  category: 'composite',
  isContainer: false,
  layoutTarget: 'inner',
  propsSchema: faqProps,
  defaultProps: { items: [{ question: 'Question?', answer: 'Answer.' }] },
  render: (node, props) => {
    const items = props.items
      .map(
        (i) =>
          `<details class="wb-faq-item"><summary>${escapeHtml(i.question)}</summary><div class="wb-faq-a"><p>${escapeHtml(i.answer)}</p></div></details>`,
      )
      .join('');
    return el(
      'section',
      node,
      wbInner(`${props.heading ? `<h2>${escapeHtml(props.heading)}</h2>` : ''}${items}`),
    );
  },
  baseCss: `.c-faq .wb-inner{max-width:760px;margin:0 auto;padding:var(--space-xl) var(--space-md)}
.c-faq h2{font-family:var(--font-heading);font-size:clamp(1.6rem,3.5vw,2.3rem);text-align:center;margin:0 0 var(--space-lg)}
.wb-faq-item{border-bottom:1px solid color-mix(in srgb, var(--color-text) 12%, transparent)}
.wb-faq-item summary{cursor:pointer;padding:1rem 2rem 1rem 0;font-weight:600;list-style:none;position:relative}
.wb-faq-item summary::-webkit-details-marker{display:none}
.wb-faq-item summary::after{content:'+';position:absolute;right:.25rem;top:50%;transform:translateY(-50%);font-size:1.4rem;color:var(--color-primary)}
.wb-faq-item[open] summary::after{content:'−'}
.wb-faq-a p{margin:0 0 1rem;line-height:1.65;color:var(--color-textMuted)}`,
};

const fieldSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][\w-]*$/).describe('Form field name attribute'),
    label: z.string().min(1),
    type: z.enum(['text', 'email', 'tel', 'textarea', 'select']).default('text'),
    required: z.boolean().default(false),
    options: z.array(z.string()).optional().describe('Options for select fields'),
    placeholder: z.string().optional(),
  })
  .strict();

const contactFormProps = z
  .object({
    heading: z.string().optional(),
    fields: z.array(fieldSchema).min(1),
    submitLabel: z.string().default('Send message'),
    action: z
      .string()
      .optional()
      .describe('Form POST endpoint (e.g. Formspree URL). Static sites need an external handler.'),
    netlifyForms: z.boolean().default(false).describe('Add the data-netlify attribute for Netlify Forms'),
  })
  .strict();

export const contactForm: ComponentDef<z.infer<typeof contactFormProps>> = {
  type: 'contactForm',
  title: 'Contact form',
  description:
    'A contact form. On static hosting, point `action` at a form service (Formspree etc.) or enable netlifyForms.',
  category: 'composite',
  isContainer: false,
  propsSchema: contactFormProps,
  defaultProps: {
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'message', label: 'Message', type: 'textarea', required: true },
    ],
    submitLabel: 'Send message',
    netlifyForms: false,
  },
  render: (node, props) => {
    const fields = props.fields
      .map((f) => {
        const id = `f-${node.id}-${f.name}`;
        const req = f.required ? ' required' : '';
        const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
        let control: string;
        if (f.type === 'textarea') {
          control = `<textarea id="${id}" name="${escapeHtml(f.name)}" rows="5"${req}${ph}></textarea>`;
        } else if (f.type === 'select') {
          const opts = (f.options ?? [])
            .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
            .join('');
          control = `<select id="${id}" name="${escapeHtml(f.name)}"${req}><option value="" disabled selected>Choose…</option>${opts}</select>`;
        } else {
          control = `<input id="${id}" type="${f.type}" name="${escapeHtml(f.name)}"${req}${ph}>`;
        }
        return `<div class="wb-field"><label for="${id}">${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>${control}</div>`;
      })
      .join('');
    const formAttrs = `method="POST"${props.action ? ` action="${safeHref(props.action)}"` : ''}${
      props.netlifyForms ? ` data-netlify="true" name="contact"` : ''
    }`;
    return el(
      'div',
      node,
      `${props.heading ? `<h2>${escapeHtml(props.heading)}</h2>` : ''}<form ${formAttrs}>${fields}<button type="submit" class="wb-btn wb-btn-primary wb-btn-md">${escapeHtml(props.submitLabel)}</button></form>`,
    );
  },
  baseCss: `.c-contactForm h2{font-family:var(--font-heading);margin:0 0 var(--space-md)}
.c-contactForm form{display:flex;flex-direction:column;gap:var(--space-md)}
.wb-field{display:flex;flex-direction:column;gap:.35rem}
.wb-field label{font-weight:600;font-size:.95rem}
.wb-field input,.wb-field textarea,.wb-field select{font:inherit;padding:.6rem .75rem;border:1px solid color-mix(in srgb, var(--color-text) 25%, transparent);border-radius:var(--radius-sm);background:var(--color-background);color:var(--color-text)}
.wb-field input:focus,.wb-field textarea:focus,.wb-field select:focus{outline:2px solid var(--color-primary);outline-offset:1px;border-color:var(--color-primary)}
.c-contactForm button{align-self:flex-start;cursor:pointer;border:none}`,
};

const mapEmbedProps = z
  .object({
    address: z.string().min(1).describe('Street address shown as text and used for the map link'),
    embedUrl: z.string().optional().describe('Full map embed iframe URL (Google Maps embed etc.)'),
    heading: z.string().optional(),
  })
  .strict();

export const mapEmbed: ComponentDef<z.infer<typeof mapEmbedProps>> = {
  type: 'mapEmbed',
  title: 'Map',
  description: 'An embedded map (lazy iframe) with the address as accessible text and a directions link.',
  category: 'composite',
  isContainer: false,
  propsSchema: mapEmbedProps,
  defaultProps: { address: '123 Main St' },
  render: (node, props) => {
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(props.address)}`;
    const frame = props.embedUrl
      ? `<iframe src="${safeHref(props.embedUrl)}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" title="Map: ${escapeHtml(props.address)}"></iframe>`
      : '';
    return el(
      'div',
      node,
      `${props.heading ? `<h3>${escapeHtml(props.heading)}</h3>` : ''}${frame}<p class="wb-map-addr">${escapeHtml(props.address)} · <a href="${escapeHtml(mapsLink)}" rel="noopener">Get directions</a></p>`,
    );
  },
  baseCss: `.c-mapEmbed iframe{width:100%;aspect-ratio:16/10;border:0;border-radius:var(--radius-md)}
.c-mapEmbed h3{font-family:var(--font-heading);margin:0 0 .75rem}
.wb-map-addr{margin:.6rem 0 0;color:var(--color-textMuted)}
.wb-map-addr a{color:var(--color-primary)}`,
};

const videoEmbedProps = z
  .object({
    url: z.string().min(1).describe('YouTube or Vimeo video URL'),
    title: z.string().min(1).describe('Accessible title for the video'),
  })
  .strict();

function videoEmbedUrl(url: string): string | null {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1`;
  return null;
}

export const videoEmbed: ComponentDef<z.infer<typeof videoEmbedProps>> = {
  type: 'videoEmbed',
  title: 'Video',
  description:
    'YouTube/Vimeo video as a click-to-load facade — no third-party requests until the visitor presses play.',
  category: 'composite',
  isContainer: false,
  propsSchema: videoEmbedProps,
  defaultProps: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Video' },
  render: (node, props) => {
    const embed = videoEmbedUrl(props.url);
    if (!embed) return el('div', node, `<p>Unsupported video URL</p>`);
    return el(
      'div',
      node,
      `<button class="wb-video-facade" data-embed="${escapeHtml(embed)}" aria-label="Play video: ${escapeHtml(props.title)}"><span class="wb-video-play">▶</span><span class="wb-video-title">${escapeHtml(props.title)}</span></button>`,
    );
  },
  baseCss: `.c-videoEmbed{position:relative}
.wb-video-facade{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;width:100%;aspect-ratio:16/9;background:var(--color-secondary);color:#fff;border:0;border-radius:var(--radius-md);cursor:pointer}
.wb-video-play{width:64px;height:64px;border-radius:9999px;background:var(--color-primary);display:flex;align-items:center;justify-content:center;font-size:1.5rem;padding-left:5px}
.wb-video-facade:hover .wb-video-play{filter:brightness(1.1)}
.c-videoEmbed iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:var(--radius-md)}`,
};

const htmlEmbedProps = z
  .object({
    html: z
      .string()
      .min(1)
      .describe('Raw HTML injected verbatim — UNSAFE escape hatch; you are responsible for its content'),
  })
  .strict();

export const htmlEmbed: ComponentDef<z.infer<typeof htmlEmbedProps>> = {
  type: 'htmlEmbed',
  title: 'HTML embed',
  description: 'Raw HTML escape hatch (scripts/widgets). Content is injected verbatim — use sparingly.',
  category: 'composite',
  isContainer: false,
  propsSchema: htmlEmbedProps,
  defaultProps: { html: '<!-- custom html -->' },
  render: (node, props) => el('div', node, props.html),
};

export const compositeDefs = [
  hero,
  featureGrid,
  card,
  testimonial,
  faq,
  contactForm,
  mapEmbed,
  videoEmbed,
  htmlEmbed,
];
