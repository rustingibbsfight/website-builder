import { z } from 'zod';

export const SPACING_TOKENS = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const;
export const SpacingTokenSchema = z.enum(SPACING_TOKENS).describe('Spacing token from the theme scale');
export type SpacingToken = z.infer<typeof SpacingTokenSchema>;

export const COLOR_TOKENS = [
  'primary',
  'secondary',
  'accent',
  'background',
  'surface',
  'text',
  'textMuted',
  'white',
] as const;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const ColorTokenSchema = z
  .union([z.enum(COLOR_TOKENS), z.string().regex(HEX_RE, 'must be a theme color token or #rrggbb hex')])
  .describe(`Theme color token (${COLOR_TOKENS.join('|')}) or raw hex like #0e7c66 (tokens preferred)`);
export type ColorToken = z.infer<typeof ColorTokenSchema>;

export const isThemeColorToken = (c: string): c is (typeof COLOR_TOKENS)[number] =>
  (COLOR_TOKENS as readonly string[]).includes(c);

export const RadiusTokenSchema = z.enum(['none', 'sm', 'md', 'lg', 'full']);
export type RadiusToken = z.infer<typeof RadiusTokenSchema>;

export const ShadowTokenSchema = z.enum(['none', 'sm', 'md', 'lg']);
export type ShadowToken = z.infer<typeof ShadowTokenSchema>;

export const BREAKPOINTS = {
  tablet: 1023,
  mobile: 639,
} as const;
export type Breakpoint = keyof typeof BREAKPOINTS;
