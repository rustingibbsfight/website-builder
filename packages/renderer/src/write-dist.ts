import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Write a rendered file map to disk. The only fs-touching module in the renderer. */
export async function writeDist(files: Map<string, string | Uint8Array>, outDir: string): Promise<string[]> {
  const root = resolve(outDir);
  const written: string[] = [];
  for (const [rel, content] of files) {
    const abs = resolve(root, rel);
    // Defense in depth: never write outside the build directory, however the
    // relative path was derived (e.g. a page slug that slipped validation).
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`refusing to write outside the build directory: ${rel}`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    written.push(rel);
  }
  return written;
}
