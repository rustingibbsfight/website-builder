import {
  BASE_CSS,
  cssUrl,
  getComponent,
  parseProps,
  type RenderCtx,
} from '@wb/components';
import {
  BREAKPOINTS,
  FONT_STACKS,
  isThemeColorToken,
  radiusPx,
  spacingPx,
  walk,
  type Layout,
  type Padding,
  type Site,
  type Style,
  type WbNode,
} from '@wb/schema';

export interface CssTree {
  root: WbNode;
  /** CSS scope prefix for this tree's node selectors (e.g. '.wb-page-home '). */
  scope: string;
}

export function themeCssVars(site: Site): string {
  const t = site.theme;
  const space = spacingPx(t.spacingScale);
  const radius = radiusPx(t.radiusScale);
  const vars = [
    ...Object.entries(t.colors).map(([k, v]) => `--color-${k}:${v}`),
    '--color-white:#ffffff',
    `--font-heading:${FONT_STACKS[t.fonts.heading]}`,
    `--font-body:${FONT_STACKS[t.fonts.body]}`,
    ...Object.entries(space).map(([k, v]) => `--space-${k}:${v}px`),
    ...Object.entries(radius).map(([k, v]) => `--radius-${k}:${v}`),
  ];
  return `:root{${vars.join(';')}}`;
}

function colorValue(token: string): string {
  return isThemeColorToken(token) ? `var(--color-${token})` : token;
}


function paddingValue(p: Padding): string {
  if (typeof p === 'string') return `var(--space-${p})`;
  const side = (s?: string) => (s ? `var(--space-${s})` : '0');
  return `${side(p.top)} ${side(p.right)} ${side(p.bottom)} ${side(p.left)}`;
}

const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const;
const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' } as const;
const MAX_WIDTH = { content: '760px', wide: '1200px', full: 'none' } as const;

export function layoutRules(layout: Partial<Layout>): string[] {
  const rules: string[] = [];
  if (layout.direction === 'stack') rules.push('display:flex', 'flex-direction:column');
  if (layout.direction === 'row') rules.push('display:flex', 'flex-direction:row');
  if (layout.direction === 'grid') {
    rules.push('display:grid', `grid-template-columns:repeat(${layout.columns ?? 3},1fr)`);
  } else if (layout.columns !== undefined) {
    rules.push(`grid-template-columns:repeat(${layout.columns},1fr)`);
  }
  if (layout.gap) rules.push(`gap:var(--space-${layout.gap})`);
  if (layout.padding !== undefined) rules.push(`padding:${paddingValue(layout.padding)}`);
  if (layout.align) rules.push(`align-items:${ALIGN[layout.align]}`);
  if (layout.justify) rules.push(`justify-content:${JUSTIFY[layout.justify]}`);
  if (layout.wrap !== undefined) rules.push(`flex-wrap:${layout.wrap ? 'wrap' : 'nowrap'}`);
  if (layout.maxWidth) rules.push(`max-width:${MAX_WIDTH[layout.maxWidth]}`, 'margin-inline:auto', 'width:100%');
  return rules;
}

export function styleRules(style: Partial<Style>, resolveAsset: RenderCtx['resolveAsset']): string[] {
  const rules: string[] = [];
  if (style.background !== undefined) {
    if (typeof style.background === 'string') {
      rules.push(`background:${colorValue(style.background)}`);
    } else {
      const url = cssUrl(resolveAsset(style.background.image));
      const overlay = style.background.overlay
        ? `linear-gradient(color-mix(in srgb, ${colorValue(style.background.overlay)} 60%, transparent), color-mix(in srgb, ${colorValue(style.background.overlay)} 60%, transparent)),`
        : '';
      if (url) rules.push(`background:${overlay}url('${url}') center/cover no-repeat`);
      else if (style.background.overlay) rules.push(`background:${colorValue(style.background.overlay)}`);
    }
  }
  if (style.color) rules.push(`color:${colorValue(style.color)}`);
  if (style.radius) rules.push(`border-radius:var(--radius-${style.radius})`);
  if (style.shadow && style.shadow !== 'none') {
    const shadows = {
      sm: '0 1px 3px rgb(0 0 0 / .08)',
      md: '0 4px 12px rgb(0 0 0 / .1)',
      lg: '0 12px 32px rgb(0 0 0 / .14)',
    } as const;
    rules.push(`box-shadow:${shadows[style.shadow]}`);
  }
  if (style.border) {
    rules.push(`border:${style.border.width ?? 1}px solid ${colorValue(style.border.color)}`);
  }
  if (style.minHeight && style.minHeight !== 'auto') {
    rules.push(`min-height:${style.minHeight === 'half' ? '50vh' : '100vh'}`);
  }
  return rules;
}

interface NodeCssBuckets {
  base: string[];
  tablet: string[];
  mobile: string[];
}

function selectorsFor(node: WbNode, scope: string): { self: string; layoutSel: string } {
  const def = getComponent(node.type);
  const self = `${scope}.n-${node.id}`;
  return { self, layoutSel: def.layoutTarget === 'inner' ? `${self}>.wb-inner` : self };
}

function cssForNode(node: WbNode, scope: string, resolveAsset: RenderCtx['resolveAsset']): NodeCssBuckets {
  const out: NodeCssBuckets = { base: [], tablet: [], mobile: [] };
  const { self, layoutSel } = selectorsFor(node, scope);

  const emit = (bucket: string[], sel: string, rules: string[]) => {
    if (rules.length) bucket.push(`${sel}{${rules.join(';')}}`);
  };

  if (node.layout) emit(out.base, layoutSel, layoutRules(node.layout));
  if (node.style) emit(out.base, self, styleRules(node.style, resolveAsset));

  // Interactive states — pure CSS, no JavaScript.
  if (node.style?.hover) {
    const r = styleRules(node.style.hover as Partial<Style>, resolveAsset);
    if (r.length) {
      out.base.push(
        `${self}{transition:background-color .15s ease,color .15s ease,box-shadow .15s ease,border-color .15s ease}`,
      );
      emit(out.base, `${self}:hover`, r);
    }
  }
  if (node.style?.focus) {
    emit(out.base, `${self}:focus-visible`, styleRules(node.style.focus as Partial<Style>, resolveAsset));
  }

  const def = getComponent(node.type);
  if (def.nodeCss) {
    const props = parseProps(node.type, node.props);
    const css = def.nodeCss(node, props, self);
    if (css) out.base.push(css);
  }

  const tablet = node.responsive?.tablet;
  const mobile = node.responsive?.mobile;
  if (tablet?.layout) emit(out.tablet, layoutSel, layoutRules(tablet.layout));
  if (tablet?.style) emit(out.tablet, self, styleRules(tablet.style, resolveAsset));
  if (tablet?.hidden) out.tablet.push(`${self}{display:none}`);
  if (mobile?.layout) emit(out.mobile, layoutSel, layoutRules(mobile.layout));
  if (mobile?.style) emit(out.mobile, self, styleRules(mobile.style, resolveAsset));
  if (mobile?.hidden) out.mobile.push(`${self}{display:none}`);

  // Responsive by construction: multi-column grids collapse and rows stack
  // unless the author supplied an explicit override for that breakpoint.
  if (node.layout?.direction === 'grid') {
    const cols = node.layout.columns ?? 3;
    if (cols > 2 && tablet?.layout?.columns === undefined && !tablet?.layout?.direction) {
      out.tablet.push(`${layoutSel}{grid-template-columns:repeat(2,1fr)}`);
    }
    if (cols > 1 && mobile?.layout?.columns === undefined && !mobile?.layout?.direction) {
      out.mobile.push(`${layoutSel}{grid-template-columns:1fr}`);
    }
  }
  if (node.layout?.direction === 'row' && !mobile?.layout?.direction) {
    out.mobile.push(`${layoutSel}{flex-direction:column}`);
  }

  return out;
}

/** Full stylesheet for a site: reset, theme vars, component base CSS, per-node rules, media queries. */
export function renderCss(site: Site, trees: CssTree[], resolveAsset: RenderCtx['resolveAsset']): string {
  const usedTypes = new Set<string>();
  const base: string[] = [];
  const tablet: string[] = [];
  const mobile: string[] = [];

  for (const { root, scope } of trees) {
    walk(root, (node) => {
      usedTypes.add(node.type);
      const css = cssForNode(node, scope, resolveAsset);
      base.push(...css.base);
      tablet.push(...css.tablet);
      mobile.push(...css.mobile);
    });
  }

  const componentCss = [...usedTypes]
    .sort()
    .map((t) => getComponent(t).baseCss)
    .filter((c): c is string => Boolean(c));

  const parts = [
    '/* generated by wb — do not edit by hand */',
    BASE_CSS.trim(),
    themeCssVars(site),
    ...componentCss,
    ...base,
  ];
  if (tablet.length) parts.push(`@media (max-width:${BREAKPOINTS.tablet}px){${tablet.join('\n')}}`);
  if (mobile.length) parts.push(`@media (max-width:${BREAKPOINTS.mobile}px){${mobile.join('\n')}}`);
  return `${parts.join('\n')}\n`;
}
