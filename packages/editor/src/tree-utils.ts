import type { WbNode } from './types';

export function findNode(root: WbNode, id: string): WbNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findParent(root: WbNode, id: string): { parent: WbNode; index: number } | null {
  for (let i = 0; i < (root.children ?? []).length; i++) {
    const child = root.children![i]!;
    if (child.id === id) return { parent: root, index: i };
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
}

export function collectContainerIds(root: WbNode, isContainer: (type: string) => boolean): string[] {
  const ids: string[] = [];
  const rec = (n: WbNode) => {
    if (isContainer(n.type)) ids.push(n.id);
    n.children?.forEach(rec);
  };
  rec(root);
  return ids;
}

/** Deep-copy a node with all ids stripped (server assigns fresh ones). */
export function stripIds(node: WbNode): Omit<WbNode, 'id'> & { type: string } {
  const { id, children, ...rest } = node;
  void id;
  return { ...rest, ...(children ? { children: children.map(stripIds) as never } : {}) };
}

export function nodeLabel(node: WbNode): string {
  const p = node.props;
  const text =
    (p.headline as string) ?? (p.text as string) ?? (p.title as string) ?? (p.heading as string) ?? (p.label as string);
  if (typeof text === 'string' && text) return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  return '';
}
