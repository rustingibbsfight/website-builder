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

/** Cap fetched assets so a hostile/oversized URL can't blow up memory or the API body limit (30 MB). */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

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
    // Reject up front when the server advertises an oversized body...
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
      throw new Error(`asset too large: ${declared} bytes (max ${MAX_ASSET_BYTES})`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // ...and again after download, since content-length can be absent or lie.
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`asset too large: ${bytes.byteLength} bytes (max ${MAX_ASSET_BYTES})`);
    }
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const resolvedMime =
      mime ?? res.headers.get('content-type') ?? MIME[ext] ?? 'application/octet-stream';
    return wbPost(`/sites/${encodeURIComponent(siteId)}/assets`, {
      filename,
      mime: resolvedMime,
      base64: bytes.toString('base64'),
    });
  },
});
