/** Thin HTTP client for the wb REST API — Eve's hands. */
export class WbClient {
  constructor(
    private baseUrl: string,
    private apiToken?: string,
  ) {}

  async req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.apiToken ? { authorization: `Bearer ${this.apiToken}` } : {}),
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

  get<T = unknown>(path: string): Promise<T> {
    return this.req<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>('POST', path, body);
  }

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>('PUT', path, body);
  }
}
