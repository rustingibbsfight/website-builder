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

      /**
       * Every page must have exactly one h1 (SEO/accessibility). The publish
       * linter emits a warning for pages with no h1, and another for more than
       * one, and those two sentences are what this is about.
       *
       * `/h1/` is not those two sentences — it is any warning whose text
       * happens to contain those characters, and node ids are random, so a form
       * node called `1h4yvfh1a8` made "this form has nowhere to post" match. The
       * test failed roughly one run in a few hundred, on a template it was not
       * about, and passed on a re-run. A test that fails at random is worse than
       * no test: it teaches everyone to re-run rather than to look.
       */
      const h1Warnings = result.warnings.filter((w) =>
        /(no h1|h1 elements)/.test(w.message),
      );
      expect(h1Warnings).toEqual([]);

      // Home page renders an h1 (the hero) and no unresolved component errors.
      const home = await core.getPage(site.id, '');
      const hasHero = (function find(nd: { type: string; children?: unknown[] }): boolean {
        if (nd.type === 'hero') return true;
        return (nd.children ?? []).some((c) => find(c as { type: string; children?: unknown[] }));
      })(home.tree);
      expect(hasHero).toBe(true);
    });
  }

  /**
   * A template's contact form is only as good as `WB_PUBLIC_URL`.
   *
   * Every starter has a contact page, `store` defaults to on, and the endpoint
   * is *seeded* from this API's own public URL — a published site is served from
   * another origin, so the form needs an absolute address and a form that has to
   * be told one by hand is a form that ships without one. Unset, the publish
   * linter says so per form, which is how a deployment missing the variable
   * announces itself rather than discarding enquiries in silence.
   *
   * Both directions, because the interesting one is the *quiet* one: the warning
   * going away is the only evidence the seeding is wired at all, and a test that
   * only checks the warning appears would pass with the seeding deleted.
   */
  // `submissions go nowhere` rather than either message's own wording: the two
  // differ on *why* — no storage at all, versus storage with no endpoint — and
  // what this is about is the outcome they share.
  const postWarnings = async (core_: WbCore) => {
    const site = await core_.createSiteFromTemplate('local-service');
    const result = await core_.publishSite(site.id);
    return result.warnings.filter((w) => /submissions go nowhere/.test(w.message));
  };

  it('warns per form when this API has no public url to post to', async () => {
    const warnings = await postWarnings(core);
    expect(warnings).not.toEqual([]);
    // The precise one: a template's form *does* ask to be stored, so the
    // missing piece is the endpoint, and saying "set store:true" here would
    // send somebody to change a setting that is already right.
    expect(warnings[0]?.message).toMatch(/no formEndpoint setting/);
  });

  it('says nothing once the endpoint is seeded from the public url', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-tpl-url-'));
    const seeded = await WbCore.create({ dataDir: dir, publicUrl: 'https://api.example.com' });
    try {
      expect(await postWarnings(seeded)).toEqual([]);
    } finally {
      seeded.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies brand overrides (name + primary color)', async () => {
    const site = await core.createSiteFromTemplate('saas-landing', 'Acme', { colors: { primary: '#0e7c66' } });
    expect(site.theme.brandName).toBe('Acme');
    expect(site.theme.colors.primary).toBe('#0e7c66');
  });
});
