import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import {
  contentTypeFor,
  createPublishTarget,
  projectNameFor,
  R2PublishTarget,
  slugifyProject,
  VercelApiTarget,
  type PublishTarget,
} from './publish-target.js';

describe('slugifyProject + projectNameFor + contentTypeFor', () => {
  it('produces stable DNS-safe project names', () => {
    expect(slugifyProject('Breakthrough Medical')).toBe('wb-breakthrough-medical');
    expect(slugifyProject('  Émile & Co!!  ')).toBe('wb-emile-co'); // accents transliterate
    expect(slugifyProject('___')).toBe('wb-site');
    expect(slugifyProject('x'.repeat(80)).length).toBeLessThanOrEqual(43);
  });

  it('never leaves a trailing hyphen even when truncation cuts mid-word', () => {
    // 39 chars then '-word' → slice(0,40) lands on the hyphen; it must be stripped.
    const name = `${'a'.repeat(39)}-bcdef`;
    expect(slugifyProject(name).endsWith('-')).toBe(false);
  });

  it('discriminates project names by siteId so same-named sites never collide', () => {
    const a = projectNameFor('Clinic', 'AbC12345xy');
    const b = projectNameFor('Clinic', 'ZZfoo99988');
    expect(a).not.toBe(b);
    expect(a).toBe('wb-clinic-c12345xy'); // slug + last-8 of lowercased id ('abc12345xy' → 'c12345xy')
    expect(a.startsWith('wb-clinic-')).toBe(true);
    // Deterministic: same inputs → same name (so republishing hits the same project).
    expect(projectNameFor('Clinic', 'AbC12345xy')).toBe(a);
    // An all-symbol name still yields a valid, id-discriminated name.
    expect(projectNameFor('***', 'Xy9').startsWith('wb-')).toBe(true);
  });

  it('maps extensions to content types with a safe, case-insensitive fallback', () => {
    expect(contentTypeFor('services/index.html')).toContain('text/html');
    expect(contentTypeFor('styles.css')).toContain('text/css');
    expect(contentTypeFor('assets/x.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('LOGO.PNG')).toBe('image/png'); // uppercase extension
    expect(contentTypeFor('photo.JPG')).toBe('image/jpeg');
    expect(contentTypeFor('font.WOFF2')).toBe('font/woff2');
    expect(contentTypeFor('mystery.bin')).toBe('application/octet-stream');
  });
});

describe('VercelApiTarget', () => {
  it('uploads each file by digest, then POSTs a body that only references shas', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).includes('/v2/files')) return new Response(JSON.stringify({ urls: [] }), { status: 200 });
      // readyState READY on the POST → no follow-up polling.
      return new Response(
        JSON.stringify({ url: 'wb-my-clinic-s1-abc123.vercel.app', id: 'dpl_1', readyState: 'READY' }),
        { status: 200 },
      );
    }) as typeof fetch;

    const target = new VercelApiTarget({ token: 'tok', teamId: 'team_1', fetchFn });
    const html = '<!doctype html><h1>Hi</h1>';
    const files = new Map<string, string | Uint8Array>([
      ['index.html', html],
      ['assets/logo.svg', new Uint8Array([60, 115, 118, 103, 62])],
    ]);
    const result = await target.deploy({ siteId: 's1', siteName: 'My Clinic', files });

    const uploads = calls.filter((c) => c.url.includes('/v2/files'));
    const deploys = calls.filter((c) => c.url.includes('/v13/deployments'));
    expect(uploads).toHaveLength(2);
    expect(deploys).toHaveLength(1);

    // The digest is of the raw bytes, and the raw bytes are what's sent.
    const htmlSha = createHash('sha1').update(Buffer.from(html)).digest('hex');
    const htmlUpload = uploads.find((c) => (c.init.headers as Record<string, string>)['x-vercel-digest'] === htmlSha);
    expect(htmlUpload).toBeDefined();
    expect(htmlUpload!.url).toBe('https://api.vercel.com/v2/files?teamId=team_1');
    expect((htmlUpload!.init.headers as Record<string, string>)['content-length']).toBe(String(html.length));
    expect(Buffer.from(htmlUpload!.init.body as Uint8Array).toString()).toBe(html);

    expect(deploys[0]!.url).toBe('https://api.vercel.com/v13/deployments?teamId=team_1');
    const body = JSON.parse(deploys[0]!.init.body as string) as {
      name: string;
      target: string;
      files: Array<{ file: string; sha: string; size: number; data?: string }>;
    };
    // Project name is discriminated by siteId so same-named sites can't collide.
    expect(body.name).toBe('wb-my-clinic-s1');
    expect(body.target).toBe('production');
    expect(body.files.map((f) => f.file).sort()).toEqual(['assets/logo.svg', 'index.html']);
    const entry = body.files.find((f) => f.file === 'index.html')!;
    expect(entry.sha).toBe(htmlSha);
    expect(entry.size).toBe(html.length);
    // The whole point: no bytes in the deployment body.
    expect(entry.data).toBeUndefined();
    expect((deploys[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');

    expect(result.url).toBe('https://wb-my-clinic-s1.vercel.app');
    expect(result.detail).toContain('live');
  });

  it('keeps the deployment body small no matter how heavy the site is', async () => {
    // The regression: six generated hero images used to be base64-inlined into
    // one POST, which Vercel rejects with "Request body too large. Limit: 10mb".
    let deployBodyBytes = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/v2/files')) return new Response('{}', { status: 200 });
      deployBodyBytes = Buffer.byteLength(init!.body as string);
      return new Response(JSON.stringify({ url: 'big.vercel.app', id: 'dpl_big', readyState: 'READY' }), {
        status: 200,
      });
    }) as typeof fetch;

    const files = new Map<string, string | Uint8Array>([['index.html', '<h1>x</h1>']]);
    for (let i = 0; i < 6; i++) files.set(`assets/hero-${i}.png`, new Uint8Array(1_600_000).fill(i + 1));
    const total = [...files.values()].reduce((n, v) => n + Buffer.from(v as Uint8Array).byteLength, 0);
    expect(total).toBeGreaterThan(9_000_000); // base64 of this is ~12.8 MB — over the limit

    const target = new VercelApiTarget({ token: 't', fetchFn });
    await expect(target.deploy({ siteId: 's', siteName: 'Heavy', files })).resolves.toBeTruthy();
    expect(deployBodyBytes).toBeLessThan(2_000);
  });

  it('fails the deploy when an upload cannot be completed, rather than shipping a missing image', async () => {
    let attempts = 0;
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes('/v2/files')) {
        attempts++;
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      }
      return new Response(JSON.stringify({ url: 'x.vercel.app', id: 'd', readyState: 'READY' }), { status: 200 });
    }) as typeof fetch;

    const target = new VercelApiTarget({ token: 't', fetchFn });
    await expect(
      target.deploy({ siteId: 's', siteName: 'X', files: new Map([['index.html', 'x']]) }),
    ).rejects.toThrow(/upload of "index\.html" failed/);
    expect(attempts).toBe(2); // one retry, because the request is digest-addressed and idempotent
  });

  it('waits for the deployment to go READY before reporting success', async () => {
    const states = ['BUILDING', 'BUILDING', 'READY'];
    let poll = 0;
    const gets: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ url: 'dep.vercel.app', id: 'dpl_9', readyState: 'QUEUED' }), { status: 200 });
      }
      gets.push(String(url));
      return new Response(JSON.stringify({ readyState: states[poll++] ?? 'READY' }), { status: 200 });
    }) as typeof fetch;

    const target = new VercelApiTarget({ token: 't', fetchFn, pollIntervalMs: 0, maxPolls: 10 });
    const result = await target.deploy({ siteId: 's', siteName: 'X', files: new Map([['index.html', 'x']]) });
    expect(gets.length).toBe(3); // BUILDING, BUILDING, READY
    expect(gets[0]).toBe('https://api.vercel.com/v13/deployments/dpl_9');
    expect(result.detail).toContain('live');
  });

  it('throws when the deployment ends in ERROR', async () => {
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ url: 'dep.vercel.app', id: 'dpl_e', readyState: 'QUEUED' }), { status: 200 });
      }
      return new Response(JSON.stringify({ readyState: 'ERROR' }), { status: 200 });
    }) as typeof fetch;
    const target = new VercelApiTarget({ token: 't', fetchFn, pollIntervalMs: 0, maxPolls: 5 });
    await expect(
      target.deploy({ siteId: 's', siteName: 'X', files: new Map([['index.html', 'x']]) }),
    ).rejects.toThrow(/error/i);
  });

  it('surfaces API errors readably, even with a non-JSON body', async () => {
    // Uploads succeed; the deployment call is what refuses — so the message the
    // caller sees is the deployment's, not a generic upload failure.
    const ok = (url: string | URL | Request) => String(url).includes('/v2/files');
    const fetchFn = (async (url: string | URL | Request) =>
      ok(url)
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'invalid token' } }), {
            status: 403,
          })) as unknown as typeof fetch;
    const target = new VercelApiTarget({ token: 'bad', fetchFn });
    await expect(
      target.deploy({ siteId: 's', siteName: 'X', files: new Map([['index.html', 'x']]) }),
    ).rejects.toThrow(/403.*invalid token/);

    const htmlFetch = (async (url: string | URL | Request) =>
      ok(url)
        ? new Response('{}', { status: 200 })
        : new Response('<html>Gateway Timeout</html>', { status: 504 })) as unknown as typeof fetch;
    const t2 = new VercelApiTarget({ token: 'x', fetchFn: htmlFetch });
    await expect(
      t2.deploy({ siteId: 's', siteName: 'X', files: new Map([['index.html', 'x']]) }),
    ).rejects.toThrow(/504.*Gateway/);
  });
});

describe('R2PublishTarget', () => {
  it('clears the previous build then uploads with content types', async () => {
    const sent: Array<{ kind: string; input: Record<string, unknown> }> = [];
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ kind: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return { Contents: [{ Key: 'site1/old.html' }], IsTruncated: false };
        }
        return {};
      },
    };
    const target = new R2PublishTarget({
      bucket: 'wb-sites',
      accessKeyId: 'k',
      secretAccessKey: 's',
      publicUrl: 'https://sites.example.com',
      client: client as never,
    });
    const files = new Map<string, string | Uint8Array>([
      ['index.html', '<h1>x</h1>'],
      ['styles.css', 'body{}'],
    ]);
    const result = await target.deploy({ siteId: 'site1', siteName: 'X', files });

    const kinds = sent.map((s) => s.kind);
    expect(kinds[0]).toBe('ListObjectsV2Command');
    expect(kinds).toContain('DeleteObjectsCommand');
    const puts = sent.filter((s) => s.kind === 'PutObjectCommand');
    expect(puts.map((p) => p.input.Key).sort()).toEqual(['site1/index.html', 'site1/styles.css']);
    expect(puts.find((p) => p.input.Key === 'site1/styles.css')!.input.ContentType).toContain('text/css');
    expect(result.url).toBe('https://sites.example.com/site1/index.html');
  });
});

describe('createPublishTarget selection', () => {
  it('returns null when unset and validates required vars', () => {
    expect(createPublishTarget({})).toBeNull();
    expect(() => createPublishTarget({ WB_PUBLISH_TARGET: 'vercel' })).toThrow(/WB_VERCEL_TOKEN/);
    expect(() => createPublishTarget({ WB_PUBLISH_TARGET: 'r2' })).toThrow(/WB_PUBLISH_S3_BUCKET/);
    expect(
      createPublishTarget({ WB_PUBLISH_TARGET: 'vercel', WB_VERCEL_TOKEN: 't' }),
    ).toBeInstanceOf(VercelApiTarget);
    expect(
      createPublishTarget({
        WB_PUBLISH_TARGET: 'r2',
        WB_PUBLISH_S3_BUCKET: 'b',
        WB_S3_ACCESS_KEY_ID: 'k',
        WB_S3_SECRET_ACCESS_KEY: 's',
      }),
    ).toBeInstanceOf(R2PublishTarget);
  });
});

describe('WbCore.deploySite (fully serverless path)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wb-deploy-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('renders the complete site in memory and hands it to the target', async () => {
    const received: Array<{ siteId: string; siteName: string; files: Map<string, string | Uint8Array> }> = [];
    const fake: PublishTarget = {
      name: 'fake',
      deploy: async (input) => {
        received.push(input);
        return { url: 'https://live.example.com', detail: 'ok' };
      },
    };
    const core = await WbCore.create({ dataDir, publishTarget: fake });
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'Deploy Clinic');

    const result = await core.deploySite(site.id);
    expect(result.url).toBe('https://live.example.com');
    expect(result.target).toBe('fake');
    expect(result.pageCount).toBe(4);

    const files = received[0]!.files;
    // Complete build: pages, css, seo files, AND asset bytes — all in memory.
    for (const key of ['index.html', 'services/index.html', 'styles.css', 'robots.txt', '404.html']) {
      expect(files.has(key), key).toBe(true);
    }
    const assetKeys = [...files.keys()].filter((k) => k.startsWith('assets/'));
    expect(assetKeys.length).toBe(3); // logo, hero, about svgs
    expect(Buffer.from(files.get(assetKeys[0]!) as Uint8Array).length).toBeGreaterThan(0);

    // The deploy is recorded as a build pointing at the live URL.
    const builds = await core.listBuilds(site.id);
    expect(builds[0]!.manifest.distPath).toBe('https://live.example.com');
    core.close();
  });

  it('throws a helpful error when no target is configured', async () => {
    const core = await WbCore.create({ dataDir, publishTarget: null });
    const site = await core.createSite('NoTarget');
    await expect(core.deploySite(site.id)).rejects.toThrow(/WB_PUBLISH_TARGET/);
    core.close();
  });
});
