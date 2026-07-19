import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assetDir } from './db.js';

/**
 * Durable storage for uploaded asset bytes. Blobs are keyed by (siteId, path)
 * where path is the id-namespaced filename. Two implementations: local
 * filesystem (default, for CLI + self-hosting) and S3-compatible (Cloudflare
 * R2 / AWS S3, for serverless where the filesystem is ephemeral).
 */
export interface AssetStorage {
  put(siteId: string, path: string, body: Uint8Array | string, contentType: string): Promise<void>;
  get(siteId: string, path: string): Promise<Buffer>;
  delete(siteId: string, path: string): Promise<void>;
  deleteSite(siteId: string): Promise<void>;
}

export class LocalAssetStorage implements AssetStorage {
  constructor(private dataDir: string) {}

  private file(siteId: string, path: string): string {
    return join(assetDir(this.dataDir, siteId), path);
  }

  async put(siteId: string, path: string, body: Uint8Array | string, _contentType: string): Promise<void> {
    const file = this.file(siteId, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  async get(siteId: string, path: string): Promise<Buffer> {
    return readFile(this.file(siteId, path));
  }

  async delete(siteId: string, path: string): Promise<void> {
    rmSync(this.file(siteId, path), { force: true });
  }

  async deleteSite(siteId: string): Promise<void> {
    rmSync(assetDir(this.dataDir, siteId), { recursive: true, force: true });
  }
}

export interface S3StorageConfig {
  bucket: string;
  /** e.g. https://<accountid>.r2.cloudflarestorage.com for R2. Omit for AWS S3. */
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional key prefix so one bucket can host multiple environments. */
  prefix?: string;
}

export class S3AssetStorage implements AssetStorage {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(cfg: S3StorageConfig) {
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix ? cfg.prefix.replace(/\/$/, '') + '/' : '';
    this.client = new S3Client({
      region: cfg.region ?? 'auto',
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  private key(siteId: string, path: string): string {
    return `${this.prefix}${siteId}/${path}`;
  }

  async put(siteId: string, path: string, body: Uint8Array | string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(siteId, path),
        Body: typeof body === 'string' ? Buffer.from(body) : body,
        ContentType: contentType,
      }),
    );
  }

  async get(siteId: string, path: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(siteId, path) }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(siteId: string, path: string): Promise<void> {
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: [{ Key: this.key(siteId, path) }] },
      }),
    );
  }

  async deleteSite(siteId: string): Promise<void> {
    const prefix = `${this.prefix}${siteId}/`;
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
}

/**
 * Select the asset store from environment. WB_ASSET_STORE=s3 uses R2/S3 (needs
 * WB_S3_BUCKET, WB_S3_ACCESS_KEY_ID, WB_S3_SECRET_ACCESS_KEY, and — for R2 —
 * WB_S3_ENDPOINT); anything else falls back to the local filesystem.
 */
export function createAssetStorage(dataDir: string, env: NodeJS.ProcessEnv = process.env): AssetStorage {
  if ((env.WB_ASSET_STORE ?? '').toLowerCase() === 's3') {
    const bucket = env.WB_S3_BUCKET;
    const accessKeyId = env.WB_S3_ACCESS_KEY_ID;
    const secretAccessKey = env.WB_S3_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'WB_ASSET_STORE=s3 requires WB_S3_BUCKET, WB_S3_ACCESS_KEY_ID, WB_S3_SECRET_ACCESS_KEY',
      );
    }
    return new S3AssetStorage({
      bucket,
      accessKeyId,
      secretAccessKey,
      ...(env.WB_S3_ENDPOINT ? { endpoint: env.WB_S3_ENDPOINT } : {}),
      ...(env.WB_S3_REGION ? { region: env.WB_S3_REGION } : {}),
      ...(env.WB_S3_PREFIX ? { prefix: env.WB_S3_PREFIX } : {}),
    });
  }
  return new LocalAssetStorage(dataDir);
}
