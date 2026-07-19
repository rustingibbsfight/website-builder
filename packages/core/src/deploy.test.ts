import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEPLOY_ADAPTERS, deployDist, type DeployAdapterName } from './deploy.js';

let dist: string;

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'wb-dep-'));
  writeFileSync(join(dist, 'index.html'), '<h1>hi</h1>');
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe('deployDist adapter validation', () => {
  it('throws on an unknown adapter instead of silently returning undefined', () => {
    expect(() => deployDist(dist, 'ftp' as DeployAdapterName)).toThrow(/unknown deploy adapter "ftp"/);
    // The error names the valid set so the CLI user can self-correct.
    expect(() => deployDist(dist, 'typo' as DeployAdapterName)).toThrow(/static, vercel, netlify, cloudflare/);
  });

  it('the static adapter with no targetDir just reports the build path', () => {
    const res = deployDist(dist, 'static');
    expect(res.adapter).toBe('static');
    expect(res.status).toBe('prepared');
    expect(res.message).toContain(dist);
  });

  it('the valid-adapter set is exactly the union (guards against drift)', () => {
    // Note: we don't invoke the provider adapters here — they shell out to real
    // CLIs. The validation guard + static path prove the no-undefined fix.
    expect([...DEPLOY_ADAPTERS].sort()).toEqual(['cloudflare', 'netlify', 'static', 'vercel']);
  });

  it('refuses to deploy when no build exists at the path', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wb-empty-'));
    try {
      expect(() => deployDist(empty, 'static')).toThrow(/no build found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
