/**
 * Fetching a file somebody named by URL, once.
 *
 * Three surfaces let an agent or an operator say "put the picture at this
 * address into this site": the MCP `add_asset` tool, Eve's `add_asset` tool,
 * and — once image generation lands — the ingest step that pulls a finished
 * render out of ComfyStudio. Every one of them is a request from our own
 * server to an address a stranger chose, which is the definition of SSRF, and
 * every one of them streams a body of unknown size into memory.
 *
 * Two of those three had already grown their own copy of the guard. They were
 * near-identical, which is the dangerous kind: close enough that a reader
 * assumes they are the same, far enough apart that a fix to one silently
 * leaves the other exploitable. The MCP copy returned a `Uint8Array` and the
 * Eve copy a `Buffer`; the MCP copy's error said "private/internal" and Eve's
 * said "private". Nobody would have noticed the day one of them stopped
 * resolving hostnames.
 *
 * So this is the only implementation, and the surfaces call it.
 *
 * The rules it encodes, each of which is a thing an attacker tried:
 *
 * - **Only http(s).** `file:`, `gopher:` and friends read the disk or speak
 *   protocols the fetch layer was never audited for.
 * - **The hostname is resolved and every answer checked**, not just the ones
 *   that look like an address. `169.254.169.254` is obvious; a public DNS
 *   record that returns it is the actual attack.
 * - **Redirects are refused outright** rather than followed and re-checked. A
 *   public URL that 302s to an internal one defeats a check that ran before
 *   the redirect, and re-checking each hop is a loop somebody eventually gets
 *   wrong.
 * - **The cap is enforced on the stream, not on `content-length`.** A header
 *   is a claim; the bytes are the fact, and a server that lies about the
 *   length is exactly the one trying to exhaust memory. The declared length is
 *   still checked first, because refusing before reading anything is cheaper.
 *
 * `fetchFn` and `lookupFn` are injectable for the same reason `notify.ts`
 * injects `fetch`: a test that has to reach the network to prove a guard works
 * is a test that gets skipped.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ValidationError } from './errors.js';

/** Cap fetched assets so a hostile or oversized URL can't exhaust memory or
 *  blow the API body limit (30 MB). */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** The fallback when nothing — not the caller, not the response, not the
 *  extension — knows what the bytes are. */
export const UNKNOWN_MIME = 'application/octet-stream';

/** MIME from a filename's extension, or the unknown fallback. */
export function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXTENSION[ext] ?? UNKNOWN_MIME;
}

/** True for loopback / private / link-local / unique-local / metadata IPs. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    );
  }
  const lo = ip.toLowerCase();
  if (lo === '::1' || lo === '::') return true;
  if (lo.startsWith('::ffff:')) return isPrivateIp(lo.slice(7)); // IPv4-mapped
  return lo.startsWith('fe80') || lo.startsWith('fc') || lo.startsWith('fd'); // link-local / unique-local
}

export interface FetchAssetDeps {
  /** Injected in tests so a guard can be proven without reaching the network. */
  fetchFn?: typeof fetch;
  /** Injected in tests so "a public name resolving to a private address" —
   *  the case that matters and the one nobody can arrange on demand — is
   *  reachable. */
  lookupFn?: typeof dnsLookup;
}

/**
 * Reject non-http(s), and any URL whose host is — or resolves to — an internal
 * address.
 *
 * Throws rather than returning a boolean: a guard whose result can be ignored
 * is one that will be, and there is no useful "unsafe but continue" path.
 */
export async function assertPublicUrl(raw: string, deps: FetchAssetDeps = {}): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ValidationError('only http(s) asset urls are allowed');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new ValidationError('refusing to fetch a local address');
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new ValidationError('refusing to fetch a private/internal address');
    return;
  }
  const resolved = await (deps.lookupFn ?? dnsLookup)(host, { all: true });
  if (resolved.some((r) => isPrivateIp(r.address))) {
    throw new ValidationError('refusing to fetch a host that resolves to a private/internal address');
  }
}

/**
 * Fetch with a hard streamed byte cap and no redirects.
 *
 * Returns a `Uint8Array` rather than a `Buffer` so this module stays usable
 * from anywhere; callers that need a `Buffer` can wrap it without a copy.
 */
export async function fetchCapped(
  url: string,
  max: number = MAX_ASSET_BYTES,
  deps: FetchAssetDeps = {},
): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await (deps.fetchFn ?? fetch)(url, { redirect: 'error' });
  if (!res.ok) throw new ValidationError(`fetch ${url} failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    throw new ValidationError(`asset too large: ${declared} bytes (max ${max})`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new ValidationError('empty response body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ValidationError(`asset too large (max ${max} bytes)`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mime: res.headers.get('content-type') ?? UNKNOWN_MIME };
}

export interface FetchAssetOptions extends FetchAssetDeps {
  /** Used only to infer a MIME when neither the caller nor the response says. */
  filename?: string;
  /** The caller's own answer, which wins over both. */
  mime?: string;
  max?: number;
}

/**
 * Settle on a MIME: caller → response → filename → unknown.
 *
 * The caller wins because it is the only one that can be *told*. The response
 * beats the filename because a server serving the file knows more about it
 * than the last three characters of a name somebody typed.
 *
 * Separate from `fetchAsset` because two callers need the same precedence
 * around a differently-ordered set of steps, and a precedence rule written
 * twice is a precedence rule that will eventually disagree with itself.
 */
export function resolveMime(
  callerMime: string | undefined,
  responseMime: string | undefined,
  filename: string | undefined,
): string {
  const fromResponse = responseMime && responseMime !== UNKNOWN_MIME ? responseMime : undefined;
  const guessed = filename ? guessMime(filename) : undefined;
  const fromFilename = guessed && guessed !== UNKNOWN_MIME ? guessed : undefined;
  return callerMime ?? fromResponse ?? fromFilename ?? UNKNOWN_MIME;
}

/**
 * Guard, fetch, and settle on a MIME — the whole of "get me those bytes".
 *
 * Callers that have their own work to do between the guard passing and the
 * fetch starting — `WbCore.addAssetFromUrl` checks the site exists there —
 * compose the three steps themselves rather than calling this twice. Running
 * `assertPublicUrl` a second time would mean a second DNS lookup, and a second
 * answer that could differ from the first is the rebinding window widened
 * rather than closed.
 */
export async function fetchAsset(
  url: string,
  options: FetchAssetOptions = {},
): Promise<{ bytes: Uint8Array; mime: string }> {
  await assertPublicUrl(url, options);
  const fetched = await fetchCapped(url, options.max ?? MAX_ASSET_BYTES, options);
  return { bytes: fetched.bytes, mime: resolveMime(options.mime, fetched.mime, options.filename) };
}
