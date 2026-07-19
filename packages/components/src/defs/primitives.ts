import { AssetRefSchema, SpacingTokenSchema } from '@wb/schema';
import { z } from 'zod';
import { escapeHtml, safeHref } from '../html.js';
import { renderMarkdown } from '../markdown.js';
import type { ComponentDef } from '../registry.js';
import { el } from './shared.js';

const headingProps = z
  .object({
    text: z.string().min(1).describe('Heading text'),
    level: z.number().int().min(1).max(4).default(2).describe('Semantic level: 1 = page title (one per page)'),
    size: z.enum(['sm', 'md', 'lg', 'xl']).optional().describe('Visual size (defaults by level)'),
    align: z.enum(['left', 'center', 'right']).optional(),
  })
  .strict();

export const heading: ComponentDef<z.infer<typeof headingProps>> = {
  type: 'heading',
  title: 'Heading',
  description: 'A heading (h1–h4).',
  category: 'primitive',
  isContainer: false,
  propsSchema: headingProps,
  defaultProps: { text: 'Heading', level: 2 },
  render: (node, props) => el(`h${props.level}`, node, escapeHtml(props.text)),
  baseCss: `.c-heading{font-family:var(--font-heading);line-height:1.15;margin:0;color:inherit}
h1.c-heading{font-size:clamp(2rem,5vw,3.2rem)}
h2.c-heading{font-size:clamp(1.6rem,3.5vw,2.3rem)}
h3.c-heading{font-size:clamp(1.25rem,2.5vw,1.6rem)}
h4.c-heading{font-size:1.15rem}`,
  nodeCss: (_n, props, sel) => {
    const rules: string[] = [];
    if (props.align) rules.push(`text-align:${props.align}`);
    const sizes = { sm: '1.15rem', md: '1.6rem', lg: '2.3rem', xl: 'clamp(2rem,5vw,3.2rem)' } as const;
    if (props.size) rules.push(`font-size:${sizes[props.size]}`);
    return rules.length ? `${sel}{${rules.join(';')}}` : '';
  },
};

const textProps = z
  .object({
    text: z.string().min(1).describe('Paragraph text'),
    size: z.enum(['sm', 'md', 'lg']).default('md').describe('lg = lead/intro paragraph'),
    align: z.enum(['left', 'center', 'right']).optional(),
  })
  .strict();

export const text: ComponentDef<z.infer<typeof textProps>> = {
  type: 'text',
  title: 'Text',
  description: 'A paragraph of plain text.',
  category: 'primitive',
  isContainer: false,
  propsSchema: textProps,
  defaultProps: { text: 'Lorem ipsum dolor sit amet.', size: 'md' },
  render: (node, props) => el('p', node, escapeHtml(props.text)),
  baseCss: `.c-text{margin:0;line-height:1.65}`,
  nodeCss: (_n, props, sel) => {
    const rules: string[] = [];
    if (props.align) rules.push(`text-align:${props.align}`);
    if (props.size === 'sm') rules.push('font-size:.9rem');
    if (props.size === 'lg') rules.push('font-size:1.2rem');
    return rules.length ? `${sel}{${rules.join(';')}}` : '';
  },
};

const richTextProps = z
  .object({
    markdown: z
      .string()
      .min(1)
      .describe('Constrained markdown: #–#### headings, lists, **bold**, *italic*, [links](href), `code`'),
  })
  .strict();

export const richText: ComponentDef<z.infer<typeof richTextProps>> = {
  type: 'richText',
  title: 'Rich text',
  description: 'Multi-paragraph formatted text written in constrained markdown (sanitized).',
  category: 'primitive',
  isContainer: false,
  propsSchema: richTextProps,
  defaultProps: { markdown: 'Write **markdown** here.' },
  render: (node, props) => el('div', node, renderMarkdown(props.markdown)),
  baseCss: `.c-richText{line-height:1.65}
.c-richText>*+*{margin-top:.8em}
.c-richText h1,.c-richText h2,.c-richText h3,.c-richText h4{font-family:var(--font-heading);line-height:1.2}
.c-richText a{color:var(--color-primary)}
.c-richText ul,.c-richText ol{padding-left:1.4em}`,
};

const imageProps = z
  .object({
    image: AssetRefSchema.describe('The image to show (assetId or url + alt)'),
    aspect: z.enum(['auto', 'square', 'video', 'wide']).default('auto').describe('Aspect ratio crop'),
    fit: z.enum(['cover', 'contain']).default('cover'),
    rounded: z.boolean().default(false),
    caption: z.string().optional(),
  })
  .strict();

export const image: ComponentDef<z.infer<typeof imageProps>> = {
  type: 'image',
  title: 'Image',
  description: 'An image from the site assets or an external URL. Alt text is required for accessibility.',
  category: 'primitive',
  isContainer: false,
  propsSchema: imageProps,
  defaultProps: { image: { alt: '' }, aspect: 'auto', fit: 'cover', rounded: false },
  render: (node, props, ctx) => {
    const src = ctx.resolveAsset(props.image);
    const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(props.image.alt ?? '')}" loading="lazy">`;
    const inner = props.caption ? `${img}<figcaption>${escapeHtml(props.caption)}</figcaption>` : img;
    return el('figure', node, inner);
  },
  baseCss: `.c-image{margin:0}
.c-image img{display:block;width:100%;height:auto}
.c-image figcaption{font-size:.85rem;color:var(--color-textMuted);margin-top:.5rem}`,
  nodeCss: (_n, props, sel) => {
    const rules: string[] = [];
    const aspects = { square: '1/1', video: '16/9', wide: '21/9' } as const;
    if (props.aspect !== 'auto') rules.push(`aspect-ratio:${aspects[props.aspect]}`);
    rules.push(`object-fit:${props.fit}`);
    if (props.aspect !== 'auto') rules.push('height:100%');
    const imgRules = `${sel} img{${rules.join(';')}}`;
    return props.rounded ? `${imgRules}\n${sel} img{border-radius:var(--radius-md)}` : imgRules;
  },
};

const buttonProps = z
  .object({
    label: z.string().min(1),
    href: z.string().min(1).describe('Destination URL or path'),
    variant: z.enum(['primary', 'secondary', 'ghost']).default('primary'),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
  })
  .strict();

export const button: ComponentDef<z.infer<typeof buttonProps>> = {
  type: 'button',
  title: 'Button',
  description: 'A call-to-action link styled as a button.',
  category: 'primitive',
  isContainer: false,
  propsSchema: buttonProps,
  defaultProps: { label: 'Learn more', href: '#', variant: 'primary', size: 'md' },
  render: (node, props) =>
    el('a', node, escapeHtml(props.label), {
      class: `wb-btn wb-btn-${props.variant} wb-btn-${props.size}`,
      attrs: { href: safeHref(props.href) },
    }),
  baseCss: `.wb-btn{display:inline-block;font-family:var(--font-body);font-weight:600;text-decoration:none;border-radius:var(--radius-md);transition:filter .15s ease;border:2px solid transparent;text-align:center}
.wb-btn:hover{filter:brightness(1.08)}
.wb-btn-primary{background:var(--color-primary);color:#fff}
.wb-btn-secondary{background:var(--color-secondary);color:#fff}
.wb-btn-ghost{background:transparent;color:var(--color-primary);border-color:var(--color-primary)}
.wb-btn-sm{padding:.4rem .9rem;font-size:.9rem}
.wb-btn-md{padding:.65rem 1.4rem;font-size:1rem}
.wb-btn-lg{padding:.85rem 1.9rem;font-size:1.1rem}`,
};

const spacerProps = z.object({ size: SpacingTokenSchema.default('lg') }).strict();

export const spacer: ComponentDef<z.infer<typeof spacerProps>> = {
  type: 'spacer',
  title: 'Spacer',
  description: 'Vertical empty space.',
  category: 'primitive',
  isContainer: false,
  propsSchema: spacerProps,
  defaultProps: { size: 'lg' },
  render: (node) => el('div', node, '', { attrs: { 'aria-hidden': 'true' } }),
  nodeCss: (_n, props, sel) => `${sel}{height:var(--space-${props.size})}`,
};

export const divider: ComponentDef = {
  type: 'divider',
  title: 'Divider',
  description: 'A horizontal rule.',
  category: 'primitive',
  isContainer: false,
  propsSchema: z.object({}).strict(),
  defaultProps: {},
  render: (node) => `<hr class="c-divider n-${node.id}" data-node-id="${node.id}">`,
  baseCss: `.c-divider{border:0;border-top:1px solid color-mix(in srgb, var(--color-text) 15%, transparent);margin:0;width:100%}`,
};

export const primitiveDefs = [heading, text, richText, image, button, spacer, divider];
