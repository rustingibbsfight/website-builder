import { type WbNode } from '@wb/schema';

/** Compact node-id-annotated outline of a tree, cheap for agents to read. */
export function treeOutline(root: WbNode): string {
  const lines: string[] = [];
  const rec = (node: WbNode, depth: number) => {
    const label = summarizeProps(node);
    const layout = node.layout
      ? ` [${node.layout.direction}${node.layout.direction === 'grid' && node.layout.columns ? ` ${node.layout.columns}col` : ''}]`
      : '';
    const responsive = node.responsive ? ' {responsive}' : '';
    lines.push(`${'  '.repeat(depth)}${node.id} ${node.type}${label ? ` ${label}` : ''}${layout}${responsive}`);
    node.children?.forEach((c) => rec(c, depth + 1));
  };
  rec(root, 0);
  return lines.join('\n');
}

function summarizeProps(node: WbNode): string {
  const p = node.props;
  const text =
    (p.headline as string | undefined) ??
    (p.text as string | undefined) ??
    (p.title as string | undefined) ??
    (p.heading as string | undefined) ??
    (p.label as string | undefined) ??
    (p.quote as string | undefined) ??
    (p.markdown as string | undefined);
  if (typeof text === 'string' && text.length > 0) {
    const short = text.replace(/\s+/g, ' ').slice(0, 40);
    return `"${short}${text.length > 40 ? '…' : ''}"`;
  }
  const items = p.items as unknown[] | undefined;
  if (Array.isArray(items)) return `(${items.length} items)`;
  const fields = p.fields as unknown[] | undefined;
  if (Array.isArray(fields)) return `(${fields.length} fields)`;
  return '';
}
