import type { AssetRef, Theme, WbNode } from '@wb/schema';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export interface RenderCtx {
  theme: Theme;
  /** Resolve an asset reference to a URL usable in the published site. */
  resolveAsset: (ref: Partial<AssetRef> | undefined) => string;
  /** Render a child node (implemented by the renderer). */
  renderNode: (node: WbNode) => string;
  /** True when rendering for the live preview (adds editor hooks). */
  preview?: boolean;
  /** The site being rendered — used to compose stored-form POST URLs. */
  siteId?: string;
  /** Base URL of the wb-api that captures stored form submissions (#27). */
  formEndpoint?: string;
}

// biome-ignore lint: any is the ergonomic choice for a heterogeneous registry
export interface ComponentDef<P = any> {
  type: string;
  title: string;
  description: string;
  category: 'layout' | 'primitive' | 'chrome' | 'composite';
  isContainer: boolean;
  /** Restrict which child types are allowed (undefined = any). */
  allowedChildren?: string[];
  // biome-ignore lint: input type must stay loose — zod .default() fields accept undefined on input
  propsSchema: z.ZodType<P, z.ZodTypeDef, any>;
  defaultProps: P;
  /**
   * Where per-node layout CSS applies: 'self' (default) or 'inner' for
   * full-bleed components that center content in a .wb-inner wrapper.
   */
  layoutTarget?: 'self' | 'inner';
  render: (node: WbNode, props: P, ctx: RenderCtx) => string;
  /** Static base CSS for this component type (uses theme custom properties). */
  baseCss?: string;
  /** Prop-dependent CSS for one node; sel is the escaped `.n-<id>` selector. */
  nodeCss?: (node: WbNode, props: P, sel: string) => string;
}

const registry = new Map<string, ComponentDef>();

export function register(def: ComponentDef): void {
  if (registry.has(def.type)) throw new Error(`component "${def.type}" already registered`);
  registry.set(def.type, def);
}

export function getComponent(type: string): ComponentDef {
  const def = registry.get(type);
  if (!def) {
    throw new Error(
      `unknown component "${type}" — valid types: ${[...registry.keys()].sort().join(', ')}`,
    );
  }
  return def;
}

export function hasComponent(type: string): boolean {
  return registry.has(type);
}

export function listComponents(): ComponentDef[] {
  return [...registry.values()];
}

export function isContainer(type: string): boolean {
  return registry.get(type)?.isContainer ?? false;
}

/** Parse props with defaults applied; throws with an agent-readable message. */
export function parseProps(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const def = getComponent(type);
  const result = (def.propsSchema as z.ZodTypeAny).safeParse(props);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid props for "${type}": ${issues}`);
  }
  return result.data as Record<string, unknown>;
}

/** Validate a node's props and (when restricted) its children types. */
export function validateNodeAgainstRegistry(node: WbNode): void {
  const def = getComponent(node.type);
  parseProps(node.type, node.props);
  if (node.children && node.children.length > 0 && !def.isContainer) {
    throw new Error(`component "${node.type}" is not a container and cannot have children`);
  }
  if (def.allowedChildren && node.children) {
    for (const child of node.children) {
      if (!def.allowedChildren.includes(child.type)) {
        throw new Error(
          `component "${node.type}" only allows children of type: ${def.allowedChildren.join(', ')} (got "${child.type}")`,
        );
      }
    }
  }
}

export interface ComponentSummary {
  type: string;
  title: string;
  description: string;
  category: string;
  isContainer: boolean;
  allowedChildren?: string[];
}

export function componentSummary(def: ComponentDef): ComponentSummary {
  return {
    type: def.type,
    title: def.title,
    description: def.description,
    category: def.category,
    isContainer: def.isContainer,
    ...(def.allowedChildren ? { allowedChildren: def.allowedChildren } : {}),
  };
}

export function componentJsonSchema(type: string): Record<string, unknown> {
  const def = getComponent(type);
  return zodToJsonSchema(def.propsSchema as z.ZodTypeAny, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
}
