import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WbCore } from './core.js';
import {
  createWordPressPublisher,
  detectMaskMode,
  resolveMaskMode,
  WpContentMaskPublisher,
  wordPressModeFromEnv,
  type WordPressPublisher,
} from './wordpress.js';

/** A scripted WordPress — record calls, answer the app-page route. */
function fakeWordPress(opts: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(init.body as string) : {},
    });
    const body = opts.body ?? { id: 42, link: 'https://breakthrough-medspa.com/app-clinic-abcd1234/', created: true };
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const cfg = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) => ({
  baseUrl: 'https://breakthrough-medspa.com',
  username: 'wb-bot',
  appPassword: 'abcd EFGH ijkl MNOP qrst UVWX',
  fetchFn,
  ...extra,
});

describe('WpContentMaskPublisher', () => {
  it('posts the app page to the companion route with basic auth', async () => {
    const wp = fakeWordPress();
    const publisher = new WpContentMaskPublisher(cfg(wp.fetchFn, { status: 'publish', parentId: 7 }));

    const page = await publisher.publishAppPage({
      siteId: 'site_abcd1234',
      siteName: 'Glow Clinic',
      appUrl: 'https://wb-glow-clinic-abcd1234.vercel.app',
      mode: 'iframe',
    });

    const call = wp.calls[0]!;
    expect(call.url).toBe('https://breakthrough-medspa.com/wp-json/wb/v1/app-page');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({
      slug: 'app-glow-clinic-abcd1234',
      title: 'Glow Clinic',
      url: 'https://wb-glow-clinic-abcd1234.vercel.app',
      mode: 'iframe',
      status: 'publish',
      parent: 7,
    });
    // Spaces are how WordPress *shows* an application password; a pasted value
    // must authenticate rather than 401.
    const auth = Buffer.from(call.headers.get('authorization')!.replace('Basic ', ''), 'base64').toString();
    expect(auth).toBe('wb-bot:abcdEFGHijklMNOPqrstUVWX');
    expect(page).toEqual({
      pageId: 42,
      pageUrl: 'https://breakthrough-medspa.com/app-clinic-abcd1234/',
      mode: 'iframe',
      created: true,
    });
  });

  it('derives the slug from the site id, so republishing updates one page', async () => {
    // Two sites with the same name must not fight over a single WordPress page.
    const wp = fakeWordPress();
    const publisher = new WpContentMaskPublisher(cfg(wp.fetchFn));
    const deploy = (siteId: string) =>
      publisher.publishAppPage({ siteId, siteName: 'Clinic', appUrl: 'https://a.example.com', mode: 'iframe' });

    await deploy('site_11111111');
    await deploy('site_22222222');
    await deploy('site_11111111');

    const slugs = wp.calls.map((c) => c.body.slug);
    expect(slugs[0]).not.toBe(slugs[1]);
    expect(slugs[2]).toBe(slugs[0]);
  });

  it('prefers an explicit slug and title over the derived ones', async () => {
    const wp = fakeWordPress();
    const publisher = new WpContentMaskPublisher(cfg(wp.fetchFn));
    await publisher.publishAppPage({
      siteId: 's1',
      siteName: 'Glow Clinic',
      appUrl: 'https://a.example.com',
      mode: 'redirect',
      slug: 'member-portal',
      title: 'Member Portal',
    });
    expect(wp.calls[0]!.body.slug).toBe('member-portal');
    expect(wp.calls[0]!.body.title).toBe('Member Portal');
  });

  it('says the plugin is missing when the route 404s', async () => {
    // A bare "404" here sends somebody looking at DNS. The cause is almost
    // always an uninstalled mu-plugin, and the message should say so.
    const wp = fakeWordPress({ status: 404, body: {} });
    const publisher = new WpContentMaskPublisher(cfg(wp.fetchFn));
    await expect(
      publisher.publishAppPage({ siteId: 's', siteName: 'X', appUrl: 'https://a.example.com', mode: 'iframe' }),
    ).rejects.toThrow(/wb-app-pages\.php/);
  });

  it("reports WordPress's own reason when it rejects the write", async () => {
    const wp = fakeWordPress({ status: 401, body: { message: 'Sorry, you are not allowed to do that.' } });
    const publisher = new WpContentMaskPublisher(cfg(wp.fetchFn));
    await expect(
      publisher.publishAppPage({ siteId: 's', siteName: 'X', appUrl: 'https://a.example.com', mode: 'iframe' }),
    ).rejects.toThrow(/not allowed to do that/);
  });

  it('does not report success when the response carries no page id', async () => {
    // A login page or a caching layer can answer 200 with something that is not
    // a created page. Reporting that as a live page is worse than failing.
    const wp = fakeWordPress({ status: 200, body: { ok: true } });
    const publisher = new WpContentMaskPublisher(cfg(wp.fetchFn));
    await expect(
      publisher.publishAppPage({ siteId: 's', siteName: 'X', appUrl: 'https://a.example.com', mode: 'iframe' }),
    ).rejects.toThrow(/no page id/);
  });

  it('refuses to send an application password over plain http', async () => {
    const wp = fakeWordPress();
    expect(() => new WpContentMaskPublisher(cfg(wp.fetchFn, { baseUrl: 'http://breakthrough-medspa.com' }))).toThrow(
      /must be https/,
    );
    // …but a local WordPress is a normal way to develop against this.
    expect(() => new WpContentMaskPublisher(cfg(wp.fetchFn, { baseUrl: 'http://localhost:8080' }))).not.toThrow();
  });

  it('never follows a redirect while carrying the credential', async () => {
    const wp = fakeWordPress();
    const publisher = new WpContentMaskPublisher(cfg(wp.fetchFn));
    let init: RequestInit | undefined;
    const spy = (async (url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return wp.fetchFn(url, i);
    }) as unknown as typeof fetch;
    await new WpContentMaskPublisher(cfg(spy)).publishAppPage({
      siteId: 's',
      siteName: 'X',
      appUrl: 'https://a.example.com',
      mode: 'iframe',
    });
    expect(init!.redirect).toBe('error');
    expect(publisher.name).toBe('wordpress');
  });
});

describe('choosing iframe vs redirect', () => {
  const build = (html: string) =>
    new Map<string, string | Uint8Array>([
      ['index.html', html],
      ['styles.css', 'body{}'],
      ['assets/logo.png', new Uint8Array([1, 2, 3])],
    ]);

  it('redirects when the build signs people in with Google', () => {
    // Google's consent screen sends X-Frame-Options: DENY. Masked in an iframe
    // the app looks perfect until the moment somebody tries to sign in.
    expect(detectMaskMode(build('<a href="https://accounts.google.com/o/oauth2/v2/auth?client_id=x">Sign in</a>'))).toBe(
      'redirect',
    );
    expect(detectMaskMode(build('<script src="https://accounts.google.com/gsi/client" async></script>'))).toBe(
      'redirect',
    );
    // Case is not a signal.
    expect(detectMaskMode(build('<a href="https://ACCOUNTS.GOOGLE.COM/signin">in</a>'))).toBe('redirect');
  });

  it('iframes an ordinary marketing site', () => {
    expect(detectMaskMode(build('<h1>Weight loss that works</h1><a href="/contact">Book</a>'))).toBe('iframe');
  });

  it('never searches asset bytes for the signal', () => {
    // A PNG whose bytes happen to spell the signal is not an OAuth app, and
    // decoding megabytes of images to find out would be a waste besides.
    const files = new Map<string, string | Uint8Array>([
      ['index.html', '<h1>Hi</h1>'],
      ['assets/x.png', Buffer.from('accounts.google.com')],
    ]);
    expect(detectMaskMode(files)).toBe('iframe');
  });

  it('lets a site override the automatic choice, and opt out entirely', () => {
    const oauth = build('<a href="https://accounts.google.com/o/oauth2/v2/auth">in</a>');
    const plain = build('<h1>Hi</h1>');
    expect(resolveMaskMode(undefined, 'auto', oauth)).toBe('redirect');
    expect(resolveMaskMode('iframe', 'auto', oauth)).toBe('iframe'); // site knows better
    expect(resolveMaskMode('off', 'auto', plain)).toBe('off');
    expect(resolveMaskMode(undefined, 'redirect', plain)).toBe('redirect'); // env default
    expect(resolveMaskMode('auto', 'redirect', plain)).toBe('iframe'); // explicit auto still detects
  });
});

describe('createWordPressPublisher', () => {
  it('is off unless a WordPress URL is configured', () => {
    expect(createWordPressPublisher({})).toBeNull();
  });

  it('refuses a URL with no credentials rather than 401ing on every deploy', () => {
    expect(() => createWordPressPublisher({ WB_WORDPRESS_URL: 'https://breakthrough-medspa.com' })).toThrow(
      /WB_WORDPRESS_USER/,
    );
  });

  it('reads status, parent, and prefix from the environment', () => {
    const publisher = createWordPressPublisher({
      WB_WORDPRESS_URL: 'https://breakthrough-medspa.com/',
      WB_WORDPRESS_USER: 'wb-bot',
      WB_WORDPRESS_APP_PASSWORD: 'pw',
      WB_WORDPRESS_STATUS: 'publish',
      WB_WORDPRESS_PARENT_ID: '12',
      WB_WORDPRESS_SLUG_PREFIX: 'apps-',
    }) as unknown as { cfg: { status: string; parentId: number; slugPrefix: string } };
    expect(publisher.cfg).toMatchObject({ status: 'publish', parentId: 12, slugPrefix: 'apps-' });
  });

  it('defaults to draft — an automatic publish to the live domain is opt-in', () => {
    const publisher = createWordPressPublisher({
      WB_WORDPRESS_URL: 'https://breakthrough-medspa.com',
      WB_WORDPRESS_USER: 'wb-bot',
      WB_WORDPRESS_APP_PASSWORD: 'pw',
    }) as unknown as { cfg: { status: string } };
    expect(publisher.cfg.status).toBe('draft');
  });

  it('rejects nonsense configuration at startup, not at deploy time', () => {
    const base = {
      WB_WORDPRESS_URL: 'https://breakthrough-medspa.com',
      WB_WORDPRESS_USER: 'u',
      WB_WORDPRESS_APP_PASSWORD: 'p',
    };
    expect(() => createWordPressPublisher({ ...base, WB_WORDPRESS_STATUS: 'live' })).toThrow(/WB_WORDPRESS_STATUS/);
    expect(() => createWordPressPublisher({ ...base, WB_WORDPRESS_PARENT_ID: 'home' })).toThrow(
      /WB_WORDPRESS_PARENT_ID/,
    );
    expect(() => createWordPressPublisher({ ...base, WB_WORDPRESS_URL: 'not a url' })).toThrow(/not a URL/);
    expect(() => wordPressModeFromEnv({ WB_WORDPRESS_MODE: 'frame' })).toThrow(/WB_WORDPRESS_MODE/);
    expect(wordPressModeFromEnv({})).toBe('auto');
  });
});

describe('WbCore deploy + WordPress', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wb-wp-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const fakeTarget = { name: 'fake', deploy: async () => ({ url: 'https://live.example.com' }) };

  const recorder = () => {
    const seen: Array<Record<string, unknown>> = [];
    const wordpress: WordPressPublisher = {
      name: 'fake-wp',
      publishAppPage: async (input) => {
        seen.push(input);
        return { pageId: 9, pageUrl: 'https://breakthrough-medspa.com/app/', mode: input.mode, created: true };
      },
    };
    return { seen, wordpress };
  };

  it('creates the companion page pointing at the live app', async () => {
    const { seen, wordpress } = recorder();
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, wordpress, versionControl: null });
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'Deploy Clinic');
    const result = await core.deploySite(site.id);

    expect(seen[0]).toMatchObject({
      siteId: site.id,
      siteName: 'Deploy Clinic',
      appUrl: 'https://live.example.com', // the page points at what just went live
      mode: 'iframe',
    });
    expect(result.wordpress).toEqual({
      pageId: 9,
      pageUrl: 'https://breakthrough-medspa.com/app/',
      mode: 'iframe',
      created: true,
    });
    core.close();
  });

  it('does not fail a live deploy when WordPress errors', async () => {
    const wordpress: WordPressPublisher = {
      name: 'flaky',
      publishAppPage: async () => {
        throw new Error('wordpress down');
      },
    };
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, wordpress, versionControl: null });
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'Resilient');
    const result = await core.deploySite(site.id);

    expect(result.url).toBe('https://live.example.com');
    expect(result.wordpressError).toContain('wordpress down');
    expect(result.wordpress).toBeUndefined();
    core.close();
  });

  it('honours a site that has opted out', async () => {
    const { seen, wordpress } = recorder();
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, wordpress, versionControl: null });
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'Private Clinic');
    await core.updateSite(site.id, { settings: { wordpress: { mode: 'off' } } });

    const result = await core.deploySite(site.id);
    expect(seen).toHaveLength(0);
    expect(result.wordpress).toBeUndefined();
    expect(result.wordpressError).toBeUndefined();
    core.close();
  });

  it('passes the site\'s slug/title overrides and forced mode through', async () => {
    const { seen, wordpress } = recorder();
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, wordpress, versionControl: null });
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'Portal');
    await core.updateSite(site.id, {
      settings: { wordpress: { mode: 'redirect', slug: 'member-portal', title: 'Member Portal' } },
    });

    await core.deploySite(site.id);
    expect(seen[0]).toMatchObject({ mode: 'redirect', slug: 'member-portal', title: 'Member Portal' });
    core.close();
  });

  it('deploys exactly as before when WordPress is not configured', async () => {
    const core = await WbCore.create({ dataDir, publishTarget: fakeTarget, wordpress: null, versionControl: null });
    const site = await core.createSiteFromTemplate('breakthrough-medical', 'No Wp');
    const result = await core.deploySite(site.id);
    expect(result.url).toBe('https://live.example.com');
    expect(result.wordpress).toBeUndefined();
    expect(result.wordpressError).toBeUndefined();
    expect(core.hasWordPress()).toBe(false);
    core.close();
  });
});
