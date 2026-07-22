import { useState } from 'react';
import { nodeLabel } from './tree-utils';
import type { BlockSummary, ComponentSummary, PageSummary, WbNode } from './types';

export function BlocksPanel({
  blocks,
  onInsert,
}: {
  blocks: BlockSummary[];
  onInsert: (id: string) => void;
}) {
  const cats = [...new Set(blocks.map((b) => b.category))];
  if (blocks.length === 0) return null;
  return (
    <section className="panel palette">
      <h2>Blocks</h2>
      <p className="hint">Click to add a pre-built section to the page.</p>
      {cats.map((cat) => (
        <div key={cat}>
          <h3>{cat}</h3>
          <div className="palette-grid">
            {blocks
              .filter((b) => b.category === cat)
              .map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="palette-item"
                  title={b.description}
                  data-testid={`block-${b.id}`}
                  onClick={() => onInsert(b.id)}
                >
                  {b.name}
                </button>
              ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function PagesPanel({
  pages,
  currentId,
  onSelect,
  onAdd,
  onDelete,
}: {
  pages: PageSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onAdd: (slug: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');

  return (
    <section className="panel">
      <h2>
        Pages
        <button type="button" className="ghost" onClick={() => setAdding((a) => !a)} title="Add page">
          ＋
        </button>
      </h2>
      {adding && (
        <form
          className="add-page"
          onSubmit={(e) => {
            e.preventDefault();
            if (slug && title) {
              onAdd(slug, title);
              setAdding(false);
              setSlug('');
              setTitle('');
            }
          }}
        >
          <input placeholder="slug (e.g. pricing)" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="submit">Add</button>
        </form>
      )}
      <ul className="pages">
        {pages.map((p) => (
          <li key={p.id} className={p.id === currentId ? 'active' : ''}>
            <button type="button" onClick={() => onSelect(p.id)}>
              /{p.slug} <span className="muted">{p.title}</span>
            </button>
            <button type="button" className="ghost danger" onClick={() => onDelete(p.id)} title="Delete page">
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const CATEGORY_ORDER = ['layout', 'composite', 'primitive', 'chrome'];

export function Palette({
  components,
  onStartDrag,
  onEndDrag,
  onInsert,
}: {
  components: ComponentSummary[];
  onStartDrag: (type: string) => void;
  onEndDrag: () => void;
  onInsert: (type: string) => void;
}) {
  const grouped = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: components.filter((c) => c.category === cat && c.type !== 'page-root'),
  })).filter((g) => g.items.length > 0);

  return (
    <section className="panel palette">
      <h2>Components</h2>
      <p className="hint">Drag onto the canvas, or double-click to insert into the selected container.</p>
      {grouped.map(({ cat, items }) => (
        <div key={cat}>
          <h3>{cat}</h3>
          <div className="palette-grid">
            {items.map((c) => (
              <div
                key={c.type}
                className="palette-item"
                draggable
                title={c.description}
                data-testid={`palette-${c.type}`}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('text/plain', c.type);
                  onStartDrag(c.type);
                }}
                onDragEnd={onEndDrag}
                onDoubleClick={() => onInsert(c.type)}
              >
                {c.title}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function OutlineTree({
  root,
  selectedId,
  isContainer,
  onSelect,
  onStartDrag,
  onEndDrag,
  onMove,
}: {
  root: WbNode;
  selectedId: string | null;
  isContainer: (type: string) => boolean;
  onSelect: (id: string) => void;
  onStartDrag: (nodeId: string) => void;
  onEndDrag: () => void;
  onMove: (nodeId: string, parentId: string, index: number) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);

  const Row = ({ node, depth, parent, index }: { node: WbNode; depth: number; parent: WbNode | null; index: number }) => {
    const [over, setOver] = useState<'before' | 'into' | null>(null);
    const label = nodeLabel(node);
    return (
      <>
        <div
          className={`outline-row ${node.id === selectedId ? 'selected' : ''} ${over ? `over-${over}` : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={parent !== null}
          data-testid={`outline-${node.id}`}
          onClick={() => onSelect(node.id)}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.effectAllowed = 'move';
            setDragId(node.id);
            onStartDrag(node.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            onEndDrag();
          }}
          onDragOver={(e) => {
            if (!dragId || dragId === node.id) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const isTop = e.clientY < rect.top + rect.height / 2;
            setOver(isContainer(node.type) && !isTop ? 'into' : 'before');
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = dragId;
            setOver(null);
            setDragId(null);
            if (!id || id === node.id) return;
            if (over === 'into' && isContainer(node.type)) {
              onMove(id, node.id, node.children?.length ?? 0);
            } else if (parent) {
              onMove(id, parent.id, index);
            }
          }}
        >
          <span className="outline-type">{node.type}</span>
          {label && <span className="outline-label">{label}</span>}
        </div>
        {node.children?.map((child, i) => (
          <Row key={child.id} node={child} depth={depth + 1} parent={node} index={i} />
        ))}
      </>
    );
  };

  return (
    <section className="panel outline">
      <h2>Outline</h2>
      <div className="outline-tree">
        <Row node={root} depth={0} parent={null} index={0} />
      </div>
    </section>
  );
}
