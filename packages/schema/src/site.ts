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
    formEndpoint: z
      .string()
      .optional()
      .describe('Base URL of the wb-api that captures stored form submissions (e.g. https://wb-api-gold.vercel.app)'),
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
    symbols: z
      .record(z.string(), NodeSchema)
      .optional()
      .describe('Reusable symbol definitions (id → subtree); symbolInstance nodes render the resolved definition'),
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
  symbols?: Record<string, WbNode>;
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

/**
 * What to ask the image studio for.
 *
 * Here rather than in `core` because four surfaces send one — the HTTP route,
 * the MCP tool, Eve's tool and the editor's picker — and a schema each is four
 * chances for a field to exist at one end and not the other. That has already
 * happened once in this integration: Eve's copy of the vocabulary was a
 * `z.enum` written months before the studio grew `width`, `height`, `media`,
 * `seconds` and `brand`, so those shipped at one end and were unreachable from
 * the other.
 *
 * **The vocabulary itself stays open.** `purpose`, `aspect`, `media` and
 * `textSafe` are plain strings and the studio validates them, because a copied
 * enum here fails closed and silently: the caller never sees the seventh
 * purpose, so it never asks for it, so nobody notices. A wrong value comes back
 * as the studio's own error naming the whole accepted list, which a caller can
 * act on in the same turn rather than after a deploy here.
 *
 * The numbers *are* bounded, because those are our costs rather than the
 * studio's vocabulary: a count of forty is a bill, and a negative width is a
 * mistake at every possible far end.
 */
export const ImageSpecSchema = z
  .object({
    purpose: z.string().min(1).describe('What the image is for on the page, e.g. hero.'),
    subject: z.string().min(1).describe('What the picture is of, in plain words.'),
    mood: z.string().optional().describe('e.g. "calm, clinical" or "warm, lived-in".'),
    palette: z
      .array(z.string())
      .optional()
      .describe("Hex colours. Defaults to the site's own theme, so the picture belongs to the page."),
    aspect: z.string().optional().describe('Shape, when the slot is not laid out yet. e.g. 16/9.'),
    width: z.number().int().positive().max(8192).optional().describe('Exact slot width in pixels.'),
    height: z.number().int().positive().max(8192).optional().describe('Exact slot height in pixels.'),
    minWidth: z.number().int().positive().max(8192).optional().describe('A floor under the resulting size.'),
    media: z.string().optional().describe('"image" (default) or "video" for a clip.'),
    seconds: z.number().positive().max(60).optional().describe('Clip length. Only with media: "video".'),
    brand: z.string().optional().describe('A brand kit already sent to the studio.'),
    textSafe: z.string().optional().describe('Where a headline will sit, e.g. left.'),
    avoid: z.array(z.string()).optional().describe('e.g. ["people", "text", "logos"].'),
    count: z.number().int().min(1).max(4).optional().describe('How many to choose between. Defaults to 1.'),
  })
  .strict();
export type ImageSpecInput = z.infer<typeof ImageSpecSchema>;
