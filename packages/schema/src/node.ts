import { z } from 'zod';
import { ColorTokenSchema, RadiusTokenSchema, ShadowTokenSchema, SpacingTokenSchema } from './tokens.js';

export const AssetRefSchema = z.object({
  assetId: z.string().optional().describe('Id of an uploaded asset'),
  url: z.string().optional().describe('External or absolute URL (used when no assetId)'),
  alt: z.string().default('').describe('Alt text for accessibility'),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

export const PaddingSchema = z.union([
  SpacingTokenSchema,
  z.object({
    top: SpacingTokenSchema.optional(),
    right: SpacingTokenSchema.optional(),
    bottom: SpacingTokenSchema.optional(),
    left: SpacingTokenSchema.optional(),
  }),
]);
export type Padding = z.infer<typeof PaddingSchema>;

export const LayoutSchema = z
  .object({
    direction: z
      .enum(['stack', 'row', 'grid'])
      .optional()
      .describe('Auto-layout direction: stack (vertical), row (horizontal), grid'),
    gap: SpacingTokenSchema.optional().describe('Gap between children'),
    padding: PaddingSchema.optional().describe('Inner padding (single token or per-side)'),
    align: z.enum(['start', 'center', 'end', 'stretch']).optional().describe('Cross-axis alignment'),
    justify: z.enum(['start', 'center', 'end', 'between']).optional().describe('Main-axis distribution'),
    wrap: z.boolean().optional().describe('Allow row children to wrap'),
    columns: z.number().int().min(1).max(6).optional().describe('Grid column count (grid only)'),
    maxWidth: z
      .enum(['content', 'wide', 'full'])
      .optional()
      .describe('Max content width: content=760px, wide=1200px, full=100%'),
  })
  .strict();
export type Layout = z.infer<typeof LayoutSchema>;

/** Style overrides applied on an interactive state (:hover / :focus). Pure CSS,
 * no JavaScript — a colour subset of the full style (no background image). */
export const StateStyleSchema = z
  .object({
    background: ColorTokenSchema.optional().describe('Background color for this state'),
    color: ColorTokenSchema.optional().describe('Text color for this state'),
    shadow: ShadowTokenSchema.optional(),
    border: z
      .object({ color: ColorTokenSchema, width: z.union([z.literal(1), z.literal(2)]).optional() })
      .optional(),
    radius: RadiusTokenSchema.optional(),
  })
  .strict();
export type StateStyle = z.infer<typeof StateStyleSchema>;

export const StyleSchema = z
  .object({
    background: z
      .union([
        ColorTokenSchema,
        z
          .object({
            gradient: z
              .object({
                from: ColorTokenSchema.describe('Gradient start color'),
                to: ColorTokenSchema.describe('Gradient end color'),
                angle: z.number().int().min(0).max(360).default(180).describe('Gradient angle in degrees'),
              })
              .strict(),
          })
          .strict(),
        z.object({
          image: AssetRefSchema.describe('Background image'),
          overlay: ColorTokenSchema.optional().describe('Color overlay drawn over the image'),
        }),
      ])
      .optional(),
    color: ColorTokenSchema.optional().describe('Text color'),
    fontWeight: z.enum(['normal', 'medium', 'semibold', 'bold']).optional().describe('Text weight'),
    letterSpacing: z.enum(['tight', 'normal', 'wide']).optional().describe('Letter spacing'),
    textTransform: z.enum(['none', 'uppercase', 'capitalize']).optional().describe('Text casing'),
    radius: RadiusTokenSchema.optional(),
    shadow: ShadowTokenSchema.optional(),
    border: z
      .object({ color: ColorTokenSchema, width: z.union([z.literal(1), z.literal(2)]).optional() })
      .optional(),
    minHeight: z.enum(['auto', 'half', 'screen']).optional().describe('Minimum height: half/full viewport'),
    hover: StateStyleSchema.optional().describe('Style applied on hover (pure CSS)'),
    focus: StateStyleSchema.optional().describe('Style applied on keyboard focus (pure CSS)'),
  })
  .strict();
export type Style = z.infer<typeof StyleSchema>;

const ResponsiveDeltaSchema = z
  .object({
    props: z.record(z.unknown()).optional().describe('Prop overrides at this breakpoint'),
    layout: LayoutSchema.partial().optional(),
    style: StyleSchema.partial().optional(),
    hidden: z.boolean().optional().describe('Hide this node at this breakpoint'),
  })
  .strict();
export type ResponsiveDelta = z.infer<typeof ResponsiveDeltaSchema>;

export const ResponsiveSchema = z
  .object({
    tablet: ResponsiveDeltaSchema.optional(),
    mobile: ResponsiveDeltaSchema.optional(),
  })
  .strict();
export type Responsive = z.infer<typeof ResponsiveSchema>;

export interface WbNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  layout?: Layout;
  style?: Style;
  responsive?: Responsive;
  children?: WbNode[];
}

export const NodeSchema: z.ZodType<WbNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).describe('Unique node id within the page'),
      type: z.string().min(1).describe('Registered component type'),
      props: z.record(z.unknown()).default({}),
      layout: LayoutSchema.optional(),
      style: StyleSchema.optional(),
      responsive: ResponsiveSchema.optional(),
      children: z.array(NodeSchema).optional(),
    })
    .strict(),
) as z.ZodType<WbNode>;

/** Node as supplied by clients: ids optional (auto-assigned). */
export interface NodeInput {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  layout?: Layout;
  style?: Style;
  responsive?: Responsive;
  children?: NodeInput[];
}

export const NodeInputSchema: z.ZodType<NodeInput> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).optional(),
      type: z.string().min(1),
      props: z.record(z.unknown()).optional(),
      layout: LayoutSchema.optional(),
      style: StyleSchema.optional(),
      responsive: ResponsiveSchema.optional(),
      children: z.array(NodeInputSchema).optional(),
    })
    .strict(),
) as z.ZodType<NodeInput>;
