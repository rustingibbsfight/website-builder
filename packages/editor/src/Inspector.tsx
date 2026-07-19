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
        </div>
      )}
    </section>
  );
}
