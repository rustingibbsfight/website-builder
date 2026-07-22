import { useMemo, useState } from 'react';
import { api } from './api';
import type { Page, PageMeta, Site } from './types';

const DESC_MAX = 160;

/** Trim to a value only if non-empty, so blanks clear the field on the server. */
function clean(meta: PageMeta): PageMeta {
  const out: PageMeta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === 'string') out[k as keyof PageMeta] = v.trim() as never;
    else if (v !== undefined) out[k as keyof PageMeta] = v as never;
  }
  return out;
}

export function SeoDialog({
  site,
  page,
  onClose,
  onSaved,
}: {
  site: Site;
  page: Page;
  onClose: () => void;
  onSaved: (page: Page) => void;
}) {
  const [meta, setMeta] = useState<PageMeta>({ ...page.meta });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<PageMeta>) => setMeta((m) => ({ ...m, ...patch }));

  const brand = site.theme.brandName;
  const isHome = page.slug === '' || page.slug === 'index';
  const defaultTitle = isHome ? `${brand} — ${page.title}` : `${page.title} — ${brand}`;
  const base = (site.settings?.baseUrl || 'https://your-site.com').replace(/\/$/, '');
  const path = isHome ? '/' : `/${page.slug}/`;

  // Effective values, mirroring the renderer's fallbacks — this is the preview.
  const eff = useMemo(() => {
    const title = meta.title?.trim() || defaultTitle;
    const description = meta.description?.trim() || '';
    return {
      title,
      description,
      ogTitle: meta.ogTitle?.trim() || title,
      ogDescription: meta.ogDescription?.trim() || description,
      ogImage: meta.ogImage?.trim() || '',
    };
  }, [meta, defaultTitle]);

  const save = async () => {
    try {
      setSaving(true);
      setError('');
      const updated = await api.setPageMeta(site.id, page.id, clean(meta));
      onSaved(updated);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const descLen = (meta.description ?? '').length;
  const prettyUrl = `${base.replace(/^https?:\/\//, '')}${path}`;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        data-testid="seo-dialog"
        style={{ maxWidth: 560 }}
      >
        <h2>SEO &amp; social — /{page.slug || '(home)'}</h2>

        {/* Live search-result preview */}
        <div style={previewBox}>
          <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.6 }}>
            Google preview
          </div>
          <div style={{ color: '#1a73e8', fontSize: 18, lineHeight: 1.3, marginTop: 6 }}>
            {truncate(eff.title, 60)}
          </div>
          <div style={{ color: '#0a8043', fontSize: 13, margin: '2px 0 4px' }}>{prettyUrl}</div>
          <div style={{ fontSize: 13, lineHeight: 1.5, opacity: 0.85 }}>
            {eff.description ? truncate(eff.description, DESC_MAX) : 'Add a description to control this snippet.'}
          </div>
          {meta.noIndex && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#c0555d' }}>⚠ noindex — hidden from search &amp; sitemap</div>
          )}
        </div>

        <label className="field">
          <span>SEO title</span>
          <input
            data-testid="seo-title"
            value={meta.title ?? ''}
            placeholder={defaultTitle}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <label className="field">
          <span>
            Meta description{' '}
            <em style={{ opacity: 0.6, fontStyle: 'normal' }}>
              {descLen}/{DESC_MAX}
              {descLen > DESC_MAX ? ' — long' : ''}
            </em>
          </span>
          <textarea
            data-testid="seo-description"
            rows={3}
            value={meta.description ?? ''}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>

        <details style={{ margin: '4px 0' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '.9rem' }}>Social sharing (Open Graph)</summary>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Social card preview */}
            <div style={{ ...previewBox, padding: 0, overflow: 'hidden' }}>
              {eff.ogImage ? (
                <img src={eff.ogImage} alt="" style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }} />
              ) : (
                <div style={{ height: 90, display: 'grid', placeItems: 'center', opacity: 0.5, fontSize: 13 }}>
                  no OG image
                </div>
              )}
              <div style={{ padding: '8px 12px' }}>
                <div style={{ fontSize: 11, opacity: 0.6 }}>{base.replace(/^https?:\/\//, '')}</div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{truncate(eff.ogTitle, 70)}</div>
                {eff.ogDescription && (
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{truncate(eff.ogDescription, 120)}</div>
                )}
              </div>
            </div>
            <label className="field">
              <span>OG image (URL or uploaded asset id)</span>
              <input
                data-testid="seo-ogimage"
                value={meta.ogImage ?? ''}
                placeholder="https://…/share.png"
                onChange={(e) => set({ ogImage: e.target.value })}
              />
            </label>
            <label className="field">
              <span>OG title</span>
              <input value={meta.ogTitle ?? ''} placeholder={eff.title} onChange={(e) => set({ ogTitle: e.target.value })} />
            </label>
            <label className="field">
              <span>OG description</span>
              <textarea
                rows={2}
                value={meta.ogDescription ?? ''}
                placeholder={eff.description || 'Defaults to the meta description'}
                onChange={(e) => set({ ogDescription: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Twitter card</span>
              <select
                value={meta.twitterCard ?? ''}
                onChange={(e) => set({ twitterCard: (e.target.value || undefined) as PageMeta['twitterCard'] })}
              >
                <option value="">Auto (large image when set)</option>
                <option value="summary_large_image">Large image</option>
                <option value="summary">Summary</option>
              </select>
            </label>
          </div>
        </details>

        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            data-testid="seo-noindex"
            checked={!!meta.noIndex}
            onChange={(e) => set({ noIndex: e.target.checked })}
            style={{ width: 'auto' }}
          />
          <span>Hide this page from search engines (noindex)</span>
        </label>

        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={saving} data-testid="seo-save">
            {saving ? 'Saving…' : 'Save SEO'}
          </button>
        </div>
      </div>
    </div>
  );
}

const previewBox: React.CSSProperties = {
  border: '1px solid var(--line, #ddd)',
  borderRadius: 8,
  padding: 12,
  background: 'var(--surface-2, rgba(127,127,127,.06))',
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
