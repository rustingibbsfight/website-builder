/**
 * Telling an image field apart from any other nested object.
 *
 * The Inspector renders props from their JSON Schema, which is what lets a new
 * component appear with working controls and nobody touching the editor. The
 * cost is that it has no idea what anything *means*: an `AssetRef` — the shape
 * every picture on every page is — came out as a fieldset of raw `assetId`,
 * `url` and `alt` text boxes. Choosing a picture meant knowing an asset's id
 * and typing it, which is not a thing anybody knows.
 *
 * So one module decides "is this an image", the component draws one, and the
 * decision is by **shape rather than by name**. A prop called `image` is the
 * common case and not the rule: `logo`, `background`, `avatar` and `poster` are
 * all `AssetRef`s, and a name list would have to grow every time somebody adds
 * a component — silently, since the failure is a field that merely looks
 * primitive again.
 *
 * Deliberately strict about the shape. Matching anything with an `alt` would
 * catch a future object that happens to describe alternatives, and turning an
 * unrelated field into a picture picker is worse than leaving it as boxes: the
 * boxes are ugly and honest, and the picker would write `{assetId}` into
 * something that means nothing of the kind.
 */

/**
 * The two fields this needs, and nothing else.
 *
 * Structural rather than an import of the editor's `JsonSchema`, so this module
 * stays a pure function over a shape and can be tested without one — and
 * deliberately with no index signature, which would stop the real `JsonSchema`
 * from satisfying it.
 */
export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
}

/**
 * True for the `AssetRef` shape: an object carrying `alt` plus **both** ways of
 * naming a picture.
 *
 * `assetId` *and* `url` together is what makes this specific. An object with
 * only one of them is some other thing that happens to reference something —
 * and requiring `alt` as well means the match is on "a picture, described",
 * which is precisely what `AssetRef` is for.
 */
export function isImageField(schema: JsonSchemaLike | undefined): boolean {
  if (!schema || schema.type !== 'object') return false;
  const props = schema.properties;
  if (!props) return false;
  return (
    props.assetId?.type === 'string' && props.url?.type === 'string' && props.alt?.type === 'string'
  );
}

/** What a picker holds while it is open, and writes back on a pick. */
export interface ImageValue {
  assetId?: string;
  url?: string;
  alt?: string;
  width?: number;
  height?: number;
}

/**
 * The value to commit for a chosen asset.
 *
 * **Clearing the other source is the whole of it.** A field that already held a
 * `url` and then had an `assetId` written beside it carries both, and the
 * renderer resolves `assetId` first — so the picture changes while the box
 * still shows the old address, and the next person to look concludes the URL
 * field does nothing. One source at a time, whichever was just picked.
 *
 * Alt text survives a change of picture unless the new one brings its own. Alt
 * describes *what the picture is for on this page*, which is usually still true
 * of a replacement, and silently emptying it is how a page loses its
 * accessibility one swap at a time.
 */
export function pickAsset(current: ImageValue | undefined, assetId: string, alt?: string): ImageValue {
  const next: ImageValue = { ...current, assetId };
  delete next.url;
  // Intrinsic size belonged to the old picture. Keeping it is worse than having
  // none: it is emitted to prevent layout shift, so a stale pair *causes* the
  // shift it exists to prevent.
  delete next.width;
  delete next.height;
  if (alt) next.alt = alt;
  else if (next.alt === undefined) next.alt = '';
  return next;
}

/** The mirror of it, for a picture named by address. */
export function pickUrl(current: ImageValue | undefined, url: string): ImageValue {
  const next: ImageValue = { ...current, url };
  delete next.assetId;
  delete next.width;
  delete next.height;
  if (next.alt === undefined) next.alt = '';
  return next;
}

/**
 * Whether a brief is worth spending a render on.
 *
 * A subject is the one thing the studio cannot infer — everything else has a
 * default or is optional — so an empty one is the single mistake that reliably
 * buys a picture of nothing. Checked here rather than left to the far end,
 * because the far end's refusal costs a round trip and this one costs nothing.
 */
export function canGenerate(subject: string): boolean {
  return subject.trim().length > 0;
}
