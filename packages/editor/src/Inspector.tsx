import { useEffect, useState } from 'react';
import { api } from './api';
import { SchemaFields } from './SchemaFields';
import type { ComponentDetail, TreeOp, WbNode } from './types';

const GAP_TOKENS = ['', 'none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];
const COLOR_TOKENS = ['', 'primary', 'secondary', 'accent', 'background', 'surface', 'text', 'textMuted', 'white'];

function Select({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  testId?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o === '' ? '—' : o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Inspector({
  node,
  isRoot,
  isContainer,
  onOps,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
}: {
  node: WbNode | null;
  isRoot: boolean;
  isContainer: (type: string) => boolean;
  onOps: (ops: TreeOp[]) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [detail, setDetail] = useState<ComponentDetail | null>(null);
  const [tab, setTab] = useState<'props' | 'layout' | 'style'>('props');

  useEffect(() => {
    setDetail(null);
    if (node) api.getComponent(node.type).then(setDetail).catch(() => {});
  }, [node?.type]);

  if (!node) {
    return (
      <section className="panel inspector">
        <h2>Inspector</h2>
        <p className="hint">Click an element in the canvas (or the outline) to edit it.</p>
      </section>
    );
  }

  const layout = (node.layout ?? {}) as Record<string, string | number | boolean>;
  const style = (node.style ?? {}) as Record<string, unknown>;
  const responsive = (node.responsive ?? {}) as Record<string, { hidden?: boolean } & Record<string, unknown>>;

  // A null value deletes the key server-side (mergeClean in @wb/schema ops).
  const setLayout = (key: string, value: unknown) => {
    onOps([{ op: 'update', nodeId: node.id, layout: { [key]: value === '' ? null : value } }]);
  };

  const setStyle = (key: string, value: unknown) => {
    onOps([{ op: 'update', nodeId: node.id, style: { [key]: value === '' ? null : value } }]);
  };

  // Hover/focus are nested style objects; mergeClean replaces the whole object,
  // so send the full state each edit (and clear it entirely when it empties).
  const setState = (state: 'hover' | 'focus', key: string, value: unknown) => {
    const current = { ...((style[state] as Record<string, unknown>) ?? {}) };
    if (value === '' || value === undefined) delete current[key];
    else current[key] = value;
    onOps([
      { op: 'update', nodeId: node.id, style: { [state]: Object.keys(current).length ? current : null } },
    ]);
  };
  const hover = (style.hover as Record<string, unknown>) ?? {};
  const focus = (style.focus as Record<string, unknown>) ?? {};

  const border = (style.border as { color?: string; width?: number; sides?: string[] }) ?? {};
  const commitBorder = (next: { color?: string; width?: unknown; sides?: string[] }) => {
    onOps([
      {
        op: 'update',
        nodeId: node.id,
        style: {
          border: next.color
            ? {
                color: next.color,
                ...(next.width ? { width: Number(next.width) } : {}),
                // Omit `sides` when it covers all four — that's the plain-border default.
                ...(next.sides && next.sides.length && next.sides.length < 4 ? { sides: next.sides } : {}),
              }
            : null,
        },
      },
    ]);
  };
  const setBorder = (key: string, value: unknown) =>
    commitBorder({ ...border, [key]: value === '' ? undefined : value });
  const toggleBorderSide = (side: string) => {
    // Undefined `sides` means all four are on; start from that so clicking a lit
    // side turns it off (leaving the other three) rather than isolating it.
    const cur = new Set(border.sides ?? ['top', 'right', 'bottom', 'left']);
    if (cur.has(side)) cur.delete(side);
    else cur.add(side);
    // Zero sides isn't a real state (that's "no border" — clear the colour instead);
    // fall back to all four. commitBorder omits `sides` when it covers all four.
    commitBorder({ ...border, sides: cur.size ? [...cur] : ['top', 'right', 'bottom', 'left'] });
  };

  // A gradient needs both stops; keep a local draft (Inspector is keyed per node,
  // so this resets on selection) so picking "from" before "to" isn't lost, and
  // an incomplete gradient doesn't clobber an existing background.
  const committedGrad =
    typeof style.background === 'object' && style.background && 'gradient' in style.background
      ? ((style.background as { gradient: Record<string, unknown> }).gradient ?? {})
      : {};
  const [grad, setGradDraft] = useState<Record<string, unknown>>(committedGrad);
  const setGrad = (key: string, value: unknown) => {
    const next = { ...grad, [key]: value === '' ? undefined : value } as Record<string, unknown>;
    setGradDraft(next);
    if (next.from && next.to) {
      onOps([
        {
          op: 'update',
          nodeId: node.id,
          style: {
            background: {
              gradient: { from: next.from, to: next.to, ...(next.angle != null ? { angle: Number(next.angle) } : {}) },
            },
          },
        },
      ]);
    } else if (typeof style.background === 'object' && style.background && 'gradient' in style.background) {
      // had a committed gradient, now incomplete → clear the background
      onOps([{ op: 'update', nodeId: node.id, style: { background: null } }]);
    }
  };

  const setHidden = (bp: 'tablet' | 'mobile', hidden: boolean) => {
    const next = {
      ...responsive,
      [bp]: { ...(responsive[bp] ?? {}), hidden: hidden || undefined },
    };
    if (!hidden && next[bp] && Object.values(next[bp]!).every((v) => v === undefined)) delete next[bp];
    onOps([{ op: 'update', nodeId: node.id, responsive: next as never }]);
  };

  return (
    <section className="panel inspector" data-testid="inspector">
      <h2>
        <code>{node.type}</code> <span className="muted">{node.id}</span>
      </h2>
      {!isRoot && (
        <div className="node-actions">
          <button type="button" onClick={onMoveUp} title="Move up">↑</button>
          <button type="button" onClick={onMoveDown} title="Move down">↓</button>
          <button type="button" onClick={onDuplicate} title="Duplicate">⧉</button>
          <button type="button" className="danger" onClick={onDelete} title="Delete" data-testid="delete-node">🗑</button>
        </div>
      )}
      <nav className="tabs">
        {(['props', 'layout', 'style'] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'props' &&
        (detail ? (
          <SchemaFields
            schema={detail.propsSchema}
            values={node.props}
            onCommit={(props) => onOps([{ op: 'update', nodeId: node.id, props }])}
          />
        ) : (
          <p className="hint">loading schema…</p>
        ))}

      {tab === 'layout' && (
        <div className="fields">
          {isContainer(node.type) || node.layout ? (
            <>
              <Select
                label="direction"
                testId="layout-direction"
                value={(layout.direction as string) ?? ''}
                options={['', 'stack', 'row', 'grid']}
                onChange={(v) => setLayout('direction', v)}
              />
              {layout.direction === 'grid' && (
                <Select
                  label="columns"
                  value={String(layout.columns ?? '')}
                  options={['', '1', '2', '3', '4', '5', '6']}
                  onChange={(v) => setLayout('columns', v === '' ? '' : Number(v))}
                />
              )}
              <Select label="gap" value={(layout.gap as string) ?? ''} options={GAP_TOKENS} onChange={(v) => setLayout('gap', v)} />
              <Select
                label="padding"
                value={typeof layout.padding === 'string' ? layout.padding : ''}
                options={GAP_TOKENS}
                onChange={(v) => setLayout('padding', v)}
              />
              <Select
                label="align"
                value={(layout.align as string) ?? ''}
                options={['', 'start', 'center', 'end', 'stretch']}
                onChange={(v) => setLayout('align', v)}
              />
              <Select
                label="justify"
                value={(layout.justify as string) ?? ''}
                options={['', 'start', 'center', 'end', 'between']}
                onChange={(v) => setLayout('justify', v)}
              />
              <Select
                label="max width"
                value={(layout.maxWidth as string) ?? ''}
                options={['', 'content', 'wide', 'full']}
                onChange={(v) => setLayout('maxWidth', v)}
              />
            </>
          ) : (
            <p className="hint">This component manages its own internal layout.</p>
          )}
          <h3>Visibility</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(responsive.tablet?.hidden)}
              onChange={(e) => setHidden('tablet', e.target.checked)}
            />
            hide on tablet
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(responsive.mobile?.hidden)}
              onChange={(e) => setHidden('mobile', e.target.checked)}
            />
            hide on mobile
          </label>
        </div>
      )}

      {tab === 'style' && (
        <div className="fields">
          <Select
            label="background"
            testId="style-background"
            value={typeof style.background === 'string' ? (style.background as string) : ''}
            options={COLOR_TOKENS}
            onChange={(v) => setStyle('background', v)}
          />
          <Select
            label="text color"
            value={(style.color as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setStyle('color', v)}
          />
          <Select
            label="radius"
            value={(style.radius as string) ?? ''}
            options={['', 'none', 'sm', 'md', 'lg', 'full']}
            onChange={(v) => setStyle('radius', v)}
          />
          <Select
            label="shadow"
            value={(style.shadow as string) ?? ''}
            options={['', 'none', 'sm', 'md', 'lg']}
            onChange={(v) => setStyle('shadow', v)}
          />
          <Select
            label="min height"
            value={(style.minHeight as string) ?? ''}
            options={['', 'auto', 'half', 'screen']}
            onChange={(v) => setStyle('minHeight', v)}
          />
          <div className="style-state-head">Hover state</div>
          <Select
            label="hover background"
            testId="style-hover-background"
            value={(hover.background as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setState('hover', 'background', v)}
          />
          <Select
            label="hover text"
            value={(hover.color as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setState('hover', 'color', v)}
          />
          <Select
            label="hover shadow"
            value={(hover.shadow as string) ?? ''}
            options={['', 'none', 'sm', 'md', 'lg']}
            onChange={(v) => setState('hover', 'shadow', v)}
          />

          <div className="style-state-head">Focus state (keyboard)</div>
          <Select
            label="focus background"
            testId="style-focus-background"
            value={(focus.background as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setState('focus', 'background', v)}
          />
          <Select
            label="focus text"
            value={(focus.color as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setState('focus', 'color', v)}
          />
          <Select
            label="focus shadow"
            value={(focus.shadow as string) ?? ''}
            options={['', 'none', 'sm', 'md', 'lg']}
            onChange={(v) => setState('focus', 'shadow', v)}
          />

          <div className="style-state-head">Typography</div>
          <Select
            label="weight"
            value={(style.fontWeight as string) ?? ''}
            options={['', 'normal', 'medium', 'semibold', 'bold']}
            onChange={(v) => setStyle('fontWeight', v)}
          />
          <Select
            label="letter spacing"
            value={(style.letterSpacing as string) ?? ''}
            options={['', 'tight', 'normal', 'wide']}
            onChange={(v) => setStyle('letterSpacing', v)}
          />
          <Select
            label="text case"
            value={(style.textTransform as string) ?? ''}
            options={['', 'none', 'uppercase', 'capitalize']}
            onChange={(v) => setStyle('textTransform', v)}
          />

          <div className="style-state-head">Border</div>
          <Select
            label="border color"
            testId="style-border-color"
            value={(border.color as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setBorder('color', v)}
          />
          <Select
            label="border width"
            value={border.width ? String(border.width) : ''}
            options={['', '1', '2']}
            onChange={(v) => setBorder('width', v)}
          />
          {border.color && (
            <label className="field">
              <span>sides</span>
              <span className="side-toggles" data-testid="style-border-sides">
                {(['top', 'right', 'bottom', 'left'] as const).map((side) => {
                  const on = !border.sides || border.sides.includes(side);
                  return (
                    <button
                      key={side}
                      type="button"
                      className={`side-toggle${on ? ' on' : ''}`}
                      data-testid={`style-border-side-${side}`}
                      aria-pressed={on}
                      title={side}
                      onClick={() => toggleBorderSide(side)}
                    >
                      {side[0]?.toUpperCase()}
                    </button>
                  );
                })}
              </span>
            </label>
          )}

          <div className="style-state-head">Gradient background</div>
          <Select
            label="from"
            testId="style-grad-from"
            value={(grad.from as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setGrad('from', v)}
          />
          <Select
            label="to"
            testId="style-grad-to"
            value={(grad.to as string) ?? ''}
            options={COLOR_TOKENS}
            onChange={(v) => setGrad('to', v)}
          />
          <label className="field">
            <span>angle</span>
            <input
              type="number"
              min="0"
              max="360"
              value={(grad.angle as number) ?? ''}
              onChange={(e) => setGrad('angle', e.target.value)}
            />
          </label>
        </div>
      )}
    </section>
  );
}
