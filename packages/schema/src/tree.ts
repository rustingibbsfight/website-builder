import type { NodeInput, WbNode } from './node.js';
import { newNodeId } from './ids.js';

export function walk(root: WbNode, visit: (node: WbNode, parent: WbNode | null, index: number) => void): void {
  const rec = (node: WbNode, parent: WbNode | null, index: number) => {
    visit(node, parent, index);
    node.children?.forEach((child, i) => rec(child, node, i));
  };
  rec(root, null, 0);
}

export function findNode(root: WbNode, id: string): WbNode | null {
  let found: WbNode | null = null;
  walk(root, (n) => {
    if (n.id === id) found = n;
  });
  return found;
}

export function findParent(root: WbNode, id: string): { parent: WbNode; index: number } | null {
  let found: { parent: WbNode; index: number } | null = null;
  walk(root, (n, parent, index) => {
    if (n.id === id && parent) found = { parent, index };
  });
  return found;
}

export function isDescendant(ancestor: WbNode, id: string): boolean {
  if (!ancestor.children) return false;
  return ancestor.children.some((c) => c.id === id || isDescendant(c, id));
}

export function collectIds(root: WbNode): Set<string> {
  const ids = new Set<string>();
  walk(root, (n) => ids.add(n.id));
  return ids;
}

export function cloneTree<T>(tree: T): T {
  return structuredClone(tree);
}

/** Assign ids to a NodeInput subtree, avoiding collisions with `taken`. */
export function materializeNode(input: NodeInput, taken: Set<string>): WbNode {
  const id = input.id && !taken.has(input.id) ? input.id : freshId(taken);
  taken.add(id);
  return {
    id,
    type: input.type,
    props: input.props ?? {},
    ...(input.layout ? { layout: input.layout } : {}),
    ...(input.style ? { style: input.style } : {}),
    ...(input.responsive ? { responsive: input.responsive } : {}),
    ...(input.children ? { children: input.children.map((c) => materializeNode(c, taken)) } : {}),
  };
}

function freshId(taken: Set<string>): string {
  for (;;) {
    const id = newNodeId();
    if (!taken.has(id)) return id;
  }
}

export interface TreeProblem {
  nodeId: string;
  message: string;
}

/** Structural validation: unique ids, non-empty types. */
/** Resource caps so a pathologically large/deep tree can't exhaust memory or
 *  stack-overflow the recursive walk/render. Generous for real pages. */
export const MAX_TREE_NODES = 5000;
export const MAX_TREE_DEPTH = 60;

export function validateTreeStructure(root: WbNode): TreeProblem[] {
  const problems: TreeProblem[] = [];
  // Bounds check FIRST, iteratively — a recursive walk would stack-overflow on a
  // pathologically deep tree before any guard could fire. Bail on the first
  // breach so we never recurse into an oversized/too-deep tree below.
  const stack: Array<{ node: WbNode; depth: number }> = [{ node: root, depth: 1 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > MAX_TREE_NODES) return [{ nodeId: root.id, message: `tree too large (max ${MAX_TREE_NODES} nodes)` }];
    if (depth > MAX_TREE_DEPTH) return [{ nodeId: node.id, message: `tree too deep (max ${MAX_TREE_DEPTH} levels)` }];
    for (const c of node.children ?? []) stack.push({ node: c, depth: depth + 1 });
  }

  const seen = new Set<string>();
  walk(root, (n) => {
    if (!n.id) problems.push({ nodeId: n.id, message: 'node has empty id' });
    else if (seen.has(n.id)) problems.push({ nodeId: n.id, message: `duplicate node id "${n.id}"` });
    seen.add(n.id);
    if (!n.type) problems.push({ nodeId: n.id, message: 'node has empty type' });
  });
  return problems;
}
