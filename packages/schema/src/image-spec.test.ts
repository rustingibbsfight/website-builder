import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ImageSpecSchema } from './site.js';

/**
 * The image vocabulary belongs to the studio, and this repo must not hold a copy.
 *
 * `ImageSpecSchema` is now the shared definition — the HTTP route, the MCP
 * tool, Eve's tool and the editor's picker all validate against it — so this is
 * where a copied enum would do the most damage, all four surfaces at once.
 *
 * The failure is worth naming precisely, because it fails **closed and
 * silently**: a purpose added to the studio this morning is simply unreachable.
 * The caller never sees it, so it never asks for it, so nobody notices until
 * somebody wonders aloud why the integration ignores a feature. That already
 * happened here — `width`, `height`, `media`, `seconds` and `brand` all existed
 * at the far end and none could be sent, because the enum predated them.
 *
 * Reading the source off disk is deliberate. A zod enum *is* checkable at
 * runtime, so half of this could be a parse test — but the case worth catching
 * is the well-meaning tidy-up next month that "adds types", and a reader looking
 * at the file is what catches the version of it that hasn't been thought of.
 */

const SOURCE = readFileSync(join(__dirname, 'site.ts'), 'utf8');
const SPEC = SOURCE.slice(SOURCE.indexOf('export const ImageSpecSchema'));

/** Fields whose accepted values live in the studio rather than here. */
const THEIRS = ['purpose', 'aspect', 'textSafe', 'media'];

describe('no copy of the studio vocabulary', () => {
  it('keeps the shared spec open where the values are not ours', () => {
    for (const field of THEIRS) {
      const declaration = new RegExp(`${field}:\\s*z[\\s\\S]{0,160}?\\.(enum|literal)\\(`);
      expect(
        declaration.test(SPEC),
        `${field} is a z.enum again — the accepted values live in the image studio, and an enum here ` +
          `fails closed: a value added there becomes unreachable from every surface at once, and nobody ` +
          `notices. Keep it z.string() and let the guidance endpoint carry the list.`,
      ).toBe(false);
    }
  });

  it('accepts a value this side has never heard of', () => {
    // The runtime half. A purpose invented at the far end this morning has to
    // pass through untouched, which is the whole reason these are strings.
    expect(() =>
      ImageSpecSchema.parse({ purpose: 'a-purpose-invented-later', subject: 'a fox' }),
    ).not.toThrow();
  });

  it('still bounds what is genuinely ours', () => {
    /**
     * The load-bearing negative. "Do not constrain these fields" is not the
     * rule — the rule is that the *studio's* lists are not copied. A count of
     * forty is a bill and a negative width is a mistake at every far end, so
     * those are ours to refuse, and a version of this check that flagged them
     * would be switched off within a week.
     */
    expect(() => ImageSpecSchema.parse({ purpose: 'hero', subject: 'x', count: 40 })).toThrow();
    expect(() => ImageSpecSchema.parse({ purpose: 'hero', subject: 'x', width: -1 })).toThrow();
    expect(() => ImageSpecSchema.parse({ purpose: 'hero' })).toThrow();
    // And nothing undeclared rides along into a request we pay for.
    expect(() => ImageSpecSchema.parse({ purpose: 'hero', subject: 'x', workflow: 'pick-this-one' })).toThrow();
  });
});
