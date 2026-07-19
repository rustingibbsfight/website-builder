import type { WbNode } from '@wb/schema';
import { z } from 'zod';
import { attrs } from '../html.js';
import type { RenderCtx } from '../registry.js';

/** Standard element wrapper: class hooks + data-node-id for the future editor. */
export function el(
  tag: string,
  node: WbNode,
  inner: string,
  extra: { class?: string; attrs?: Record<string, string | number | boolean | undefined> } = {},
): string {
  const cls = `c-${node.type} n-${node.id}${extra.class ? ` ${extra.class}` : ''}`;
  return `<${tag} class="${cls}" data-node-id="${node.id}"${attrs(extra.attrs ?? {})}>${inner}</${tag}>`;
}

export function wbInner(content: string): string {
  return `<div class="wb-inner">${content}</div>`;
}

export function renderChildren(node: WbNode, ctx: RenderCtx): string {
  return (node.children ?? []).map((c) => ctx.renderNode(c)).join('\n');
}

export const LinkSchema = z
  .object({
    label: z.string().min(1).describe('Link text'),
    href: z.string().min(1).describe('URL or path, e.g. /contact or https://…'),
  })
  .strict();
export type Link = z.infer<typeof LinkSchema>;

export const CtaSchema = LinkSchema.describe('Call-to-action button');
