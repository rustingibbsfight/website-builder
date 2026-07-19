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

/**
 * Stream a file to the response, but never let a read-stream error (EISDIR,
 * EACCES, or an ENOENT from a TOCTOU delete) become an uncaught exception that
 * takes down the whole server process.
 */
function pipeFile(filePath: string, res: import('node:http').ServerResponse): void {
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('internal error');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

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
        pipeFile(notFound, res);
      } else {
        res.end('not found');
      }
      return;
    }
    // A path that resolved to a directory (or a broken symlink) must not be
    // streamed — that would throw EISDIR. Serve only regular files.
    if (!statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
    pipeFile(filePath, res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
