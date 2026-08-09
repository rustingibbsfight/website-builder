/**
 * Thin HTTP client for ComfyStudio's image service — the other agent's hands.
 *
 * **The vocabulary is not written down here, on purpose.** `purpose` used to be
 * a union of six literals and `aspect` a union of five, copied from
 * ComfyStudio's `lib/serve/spec.ts` at the time this was written. That is the
 * failure the studio's guidance endpoint exists to stop, and this file was
 * already suffering it: the studio grew `width`, `height`, `media`, `seconds`
 * and `brand`, and none of them could be sent from here, because a type written
 * months ago does not know about them.
 *
 * A copied enum has two ways to be wrong and no way to be right for long. Too
 * narrow, and a value the studio accepts is unreachable — the feature ships and
 * nothing calls it. Too wide, and the caller sends something rejected at the far
 * end, which surfaces as a missing image on somebody's website.
 *
 * So these are **strings**, the studio validates them, and `guidance()` is how
 * the agent finds out what is currently valid. A rejected value comes back as
 * the studio's own error, which names the whole accepted list — so even a guess
 * self-corrects in one round trip rather than needing a deploy here.
 */

export interface ImageSpec {
  /** Where on the page. `guidance()` lists what is accepted. */
  purpose: string;
  subject: string;
  mood?: string;
  palette?: string[];
  aspect?: string;
  minWidth?: number;
  /**
   * The exact canvas, when the layout already knows it.
   *
   * The reason this matters here specifically: this *is* the caller that lays
   * pages out. A builder holding a 1440x480 slot and only able to say "16/9, at
   * least 1280 wide" is doing a conversion it can get wrong, and getting it
   * wrong looks like a picture that does not fit rather than like an error.
   */
  width?: number;
  height?: number;
  media?: string;
  seconds?: number;
  /** A kit sent to `/api/serve/brands`, so the ninth picture matches the first. */
  brand?: string;
  textSafe?: string;
  avoid?: string[];
  count?: number;
}

/**
 * What the studio currently accepts, fetched rather than remembered.
 *
 * Deliberately typed loosely. Narrowing `purposes` to a union here would
 * reintroduce the copy one level up — the point is that this repo does not know
 * the list, and a type that claims to know it is a claim that goes stale.
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

export interface Ticket {
  ticket: string;
  status: 'running' | 'ready' | 'failed';
  images: string[];
  alt: string;
  assumptions: string[];
  pending: number;
  error?: string;
  poll?: string;
}

function config(): { baseUrl: string; token: string } {
  const baseUrl = process.env.STUDIO_API_URL;
  if (!baseUrl) {
    throw new Error(
      'STUDIO_API_URL is not set — point it at the ComfyStudio deployment (e.g. https://comfystudio-….vercel.app)',
    );
  }
  const token = process.env.STUDIO_API_KEY;
  if (!token) {
    throw new Error('STUDIO_API_KEY is not set — mint one in ComfyStudio under Settings → Agent access');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

async function studioRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = config();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    // A credential-bearing request must not follow a redirect — the header
    // would go with it.
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
    // Never repeat the token back: an error message is the single most likely
    // thing to end up in a log or a transcript.
    throw new Error(`ComfyStudio ${method} ${path}: ${message}`);
  }
  return data as T;
}

export const askForImage = (spec: ImageSpec) => studioRequest<Ticket>('POST', '/api/serve/images', spec);

/**
 * The contract, asked for.
 *
 * Cached for a minute, and the number is the whole of the reasoning: an agent
 * building one page may ask three times in a row, and three identical round
 * trips to another deployment is latency spent on an answer that cannot have
 * changed. A minute is also short enough that a studio deploy is picked up
 * within the same session somebody notices it in.
 *
 * A stale entry is served if the refetch fails. Guidance that is sixty seconds
 * old is a far better answer than an exception, because the alternative is the
 * agent falling back to guessing — which is the thing this replaced.
 */
let cached: { at: number; value: Guidance } | null = null;
export const GUIDANCE_TTL_MS = 60_000;

export async function guidance(now: () => number = Date.now): Promise<Guidance> {
  if (cached && now() - cached.at < GUIDANCE_TTL_MS) return cached.value;
  try {
    const value = await studioRequest<Guidance>('GET', '/api/serve/guidance');
    cached = { at: now(), value };
    return value;
  } catch (error) {
    if (cached) return cached.value;
    throw error;
  }
}

/** Only for tests, and named so that is obvious at the call site. */
export function forgetGuidance(): void {
  cached = null;
}

export const sendBrandKit = (kit: BrandKit) =>
  studioRequest<SavedBrand>('POST', '/api/serve/brands', kit);

export const listBrands = () => studioRequest<{ brands: string[] }>('GET', '/api/serve/brands');

export const readTicket = (ticket: string) =>
  studioRequest<Ticket>('GET', `/api/serve/images/${encodeURIComponent(ticket)}`);

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask, then wait for the picture — up to `budgetMs`.
 *
 * Returns whatever the ticket says when the budget runs out rather than
 * throwing, because a ticket that is still running is not a failure: the render
 * is still coming and the id is how to collect it. A tool that threw here would
 * lose the id and leave a paid-for render unreachable.
 */
export async function requestAndWait(
  spec: ImageSpec,
  budgetMs: number,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<Ticket> {
  const started = now();
  let ticket = await askForImage(spec);

  for (let attempt = 0; ticket.status === 'running'; attempt += 1) {
    const left = budgetMs - (now() - started);
    const delay = nextDelay(attempt);
    if (left <= delay) return ticket;
    await wait(delay);
    ticket = await readTicket(ticket.ticket);
  }
  return ticket;
}
