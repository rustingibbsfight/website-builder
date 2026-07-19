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
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

const VERCEL_TERMINAL_STATES = new Set(['READY', 'ERROR', 'CANCELED']);

/**
 * Deploys via the Vercel Deployments API (v13) with files inlined as base64 —
 * a single POST, no CLI. The project name is derived deterministically from
 * the site id (not just its name), so republishing updates the same project
 * (and its <project>.vercel.app domain / any custom domains attached to it)
 * while two same-named sites never clobber each other.
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
    const body = {
      name: project,
      target: 'production',
      projectSettings: { framework: null },
      files: [...files].map(([file, data]) => ({
        file,
        data: Buffer.from(data as Uint8Array).toString('base64'),
        encoding: 'base64',
      })),
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
