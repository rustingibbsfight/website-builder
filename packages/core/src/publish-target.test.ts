import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import {
  contentTypeFor,
  createPublishTarget,
  R2PublishTarget,
  slugifyProject,
  VercelApiTarget,
  type PublishTarget,
} from './publish-target.js';

describe('slugifyProject + contentTypeFor', () => {
  it('produces stable DNS-safe project names', () => {
    expect(slugifyProject('Breakthrough Medical')).toBe('wb-breakthrough-medical');
    expect(slugifyProject('  Émile & Co!!  ')).toBe('wb-emile-co'); // accents transliterate
    expect(slugifyProject('___')).toBe('wb-site');
    expect(slugifyProject('x'.repeat(80)).length).toBeLessThanOrEqual(43);
  });

  it('maps extensions to content types with a safe fallback', () => {
    expect(contentTypeFor('services/index.html')).toContain('text/html');
    expect(contentTypeFor('styles.css')).toContain('text/css');
    expect(contentTypeFor('assets/x.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('mystery.bin')).toBe('application/octet-stream');
  });
});

describe('VercelApiTarget', () => {
  it('POSTs base64-inlined files to v13/deployments and returns the project URL', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ url: 'wb-my-clinic-abc123.vercel.app', id: 'dpl_1' }), { status: 200 });
    }) as typeof fetch;

    const target = new VercelApiTarget({ token: 'tok', teamId: 'team_1', fetchFn });
    const files = new Map<string, string | Uint8Array>([
      ['index.html', '<!doctype html><h1>Hi</h1>'],
      ['assets/logo.svg', new Uint8Array([60, 115, 118, 103, 62])],
    ]);
    const result = await target.deploy({ siteId: 's1', siteName: 'My Clinic', files });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.vercel.com/v13/deployments?teamId=team_1');
    const body = JSON.parse(calls[0]!.init.body as string) as {
      name: string;
      target: string;
      files: Array<{ file: string; data: string; encoding: string }>;
    };
    expect(body.name).toBe('wb-my-clinic');
    expect(body.target).toBe('production');
    expect(body.files.map((f) => f.file).sort()).toEqual(['assets/logo.svg', 'index.html']);
    expect(Buffer.from(body.files.find((f) => f.file === 'index.html')!.data, 'base64').toString()).toContain('Hi');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');

    expect(result.url).toBe('https://wb-my-clinic.vercel.app');
    expect(result.detail).toContain('wb-my-clinic-abc123.vercel.app');
  });

  it('surfaces API errors readably', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: { message: 'invalid token' } }), { status: 403 })) as unknown as typeof fetch;
    const target = new VercelApiTarget({ token: 'bad', fetchFn });
    await expect(
      target.deploy({ siteId: 's', siteName: 'X', files: new Map([['index.html', 'x']]) }),
    ).rejects.toThrow(/403.*invalid token/);
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
