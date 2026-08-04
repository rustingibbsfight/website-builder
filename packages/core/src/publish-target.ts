import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * A destination that can take a fully-rendered site (an in-memory file map)
 * and make it live on the public internet — via provider HTTP APIs only, so
 * it works from serverless functions with no CLI and no persistent disk.
 */
export interface PublishTarget {
  readonly name: string;
  deploy(input: {
    siteId: string;
    siteName: string;
    files: Map<string, string | Uint8Array>;
  }): Promise<{ url: string; detail?: string }>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  // Extensions are matched case-insensitively (e.g. LOGO.PNG, photo.JPG).
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Deterministic, DNS-safe project name from a site name. */
export function slugifyProject(name: string, prefix = 'wb-'): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    // A truncating slice can re-expose a trailing hyphen ("clinic-of-…-" → strip it).
    .replace(/-+$/, '');
  return `${prefix}${slug || 'site'}`;
}

/**
 * Project name that is unique per site, not just per site *name*. Two sites
 * both called "Clinic" must not deploy over each other, so a short stable
 * discriminator derived from the (immutable) siteId is appended. Republishing
 * the same site keeps the same name → same project → same domain.
 */
export function projectNameFor(siteName: string, siteId: string, prefix = 'wb-'): string {
  const base = slugifyProject(siteName, ''); // slug only (no prefix), already bounded to 40
  const disc = siteId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-8) || 'x';
  const slug = base === 'site' ? disc : `${base}-${disc}`;
  return `${prefix}${slug}`;
}

/** Parse a Response body as JSON without throwing on empty/non-JSON payloads. */
async function readJsonSafe(res: { text(): Promise<string> }): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { _raw: parsed };
  } catch {
    return { _raw: text };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface VercelApiTargetConfig {
  token: string;
  teamId?: string;
  /** Prefix for auto-created project names (default "wb-"). */
  projectPrefix?: string;
  /** Poll interval (ms) while waiting for a deployment to go READY. Default 2000. */
  pollIntervalMs?: number;
  /** Max readiness polls before returning while-still-building. Default 45 (~90s). */
  maxPolls?: number;
  /** Parallel file uploads. Default 8. */
  uploadConcurrency?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

const VERCEL_TERMINAL_STATES = new Set(['READY', 'ERROR', 'CANCELED']);

/**
 * Deploys via the Vercel Deployments API (v13), no CLI. The project name is
 * derived deterministically from the site id (not just its name), so
 * republishing updates the same project (and its <project>.vercel.app domain /
 * any custom domains attached to it) while two same-named sites never clobber
 * each other.
 *
 * Files are **uploaded first and referenced by digest**, not inlined as base64
 * in the deployment body. Inlining is one fewer round trip and it works right
 * up until it doesn't: the deployments endpoint caps a request body at 10 MB,
 * base64 inflates bytes by a third, and a site with half a dozen generated
 * hero images clears that without looking large. What came back was
 * `400 Request body too large`, several layers below the person who had just
 * asked for their site to go live.
 *
 * So every file goes to `/v2/files` keyed by the SHA-1 of its bytes, and the
 * deployment body carries `{file, sha, size}` — a few hundred bytes whatever
 * the site weighs. Deliberately not a size-triggered fallback: a second path
 * taken only by unusually heavy sites is a path that is broken most of the time
 * and nobody finds out until the day it is needed.
 */
export class VercelApiTarget implements PublishTarget {
  readonly name = 'vercel-api';
  private fetchFn: typeof fetch;

  constructor(private cfg: VercelApiTargetConfig) {
    this.fetchFn = cfg.fetchFn ?? fetch;
  }

  private get authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.token}` };
  }

  private get query(): string {
    return this.cfg.teamId ? `?teamId=${encodeURIComponent(this.cfg.teamId)}` : '';
  }

  async deploy({ siteId, siteName, files }: { siteId: string; siteName: string; files: Map<string, string | Uint8Array> }) {
    const project = projectNameFor(siteName, siteId, this.cfg.projectPrefix ?? 'wb-');
    const uploads = [...files].map(([file, data]) => {
      const bytes = Buffer.from(data as Uint8Array);
      return { file, bytes, sha: createHash('sha1').update(bytes).digest('hex'), size: bytes.byteLength };
    });
    await this.uploadFiles(uploads);
    const body = {
      name: project,
      target: 'production',
      projectSettings: { framework: null },
      files: uploads.map(({ file, sha, size }) => ({ file, sha, size })),
    };
    const res = await this.fetchFn(`https://api.vercel.com/v13/deployments${this.query}`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await readJsonSafe(res);
    const url = typeof payload.url === 'string' ? payload.url : undefined;
    if (!res.ok || !url) {
      const err = payload.error as { message?: string } | undefined;
      const detail = err?.message ?? (typeof payload._raw === 'string' ? payload._raw.slice(0, 300) : 'unknown error');
      throw new Error(`vercel deploy failed (${res.status}): ${detail}`);
    }

    // Don't report success until Vercel finishes building — a 200 on POST only
    // means the deployment was accepted (QUEUED/BUILDING), not that it's live.
    const id = typeof payload.id === 'string' ? payload.id : undefined;
    const state = await this.waitUntilReady(id, typeof payload.readyState === 'string' ? payload.readyState : undefined);
    if (state === 'ERROR' || state === 'CANCELED') {
      throw new Error(`vercel deployment ${state.toLowerCase()} for project "${project}" (${url})`);
    }
    const status = state === 'READY' ? 'live' : `still building (last state ${state})`;
    return {
      url: `https://${project}.vercel.app`,
      detail: `deployment https://${url} ${status} on project "${project}"`,
    };
  }

  /**
   * Put every file where the deployment can reference it by digest.
   *
   * Bounded concurrency rather than one `Promise.all` over the whole map: a
   * site with a hundred files would otherwise open a hundred sockets from a
   * serverless function and get itself rate-limited.
   *
   * A failure here is fatal to the deploy, and that is the point — a
   * deployment that references a sha nobody uploaded builds into a site with a
   * missing image, which is far worse than not deploying at all.
   */
  private async uploadFiles(uploads: ReadonlyArray<{ file: string; bytes: Buffer; sha: string; size: number }>): Promise<void> {
    const limit = Math.min(this.cfg.uploadConcurrency ?? 8, uploads.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: limit }, async () => {
        for (let i = next++; i < uploads.length; i = next++) await this.uploadFile(uploads[i]!);
      }),
    );
  }

  private async uploadFile(upload: { file: string; bytes: Buffer; sha: string; size: number }): Promise<void> {
    // One retry, because a single dropped upload fails a deploy that is
    // otherwise fine and the request is idempotent — it is addressed by the
    // digest of its own bytes, so sending it twice cannot produce two things.
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<typeof fetch>> | undefined;
      try {
        res = await this.fetchFn(`https://api.vercel.com/v2/files${this.query}`, {
          method: 'POST',
          headers: {
            ...this.authHeaders,
            'content-type': 'application/octet-stream',
            'content-length': String(upload.size),
            'x-vercel-digest': upload.sha,
          },
          body: new Uint8Array(upload.bytes),
        });
        if (res.ok) return;
      } catch {
        // Network blip — falls through to the retry/throw below.
      }
      if (attempt >= 1) {
        const detail = res ? `${res.status}: ${(await readJsonSafe(res)).error ?? ''}`.trim() : 'network error';
        throw new Error(`vercel upload of "${upload.file}" failed (${detail})`);
      }
    }
  }

  /** Poll the deployment until it reaches a terminal state or the budget runs out. */
  private async waitUntilReady(id: string | undefined, initial: string | undefined): Promise<string> {
    let state = initial ?? 'QUEUED';
    if (!id || VERCEL_TERMINAL_STATES.has(state)) return state;
    const interval = this.cfg.pollIntervalMs ?? 2000;
    const maxPolls = this.cfg.maxPolls ?? 45;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(interval);
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await this.fetchFn(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}${this.query}`, {
          headers: this.authHeaders,
        });
      } catch {
        continue; // transient network blip — keep polling within the budget
      }
      const data = await readJsonSafe(res);
      if (typeof data.readyState === 'string') state = data.readyState;
      if (VERCEL_TERMINAL_STATES.has(state)) break;
    }
    return state;
  }
}

export interface R2PublishTargetConfig {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL the bucket is served from (custom domain / r2.dev). */
  publicUrl?: string;
  /** Injectable for tests. */
  client?: Pick<S3Client, 'send'>;
}

/**
 * Uploads the rendered site to a (public) R2/S3 bucket under the site's id,
 * replacing any previous build. Serve the bucket via an R2 custom domain.
 * Note R2 serves exact keys: link internally with explicit paths or add a
 * Cloudflare transform rule mapping "/x/" → "/x/index.html" for clean URLs.
 */
export class R2PublishTarget implements PublishTarget {
  readonly name = 'r2';
  private client: Pick<S3Client, 'send'>;

  constructor(private cfg: R2PublishTargetConfig) {
    this.client =
      cfg.client ??
      new S3Client({
        region: cfg.region ?? 'auto',
        ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
  }

  async deploy({ siteId, files }: { siteId: string; siteName: string; files: Map<string, string | Uint8Array> }) {
    const prefix = `${siteId}/`;

    // Enumerate the previous build's keys BEFORE touching anything, so we can
    // diff. We never delete-then-upload — that would leave the site 404ing for
    // the whole upload window. Instead: upload the new build over the top, then
    // delete only the keys that are no longer part of it.
    const existing = new Set<string>();
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of listed.Contents ?? []) if (o.Key) existing.add(o.Key);
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    const written = new Set<string>();
    for (const [path, data] of files) {
      const key = `${prefix}${path}`;
      written.add(key);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Body: typeof data === 'string' ? Buffer.from(data) : data,
          ContentType: contentTypeFor(path),
        }),
      );
    }

    // Now that the new build is fully live, prune keys it replaced. S3/R2
    // DeleteObjects caps at 1000 keys per call, so chunk it.
    const stale = [...existing].filter((k) => !written.has(k)).map((Key) => ({ Key }));
    for (let i = 0; i < stale.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: stale.slice(i, i + 1000) } }),
      );
    }

    const base = this.cfg.publicUrl?.replace(/\/$/, '');
    return {
      url: base ? `${base}/${siteId}/index.html` : `r2://${this.cfg.bucket}/${prefix}`,
      detail: `${files.size} files uploaded to ${this.cfg.bucket}/${prefix}${stale.length ? `, ${stale.length} stale removed` : ''}`,
    };
  }
}

/**
 * Select the publish target from environment.
 *   WB_PUBLISH_TARGET=vercel  → Vercel API (WB_VERCEL_TOKEN, optional
 *                               WB_VERCEL_TEAM_ID, WB_VERCEL_PROJECT_PREFIX)
 *   WB_PUBLISH_TARGET=r2      → R2/S3 upload (WB_PUBLISH_S3_BUCKET + the
 *                               WB_S3_* credentials, optional WB_PUBLISH_PUBLIC_URL)
 * Unset → null (deploy falls back to the local CLI adapters).
 */
export function createPublishTarget(env: NodeJS.ProcessEnv = process.env): PublishTarget | null {
  const kind = (env.WB_PUBLISH_TARGET ?? '').toLowerCase();
  if (kind === 'vercel') {
    if (!env.WB_VERCEL_TOKEN) throw new Error('WB_PUBLISH_TARGET=vercel requires WB_VERCEL_TOKEN');
    return new VercelApiTarget({
      token: env.WB_VERCEL_TOKEN,
      ...(env.WB_VERCEL_TEAM_ID ? { teamId: env.WB_VERCEL_TEAM_ID } : {}),
      ...(env.WB_VERCEL_PROJECT_PREFIX ? { projectPrefix: env.WB_VERCEL_PROJECT_PREFIX } : {}),
    });
  }
  if (kind === 'r2') {
    const bucket = env.WB_PUBLISH_S3_BUCKET;
    const accessKeyId = env.WB_S3_ACCESS_KEY_ID;
    const secretAccessKey = env.WB_S3_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'WB_PUBLISH_TARGET=r2 requires WB_PUBLISH_S3_BUCKET, WB_S3_ACCESS_KEY_ID, WB_S3_SECRET_ACCESS_KEY',
      );
    }
    return new R2PublishTarget({
      bucket,
      accessKeyId,
      secretAccessKey,
      ...(env.WB_S3_ENDPOINT ? { endpoint: env.WB_S3_ENDPOINT } : {}),
      ...(env.WB_S3_REGION ? { region: env.WB_S3_REGION } : {}),
      ...(env.WB_PUBLISH_PUBLIC_URL ? { publicUrl: env.WB_PUBLISH_PUBLIC_URL } : {}),
    });
  }
  return null;
}
