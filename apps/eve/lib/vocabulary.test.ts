import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The image vocabulary is ComfyStudio's, and this repo must not hold a copy.
 *
 * `studio.test.ts` has a case called *"sends a value this side has never heard
 * of"*, and it is worth saying plainly that it does **not** prove this. A
 * TypeScript union is erased before anything runs, so restoring
 * `purpose: 'hero' | 'section'` leaves every runtime test passing — verified by
 * doing it. That test proves the transport forwards the field; it cannot prove
 * the type would have let you call it.
 *
 * The failure it cannot see is the expensive one, because it fails **closed and
 * silently**. A purpose added to the studio this morning is simply unreachable:
 * the model never sees it, so it never asks for it, so nobody notices until
 * somebody wonders aloud why the integration ignores a feature. That is exactly
 * what had already happened — `width`, `height`, `media`, `seconds` and `brand`
 * all existed at the far end and none could be sent from here.
 *
 * So this reads the source off disk, the way `test/media-coverage.test.ts` does
 * in ComfyStudio and for the same reason: the case worth catching is the
 * well-meaning tidy-up next month that "adds types" to these fields.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

/** Fields whose accepted values live in ComfyStudio rather than here. */
const THEIRS = ['purpose', 'aspect', 'textSafe', 'media'];

describe('no copy of the studio vocabulary', () => {
  it('keeps the request tool schema open', () => {
    const source = read('agent/tools/request_image.ts');
    // Only the schema body: the file's own prose explains why the enums went,
    // and matching that would make the comment unwritable.
    const schema = source.slice(source.indexOf('inputSchema:'), source.indexOf('async execute'));

    for (const field of THEIRS) {
      const declaration = new RegExp(`${field}:\\s*z[\\s\\S]{0,120}?\\.(enum|literal)\\(`);
      expect(
        declaration.test(schema),
        `${field} is a z.enum again — the accepted values live in ComfyStudio, and an enum here fails ` +
          `closed: a value added there becomes unreachable from here and nobody notices. Use z.string() ` +
          `and let image_guidance carry the list.`,
      ).toBe(false);
    }
  });

  it('keeps the client type open', () => {
    const source = read('lib/studio.ts');
    const spec = source.slice(source.indexOf('export interface ImageSpec'), source.indexOf('export interface Guidance'));

    for (const field of THEIRS) {
      const union = new RegExp(`${field}\\??:\\s*'[^;]*'\\s*\\|`);
      expect(
        union.test(spec),
        `${field} is a union of literals again. It is erased at runtime, so no other test here can see it — ` +
          `which is why this one reads the source.`,
      ).toBe(false);
    }
  });

  it('still narrows what is genuinely ours', () => {
    /**
     * The load-bearing negative. "Do not type these fields" is not the rule —
     * the rule is that *ComfyStudio's* lists are not copied. `count` has a
     * bound this side legitimately knows, and a version of this check that
     * flagged it would be switched off within a week.
     */
    const schema = read('agent/tools/request_image.ts');
    expect(schema).toMatch(/count:\s*z\s*\.number\(\)[\s\S]{0,80}?\.max\(4\)/);
  });
});
