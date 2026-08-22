import { projectNameFor } from './publish-target.js';

/**
 * Publishing a site also gives it a home on the clinic's WordPress site.
 *
 * The app itself lives wherever the publish target put it (a `*.vercel.app`
 * host, an R2 bucket). That URL is correct and nobody will ever type it: the
 * clinic's audience arrives at breakthrough-medspa.com, and an app that isn't
 * reachable from there may as well not be deployed. So each deploy also
 * creates — or updates — one WordPress page that points at the live app,
 * masked by the Content Mask plugin.
 *
 * **Why a companion plugin rather than the stock endpoint.** Content Mask
 * keeps its configuration in post meta, and the WordPress REST API silently
 * drops any meta key that was not registered with `show_in_rest`. Plugin meta
 * almost never is. `POST /wp/v2/pages` with the masking keys in `meta` would
 * therefore create the page, return 201, and ignore the masking — a blank page
 * on the clinic's domain and a success in the logs. So the WordPress side runs
 * `wordpress/wb-app-pages.php` (drop it in `wp-content/mu-plugins/`), which
 * exposes one route and owns the meta keys.
 *
 * **The meta key names live in that file, in one constant.** They are the
 * plugin's private contract, not a documented API, so they are the thing most
 * likely to be wrong here — see `WB_CONTENT_MASK_META` in the PHP. Nothing on
 * this side needs to know them.
 *
 * Everything here is best-effort by construction, and `deploySite` treats it
 * that way: a WordPress that is down, misconfigured, or missing the plugin
 * must not fail a deploy that already put the app live.
 */

/** How Content Mask should serve the app from the WordPress URL. */
export type WordPressMaskMode = 'iframe' | 'redirect';

/** What a site (or the environment) can ask for. `auto` decides per build. */
export type WordPressModeSetting = WordPressMaskMode | 'auto' | 'off';

export interface WordPressAppPage {
  /** WordPress post id of the page. */
  pageId: number;
  /** Public permalink on the WordPress site. */
  pageUrl: string;
  mode: WordPressMaskMode;
  /** False when an existing page for this site was updated in place. */
  created: boolean;
}

export interface WordPressPublisher {
  readonly name: string;
  publishAppPage(input: {
    siteId: string;
    siteName: string;
    /** Where the app actually lives — what the page will point at. */
    appUrl: string;
    mode: WordPressMaskMode;
    /** Override the derived slug / title (site settings). */
    slug?: string;
    title?: string;
  }): Promise<WordPressAppPage>;
}

/**
 * Signals that the app signs people in with Google.
 *
 * This is not a style preference. Google's OAuth consent screen is served with
 * `X-Frame-Options: DENY`, so an app masked in an iframe looks perfect until
 * somebody clicks "Sign in with Google" and lands in a blank frame with no
 * error — the worst available failure, because it only appears at the moment
 * the app is finally being used.
 *
 * Matched against rendered HTML only. A false positive costs a redirect (the
 * WordPress URL is not kept in the address bar); a false negative costs a
 * sign-in that cannot complete. The bias is deliberate.
 */
const GOOGLE_AUTH_SIGNALS = [
  'accounts.google.com',
  '/o/oauth2/',
  'oauth2/v2/auth',
  'googleapis.com/oauth2',
  'gsi/client',
];

/** Pick the masking mode for a build by looking at what it renders. */
export function detectMaskMode(files: Map<string, string | Uint8Array>): WordPressMaskMode {
  for (const [path, data] of files) {
    if (typeof data !== 'string') continue; // assets are bytes; never search them
    if (!path.endsWith('.html')) continue;
    const haystack = data.toLowerCase();
    if (GOOGLE_AUTH_SIGNALS.some((signal) => haystack.includes(signal))) return 'redirect';
  }
  return 'iframe';
}

/**
 * Resolve the mode for one deploy: the site's own setting wins, then the
 * environment default, and `auto` at either level means "look at the build".
 * `off` anywhere means this site does not get a WordPress page.
 */
export function resolveMaskMode(
  siteSetting: WordPressModeSetting | undefined,
  envDefault: WordPressModeSetting,
  files: Map<string, string | Uint8Array>,
): WordPressMaskMode | 'off' {
  const chosen = siteSetting ?? envDefault;
  if (chosen === 'off') return 'off';
  if (chosen === 'auto') return detectMaskMode(files);
  return chosen;
}

export interface WordPressPublisherConfig {
  /** Site root, e.g. https://breakthrough-medspa.com */
  baseUrl: string;
  username: string;
  /** A WordPress Application Password (Users → Profile → Application Passwords). */
  appPassword: string;
  /** Nest the app pages under this page id. */
  parentId?: number;
  /** Status for pages this creates. Default 'draft'. */
  status?: 'draft' | 'publish' | 'private';
  /** Prefix for derived page slugs (default "app-"). */
  slugPrefix?: string;
  /** Default 10000. A sick WordPress is not the deploy's problem. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Localhost is the one place an unencrypted WordPress is a normal thing. */
function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local');
}

export class WpContentMaskPublisher implements WordPressPublisher {
  readonly name = 'wordpress';
  private fetchFn: typeof fetch;
  private baseUrl: string;

  constructor(private cfg: WordPressPublisherConfig) {
    this.fetchFn = cfg.fetchFn ?? fetch;
    let url: URL;
    try {
      url = new URL(cfg.baseUrl);
    } catch {
      throw new Error(`wordpress: WB_WORDPRESS_URL is not a URL ("${cfg.baseUrl}")`);
    }
    // An application password is a credential with author rights on the
    // clinic's live site. It does not travel in the clear.
    if (url.protocol !== 'https:' && !isLocal(url.hostname)) {
      throw new Error(`wordpress: WB_WORDPRESS_URL must be https (got ${url.protocol}//${url.hostname})`);
    }
    this.baseUrl = url.origin + url.pathname.replace(/\/$/, '');
  }

  private get authHeader(): string {
    // WordPress shows application passwords in space-separated groups and
    // accepts them either way; a pasted-with-spaces value must not 401.
    const token = Buffer.from(`${this.cfg.username}:${this.cfg.appPassword.replace(/\s+/g, '')}`).toString('base64');
    return `Basic ${token}`;
  }

  async publishAppPage(input: {
    siteId: string;
    siteName: string;
    appUrl: string;
    mode: WordPressMaskMode;
    slug?: string;
    title?: string;
  }): Promise<WordPressAppPage> {
    // Deterministic from the site *id*, not its name: two sites both called
    // "Clinic" must not fight over one WordPress page, and republishing the
    // same site must land on the page it made last time. Same rule, and the
    // same helper, as the deploy project name.
    const slug = input.slug || projectNameFor(input.siteName, input.siteId, this.cfg.slugPrefix ?? 'app-');
    const body = {
      slug,
      title: input.title || input.siteName,
      url: input.appUrl,
      mode: input.mode,
      status: this.cfg.status ?? 'draft',
      ...(this.cfg.parentId ? { parent: this.cfg.parentId } : {}),
    };

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/wp-json/wb/v1/app-page`, {
        method: 'POST',
        headers: { authorization: this.authHeader, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        // A credential-bearing request must not follow a redirect — a
        // misconfigured canonical host would hand the password to whatever is
        // on the other end.
        redirect: 'error',
      });
    } catch (err) {
      throw new Error(`wordpress: request to ${this.baseUrl} failed (${err instanceof Error ? err.message : String(err)})`);
    }

    const payload = await readJsonSafe(res);
    if (!res.ok) {
      // WordPress puts a human-readable reason in `message`; a 404 here almost
      // always means the mu-plugin isn't installed, which is worth saying
      // outright rather than leaving as a status code.
      const reason =
        typeof payload.message === 'string'
          ? payload.message
          : res.status === 404
            ? 'no /wb/v1/app-page route — is wordpress/wb-app-pages.php installed in wp-content/mu-plugins/?'
            : typeof payload._raw === 'string'
              ? payload._raw.slice(0, 200)
              : 'unknown error';
      throw new Error(`wordpress: app page for "${slug}" failed (${res.status}): ${reason}`);
    }

    const pageId = typeof payload.id === 'number' ? payload.id : Number(payload.id);
    if (!Number.isFinite(pageId) || pageId <= 0) {
      throw new Error(`wordpress: app page for "${slug}" returned no page id`);
    }
    return {
      pageId,
      pageUrl: typeof payload.link === 'string' ? payload.link : `${this.baseUrl}/${slug}/`,
      mode: input.mode,
      created: payload.created === true,
    };
  }
}

/** Parse a response body without throwing on an HTML error page or an empty body. */
async function readJsonSafe(res: { text(): Promise<string> }): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { _raw: parsed };
  } catch {
    return { _raw: text };
  }
}

const MODE_SETTINGS: readonly WordPressModeSetting[] = ['auto', 'iframe', 'redirect', 'off'];

/** The environment's default masking mode (`WB_WORDPRESS_MODE`). */
export function wordPressModeFromEnv(env: NodeJS.ProcessEnv = process.env): WordPressModeSetting {
  const raw = (env.WB_WORDPRESS_MODE ?? 'auto').toLowerCase();
  if (!MODE_SETTINGS.includes(raw as WordPressModeSetting)) {
    throw new Error(`WB_WORDPRESS_MODE must be one of ${MODE_SETTINGS.join(', ')} (got "${raw}")`);
  }
  return raw as WordPressModeSetting;
}

/**
 * Select the WordPress publisher from environment.
 *   WB_WORDPRESS_URL          → enables it (e.g. https://breakthrough-medspa.com)
 *   WB_WORDPRESS_USER         + WB_WORDPRESS_APP_PASSWORD  (required with it)
 *   WB_WORDPRESS_STATUS       draft (default) | publish | private
 *   WB_WORDPRESS_PARENT_ID    nest the app pages under this page
 *   WB_WORDPRESS_SLUG_PREFIX  default "app-"
 * Unset → null: deploys behave exactly as they did before this existed.
 */
export function createWordPressPublisher(env: NodeJS.ProcessEnv = process.env): WordPressPublisher | null {
  const baseUrl = env.WB_WORDPRESS_URL;
  if (!baseUrl) return null;
  if (!env.WB_WORDPRESS_USER || !env.WB_WORDPRESS_APP_PASSWORD) {
    throw new Error('WB_WORDPRESS_URL requires WB_WORDPRESS_USER and WB_WORDPRESS_APP_PASSWORD');
  }
  const status = (env.WB_WORDPRESS_STATUS ?? 'draft').toLowerCase();
  if (status !== 'draft' && status !== 'publish' && status !== 'private') {
    throw new Error(`WB_WORDPRESS_STATUS must be draft, publish, or private (got "${status}")`);
  }
  const parentId = env.WB_WORDPRESS_PARENT_ID ? Number(env.WB_WORDPRESS_PARENT_ID) : undefined;
  if (parentId !== undefined && (!Number.isInteger(parentId) || parentId <= 0)) {
    throw new Error(`WB_WORDPRESS_PARENT_ID must be a positive page id (got "${env.WB_WORDPRESS_PARENT_ID}")`);
  }
  return new WpContentMaskPublisher({
    baseUrl,
    username: env.WB_WORDPRESS_USER,
    appPassword: env.WB_WORDPRESS_APP_PASSWORD,
    status,
    ...(parentId ? { parentId } : {}),
    ...(env.WB_WORDPRESS_SLUG_PREFIX ? { slugPrefix: env.WB_WORDPRESS_SLUG_PREFIX } : {}),
  });
}
