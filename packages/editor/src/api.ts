import type {
  Asset,
  Block,
  BlockSummary,
  ChatRead,
  ComponentDetail,
  ComponentSummary,
  ImageTicket,
  Page,
  PageMeta,
  PageSummary,
  Site,
  Submission,
  SymbolSummary,
  TemplateInfo,
  Theme,
  TreeOp,
  WbNode,
} from './types';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  // Only advertise a JSON body when there actually is one. Sending
  // `content-type: application/json` on a bodyless request (e.g. DELETE) makes
  // the server reject it with 400 "Body cannot be empty…".
  const headers = init?.body != null ? { 'content-type': 'application/json' } : undefined;
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error ?? message;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  authMe: () => req<{ authRequired: boolean; authenticated: boolean }>('/auth/me'),
  login: (token: string) =>
    req<{ ok: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ token }) }),
  listSites: () => req<Site[]>('/sites'),
  listTemplates: () => req<TemplateInfo[]>('/templates'),
  createFromTemplate: (template: string, name?: string) =>
    req<{ site: Site }>('/sites/from-template', {
      method: 'POST',
      body: JSON.stringify(name ? { template, name } : { template }),
    }),
  getSite: (siteId: string) => req<Site>(`/sites/${siteId}`),
  listPages: (siteId: string) => req<PageSummary[]>(`/sites/${siteId}/pages`),
  getPage: (siteId: string, pageId: string) => req<Page>(`/sites/${siteId}/pages/${pageId}`),
  addPage: (siteId: string, slug: string, title: string) =>
    req<Page>(`/sites/${siteId}/pages`, { method: 'POST', body: JSON.stringify({ slug, title }) }),
  deletePage: (siteId: string, pageId: string) =>
    req<void>(`/sites/${siteId}/pages/${pageId}`, { method: 'DELETE' }),
  setPageMeta: (siteId: string, pageId: string, meta: PageMeta) =>
    req<Page>(`/sites/${siteId}/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ meta }) }),
  applyOps: (siteId: string, pageId: string, ops: TreeOp[]) =>
    req<Page>(`/sites/${siteId}/pages/${pageId}/tree/ops`, { method: 'POST', body: JSON.stringify({ ops }) }),
  setTree: (siteId: string, pageId: string, tree: WbNode) =>
    req<Page>(`/sites/${siteId}/pages/${pageId}/tree`, { method: 'PUT', body: JSON.stringify(tree) }),
  listSubmissions: (siteId: string, formId?: string) =>
    req<Submission[]>(`/sites/${siteId}/submissions${formId ? `?formId=${encodeURIComponent(formId)}` : ''}`),
  listSymbols: (siteId: string) => req<SymbolSummary[]>(`/sites/${siteId}/symbols`),
  setSymbol: (siteId: string, symbolId: string, node: WbNode) =>
    req<WbNode>(`/sites/${siteId}/symbols/${encodeURIComponent(symbolId)}`, { method: 'PUT', body: JSON.stringify(node) }),
  deleteSymbol: (siteId: string, symbolId: string) =>
    req<void>(`/sites/${siteId}/symbols/${encodeURIComponent(symbolId)}`, { method: 'DELETE' }),
  listComponents: () => req<ComponentSummary[]>('/components'),
  listBlocks: () => req<BlockSummary[]>('/blocks'),
  getBlock: (id: string) => req<Block>(`/blocks/${id}`),
  getComponent: (type: string) => req<ComponentDetail>(`/components/${type}`),
  setTheme: (siteId: string, patch: Partial<Theme>) =>
    req<Theme>(`/sites/${siteId}/theme`, { method: 'PUT', body: JSON.stringify(patch) }),
  sendChat: (siteId: string, body: { message: string; pageId?: string; selectedNodeId?: string }) =>
    req<{ sessionId: string; live: boolean }>(`/sites/${siteId}/chat`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // `since` is the cursor, and it only ever moves forward — it is what makes a
  // reload replay the transcript rather than start it again.
  pollChat: (siteId: string, since: number) => req<ChatRead>(`/sites/${siteId}/chat?since=${since}`),
  resetChat: (siteId: string) => req<void>(`/sites/${siteId}/chat`, { method: 'DELETE' }),
  listAssets: (siteId: string) => req<Asset[]>(`/sites/${siteId}/assets`),

  /**
   * Ask for a picture. Comes back 202 with a ticket, never with the picture.
   *
   * The panel has to hold the ticket and come back for it, which is not an
   * inconvenience of the API: the render is queued and paid for the moment this
   * resolves, so a request that waited would be holding the only copy of a
   * receipt inside a connection a phone can drop.
   */
  generateAsset: (siteId: string, spec: Record<string, unknown>) =>
    req<ImageTicket>(`/sites/${siteId}/assets/generate`, {
      method: 'POST',
      body: JSON.stringify(spec),
    }),

  /** Asking is what advances it, and asking twice does not buy twice. */
  pollGeneratedAsset: (siteId: string, ticket: string) =>
    req<ImageTicket>(`/sites/${siteId}/assets/generate/${encodeURIComponent(ticket)}`),

  /** What is still rendering for this site — what a reopened picker resumes. */
  listImageTickets: (siteId: string) =>
    req<{ tickets: ImageTicket[] }>(`/sites/${siteId}/assets/generate`),

  publish: (siteId: string) =>
    req<{ distPath: string; pageCount: number; warnings: Array<{ page: string; message: string }> }>(
      `/sites/${siteId}/publish`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};
