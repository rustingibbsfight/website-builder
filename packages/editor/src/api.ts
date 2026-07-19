import type { ComponentDetail, ComponentSummary, Page, PageSummary, Site, Theme, TreeOp, WbNode } from './types';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
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
  listSites: () => req<Site[]>('/sites'),
  getSite: (siteId: string) => req<Site>(`/sites/${siteId}`),
  listPages: (siteId: string) => req<PageSummary[]>(`/sites/${siteId}/pages`),
  getPage: (siteId: string, pageId: string) => req<Page>(`/sites/${siteId}/pages/${pageId}`),
  addPage: (siteId: string, slug: string, title: string) =>
    req<Page>(`/sites/${siteId}/pages`, { method: 'POST', body: JSON.stringify({ slug, title }) }),
  deletePage: (siteId: string, pageId: string) =>
    req<void>(`/sites/${siteId}/pages/${pageId}`, { method: 'DELETE' }),
  applyOps: (siteId: string, pageId: string, ops: TreeOp[]) =>
    req<Page>(`/sites/${siteId}/pages/${pageId}/tree/ops`, { method: 'POST', body: JSON.stringify({ ops }) }),
  setTree: (siteId: string, pageId: string, tree: WbNode) =>
    req<Page>(`/sites/${siteId}/pages/${pageId}/tree`, { method: 'PUT', body: JSON.stringify(tree) }),
  listComponents: () => req<ComponentSummary[]>('/components'),
  getComponent: (type: string) => req<ComponentDetail>(`/components/${type}`),
  setTheme: (siteId: string, patch: Partial<Theme>) =>
    req<Theme>(`/sites/${siteId}/theme`, { method: 'PUT', body: JSON.stringify(patch) }),
  publish: (siteId: string) =>
    req<{ distPath: string; pageCount: number; warnings: Array<{ page: string; message: string }> }>(
      `/sites/${siteId}/publish`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};
