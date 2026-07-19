import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Inspector } from './Inspector';
import { OutlineTree, Palette, PagesPanel } from './panels';
import { ThemeDialog } from './ThemeDialog';
import { collectContainerIds, findNode, findParent, stripIds } from './tree-utils';
import type { ComponentSummary, Page, PageSummary, Site, TreeOp, WbNode } from './types';

const VIEWPORTS = { desktop: '100%', tablet: '834px', mobile: '390px' } as const;
type Viewport = keyof typeof VIEWPORTS;

/** Sensible starting layout when dropping a fresh container. */
const LAYOUT_DEFAULTS: Record<string, Record<string, unknown>> = {
  section: { direction: 'stack', gap: 'md', padding: 'xl', maxWidth: 'wide' },
  stack: { direction: 'stack', gap: 'md' },
  grid: { direction: 'grid', columns: 3, gap: 'lg' },
};

export interface DragState {
  kind: 'palette' | 'node';
  type?: string;
  nodeId?: string;
}

export function Editor({ siteId, onExit }: { siteId: string; onExit: () => void }) {
  const [site, setSite] = useState<Site | null>(null);
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [components, setComponents] = useState<ComponentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [status, setStatus] = useState('');
  const [themeOpen, setThemeOpen] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const undoStack = useRef<WbNode[]>([]);
  const redoStack = useRef<WbNode[]>([]);
  const dropTarget = useRef<{ containerId: string; index: number } | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const isContainer = useCallback(
    (type: string) => components.find((c) => c.type === type)?.isContainer ?? false,
    [components],
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  useEffect(() => {
    api.getSite(siteId).then(setSite).catch((e: Error) => setStatus(`error: ${e.message}`));
    api.listComponents().then(setComponents).catch(() => {});
    api
      .listPages(siteId)
      .then((list) => {
        setPages(list);
        setPageId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((e: Error) => setStatus(`error: ${e.message}`));
  }, [siteId]);

  useEffect(() => {
    if (!pageId) return;
    setSelectedId(null);
    undoStack.current = [];
    redoStack.current = [];
    api.getPage(siteId, pageId).then(setPage).catch((e: Error) => setStatus(`error: ${e.message}`));
  }, [siteId, pageId]);

  // ── Canvas messaging ───────────────────────────────────────────────────────
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // The preview iframe is same-origin; ignore messages from anywhere else.
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; nodeId?: string; containerId?: string | null; index?: number };
      if (d.type === 'wb:clicked' && d.nodeId) setSelectedId(d.nodeId);
      if (d.type === 'wb:ready' && selectedId) {
        frameRef.current?.contentWindow?.postMessage(
          { type: 'wb:select-node', nodeId: selectedId },
          window.location.origin,
        );
      }
      if (d.type === 'wb:drop-target') {
        dropTarget.current = d.containerId ? { containerId: d.containerId, index: d.index ?? 0 } : null;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [selectedId]);

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedId(nodeId);
    frameRef.current?.contentWindow?.postMessage({ type: 'wb:select-node', nodeId }, window.location.origin);
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const mutate = useCallback(
    async (ops: TreeOp[]) => {
      if (!page || !pageId) return;
      const before = page.tree;
      try {
        setStatus('saving…');
        const updated = await api.applyOps(siteId, pageId, ops);
        undoStack.current.push(before);
        redoStack.current = [];
        setPage(updated);
        setFrameKey((k) => k + 1);
        setStatus('saved');
      } catch (err) {
        setStatus(`error: ${(err as Error).message}`);
      }
    },
    [page, pageId, siteId],
  );

  const restoreTree = useCallback(
    async (tree: WbNode) => {
      if (!pageId) return;
      try {
        setStatus('saving…');
        const updated = await api.setTree(siteId, pageId, tree);
        setPage(updated);
        setFrameKey((k) => k + 1);
        setStatus('saved');
      } catch (err) {
        setStatus(`error: ${(err as Error).message}`);
      }
    },
    [pageId, siteId],
  );

  const undo = useCallback(async () => {
    const prev = undoStack.current.pop();
    if (!prev || !page) return;
    redoStack.current.push(page.tree);
    await restoreTree(prev);
  }, [page, restoreTree]);

  const redo = useCallback(async () => {
    const next = redoStack.current.pop();
    if (!next || !page) return;
    undoStack.current.push(page.tree);
    await restoreTree(next);
  }, [page, restoreTree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const insertComponent = useCallback(
    async (type: string, parentId: string, index?: number) => {
      const detail = await api.getComponent(type);
      const node: TreeOp & { op: 'insert' } = {
        op: 'insert',
        parentId,
        ...(index !== undefined ? { index } : {}),
        node: {
          type,
          props: detail.defaultProps,
          ...(LAYOUT_DEFAULTS[type] ? { layout: LAYOUT_DEFAULTS[type] } : {}),
        },
      };
      await mutate([node]);
    },
    [mutate],
  );

  const selectedNode = useMemo(
    () => (page && selectedId ? findNode(page.tree, selectedId) : null),
    [page, selectedId],
  );

  // ── Node actions ───────────────────────────────────────────────────────────
  const deleteSelected = useCallback(() => {
    if (selectedId && page && selectedId !== page.tree.id) {
      void mutate([{ op: 'remove', nodeId: selectedId }]);
      setSelectedId(null);
    }
  }, [selectedId, page, mutate]);

  const duplicateSelected = useCallback(() => {
    if (!selectedId || !page || !selectedNode) return;
    const found = findParent(page.tree, selectedId);
    if (!found) return;
    void mutate([
      { op: 'insert', parentId: found.parent.id, index: found.index + 1, node: stripIds(selectedNode) },
    ]);
  }, [selectedId, page, selectedNode, mutate]);

  const moveSelected = useCallback(
    (delta: number) => {
      if (!selectedId || !page) return;
      const found = findParent(page.tree, selectedId);
      if (!found) return;
      const target = found.index + delta;
      if (target < 0 || target >= (found.parent.children?.length ?? 0)) return;
      void mutate([{ op: 'move', nodeId: selectedId, parentId: found.parent.id, index: target }]);
    },
    [selectedId, page, mutate],
  );

  // ── Canvas drag overlay ────────────────────────────────────────────────────
  const containerIds = useMemo(
    () => (page ? collectContainerIds(page.tree, isContainer) : []),
    [page, isContainer],
  );

  const overlayDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const iframe = frameRef.current;
    if (!iframe) return;
    const rect = iframe.getBoundingClientRect();
    iframe.contentWindow?.postMessage(
      { type: 'wb:hittest', x: e.clientX - rect.left, y: e.clientY - rect.top, containerIds },
      window.location.origin,
    );
  };

  const overlayDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const target = dropTarget.current;
    frameRef.current?.contentWindow?.postMessage({ type: 'wb:clear-indicator' }, window.location.origin);
    const current = drag;
    setDrag(null);
    if (!target || !current) return;
    if (current.kind === 'palette' && current.type) {
      await insertComponent(current.type, target.containerId, target.index);
    } else if (current.kind === 'node' && current.nodeId && current.nodeId !== target.containerId) {
      await mutate([{ op: 'move', nodeId: current.nodeId, parentId: target.containerId, index: target.index }]);
    }
  };

  if (!site || !page) {
    return <div className="loading">{status || 'loading…'}</div>;
  }

  const currentSlug = pages.find((p) => p.id === pageId)?.slug ?? '';
  const previewPath = `/preview/${siteId}/${currentSlug ? `${currentSlug}/` : ''}`;

  return (
    <div className="editor">
      <header className="toolbar">
        <button type="button" className="ghost" onClick={onExit} title="All sites">
          ←
        </button>
        <strong className="brand">{site.name}</strong>
        <span className={`status ${status.startsWith('error') ? 'error' : ''}`}>{status}</span>
        <div className="spacer" />
        <div className="viewports">
          {(Object.keys(VIEWPORTS) as Viewport[]).map((v) => (
            <button
              key={v}
              type="button"
              className={viewport === v ? 'active' : ''}
              onClick={() => setViewport(v)}
              title={v}
            >
              {v === 'desktop' ? '🖥' : v === 'tablet' ? '📱' : '📲'} {v}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void undo()} disabled={undoStack.current.length === 0}>
          ↩ undo
        </button>
        <button type="button" onClick={() => void redo()} disabled={redoStack.current.length === 0}>
          ↪ redo
        </button>
        <button type="button" onClick={() => setThemeOpen(true)}>
          🎨 Theme
        </button>
        <a href={previewPath} target="_blank" rel="noreferrer">
          👁 Preview
        </a>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            try {
              setStatus('publishing…');
              const result = await api.publish(siteId);
              const warn = result.warnings.length ? ` (${result.warnings.length} warnings)` : '';
              setStatus(`published ${result.pageCount} pages${warn} → ${result.distPath}`);
            } catch (err) {
              setStatus(`error: ${(err as Error).message}`);
            }
          }}
        >
          🚀 Publish
        </button>
      </header>

      <aside className="left">
        <PagesPanel
          pages={pages}
          currentId={pageId}
          onSelect={setPageId}
          onAdd={async (slug, title) => {
            try {
              const p = await api.addPage(siteId, slug, title);
              const list = await api.listPages(siteId);
              setPages(list);
              setPageId(p.id);
            } catch (err) {
              setStatus(`error: ${(err as Error).message}`);
            }
          }}
          onDelete={async (id) => {
            if (!window.confirm('Delete this page?')) return;
            await api.deletePage(siteId, id);
            const list = await api.listPages(siteId);
            setPages(list);
            if (pageId === id) setPageId(list[0]?.id ?? null);
          }}
        />
        <Palette components={components} onStartDrag={(type) => setDrag({ kind: 'palette', type })} onEndDrag={() => setDrag(null)} onInsert={(type) => {
          const parentId = selectedId && isContainer(selectedNode?.type ?? '') ? selectedId : page.tree.id;
          void insertComponent(type, parentId);
        }} />
        <OutlineTree
          root={page.tree}
          selectedId={selectedId}
          isContainer={isContainer}
          onSelect={selectNode}
          onStartDrag={(nodeId) => setDrag({ kind: 'node', nodeId })}
          onEndDrag={() => setDrag(null)}
          onMove={(nodeId, parentId, index) => void mutate([{ op: 'move', nodeId, parentId, index }])}
        />
      </aside>

      <main className="canvas">
        <div className="frame-wrap" style={{ width: VIEWPORTS[viewport] }}>
          <iframe
            key={frameKey}
            ref={frameRef}
            title="canvas"
            src={`${previewPath}?editor=1`}
            data-testid="canvas-frame"
          />
          {drag && (
            <div
              className="drag-overlay"
              data-testid="drag-overlay"
              onDragOver={overlayDragOver}
              onDrop={(e) => void overlayDrop(e)}
              onDragLeave={() =>
                frameRef.current?.contentWindow?.postMessage({ type: 'wb:clear-indicator' }, window.location.origin)
              }
            />
          )}
        </div>
      </main>

      <aside className="right">
        <Inspector
          key={selectedId ?? 'none'}
          node={selectedNode}
          isRoot={selectedNode?.id === page.tree.id}
          isContainer={isContainer}
          onOps={(ops) => void mutate(ops)}
          onDelete={deleteSelected}
          onDuplicate={duplicateSelected}
          onMoveUp={() => moveSelected(-1)}
          onMoveDown={() => moveSelected(1)}
        />
      </aside>

      {themeOpen && (
        <ThemeDialog
          site={site}
          onClose={() => setThemeOpen(false)}
          onSaved={async () => {
            setSite(await api.getSite(siteId));
            setFrameKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
