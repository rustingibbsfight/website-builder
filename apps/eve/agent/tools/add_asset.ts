import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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

/** True for loopback / private / link-local / unique-local / metadata IPs. */
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  const lo = ip.toLowerCase();
  if (lo === '::1' || lo === '::') return true;
  if (lo.startsWith('::ffff:')) return isPrivateIp(lo.slice(7));
  return lo.startsWith('fe80') || lo.startsWith('fc') || lo.startsWith('fd');
}

/** Reject non-http(s) and any URL whose host is (or resolves to) an internal
 *  address — SSRF guard for user-supplied asset URLs. */
async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) asset urls are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('refusing to fetch a local address');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('refusing to fetch a private/internal address');
    return;
  }
  const resolved = await lookup(host, { all: true });
  if (resolved.some((r) => isPrivateIp(r.address))) throw new Error('refusing to fetch a host that resolves to a private address');
}

/** Fetch with a hard streamed byte cap (a body with no/false Content-Length
 *  can't exhaust memory) and no redirects (can't bounce to an internal host). */
async function fetchCapped(url: string, max: number): Promise<{ bytes: Buffer; mime: string }> {
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Error(`asset too large: ${declared} bytes (max ${max})`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('empty response body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`asset too large (max ${max} bytes)`);
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), mime: res.headers.get('content-type') ?? 'application/octet-stream' };
}

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
    // Block SSRF (internal/metadata hosts) and cap the streamed body so a hostile
    // URL can't reach internal services or exhaust memory.
    await assertPublicUrl(url);
    const { bytes, mime: fetchedMime } = await fetchCapped(url, MAX_ASSET_BYTES);
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const resolvedMime = mime ?? fetchedMime ?? MIME[ext] ?? 'application/octet-stream';
    return wbPost(`/sites/${encodeURIComponent(siteId)}/assets`, {
      filename,
      mime: resolvedMime,
      base64: bytes.toString('base64'),
    });
  },
});
