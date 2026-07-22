export interface WbNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  layout?: Record<string, unknown>;
  style?: Record<string, unknown>;
  responsive?: Record<string, unknown>;
  children?: WbNode[];
}

export interface PageSummary {
  id: string;
  slug: string;
  title: string;
  rootId?: string;
}

export interface PageMeta {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  twitterCard?: 'summary' | 'summary_large_image';
  noIndex?: boolean;
}

export interface Page {
  id: string;
  siteId: string;
  slug: string;
  title: string;
  meta: PageMeta;
  tree: WbNode;
}

export interface Theme {
  brandName: string;
  colors: Record<string, string>;
  fonts: { heading: string; body: string };
  spacingScale: number;
  radiusScale: string;
  logo?: { assetId?: string; url?: string };
}

export interface Site {
  id: string;
  name: string;
  theme: Theme;
  settings: { locale: string; baseUrl?: string };
}

export interface ComponentSummary {
  type: string;
  title: string;
  description: string;
  category: string;
  isContainer: boolean;
  allowedChildren?: string[];
}

export interface ComponentDetail extends ComponentSummary {
  propsSchema: JsonSchema;
  defaultProps: Record<string, unknown>;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  required?: string[];
  description?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
}

export type TreeOp =
  | { op: 'insert'; parentId: string; index?: number; node: Partial<WbNode> & { type: string } }
  | { op: 'update'; nodeId: string; props?: Record<string, unknown>; layout?: Record<string, unknown>; style?: Record<string, unknown>; responsive?: Record<string, unknown> }
  | { op: 'move'; nodeId: string; parentId: string; index: number }
  | { op: 'remove'; nodeId: string }
  | { op: 'replace'; nodeId: string; node: Partial<WbNode> & { type: string } };
