import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

/**
 * Mirrors @wb/core's TreeOpSchema discriminated union so the model gets typed,
 * per-variant guidance (and the tool rejects malformed ops before the network
 * round-trip). The server re-validates authoritatively; this is the fast fence.
 */
const nodeInput = z
  .record(z.string(), z.unknown())
  .describe('A node/subtree: {type, props?, layout?, style?, responsive?, children?}; ids auto-assigned if omitted');

const treeOp = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('insert'),
      parentId: z.string().describe('Container node to insert into'),
      index: z.number().int().min(0).optional().describe('Position among children (default: append)'),
      node: nodeInput,
    })
    .strict(),
  z
    .object({
      op: z.literal('update'),
      nodeId: z.string(),
      props: z.record(z.string(), z.unknown()).optional().describe('Shallow-merged into props; a null value deletes that key'),
      layout: z.record(z.string(), z.unknown()).optional().describe('Shallow-merged into layout; null deletes a key'),
      style: z.record(z.string(), z.unknown()).optional().describe('Shallow-merged into style; null deletes a key'),
      responsive: z.record(z.string(), z.unknown()).nullable().optional().describe('Replaces responsive overrides (null clears them)'),
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
  z.object({ op: z.literal('replace'), nodeId: z.string(), node: nodeInput }).strict(),
]);

export default defineTool({
  description:
    'Edit a page tree with an atomic batch of ops (insert/update/move/remove/replace). Either all ops apply and the result validates, or nothing changes and the error names the failing op index — fix your input and retry.',
  inputSchema: z.object({
    siteId: z.string(),
    page: z.string().describe('Page id or slug ("index" for home)'),
    ops: z.array(treeOp).min(1).describe('Ops applied in order, atomically'),
  }),
  async execute({ siteId, page, ops }) {
    return wbPost(
      `/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(page || 'index')}/tree/ops`,
      { ops },
    );
  },
});
