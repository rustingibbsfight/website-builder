import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff2': 'font/woff2',
};

/** Minimal static file server with clean-URL directory-index resolution. */
export function serveStatic(rootDir: string, port: number, host = '127.0.0.1'): Promise<Server> {
  const root = resolve(rootDir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.statusCode = 400;
      res.end('bad request');
      return;
    }
    const safe = normalize(pathname).replace(/^([/\\]?\.\.[/\\])+/, '');
    let filePath = join(rootDir, safe);
    // Containment: refuse anything that escapes the dist root.
    if (resolve(filePath) !== root && !resolve(filePath).startsWith(root + sep)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    if (!existsSync(filePath) && !extname(filePath)) {
      filePath = `${filePath.replace(/\/$/, '')}/index.html`;
    }
    if (!existsSync(filePath)) {
      const notFound = join(rootDir, '404.html');
      res.statusCode = 404;
      if (existsSync(notFound)) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        createReadStream(notFound).pipe(res);
      } else {
        res.end('not found');
      }
      return;
    }
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
