import { z } from 'zod';
import { LayoutSchema, NodeInputSchema, ResponsiveSchema, StyleSchema, type NodeInput, type WbNode } from './node.js';
import { cloneTree, collectIds, findNode, findParent, isDescendant, materializeNode, validateTreeStructure } from './tree.js';

export const TreeOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('insert'),
      parentId: z.string().describe('Container node to insert into'),
      index: z.number().int().min(0).optional().describe('Position among children (default: append)'),
      node: NodeInputSchema.describe('Node (subtree) to insert; ids auto-assigned if omitted'),
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      nodeId: z.string(),
      props: z
        .record(z.unknown())
        .optional()
        .describe('Shallow-merged into existing props; a null value deletes that key'),
      layout: z
        .record(z.unknown())
        .optional()
        .describe('Shallow-merged into existing layout (validated after merge); null deletes a key'),
      style: z
        .record(z.unknown())
        .optional()
        .describe('Shallow-merged into existing style (validated after merge); null deletes a key'),
      responsive: ResponsiveSchema.nullable().optional().describe('Replaces the responsive overrides (null clears them)'),
    })
    .strict(),
  z
    .object({
      op: z.literal('move'),
      nodeId: z.string(),
      parentId: z.string().describe('New parent container'),
      index: z.number().int().min(0).describe('Position among the new parent’s children'),
    })
    .strict(),
  z.object({ op: z.literal('remove'), nodeId: z.string() }).strict(),
  z
    .object({
      op: z.literal('replace'),
      nodeId: z.string(),
      node: NodeInputSchema.describe('Replacement node (subtree)'),
    })
    .strict(),
]);
export type TreeOp = z.infer<typeof TreeOpSchema>;

export class OpsError extends Error {
  constructor(
    public readonly opIndex: number,
    message: string,
    public readonly path?: string,
  ) {
    super(`op[${opIndex}]: ${message}`);
    this.name = 'OpsError';
  }
}

export interface ApplyOpsHooks {
  /**
   * Called for every inserted/replaced/updated node so callers (core) can validate
   * component props against the registry. Throw to reject; message is surfaced.
   */
  validateNode?: (node: WbNode) => void;
  /** Should return true if `type` may contain children. */
  isContainer?: (type: string) => boolean;
}

/**
 * Apply a batch of ops atomically: either every op applies and the resulting
 * tree is structurally valid, or an OpsError identifying the failing op is
 * thrown and the original tree is untouched.
 */
export function applyOps(tree: WbNode, ops: TreeOp[], hooks: ApplyOpsHooks = {}): WbNode {
  const next = cloneTree(tree);
  const ids = collectIds(next);

  ops.forEach((op, i) => {
    try {
      applyOne(next, op, ids, hooks);
    } catch (err) {
      if (err instanceof OpsError) throw err;
      throw new OpsError(i, err instanceof Error ? err.message : String(err));
    }
    const problems = validateTreeStructure(next);
    if (problems.length > 0) {
      throw new OpsError(i, `tree invalid after op: ${problems.map((p) => p.message).join('; ')}`);
    }
  });
  return next;
}

function applyOne(root: WbNode, op: TreeOp, ids: Set<string>, hooks: ApplyOpsHooks): void {
  switch (op.op) {
    case 'insert': {
      const parent = findNode(root, op.parentId);
      if (!parent) throw new Error(`parent node "${op.parentId}" not found`);
      assertContainer(parent, hooks);
      const node = materializeNode(op.node, ids);
      validateSubtree(node, hooks);
      parent.children ??= [];
      const index = op.index === undefined ? parent.children.length : Math.min(op.index, parent.children.length);
      parent.children.splice(index, 0, node);
      return;
    }
    case 'update': {
      const node = findNode(root, op.nodeId);
      if (!node) throw new Error(`node "${op.nodeId}" not found`);
      if (op.props) node.props = mergeClean(node.props, op.props);
      if (op.layout) {
        const merged = mergeClean(node.layout ?? {}, op.layout);
        node.layout = Object.keys(merged).length ? LayoutSchema.parse(merged) : undefined;
      }
      if (op.style) {
        const merged = mergeClean(node.style ?? {}, op.style);
        node.style = Object.keys(merged).length ? StyleSchema.parse(merged) : undefined;
      }
      if (op.responsive !== undefined) {
        node.responsive = op.responsive === null ? undefined : op.responsive;
      }
      hooks.validateNode?.(node);
      return;
    }
    case 'move': {
      if (op.nodeId === op.parentId) throw new Error('cannot move a node into itself');
      const found = findParent(root, op.nodeId);
      if (!found) throw new Error(`node "${op.nodeId}" not found or is the root`);
      const moving = found.parent.children![found.index]!;
      if (isDescendant(moving, op.parentId)) {
        throw new Error(`cannot move "${op.nodeId}" into its own descendant "${op.parentId}"`);
      }
      const target = findNode(root, op.parentId);
      if (!target) throw new Error(`target parent "${op.parentId}" not found`);
      assertContainer(target, hooks);
      found.parent.children!.splice(found.index, 1);
      target.children ??= [];
      // `op.index` is the node's FINAL position among the new parent's children
      // (the node is removed first, then inserted at that index). Callers that
      // compute a drop slot with the moving node still present must convert to a
      // final index before calling (the editor's drag handlers do this).
      target.children.splice(Math.min(op.index, target.children.length), 0, moving);
      return;
    }
    case 'remove': {
      const found = findParent(root, op.nodeId);
      if (!found) throw new Error(`node "${op.nodeId}" not found or is the root (root cannot be removed)`);
      found.parent.children!.splice(found.index, 1);
      return;
    }
    case 'replace': {
      const found = findParent(root, op.nodeId);
      if (!found) throw new Error(`node "${op.nodeId}" not found or is the root (use whole-tree replace instead)`);
      const node = materializeNode(op.node, ids);
      validateSubtree(node, hooks);
      found.parent.children!.splice(found.index, 1, node);
      return;
    }
  }
}

/** Shallow merge where a null patch value deletes the key. */
function mergeClean<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base, ...patch };
  for (const key of Object.keys(out)) {
    if (out[key] === null || out[key] === undefined) delete out[key];
  }
  return out as T;
}

function assertContainer(node: WbNode, hooks: ApplyOpsHooks): void {
  if (hooks.isContainer && !hooks.isContainer(node.type)) {
    throw new Error(`node "${node.id}" (${node.type}) is not a container and cannot hold children`);
  }
}

function validateSubtree(node: WbNode, hooks: ApplyOpsHooks): void {
  hooks.validateNode?.(node);
  node.children?.forEach((c) => validateSubtree(c, hooks));
}

/** Build a NodeInput tree from parts — convenience for templates and tests. */
export function n(
  type: string,
  props: Record<string, unknown> = {},
  extra: Partial<Pick<NodeInput, 'layout' | 'style' | 'responsive'>> = {},
  children?: NodeInput[],
): NodeInput {
  return { type, props, ...extra, ...(children ? { children } : {}) };
}
