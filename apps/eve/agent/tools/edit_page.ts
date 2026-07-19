import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

const treeOp = z
  .record(z.string(), z.unknown())
  .describe(
    'One op: insert {op:"insert", parentId, index?, node} · update {op:"update", nodeId, props?/layout?/style? (shallow-merged; a null value deletes that key), responsive?} · move {op:"move", nodeId, parentId, index} · remove {op:"remove", nodeId} · replace {op:"replace", nodeId, node}',
  );

export default defineTool({
  description:
    'Edit a page tree with an atomic batch of ops (insert/update/move/remove/replace). Either all ops apply and the result validates, or nothing changes and the error names the failing op index — fix your input and retry.',
  inputSchema: z.object({
    siteId: z.string(),
    page: z.string().describe('Page id or slug ("index" for home)'),
    ops: z.array(treeOp).min(1).describe('Ops applied in order, atomically'),
  }),
  async execute({ siteId, page, ops }) {
    return wbPost(`/sites/${siteId}/pages/${encodeURIComponent(page || 'index')}/tree/ops`, { ops });
  },
});
