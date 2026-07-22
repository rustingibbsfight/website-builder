import { useEffect, useState } from 'react';
import { api } from './api';
import { Editor } from './Editor';
import type { Site, TemplateInfo } from './types';

function siteIdFromPath(): string | null {
  const m = window.location.pathname.match(/^\/editor\/([^/]+)/);
  return m ? m[1]! : null;
}

export function App() {
  const [siteId, setSiteId] = useState<string | null>(siteIdFromPath());
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .authMe()
      .then((me) => setAuthed(me.authenticated))
      .catch(() => setAuthed(true)); // older server without /auth — assume open
  }, []);

  useEffect(() => {
    const onPop = () => setSiteId(siteIdFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = (id: string) => {
    window.history.pushState({}, '', `/editor/${id}`);
    setSiteId(id);
  };

  if (authed === null) return <div className="loading">loading…</div>;
  if (!authed) return <TokenGate onAuthed={() => setAuthed(true)} />;
  if (siteId) return <Editor siteId={siteId} onExit={() => open('')} />;
  return <SiteList onOpen={open} />;
}

function TokenGate({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  return (
    <div className="site-list">
      <h1>wb editor</h1>
      <p className="muted">This server requires an API token (its WB_API_TOKEN).</p>
      <form
        className="add-page"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.login(token);
            onAuthed();
          } catch {
            setError('Invalid token.');
          }
        }}
      >
        <input
          type="password"
          placeholder="API token"
          value={token}
          data-testid="token-input"
          onChange={(e) => setToken(e.target.value)}
        />
        <button type="submit" className="primary" data-testid="token-submit">
          Sign in
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SiteList({ onOpen }: { onOpen: (id: string) => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [template, setTemplate] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listSites().then(setSites).catch((e: Error) => setError(e.message));
    api
      .listTemplates()
      .then((t) => {
        setTemplates(t);
        setTemplate((cur) => cur || t[0]?.name || '');
      })
      .catch(() => {});
  }, []);

  const create = async () => {
    if (!template) return;
    try {
      setCreating(true);
      setError('');
      const { site } = await api.createFromTemplate(template, newName.trim() || undefined);
      onOpen(site.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="site-list">
      <h1>wb editor</h1>
      <p className="muted">Pick a site to edit, or start a new one from a template.</p>

      {templates.length > 0 && (
        <form
          className="add-page"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <select value={template} onChange={(e) => setTemplate(e.target.value)} data-testid="new-template">
            {templates.map((t) => (
              <option key={t.name} value={t.name} title={t.description}>
                {t.title}
              </option>
            ))}
          </select>
          <input
            placeholder="Site name (optional)"
            value={newName}
            data-testid="new-name"
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="primary" disabled={creating} data-testid="new-create">
            {creating ? 'Creating…' : 'Create site'}
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}
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
