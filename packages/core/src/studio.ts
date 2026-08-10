/**
 * The image studio, as something the whole builder can reach.
 *
 * This began life at `apps/eve/lib/studio.ts`, reachable only from a Slack
 * conversation. That is the complaint in #52 and it is worth stating precisely,
 * because "expose it in more places" is not the interesting part: somebody
 * laying out a hero section in the visual editor had to leave, ask an agent in
 * a different application for a picture, and paste a URL back. The picture then
 * lived on ComfyStudio's storage rather than as an asset of the site, so
 * publishing it depended on another deployment staying up.
 *
 * So it moves down here, beside `fetch-asset.ts`, and every surface — Eve, MCP,
 * the HTTP API, the editor's picker — asks the *core* for a picture. One ticket
 * store, one ingest, one SSRF guard, one place that knows the studio's address.
 *
 * **The vocabulary stays unwritten here, on purpose.** `purpose` was once a
 * union of six literals and `aspect` one of five, copied from ComfyStudio's own
 * spec. A copied enum has two ways to be wrong and no way to be right for long:
 * too narrow and a value the studio accepts is unreachable, so a feature ships
 * at one end and nothing can call it; too wide and the rejection surfaces as a
 * missing picture on somebody's website. These are strings, the studio
 * validates them, and its guidance endpoint says what is currently valid — a
 * wrong value comes back as an error naming the whole accepted list, which a
 * caller can act on in the same turn rather than after a deploy here.
 */

import { ValidationError } from './errors.js';

export interface ImageSpec {
  /** Where on the page. The studio's guidance lists what is accepted. */
  purpose: string;
  subject: string;
  mood?: string;
  palette?: string[];
  aspect?: string;
  minWidth?: number;
  /**
   * The exact canvas, when the layout already knows it.
   *
   * This is the caller that lays pages out. A builder holding a 1440×480 slot
   * and only able to say "16/9, at least 1280 wide" is doing a conversion it
   * can get wrong — and getting it wrong looks like a picture that does not
   * fit rather than like an error.
   */
  width?: number;
  height?: number;
  media?: string;
  seconds?: number;
  /** A kit already sent to the studio, so the ninth picture matches the first. */
  brand?: string;
  textSafe?: string;
  avoid?: string[];
  count?: number;
}

/** What the studio says about one request. Its shape, not ours. */
export interface StudioTicket {
  ticket: string;
  status: 'running' | 'ready' | 'failed';
  images: string[];
  alt: string;
  assumptions: string[];
  pending: number;
  error?: string;
  poll?: string;
}

/**
 * What the studio currently accepts, fetched rather than remembered.
 *
 * Deliberately typed loosely: narrowing `purposes` to a union here would
 * reintroduce the copy one level up. This repo does not know the list, and a
 * type claiming to know it is a claim that goes stale.
 */
export interface Guidance {
  version: number;
  request: {
    endpoint: string;
    purposes: string[];
    aspects: string[];
    textSafe: string[];
    media: string[];
    limits: { maxCount: number; maxEdge: number; maxVideoEdge: number; maxSeconds: number };
    fields: { name: string; required: boolean; note: string }[];
  };
  ontology: { kind: string; label: string; hint: string }[];
  brands: { endpoint: string; note: string; known: string[] };
}

export interface BrandKit {
  name: string;
  description: string;
  palette?: string[];
  voice?: string[];
  avoid?: string[];
}

export interface SavedBrand {
  brand: string;
  tag: string;
  snippets: { name: string; kind: string }[];
}

/** What the core needs of a studio. An interface so a test can be one. */
export interface ImageStudio {
  request(spec: ImageSpec): Promise<StudioTicket>;
  read(ticket: string): Promise<StudioTicket>;
  guidance(): Promise<Guidance>;
  sendBrandKit(kit: BrandKit): Promise<SavedBrand>;
  listBrands(): Promise<{ brands: string[] }>;
}

export interface StudioOptions {
  baseUrl: string;
  token: string;
  /** Injected in tests, for the reason `notify.ts` injects it: a guard that
   *  needs the network to prove itself is a guard nobody tests. */
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * How long a cached guidance answer stays good.
 *
 * An agent building one page may ask three times in a row, and three identical
 * round trips to another deployment is latency spent on an answer that cannot
 * have changed. A minute is short enough that a studio deploy is picked up
 * inside the session somebody notices it in.
 */
export const GUIDANCE_TTL_MS = 60_000;

export class HttpImageStudio implements ImageStudio {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cached: { at: number; value: Guidance } | null = null;

  constructor(options: StudioOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      // A credential-bearing request must not follow a redirect — the header
      // would go with it, to wherever the far end pointed.
      redirect: 'error',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : `${res.status} ${text.slice(0, 300)}`;
      // Never repeat the token back. An error message is the single most likely
      // thing to end up in a log, a transcript or a chat panel.
      throw new ValidationError(`image studio ${method} ${path}: ${message}`);
    }
    return data as T;
  }

  request(spec: ImageSpec): Promise<StudioTicket> {
    return this.call<StudioTicket>('POST', '/api/serve/images', spec);
  }

  read(ticket: string): Promise<StudioTicket> {
    return this.call<StudioTicket>('GET', `/api/serve/images/${encodeURIComponent(ticket)}`);
  }

  /**
   * A stale entry is served if the refetch fails. Guidance sixty seconds old is
   * a far better answer than an exception, because the alternative is the
   * caller falling back to guessing — which is the thing this replaced.
   */
  async guidance(): Promise<Guidance> {
    if (this.cached && this.now() - this.cached.at < GUIDANCE_TTL_MS) return this.cached.value;
    try {
      const value = await this.call<Guidance>('GET', '/api/serve/guidance');
      this.cached = { at: this.now(), value };
      return value;
    } catch (error) {
      if (this.cached) return this.cached.value;
      throw error;
    }
  }

  sendBrandKit(kit: BrandKit): Promise<SavedBrand> {
    return this.call<SavedBrand>('POST', '/api/serve/brands', kit);
  }

  listBrands(): Promise<{ brands: string[] }> {
    return this.call<{ brands: string[] }>('GET', '/api/serve/brands');
  }
}

/**
 * A studio from the environment, or nothing.
 *
 * `null` rather than a throw, and the distinction is the whole of it: image
 * generation is optional, so a deployment without it must start, serve, publish
 * and deploy exactly as before. The refusal belongs at the one route that needs
 * it, where it can say *which* variable is missing — a constructor that threw
 * would take the whole API down over a feature nobody had asked for yet.
 */
export function createImageStudio(env: NodeJS.ProcessEnv = process.env): ImageStudio | null {
  const baseUrl = env.STUDIO_API_URL;
  const token = env.STUDIO_API_KEY;
  if (!baseUrl || !token) return null;
  return new HttpImageStudio({ baseUrl, token });
}

/**
 * How long to wait before asking again.
 *
 * Backs off rather than hammering: a render is tens of seconds at best, and a
 * poll every second is ninety requests that all say "still running". It stops
 * growing at ten seconds so a picture that lands early is not sat on.
 */
export function nextDelay(attempt: number): number {
  return Math.min(10_000, 2_000 * 2 ** Math.min(attempt, 3));
}
