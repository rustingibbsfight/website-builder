/** Thin HTTP client for ComfyStudio's image service — the other agent's hands. */

export interface ImageSpec {
  purpose: 'hero' | 'section' | 'card' | 'background' | 'icon' | 'portrait';
  subject: string;
  mood?: string;
  palette?: string[];
  aspect?: '16/9' | '4/3' | '1/1' | '3/4' | '21/9';
  minWidth?: number;
  textSafe?: 'none' | 'left' | 'right' | 'top' | 'bottom' | 'centre';
  avoid?: string[];
  count?: number;
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
