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
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff2': 'font/woff2',
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return CONTENT_TYPES[dot >= 0 ? path.slice(dot) : ''] ?? 'application/octet-stream';
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
    .slice(0, 40);
  return `${prefix}${slug || 'site'}`;
}

export interface VercelApiTargetConfig {
  token: string;
  teamId?: string;
  /** Prefix for auto-created project names (default "wb-"). */
  projectPrefix?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Deploys via the Vercel Deployments API (v13) with files inlined as base64 —
 * a single POST, no CLI. The project name is derived deterministically from
 * the site name, so republishing updates the same project (and its
 * <project>.vercel.app domain / any custom domains attached to it).
 */
export class VercelApiTarget implements PublishTarget {
  readonly name = 'vercel-api';
  private fetchFn: typeof fetch;

  constructor(private cfg: VercelApiTargetConfig) {
    this.fetchFn = cfg.fetchFn ?? fetch;
  }

  async deploy({ siteName, files }: { siteId: string; siteName: string; files: Map<string, string | Uint8Array> }) {
    const project = slugifyProject(siteName, this.cfg.projectPrefix ?? 'wb-');
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
    const query = this.cfg.teamId ? `?teamId=${encodeURIComponent(this.cfg.teamId)}` : '';
    const res = await this.fetchFn(`https://api.vercel.com/v13/deployments${query}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as { url?: string; error?: { message?: string } };
    if (!res.ok || !payload.url) {
      throw new Error(`vercel deploy failed (${res.status}): ${payload.error?.message ?? 'unknown error'}`);
    }
    return {
      url: `https://${project}.vercel.app`,
      detail: `deployment https://${payload.url} promoted to production on project "${project}"`,
    };
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

    // Remove stale keys from the previous build first.
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys } }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    for (const [path, data] of files) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: `${prefix}${path}`,
          Body: typeof data === 'string' ? Buffer.from(data) : data,
          ContentType: contentTypeFor(path),
        }),
      );
    }

    const base = this.cfg.publicUrl?.replace(/\/$/, '');
    return {
      url: base ? `${base}/${siteId}/index.html` : `r2://${this.cfg.bucket}/${prefix}`,
      detail: `${files.size} files uploaded to ${this.cfg.bucket}/${prefix}`,
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
