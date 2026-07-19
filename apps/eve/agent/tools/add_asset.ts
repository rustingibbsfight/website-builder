import { defineTool } from 'eve/tools';
import { z } from 'zod';

import { wbPost } from '../../lib/wb';

const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
};

export default defineTool({
  description:
    'Add an image/file asset to a site from a URL. Returns the assetId to reference in image props ({image:{assetId, alt}}).',
  inputSchema: z.object({
    siteId: z.string(),
    filename: z.string(),
    url: z.string().describe('URL to fetch the asset from'),
    mime: z.string().optional().describe('MIME type (inferred from the response/filename if omitted)'),
  }),
  async execute({ siteId, filename, url, mime }) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const resolvedMime =
      mime ?? res.headers.get('content-type') ?? MIME[ext] ?? 'application/octet-stream';
    return wbPost(`/sites/${siteId}/assets`, {
      filename,
      mime: resolvedMime,
      base64: bytes.toString('base64'),
    });
  },
});
