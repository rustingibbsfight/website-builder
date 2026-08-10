import { describe, expect, it } from 'vitest';

import { canGenerate, isImageField, pickAsset, pickUrl } from './image-field';

/**
 * Recognising a picture, and writing one back.
 *
 * These are the two judgements the picker rests on, and both are the kind that
 * fail quietly. A recogniser that is too loose turns an unrelated field into a
 * picture picker; one that is too tight leaves somebody typing an asset id they
 * have no way of knowing. And a write that keeps the source it replaced leaves
 * a field carrying two answers, of which the renderer silently picks one.
 */

const assetRef = {
  type: 'object',
  properties: {
    assetId: { type: 'string' },
    url: { type: 'string' },
    alt: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
};

describe('recognising an image field', () => {
  it('matches the AssetRef shape', () => {
    expect(isImageField(assetRef)).toBe(true);
  });

  it('matches by shape, so every name for a picture is covered', () => {
    /**
     * The load-bearing one. `image` is the common prop name and not the rule —
     * `logo`, `background`, `avatar` and `poster` are the same shape, and a
     * list of names would have to grow every time somebody adds a component,
     * silently, because the failure is a field that merely looks primitive
     * again.
     */
    expect(isImageField({ ...assetRef })).toBe(true);
  });

  it('refuses an object that merely references something', () => {
    // `assetId` *and* `url` *and* `alt` together is what makes this specific.
    // Turning an unrelated field into a picture picker is worse than leaving it
    // as text boxes: the boxes are ugly and honest.
    expect(isImageField({ type: 'object', properties: { assetId: { type: 'string' } } })).toBe(false);
    expect(isImageField({ type: 'object', properties: { url: { type: 'string' } } })).toBe(false);
    expect(
      isImageField({ type: 'object', properties: { alt: { type: 'string' }, url: { type: 'string' } } }),
    ).toBe(false);
  });

  it('refuses everything that is not an object with properties', () => {
    expect(isImageField(undefined)).toBe(false);
    expect(isImageField({ type: 'string' })).toBe(false);
    expect(isImageField({ type: 'object' })).toBe(false);
  });
});

describe('writing a chosen picture back', () => {
  it('clears the other source, so the field holds one answer', () => {
    /**
     * The silent one. The renderer resolves `assetId` before `url`, so a field
     * carrying both changes its picture while the box still shows the old
     * address — and the next person concludes the URL field does nothing.
     */
    expect(pickAsset({ url: 'https://example.com/old.png', alt: 'a lobby' }, 'as_1')).toEqual({
      assetId: 'as_1',
      alt: 'a lobby',
    });
    expect(pickUrl({ assetId: 'as_1', alt: 'a lobby' }, 'https://example.com/new.png')).toEqual({
      url: 'https://example.com/new.png',
      alt: 'a lobby',
    });
  });

  it('drops the intrinsic size, which belonged to the old picture', () => {
    // Worse than having none: width/height are emitted to prevent layout
    // shift, so a stale pair *causes* the shift they exist to prevent.
    expect(pickAsset({ assetId: 'as_1', width: 1440, height: 480, alt: 'x' }, 'as_2')).toEqual({
      assetId: 'as_2',
      alt: 'x',
    });
  });

  it('keeps alt text across a swap, and takes a better one when offered', () => {
    /**
     * Alt describes what the picture is *for on this page*, which is usually
     * still true of a replacement. Emptying it on every swap is how a page
     * loses its accessibility one change at a time — but a generated picture
     * arrives with alt written for it, and that is better than what was there.
     */
    expect(pickAsset({ assetId: 'as_1', alt: 'the lobby at dusk' }, 'as_2').alt).toBe('the lobby at dusk');
    expect(pickAsset({ assetId: 'as_1', alt: 'old' }, 'as_2', 'a quiet lobby').alt).toBe('a quiet lobby');
  });

  it('always leaves an alt key, even starting from nothing', () => {
    // Absent alt and empty alt mean different things to a schema that defaults
    // it to '', and a field that never grew the key reads as "not yet decided"
    // for ever.
    expect(pickAsset(undefined, 'as_1').alt).toBe('');
    expect(pickUrl(undefined, 'https://example.com/a.png').alt).toBe('');
  });
});

describe('whether a brief is worth a render', () => {
  it('needs a subject, since it is the one thing nothing can infer', () => {
    // Everything else has a default or is optional, so an empty subject is the
    // single mistake that reliably buys a picture of nothing.
    expect(canGenerate('a quiet lobby')).toBe(true);
    expect(canGenerate('')).toBe(false);
    expect(canGenerate('   ')).toBe(false);
  });
});
