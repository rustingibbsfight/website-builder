import { z } from 'zod';
import type { ComponentDef } from '../registry.js';
import { el, renderChildren, wbInner } from './shared.js';

export const pageRoot: ComponentDef = {
  type: 'page-root',
  title: 'Page root',
  description: 'The root container of every page. Holds top-level sections.',
  category: 'layout',
  isContainer: true,
  propsSchema: z.object({}).strict(),
  defaultProps: {},
  render: (node, _props, ctx) => el('main', node, renderChildren(node, ctx)),
};

const sectionProps = z
  .object({
    anchorId: z
      .string()
      .regex(/^[a-zA-Z][\w-]*$/)
      .optional()
      .describe('HTML id for #anchor links'),
  })
  .strict();

export const section: ComponentDef<z.infer<typeof sectionProps>> = {
  type: 'section',
  title: 'Section',
  description:
    'Full-width page band with a centered inner container. The building block of every page; set background on the section and layout (stack/row/grid) for its content.',
  category: 'layout',
  isContainer: true,
  layoutTarget: 'inner',
  propsSchema: sectionProps,
  defaultProps: {},
  render: (node, props, ctx) =>
    el('section', node, wbInner(renderChildren(node, ctx)), {
      attrs: props.anchorId ? { id: props.anchorId } : {},
    }),
};

export const stack: ComponentDef = {
  type: 'stack',
  title: 'Stack',
  description: 'Generic auto-layout box. Use layout.direction to stack children vertically, in a row, or in a grid.',
  category: 'layout',
  isContainer: true,
  propsSchema: z.object({}).strict(),
  defaultProps: {},
  render: (node, _props, ctx) => el('div', node, renderChildren(node, ctx)),
};

const columnsProps = z
  .object({
    ratios: z
      .array(z.number().positive())
      .min(2)
      .max(4)
      .optional()
      .describe('Relative column widths, e.g. [2,1] for a 2:1 split (defaults to equal)'),
  })
  .strict();

export const columns: ComponentDef<z.infer<typeof columnsProps>> = {
  type: 'columns',
  title: 'Columns',
  description: 'Side-by-side columns with optional width ratios. Each child is one column. Stacks on mobile automatically.',
  category: 'layout',
  isContainer: true,
  propsSchema: columnsProps,
  defaultProps: {},
  render: (node, _props, ctx) => el('div', node, renderChildren(node, ctx)),
  baseCss: `.c-columns{display:flex;gap:var(--space-lg)}
.c-columns>*{flex:1 1 0;min-width:0}
@media (max-width:639px){.c-columns{flex-direction:column}}`,
  nodeCss: (_node, props, sel) =>
    props.ratios
      ? props.ratios.map((r, i) => `${sel}>:nth-child(${i + 1}){flex-grow:${r}}`).join('\n')
      : '',
};

export const grid: ComponentDef = {
  type: 'grid',
  title: 'Grid',
  description:
    'Equal-cell grid container. Set layout.columns (1–6); collapses to 2 columns on tablet and 1 on mobile unless overridden in responsive.',
  category: 'layout',
  isContainer: true,
  propsSchema: z.object({}).strict(),
  defaultProps: {},
  render: (node, _props, ctx) => el('div', node, renderChildren(node, ctx)),
};

export const layoutDefs = [pageRoot, section, stack, columns, grid];
