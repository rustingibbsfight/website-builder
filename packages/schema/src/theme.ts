import { z } from 'zod';

const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be #rgb or #rrggbb hex');

export const ThemeColorsSchema = z
  .object({
    primary: hex.describe('Primary brand color (buttons, links, accents)'),
    secondary: hex.describe('Secondary brand color (dark headers, footers)'),
    accent: hex.describe('Accent/highlight color'),
    background: hex.describe('Page background'),
    surface: hex.describe('Card/section surface background'),
    text: hex.describe('Body text color'),
    textMuted: hex.describe('Muted/secondary text color'),
  })
  .strict();
export type ThemeColors = z.infer<typeof ThemeColorsSchema>;

/** Curated system-first font stacks — self-contained, no webfont downloads. */
export const FONT_STACKS = {
  'serif-classic': "Georgia, 'Times New Roman', Times, serif",
  'serif-modern': "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  'sans-modern':
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  'sans-geometric': "Futura, 'Century Gothic', 'Trebuchet MS', Verdana, sans-serif",
  'sans-humanist': "Seravek, 'Gill Sans', 'Segoe UI', Candara, Calibri, sans-serif",
  mono: "'SF Mono', 'Cascadia Code', Consolas, 'Liberation Mono', monospace",
} as const;
export type FontStackName = keyof typeof FONT_STACKS;

export const FontStackNameSchema = z
  .enum(Object.keys(FONT_STACKS) as [FontStackName, ...FontStackName[]])
  .describe(`Named font stack: ${Object.keys(FONT_STACKS).join(', ')}`);

export const ThemeSchema = z
  .object({
    brandName: z.string().min(1).describe('Site/brand display name'),
    colors: ThemeColorsSchema,
    fonts: z
      .object({
        heading: FontStackNameSchema.describe('Heading font stack'),
        body: FontStackNameSchema.describe('Body font stack'),
      })
      .strict(),
    spacingScale: z
      .number()
      .int()
      .min(4)
      .max(16)
      .default(8)
      .describe('Base spacing unit in px (xs=unit/2 … 2xl=unit*8)'),
    radiusScale: z.enum(['sharp', 'soft', 'round']).default('soft').describe('Corner rounding character'),
    logo: z
      .object({ assetId: z.string().optional(), url: z.string().optional() })
      .optional()
      .describe('Brand logo asset'),
  })
  .strict();
export type Theme = z.infer<typeof ThemeSchema>;

export const DEFAULT_THEME: Theme = {
  brandName: 'My Site',
  colors: {
    primary: '#2563eb',
    secondary: '#1e293b',
    accent: '#f59e0b',
    background: '#ffffff',
    surface: '#f4f6f8',
    text: '#1f2937',
    textMuted: '#6b7280',
  },
  fonts: { heading: 'sans-modern', body: 'sans-modern' },
  spacingScale: 8,
  radiusScale: 'soft',
};

/** Spacing token → px for a given base unit. */
export function spacingPx(unit: number): Record<string, number> {
  return { none: 0, xs: unit / 2, sm: unit, md: unit * 2, lg: unit * 3, xl: unit * 5, '2xl': unit * 8 };
}

/** Radius token → px for a radius scale. */
export function radiusPx(scale: Theme['radiusScale']): Record<string, string> {
  const soft = { none: '0', sm: '4px', md: '8px', lg: '16px', full: '9999px' };
  if (scale === 'sharp') return { none: '0', sm: '2px', md: '4px', lg: '8px', full: '9999px' };
  if (scale === 'round') return { none: '0', sm: '8px', md: '14px', lg: '24px', full: '9999px' };
  return soft;
}
