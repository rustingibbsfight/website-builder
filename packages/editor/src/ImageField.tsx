import { useEffect, useRef, useState } from 'react';

import { api } from './api';
import { canGenerate, pickAsset, pickUrl, type ImageValue } from './image-field';
import type { Asset, ImageTicket } from './types';

/**
 * Choosing a picture, which the Inspector could not do at all.
 *
 * Props are rendered from their JSON Schema, so an `AssetRef` came out as three
 * text boxes: `assetId`, `url`, `alt`. Setting a picture meant knowing an
 * asset's id and typing it — and nobody knows an asset's id. In practice the
 * only working route was to ask Eve, in Slack, and paste a URL back, which is
 * #52's own complaint.
 *
 * Three tabs, because there are exactly three answers to "which picture":
 * one this site already has, one at an address, and one that does not exist
 * yet. The third goes through the **same route the agent uses** — one ticket
 * store, one ingest, one SSRF guard — so a picture made here and a picture made
 * in a conversation are the same kind of thing afterwards.
 */

type Tab = 'assets' | 'url' | 'generate';

export function ImageField({
  siteId,
  value,
  onCommit,
}: {
  siteId: string;
  value: ImageValue | undefined;
  onCommit: (value: ImageValue) => void;
}) {
  const [tab, setTab] = useState<Tab>('assets');

  return (
    <div className="image-field" data-testid="image-field">
      <div className="image-tabs" role="tablist">
        {(
          [
            ['assets', 'This site'],
            ['url', 'By URL'],
            ['generate', 'Generate'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'on' : ''}
            data-testid={`image-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'assets' && <AssetTab siteId={siteId} value={value} onCommit={onCommit} />}
      {tab === 'url' && <UrlTab value={value} onCommit={onCommit} />}
      {tab === 'generate' && <GenerateTab siteId={siteId} value={value} onCommit={onCommit} />}

      <AltField value={value} onCommit={onCommit} />
    </div>
  );
}

/**
 * Alt text sits outside the tabs, because it is not a way of choosing a picture.
 *
 * It describes what the picture is *for on this page*, which stays true when
 * the picture is swapped — so putting it inside a tab would make it look like a
 * property of one source, and re-typing it on every change is how a page loses
 * its accessibility one swap at a time.
 */
function AltField({
  value,
  onCommit,
}: {
  value: ImageValue | undefined;
  onCommit: (value: ImageValue) => void;
}) {
  return (
    <label className="field">
      <span title="What the picture conveys, for someone who cannot see it. Leave empty only if it is purely decorative.">
        alt
      </span>
      <input
        type="text"
        defaultValue={value?.alt ?? ''}
        key={value?.alt ?? ''}
        data-testid="image-alt"
        onBlur={(e) => onCommit({ ...value, alt: e.target.value })}
      />
    </label>
  );
}

function AssetTab({
  siteId,
  value,
  onCommit,
}: {
  siteId: string;
  value: ImageValue | undefined;
  onCommit: (value: ImageValue) => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listAssets(siteId)
      .then((list) => live && setAssets(list))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [siteId]);

  if (error) return <p className="muted">Could not list this site's pictures: {error}</p>;
  if (!assets) return <p className="muted">Loading…</p>;

  const images = assets.filter((asset) => asset.mime.startsWith('image/'));
  if (!images.length) {
    // Said rather than shown as an empty grid: "there are none" and "this is
    // still loading" look identical otherwise, and the second is what people
    // assume.
    return <p className="muted">This site has no pictures yet. Add one by URL, or generate one.</p>;
  }

  return (
    <div className="asset-grid" data-testid="image-assets">
      {images.map((asset) => (
        <button
          key={asset.id}
          type="button"
          className={value?.assetId === asset.id ? 'asset on' : 'asset'}
          title={asset.filename}
          data-testid={`image-asset-${asset.id}`}
          onClick={() => onCommit(pickAsset(value, asset.id))}
        >
          {/*
            Through the preview route, which is the only thing that serves asset
            bytes — and is already hardened for it: an uploaded SVG comes back
            under a `default-src 'none'` CSP, so it cannot execute script in this
            origin and ride the editor's session cookie. A second serving route
            for thumbnails would be a second place to remember that.
          */}
          <img src={`/preview/${siteId}/assets/${asset.path}`} alt="" loading="lazy" />
          <span>{asset.filename}</span>
        </button>
      ))}
    </div>
  );
}

function UrlTab({
  value,
  onCommit,
}: {
  value: ImageValue | undefined;
  onCommit: (value: ImageValue) => void;
}) {
  return (
    <label className="field">
      <span title="An address the published site will link to directly. It is not copied here, so it has to stay up.">
        url
      </span>
      <input
        type="text"
        defaultValue={value?.url ?? ''}
        placeholder="https://…"
        data-testid="image-url"
        onBlur={(e) => {
          const url = e.target.value.trim();
          if (url) onCommit(pickUrl(value, url));
        }}
      />
    </label>
  );
}

/**
 * Asking for a picture that does not exist yet.
 *
 * **Keeping this open is what advances it**, and the panel says so rather than
 * pretending otherwise — there is no worker on the other side. Closing it
 * strands nothing, because the ticket is durable: reopening lists what is still
 * rendering and resumes. A cron that advanced everybody's tickets on a schedule
 * would be money spent with nobody watching, which is the wrong trade for a
 * feature whose whole cost is per-render.
 */
function GenerateTab({
  siteId,
  value,
  onCommit,
}: {
  siteId: string;
  value: ImageValue | undefined;
  onCommit: (value: ImageValue) => void;
}) {
  const [purpose, setPurpose] = useState('hero');
  const [subject, setSubject] = useState('');
  const [mood, setMood] = useState('');
  const [ticket, setTicket] = useState<ImageTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const committed = useRef(false);

  // Resume whatever this site already has in flight. Without it, closing the
  // panel while a render was going looks exactly like losing the render.
  useEffect(() => {
    let live = true;
    api
      .listImageTickets(siteId)
      .then(({ tickets }) => {
        if (live && tickets.length) setTicket(tickets[0]!);
      })
      .catch(() => {
        // A listing that fails is not worth an error banner over a picture
        // nobody has asked for yet; the Generate button still works.
      });
    return () => {
      live = false;
    };
  }, [siteId]);

  // Asking is what advances it, so the poll is the drive rather than a status
  // display. It stops the moment the ticket settles.
  useEffect(() => {
    if (!ticket || ticket.status !== 'running') return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .pollGeneratedAsset(siteId, ticket.id)
        .then((next) => live && setTicket(next))
        .catch((err: Error) => live && setError(err.message));
    }, 3000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [siteId, ticket]);

  // A finished render is selected once, not on every re-render of a ready
  // ticket — otherwise editing the alt text below would keep overwriting it.
  useEffect(() => {
    if (ticket?.status !== 'ready' || committed.current) return;
    const assetId = ticket.assetIds?.[0];
    if (!assetId) return;
    committed.current = true;
    onCommit(pickAsset(value, assetId, ticket.alt));
  }, [ticket, value, onCommit]);

  async function generate() {
    setError(null);
    setBusy(true);
    committed.current = false;
    try {
      // No palette: it defaults to this site's theme on the server, which is
      // what makes a picture belong to the page it lands on.
      setTicket(
        await api.generateAsset(siteId, {
          purpose: purpose.trim() || 'hero',
          subject: subject.trim(),
          ...(mood.trim() ? { mood: mood.trim() } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const running = ticket?.status === 'running';

  return (
    <div className="generate">
      <label className="field">
        <span title="Where on the page this sits. The studio lists what it accepts; hero is the common one.">
          purpose
        </span>
        <input
          type="text"
          value={purpose}
          data-testid="image-purpose"
          onChange={(e) => setPurpose(e.target.value)}
        />
      </label>
      <label className="field">
        <span title="What the picture is of, in plain words. Not a prompt — say what it shows.">subject</span>
        <input
          type="text"
          value={subject}
          placeholder="a quiet lobby at dusk"
          data-testid="image-subject"
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      <label className="field">
        <span title='How it should feel, e.g. "calm, clinical" or "warm, lived-in".'>mood</span>
        <input type="text" value={mood} data-testid="image-mood" onChange={(e) => setMood(e.target.value)} />
      </label>

      <button
        type="button"
        className="primary"
        disabled={busy || running || !canGenerate(subject)}
        data-testid="image-generate"
        onClick={generate}
      >
        {running ? 'Rendering…' : 'Generate'}
      </button>

      {running && (
        <p className="muted" data-testid="image-generating">
          Rendering. Keep this open — asking is what moves it along. If you close it, the request is not
          lost: it is already paid for, and reopening this tab picks it back up.
        </p>
      )}
      {ticket?.status === 'ready' && (
        <p className="muted" data-testid="image-generated">
          Added to this site's pictures and selected. Check the alt text below.
        </p>
      )}
      {ticket?.status === 'failed' && <p className="error">{ticket.error ?? 'That render failed.'}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
