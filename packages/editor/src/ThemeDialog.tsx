import { useState } from 'react';
import { api } from './api';
import type { Site } from './types';

const FONT_STACKS = ['serif-classic', 'serif-modern', 'sans-modern', 'sans-geometric', 'sans-humanist', 'mono'];
const COLOR_LABELS: Record<string, string> = {
  primary: 'Primary (buttons, links)',
  secondary: 'Secondary (footer, dark)',
  accent: 'Accent',
  background: 'Page background',
  surface: 'Surface (cards, bands)',
  text: 'Text',
  textMuted: 'Muted text',
};

export function ThemeDialog({
  site,
  onClose,
  onSaved,
}: {
  site: Site;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [colors, setColors] = useState({ ...site.theme.colors });
  const [fonts, setFonts] = useState({ ...site.theme.fonts });
  const [brandName, setBrandName] = useState(site.theme.brandName);
  const [radiusScale, setRadiusScale] = useState(site.theme.radiusScale);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    try {
      setSaving(true);
      setError('');
      await api.setTheme(site.id, { colors, fonts, brandName, radiusScale } as never);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} data-testid="theme-dialog">
        <h2>Theme</h2>
        <label className="field">
          <span>Brand name</span>
          <input value={brandName} onChange={(e) => setBrandName(e.target.value)} />
        </label>
        <div className="theme-colors">
          {Object.entries(COLOR_LABELS).map(([key, label]) => (
            <label key={key} className="field color-field">
              <span>{label}</span>
              <span className="color-input">
                <input
                  type="color"
                  value={colors[key] ?? '#000000'}
                  data-testid={`theme-${key}`}
                  onChange={(e) => setColors((c) => ({ ...c, [key]: e.target.value }))}
                />
                <input
                  className="hex"
                  value={colors[key] ?? ''}
                  onChange={(e) => setColors((c) => ({ ...c, [key]: e.target.value }))}
                />
              </span>
            </label>
          ))}
        </div>
        <div className="theme-fonts">
          <label className="field">
            <span>Heading font</span>
            <select value={fonts.heading} onChange={(e) => setFonts((f) => ({ ...f, heading: e.target.value }))}>
              {FONT_STACKS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Body font</span>
            <select value={fonts.body} onChange={(e) => setFonts((f) => ({ ...f, body: e.target.value }))}>
              {FONT_STACKS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Corner rounding</span>
            <select value={radiusScale} onChange={(e) => setRadiusScale(e.target.value)}>
              {['sharp', 'soft', 'round'].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={saving} data-testid="theme-save">
            {saving ? 'Saving…' : 'Save theme'}
          </button>
        </div>
      </div>
    </div>
  );
}
