import { useEffect, useState } from 'react';
import { api } from './api';
import { Editor } from './Editor';
import type { Site } from './types';

function siteIdFromPath(): string | null {
  const m = window.location.pathname.match(/^\/editor\/([^/]+)/);
  return m ? m[1]! : null;
}

export function App() {
  const [siteId, setSiteId] = useState<string | null>(siteIdFromPath());

  useEffect(() => {
    const onPop = () => setSiteId(siteIdFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = (id: string) => {
    window.history.pushState({}, '', `/editor/${id}`);
    setSiteId(id);
  };

  if (siteId) return <Editor siteId={siteId} onExit={() => open('')} />;
  return <SiteList onOpen={open} />;
}

function SiteList({ onOpen }: { onOpen: (id: string) => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listSites().then(setSites).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="site-list">
      <h1>wb editor</h1>
      <p className="muted">Pick a site to edit — or create one with the CLI / API / MCP.</p>
      {error && <p className="error">{error}</p>}
      {sites?.length === 0 && (
        <p>
          No sites yet. Create one: <code>wb create "My Site" --template breakthrough-medical</code>
        </p>
      )}
      <ul>
        {sites?.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => onOpen(s.id)}>
              <strong>{s.name}</strong> <span className="muted">{s.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
