import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ChatPanel } from './ChatPanel';
import { Inspector } from './Inspector';
import { BlocksPanel, OutlineTree, Palette, PagesPanel, SymbolsPanel } from './panels';
import { SeoDialog } from './SeoDialog';
import { SubmissionsDialog } from './SubmissionsDialog';
import { ThemeDialog } from './ThemeDialog';
import { collectContainerIds, findNode, findParent, stripIds } from './tree-utils';
import type { BlockSummary, ComponentSummary, Page, PageSummary, Site, SymbolSummary, TreeOp, WbNode, SiteChanged } from './types';

const VIEWPORTS = { desktop: '100%', tablet: '834px', mobile: '390px' } as const;
type Viewport = keyof typeof VIEWPORTS;

/** Sensible starting layout when dropping a fresh container. */
const LAYOUT_DEFAULTS: Record<string, Record<string, unknown>> = {
  section: { direction: 'stack', gap: 'md', padding: 'xl', maxWidth: 'wide' },
  stack: { direction: 'stack', gap: 'md' },
  grid: { direction: 'grid', columns: 3, gap: 'lg' },
};

/**
 * Leaf components whose rendered element's text content maps 1:1 to a single
 * prop — these support inline (WYSIWYG) editing: double-click and type on the
 * canvas. Maps component type → the prop that holds its text.
 */
const INLINE_TEXT_PROP: Record<string, string> = {
  heading: 'text',
  text: 'text',
  button: 'label',
};

/** Rich-text components edited inline as their markdown SOURCE (with a toolbar),
 * rather than as plain textContent. Maps type → the markdown prop. */
const RICH_TEXT_PROP: Record<string, string> = { richText: 'markdown' };

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
  const [blocks, setBlocks] = useState<BlockSummary[]>([]);
  const [symbols, setSymbols] = useState<SymbolSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [status, setStatus] = useState('');
  const [themeOpen, setThemeOpen] = useState(false);
  const [seoOpen, setSeoOpen] = useState(false);
  const [submissionsOpen, setSubmissionsOpen] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  /**
   * An inline edit in progress, so a reload can wait for it.
   *
   * Bumping `frameKey` re-mounts the iframe, which destroys whatever somebody
   * is halfway through typing into the canvas. The editor already knows —
   * `wb:edit-begin` and `wb:text-commit` come up from the frame — so an agent
   * edit that lands mid-typing is *queued* rather than dropped or forced.
   */
  const editingRef = useRef(false);
  const pendingReload = useRef<SiteChanged | null>(null);

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
    api.listBlocks().then(setBlocks).catch(() => {});
    api.listSymbols(siteId).then(setSymbols).catch(() => {});
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
  // Refs so the (stable) message listener always sees the latest tree/mutate.
  const pageRef = useRef<Page | null>(page);
  pageRef.current = page;
  const mutateRef = useRef<(ops: TreeOp[]) => void>(() => {});

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // The preview iframe is same-origin; ignore messages from anywhere else.
      if (e.origin !== window.location.origin) return;
      const d = e.data as {
        type?: string;
        nodeId?: string;
        containerId?: string | null;
        index?: number;
        text?: string;
        key?: string;
        value?: string;
      };
      if (d.type === 'wb:clicked' && d.nodeId) setSelectedId(d.nodeId);
      if (d.type === 'wb:ready') {
        // Reloaded canvas: restore selection and re-send the valid drop parents
        // so in-canvas drag-to-reorder works immediately.
        if (selectedId) {
          frameRef.current?.contentWindow?.postMessage(
            { type: 'wb:select-node', nodeId: selectedId },
            window.location.origin,
          );
        }
        frameRef.current?.contentWindow?.postMessage(
          { type: 'wb:set-containers', containerIds: containerIdsRef.current },
          window.location.origin,
        );
      }
      // In-canvas drag-to-reorder: the preview computed a target slot; apply it
      // as a single move op (same slot→final-index compensation as palette drops).
      if (d.type === 'wb:move-node' && d.nodeId && d.containerId) {
        const tree = pageRef.current?.tree;
        const cur = tree ? findParent(tree, d.nodeId) : null;
        const slot = d.index ?? 0;
        const finalIndex = cur && cur.parent.id === d.containerId && cur.index < slot ? slot - 1 : slot;
        mutateRef.current([{ op: 'move', nodeId: d.nodeId, parentId: d.containerId, index: finalIndex }]);
      }
      // On-canvas spacing handle: apply the dragged layout token as one op.
      if (d.type === 'wb:set-layout' && d.nodeId && d.key) {
        mutateRef.current([{ op: 'update', nodeId: d.nodeId, layout: { [d.key]: d.value ?? null } }]);
      }
      if (d.type === 'wb:drop-target') {
        dropTarget.current = d.containerId ? { containerId: d.containerId, index: d.index ?? 0 } : null;
      }
      // Inline (WYSIWYG) editing: double-click a text node → edit on the canvas.
      if (d.type === 'wb:dblclick' && d.nodeId) {
        const node = pageRef.current ? findNode(pageRef.current.tree, d.nodeId) : null;
        setSelectedId(d.nodeId);
        // From here until the commit, a canvas reload would destroy what is
        // being typed. An agent edit that lands in this window waits.
        editingRef.current = true;
        if (node && INLINE_TEXT_PROP[node.type]) {
          frameRef.current?.contentWindow?.postMessage(
            { type: 'wb:edit-begin', nodeId: d.nodeId },
            window.location.origin,
          );
        } else if (node && RICH_TEXT_PROP[node.type]) {
          // Send the markdown source so the canvas edits it in place with a toolbar.
          const source = (node.props as Record<string, unknown>)[RICH_TEXT_PROP[node.type]!];
          frameRef.current?.contentWindow?.postMessage(
            { type: 'wb:edit-begin', nodeId: d.nodeId, rich: true, text: typeof source === 'string' ? source : '' },
            window.location.origin,
          );
        }
      }
      if (d.type === 'wb:text-commit' && d.nodeId && typeof d.text === 'string') {
        editingRef.current = false;
        const queued = pendingReload.current;
        pendingReload.current = null;
        if (queued) void applyAgentChange(queued);
        const node = pageRef.current ? findNode(pageRef.current.tree, d.nodeId) : null;
        const prop = node ? (INLINE_TEXT_PROP[node.type] ?? RICH_TEXT_PROP[node.type]) : undefined;
        const current = node ? (node.props as Record<string, unknown>)[prop ?? ''] : undefined;
        if (node && prop && d.text && d.text !== current) {
          mutateRef.current([{ op: 'update', nodeId: d.nodeId, props: { [prop]: d.text } }]);
        } else {
          // No-op / empty edit: reload the canvas so the rendered text is authoritative.
          setFrameKey((k) => k + 1);
        }
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
  mutateRef.current = (ops: TreeOp[]) => void mutate(ops);

  /**
   * The agent changed the site; catch the editor up.
   *
   * **The undo stack is a record of this tab's history, and the page's history
   * is no longer only this tab's.** That sentence is the whole of this
   * function. `mutate` is the only path that writes, snapshots and bumps
   * `frameKey`; an agent edit goes round all three, so without this the
   * in-memory tree goes stale — a later `update` on a node the agent removed
   * 422s — and ⌘Z restores a whole-tree snapshot from *before* the agent ran,
   * silently wiping its work.
   *
   * So the tree that was on screen is pushed onto `undoStack` before the
   * refetch, and `redoStack` is cleared. ⌘Z then undoes *the agent's* edit and
   * the user's own history survives underneath it, which is what somebody
   * pressing it expects.
   *
   * It **refetches** rather than applying anything the agent sent. One reload
   * path, not two: mirroring ops into local state would be a second
   * implementation of "what the tree is now" while the server has the answer,
   * and it is why the transport summarises the tree out of the event at all.
   *
   * Queued behind an inline edit, because a `frameKey` bump re-mounts the
   * iframe and destroys text somebody is mid-sentence in.
   */
  const applyAgentChange = useCallback(
    async (changed: SiteChanged) => {
      if (editingRef.current) {
        // Merge rather than replace: two agent edits during one long inline
        // edit must not lose the first one's refetch.
        const queued = pendingReload.current;
        pendingReload.current = queued
          ? {
              page: queued.page || changed.page,
              pages: queued.pages || changed.pages,
              theme: queued.theme || changed.theme,
              assets: queued.assets || changed.assets,
            }
          : changed;
        return;
      }

      try {
        if (changed.page && pageId) {
          const before = pageRef.current?.tree;
          const updated = await api.getPage(siteId, pageId);
          if (before) {
            undoStack.current.push(before);
            redoStack.current = [];
          }
          setPage(updated);
        }
        if (changed.pages) setPages(await api.listPages(siteId));
        if (changed.theme) setSite(await api.getSite(siteId));
        setFrameKey((k) => k + 1);
        setStatus('Eve made a change');
      } catch (err) {
        setStatus(`error: ${(err as Error).message}`);
      }
    },
    [pageId, siteId],
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

  const insertBlock = useCallback(
    async (blockId: string) => {
      if (!page) return;
      // Blocks are full sections — append to the page root (fetched fresh so ids
      // are assigned server-side). Reuses mutate so it saves and is undoable.
      const block = await api.getBlock(blockId);
      await mutate([{ op: 'insert', parentId: page.tree.id, node: block.node as never }]);
    },
    [page, mutate],
  );

  const selectedNode = useMemo(
    () => (page && selectedId ? findNode(page.tree, selectedId) : null),
    [page, selectedId],
  );

  // ── Symbols (#26) ──────────────────────────────────────────────────────────
  const insertSymbolInstance = useCallback(
    (symbolId: string) => {
      if (!page) return;
      // Into the selected container, else the page root.
      const parentId = selectedId && isContainer(selectedNode?.type ?? '') ? selectedId : page.tree.id;
      void mutate([{ op: 'insert', parentId, node: { type: 'symbolInstance', props: { symbolId } } as never }]);
    },
    [page, selectedId, selectedNode, isContainer, mutate],
  );

  const createSymbolFromSelection = useCallback(async () => {
    if (!page || !selectedId || !selectedNode || selectedId === page.tree.id) return;
    if (selectedNode.type === 'symbolInstance') return; // already an instance
    const found = findParent(page.tree, selectedId);
    if (!found) return;
    // Unique id from the node type.
    const base = selectedNode.type.replace(/[^a-zA-Z0-9]/g, '') || 'symbol';
    const existing = new Set(symbols.map((s) => s.id));
    let id = base;
    for (let i = 2; existing.has(id); i++) id = `${base}-${i}`;
    try {
      await api.setSymbol(siteId, id, stripIds(selectedNode) as WbNode);
      // Replace the selection with an instance in the same spot (one atomic op batch).
      await mutate([
        { op: 'insert', parentId: found.parent.id, index: found.index, node: { type: 'symbolInstance', props: { symbolId: id } } as never },
        { op: 'remove', nodeId: selectedId },
      ]);
      setSelectedId(null);
      api.listSymbols(siteId).then(setSymbols).catch(() => {});
      setStatus(`made symbol “${id}”`);
    } catch (e) {
      setStatus(`error: ${(e as Error).message}`);
    }
  }, [page, selectedId, selectedNode, symbols, siteId, mutate]);

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

  // Drag UIs compute a drop slot with the dragged node still in place; the move
  // op wants the node's FINAL index. When moving to a later slot within the same
  // parent, removing the node shifts everything down one — so subtract one.
  const dragSlotToFinalIndex = useCallback(
    (nodeId: string, parentId: string, slot: number) => {
      const cur = page ? findParent(page.tree, nodeId) : null;
      return cur && cur.parent.id === parentId && cur.index < slot ? slot - 1 : slot;
    },
    [page],
  );

  // ── Canvas drag overlay ────────────────────────────────────────────────────
  const containerIds = useMemo(
    () => (page ? collectContainerIds(page.tree, isContainer) : []),
    [page, isContainer],
  );
  // Keep a ref (for the message handler) and push the list to the preview so
  // in-canvas drag-to-reorder can hit-test valid parents.
  const containerIdsRef = useRef<string[]>(containerIds);
  useEffect(() => {
    containerIdsRef.current = containerIds;
    frameRef.current?.contentWindow?.postMessage(
      { type: 'wb:set-containers', containerIds },
      window.location.origin,
    );
  }, [containerIds]);

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
      const index = dragSlotToFinalIndex(current.nodeId, target.containerId, target.index);
      await mutate([{ op: 'move', nodeId: current.nodeId, parentId: target.containerId, index }]);
    }
  };

  if (!site || !page) {
    return <div className="loading">{status || 'loading…'}</div>;
  }

  const currentSlug = pages.find((p) => p.id === pageId)?.slug ?? '';
  const previewPath = `/preview/${siteId}/${currentSlug ? `${currentSlug}/` : ''}`;

  return (
    <div className={chatOpen ? 'editor chat-open' : 'editor'}>
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
        <button type="button" onClick={() => setSeoOpen(true)} title="SEO & social for this page" data-testid="seo-open">
          🔎 SEO
        </button>
        <button
          type="button"
          onClick={() => setSubmissionsOpen(true)}
          title="Form submissions captured for this site"
          data-testid="submissions-open"
        >
          📥 Submissions
        </button>
        <button
          type="button"
          onClick={() => setChatOpen((open) => !open)}
          title="Ask Eve to change this page"
          aria-pressed={chatOpen}
          data-testid="chat-open"
        >
          💬 Eve
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
        <BlocksPanel blocks={blocks} onInsert={(id) => void insertBlock(id)} />
        <SymbolsPanel
          symbols={symbols}
          hasSelection={Boolean(selectedId && page && selectedId !== page.tree.id && selectedNode?.type !== 'symbolInstance')}
          onInsert={insertSymbolInstance}
          onCreateFromSelection={() => void createSymbolFromSelection()}
        />
        <OutlineTree
          root={page.tree}
          selectedId={selectedId}
          isContainer={isContainer}
          onSelect={selectNode}
          onStartDrag={(nodeId) => setDrag({ kind: 'node', nodeId })}
          onEndDrag={() => setDrag(null)}
          onMove={(nodeId, parentId, index) =>
            void mutate([{ op: 'move', nodeId, parentId, index: dragSlotToFinalIndex(nodeId, parentId, index) }])
          }
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

      {chatOpen && (
        <ChatPanel
          siteId={siteId}
          {...(pageId ? { pageId } : {})}
          {...(selectedId ? { selectedNodeId: selectedId } : {})}
          onSiteChanged={(changed) => void applyAgentChange(changed)}
          onClose={() => setChatOpen(false)}
        />
      )}

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

      {seoOpen && page && (
        <SeoDialog
          site={site}
          page={page}
          onClose={() => setSeoOpen(false)}
          onSaved={(updated) => setPage(updated)}
        />
      )}

      {submissionsOpen && <SubmissionsDialog siteId={siteId} onClose={() => setSubmissionsOpen(false)} />}
    </div>
  );
}
