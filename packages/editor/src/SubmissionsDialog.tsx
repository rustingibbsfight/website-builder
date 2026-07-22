import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { Submission } from './types';

/**
 * Read-only "inbox" for form submissions captured by stored forms (#27).
 * Backed by GET /sites/:id/submissions — the same data agents read via the MCP
 * `list_submissions` tool. Grouped by formId.
 */
export function SubmissionsDialog({ siteId, onClose }: { siteId: string; onClose: () => void }) {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listSubmissions(siteId)
      .then(setSubs)
      .catch((e: Error) => setError(e.message));
  }, [siteId]);

  const byForm = useMemo(() => {
    const groups = new Map<string, Submission[]>();
    for (const s of subs ?? []) {
      const list = groups.get(s.formId) ?? [];
      list.push(s);
      groups.set(s.formId, list);
    }
    return [...groups.entries()];
  }, [subs]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} data-testid="submissions-dialog" style={{ maxWidth: 720 }}>
        <h2>Form submissions</h2>
        {error && <p className="error">{error}</p>}
        {!subs && !error && <p className="hint">loading…</p>}
        {subs && subs.length === 0 && (
          <p className="hint" data-testid="submissions-empty">
            No submissions yet. Enable “store” on a Contact form and set the site’s form endpoint, and captures show up here.
          </p>
        )}
        {byForm.map(([formId, list]) => {
          // Union of field keys across this form's submissions → table columns.
          const cols = [...new Set(list.flatMap((s) => Object.keys(s.data)))];
          return (
            <section key={formId} className="subs-group">
              <h3>
                {formId} <span className="hint">· {list.length}</span>
              </h3>
              <div className="subs-scroll">
                <table className="subs-table">
                  <thead>
                    <tr>
                      <th>received</th>
                      {cols.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id}>
                        <td className="subs-when">{new Date(s.createdAt).toLocaleString()}</td>
                        {cols.map((c) => (
                          <td key={c}>{s.data[c] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
