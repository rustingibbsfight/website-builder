import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Write a rendered file map to disk. The only fs-touching module in the renderer. */
export async function writeDist(files: Map<string, string | Uint8Array>, outDir: string): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of files) {
    const abs = join(outDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    written.push(rel);
  }
  return written;
}
