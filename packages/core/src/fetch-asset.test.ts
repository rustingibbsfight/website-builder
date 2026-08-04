import { describe, expect, it } from 'vitest';

import {
  assertPublicUrl,
  fetchAsset,
  fetchCapped,
  guessMime,
  isPrivateIp,
  resolveMime,
  MAX_ASSET_BYTES,
  UNKNOWN_MIME,
} from './fetch-asset.js';

/** A response whose body arrives in chunks, so the streamed cap is exercised
 *  rather than the declared length. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers });
}

const never = (() => {
  throw new Error('fetch should not have been attempted');
}) as unknown as typeof fetch;

/** Resolves every name to whatever address the test names. */
const resolvingTo = (address: string) =>
  (async () => [{ address, family: address.includes(':') ? 6 : 4 }]) as never;

describe('assertPublicUrl', () => {
  it('refuses anything that is not http(s)', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi', 'ftp://host/f']) {
      await expect(assertPublicUrl(url, { lookupFn: resolvingTo('93.184.216.34') })).rejects.toThrow(
        /only http/i,
      );
    }
  });

  it('refuses a malformed url before anything else looks at it', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/invalid url/i);
  });

  it('refuses loopback, private, link-local and metadata addresses by literal', async () => {
    const hostile = [
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data/', // the one that matters
      'http://0.0.0.0/x',
      'http://[::1]/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
    ];
    for (const url of hostile) {
      await expect(assertPublicUrl(url, { lookupFn: never as never }), url).rejects.toThrow(
        /private|internal/i,
      );
    }
  });

  it('refuses localhost by name, including a subdomain of it', async () => {
    await expect(assertPublicUrl('http://localhost/x')).rejects.toThrow(/local/i);
    await expect(assertPublicUrl('http://api.localhost/x')).rejects.toThrow(/local/i);
  });

  /**
   * The attack the literal checks cannot see: a name that is public in every
   * visible way and resolves to the metadata service. This is why the guard
   * resolves rather than pattern-matching the host.
   */
  it('refuses a public name that resolves to a private address', async () => {
    await expect(
      assertPublicUrl('https://totally-fine.example.com/logo.png', {
        lookupFn: resolvingTo('169.254.169.254'),
      }),
    ).rejects.toThrow(/resolves to a private/i);
  });

  it('refuses when only one of several answers is private', async () => {
    const lookupFn = (async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]) as never;
    await expect(assertPublicUrl('https://mixed.example.com/x', { lookupFn })).rejects.toThrow(
      /resolves to a private/i,
    );
  });

  it('allows an ordinary public host', async () => {
    await expect(
      assertPublicUrl('https://example.com/logo.png', { lookupFn: resolvingTo('93.184.216.34') }),
    ).resolves.toBeUndefined();
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:93.184.216.34')).toBe(false);
  });
});

describe('fetchCapped', () => {
  it('refuses a redirect rather than following it', async () => {
    // A public URL that 302s to an internal one defeats a guard that ran
    // before the redirect, so the fetch declines to follow at all.
    let seen: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return streamed([new Uint8Array([1, 2, 3])]);
    }) as unknown as typeof fetch;
    await fetchCapped('https://example.com/a.png', MAX_ASSET_BYTES, { fetchFn });
    expect(seen?.redirect).toBe('error');
  });

  /**
   * The body here is three bytes — well under the cap — while the header claims
   * more than the cap. Reading it would succeed, so a rejection can only have
   * come from the declared length, which is the cheap refusal that avoids
   * pulling a large body at all.
   */
  it('refuses on the declared length alone, before the body is read', async () => {
    const fetchFn = (async () =>
      streamed([new Uint8Array([1, 2, 3])], {
        'content-length': String(MAX_ASSET_BYTES + 1),
      })) as never;
    await expect(
      fetchCapped('https://example.com/big.png', MAX_ASSET_BYTES, { fetchFn }),
    ).rejects.toThrow(new RegExp(`asset too large: ${MAX_ASSET_BYTES + 1} bytes`));
  });

  /**
   * The declared length is a claim. A server that lies about it — or omits it
   * — is precisely the one trying to exhaust memory, so the cap is enforced on
   * the bytes as they arrive.
   */
  it('refuses mid-stream when the body exceeds the cap despite a lying header', async () => {
    const fetchFn = (async () =>
      streamed([new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)], {
        'content-length': '4',
      })) as never;
    await expect(fetchCapped('https://example.com/lies.png', 16, { fetchFn })).rejects.toThrow(/too large/i);
  });

  it('surfaces a non-ok status rather than storing an error page as an image', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as never;
    await expect(fetchCapped('https://example.com/gone.png', MAX_ASSET_BYTES, { fetchFn })).rejects.toThrow(
      /404/,
    );
  });

  it('joins the chunks in order', async () => {
    const fetchFn = (async () =>
      streamed([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])])) as never;
    const { bytes } = await fetchCapped('https://example.com/a.png', MAX_ASSET_BYTES, { fetchFn });
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('fetchAsset', () => {
  const ok = (headers: Record<string, string> = {}) =>
    (async () => streamed([new Uint8Array([1, 2, 3])], headers)) as never;
  const lookupFn = resolvingTo('93.184.216.34');

  it('guards before it fetches', async () => {
    await expect(
      fetchAsset('http://169.254.169.254/latest/meta-data/', { fetchFn: never, lookupFn }),
    ).rejects.toThrow(/private|internal/i);
  });

  it('prefers the caller-supplied mime over everything', async () => {
    const { mime } = await fetchAsset('https://example.com/a.bin', {
      fetchFn: ok({ 'content-type': 'image/png' }),
      lookupFn,
      filename: 'a.gif',
      mime: 'image/webp',
    });
    expect(mime).toBe('image/webp');
  });

  it('prefers the response over the filename — the server serving it knows more', async () => {
    const { mime } = await fetchAsset('https://example.com/a.bin', {
      fetchFn: ok({ 'content-type': 'image/png' }),
      lookupFn,
      filename: 'a.gif',
    });
    expect(mime).toBe('image/png');
  });

  it('falls back to the filename when the response says nothing useful', async () => {
    const { mime } = await fetchAsset('https://example.com/a', {
      fetchFn: ok(),
      lookupFn,
      filename: 'logo.svg',
    });
    expect(mime).toBe('image/svg+xml');
  });

  it('ends at the unknown fallback rather than inventing a type', async () => {
    const { mime } = await fetchAsset('https://example.com/a', {
      fetchFn: ok(),
      lookupFn,
      filename: 'mystery.qqq',
    });
    expect(mime).toBe(UNKNOWN_MIME);
  });
});

describe('resolveMime', () => {
  it('runs caller → response → filename → unknown', () => {
    expect(resolveMime('image/webp', 'image/png', 'a.gif')).toBe('image/webp');
    expect(resolveMime(undefined, 'image/png', 'a.gif')).toBe('image/png');
    expect(resolveMime(undefined, undefined, 'a.gif')).toBe('image/gif');
    expect(resolveMime(undefined, undefined, undefined)).toBe(UNKNOWN_MIME);
  });

  /**
   * A response that says `application/octet-stream` has told us nothing, so it
   * must not beat a filename that says `.svg`. Treating the fallback as an
   * answer is how an SVG gets stored as a generic blob and stops rendering.
   */
  it('does not let the unknown fallback outrank the filename', () => {
    expect(resolveMime(undefined, UNKNOWN_MIME, 'logo.svg')).toBe('image/svg+xml');
  });
});

describe('guessMime', () => {
  it('reads the extension, case-insensitively', () => {
    expect(guessMime('LOGO.PNG')).toBe('image/png');
    expect(guessMime('a.jpeg')).toBe('image/jpeg');
  });

  it('answers the fallback for an extension it does not know', () => {
    expect(guessMime('notes')).toBe(UNKNOWN_MIME);
    expect(guessMime('a.xyz')).toBe(UNKNOWN_MIME);
  });
});
