import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveStatic } from './serve-static.js';

let dir: string;
let secretDir: string;
let server: Server;
let base: string;

beforeEach(async () => {
  const parent = mkdtempSync(join(tmpdir(), 'wb-serve-'));
  dir = join(parent, 'dist');
  secretDir = join(parent, 'secret');
  mkdirSync(dir, { recursive: true });
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<h1>home</h1>');
  mkdirSync(join(dir, 'about'), { recursive: true });
  writeFileSync(join(dir, 'about', 'index.html'), '<h1>about</h1>');
  writeFileSync(join(dir, 'styles.css'), 'body{}');
  writeFileSync(join(dir, '404.html'), 'not found');
  writeFileSync(join(secretDir, 'passwd'), 'root:x:0:0');
  server = await serveStatic(dir, 0);
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  server.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('serveStatic — clean URLs', () => {
  it('serves index, directory-index, and static files', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('home');
    expect(await (await fetch(`${base}/about/`)).text()).toContain('about');
    expect(await (await fetch(`${base}/about`)).text()).toContain('about');
    const css = await fetch(`${base}/styles.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('serves the 404 page with a 404 status for missing paths', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not found');
  });
});

describe('serveStatic — traversal containment', () => {
  it('refuses to serve files outside the dist root', async () => {
    for (const attack of [
      '/../secret/passwd',
      '/../../secret/passwd',
      '/..%2f..%2fsecret%2fpasswd',
      '/%2e%2e/secret/passwd',
      '/about/../../secret/passwd',
    ]) {
      const res = await fetch(`${base}${attack}`);
      const body = await res.text();
      expect(body, attack).not.toContain('root:x:0:0');
      expect([403, 404], attack).toContain(res.status);
    }
  });

  it('rejects malformed percent-encoding with 400 rather than crashing', async () => {
    const res = await fetch(`${base}/%zz`);
    expect(res.status).toBe(400);
  });
});

describe('serveStatic — does not crash on odd targets', () => {
  it('returns 404 (not an EISDIR crash) when a resolved path is a directory', async () => {
    // Make `weird/index.html` itself a DIRECTORY: requesting /weird/ resolves to
    // weird/index.html, which exists but is not a regular file. Streaming it
    // would throw EISDIR and, without an error handler, kill the whole server.
    mkdirSync(join(dir, 'weird', 'index.html'), { recursive: true });
    const res = await fetch(`${base}/weird/`);
    expect(res.status).toBe(404);
    // The server is still alive and serving after the odd request.
    const still = await fetch(`${base}/`);
    expect(still.status).toBe(200);
    expect(await still.text()).toContain('home');
  });
});
