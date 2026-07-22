import { escapeHtml } from '@wb/components';
import { normalizeSlug, type Page, type Site } from '@wb/schema';

/**
 * Auto-generated branded Open Graph fallback image.
 *
 * When a page sets no explicit `meta.ogImage`, `renderSite` writes one of these
 * per page and the head references it, so every page still gets a considered
 * social card instead of nothing. It is a **static SVG** — deterministic, tiny,
 * and zero-dependency, which is the only raster-free option that fits the
 * zero-JS / serverless publish pipeline (no native image encoder needed).
 *
 * Caveat (documented, not a regression): a handful of crawlers only accept
 * raster og:images. For those this simply degrades to "no card" — exactly the
 * prior behaviour — while every SVG-capable consumer gets the branded image.
 */

/** Standard Open Graph image dimensions. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Output path (within the site) for a page's generated fallback card. */
export function ogFallbackPath(page: Page): string {
  const slug = normalizeSlug(page.slug);
  return `og/${slug === '' ? 'index' : slug}.svg`;
}

/**
 * Greedy word-wrap into at most `maxLines` lines of roughly `maxChars` each.
 * The last allowed line is ellipsised if text remains. Pure string work — no
 * font metrics — so it stays deterministic; `maxChars` is tuned to the font
 * size below rather than measured.
 */
function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || current === '') {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  // If words remain beyond the last line, ellipsise it.
  const consumed = lines.join(' ').split(/\s+/).filter(Boolean).length;
  const last = lines[lines.length - 1];
  if (consumed < words.length && last !== undefined) {
    lines[lines.length - 1] = last.length > maxChars - 1 ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
  }
  return lines;
}

/**
 * Build a 1200×630 branded OG card from the site theme + page title. Uses the
 * brand gradient (primary → secondary) with an accent rule and the brand name,
 * mirroring the published site's look.
 */
export function ogFallbackSvg(site: Site, page: Page): string {
  const c = site.theme.colors;
  const brand = site.theme.brandName;
  const title = page.meta.ogTitle || page.meta.title || page.title || brand;

  const titleLines = wrapLines(title, 26, 3);
  const titleFontSize = titleLines.length >= 3 ? 76 : titleLines.length === 2 ? 88 : 100;
  const lineHeight = titleFontSize * 1.14;
  // Vertically centre the title block within the content area.
  const blockHeight = titleLines.length * lineHeight;
  const firstBaseline = OG_HEIGHT / 2 - blockHeight / 2 + titleFontSize * 0.8;

  const tspans = titleLines
    .map((ln, i) => `<tspan x="90" y="${Math.round(firstBaseline + i * lineHeight)}">${escapeHtml(ln)}</tspan>`)
    .join('');

  // Escape colors defensively even though the schema validates them as hex.
  const primary = escapeHtml(c.primary);
  const secondary = escapeHtml(c.secondary);
  const accent = escapeHtml(c.accent);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" role="img" aria-label="${escapeHtml(
    `${brand} — ${title}`,
  )}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${secondary}"/>
      <stop offset="1" stop-color="${primary}"/>
    </linearGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#bg)"/>
  <rect x="90" y="120" width="96" height="10" rx="5" fill="${accent}"/>
  <text x="90" y="108" fill="#ffffff" fill-opacity="0.85" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="1">${escapeHtml(
    brand,
  )}</text>
  <text fill="#ffffff" font-family="Helvetica, Arial, sans-serif" font-size="${titleFontSize}" font-weight="800" letter-spacing="-1">${tspans}</text>
</svg>
`;
}
