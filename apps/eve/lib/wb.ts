/** Thin HTTP client for the wb REST API — Eve's hands. */

function config(): { baseUrl: string; token?: string } {
  const baseUrl = process.env.WB_API_URL;
  if (!baseUrl) {
    throw new Error('WB_API_URL is not set — point it at the wb API deployment (e.g. https://wb-api-….vercel.app)');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), token: process.env.WB_API_TOKEN };
}

export async function wbRequest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const { baseUrl, token } = config();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
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
    throw new Error(`wb API ${method} ${path}: ${message}`);
  }
  return data as T;
}

export const wbGet = <T = unknown>(path: string) => wbRequest<T>('GET', path);
export const wbPost = <T = unknown>(path: string, body?: unknown) => wbRequest<T>('POST', path, body);
export const wbPut = <T = unknown>(path: string, body?: unknown) => wbRequest<T>('PUT', path, body);
