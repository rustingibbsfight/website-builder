import { z } from 'zod';
import { NodeSchema, type WbNode } from './node.js';
import { ThemeSchema } from './theme.js';

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PageMetaSchema = z
  .object({
    title: z.string().optional().describe('SEO <title> override; defaults to the page title + brand'),
    description: z.string().optional().describe('Meta description for SEO'),
    ogTitle: z.string().optional().describe('Open Graph / social title override; defaults to the SEO title'),
    ogDescription: z
      .string()
      .optional()
      .describe('Open Graph / social description override; defaults to the meta description'),
    ogImage: z.string().optional().describe('Open Graph image URL or asset id'),
    twitterCard: z
      .enum(['summary', 'summary_large_image'])
      .optional()
      .describe('Twitter card type; defaults to summary_large_image when an ogImage is set'),
    noIndex: z.boolean().optional().describe('Exclude from search engines and sitemap'),
  })
  .strict();
export type PageMeta = z.infer<typeof PageMetaSchema>;

export const PageSchema = z
  .object({
    id: z.string(),
    siteId: z.string(),
    slug: z
      .string()
      .regex(SLUG_RE)
      .or(z.literal(''))
      .describe("URL slug; '' or 'index' is the home page"),
    title: z.string().min(1),
    meta: PageMetaSchema.default({}),
    tree: NodeSchema.describe('Component tree rooted at a page-root node'),
    sortOrder: z.number().int().default(0),
    /** Optimistic-lock counter; DB-managed, bumped on every persisted edit. */
    version: z.number().int().optional(),
  })
  .strict();
export type Page = z.infer<typeof PageSchema>;

export const SiteSettingsSchema = z
  .object({
    locale: z.string().default('en'),
    favicon: z.string().optional().describe('Asset id or URL'),
    baseUrl: z.string().optional().describe('Canonical base URL used in sitemap/OG tags'),
  })
  .strict();
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;

export const SiteSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    theme: ThemeSchema,
    header: NodeSchema.optional().describe('Shared header tree rendered on every page'),
    footer: NodeSchema.optional().describe('Shared footer tree rendered on every page'),
    settings: SiteSettingsSchema.default({ locale: 'en' }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type Site = z.infer<typeof SiteSchema>;

export interface Asset {
  id: string;
  siteId: string;
  filename: string;
  mime: string;
  width?: number;
  height?: number;
  /** Path relative to the site's asset dir. */
  path: string;
}

/** A site as produced by a template or bulk import (no ids/timestamps yet). */
export interface SiteInput {
  name: string;
  theme: z.infer<typeof ThemeSchema>;
  header?: WbNode;
  footer?: WbNode;
  settings?: Partial<SiteSettings>;
  pages: Array<{
    slug: string;
    title: string;
    meta?: PageMeta;
    tree: WbNode;
  }>;
  /** Bundled assets written at instantiation time. */
  assets?: Array<{ id: string; filename: string; mime: string; content: string | Uint8Array }>;
}

export function normalizeSlug(slug: string): string {
  return slug === 'index' ? '' : slug;
}
