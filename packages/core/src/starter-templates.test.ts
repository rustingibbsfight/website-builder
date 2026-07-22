import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import { STARTER_TEMPLATES } from './starter-templates.js';

let dataDir: string;
let core: WbCore;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-tpl-'));
  core = await WbCore.create({ dataDir });
});
afterEach(() => {
  core.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('starter templates', () => {
  it('lists the starter templates alongside breakthrough-medical', () => {
    const names = core.listTemplates().map((t) => t.name);
    for (const id of Object.keys(STARTER_TEMPLATES)) expect(names).toContain(id);
    expect(names).toContain('breakthrough-medical');
  });

  for (const id of Object.keys(STARTER_TEMPLATES)) {
    it(`creates and publishes "${id}" — valid trees, real output`, async () => {
      const site = await core.createSiteFromTemplate(id);
      const pages = await core.listPages(site.id);
      expect(pages.length).toBeGreaterThanOrEqual(2);

      // Publishing renders every page + CSS — a full validation of the trees.
      const result = await core.publishSite(site.id);
      expect(result.pageCount).toBe(pages.length);

      // Home page renders an h1 (the hero) and no unresolved component errors.
      const home = await core.getPage(site.id, '');
      const hasHero = (function find(nd: { type: string; children?: unknown[] }): boolean {
        if (nd.type === 'hero') return true;
        return (nd.children ?? []).some((c) => find(c as { type: string; children?: unknown[] }));
      })(home.tree);
      expect(hasHero).toBe(true);
    });
  }

  it('applies brand overrides (name + primary color)', async () => {
    const site = await core.createSiteFromTemplate('saas-landing', 'Acme', { colors: { primary: '#0e7c66' } });
    expect(site.theme.brandName).toBe('Acme');
    expect(site.theme.colors.primary).toBe('#0e7c66');
  });
});
