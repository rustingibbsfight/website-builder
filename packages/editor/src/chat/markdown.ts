/**
 * The agent writes markdown; this draws the little of it a 360px column can use.
 *
 * Hand-written rather than a library, the same call ComfyStudio's
 * `lib/markdown.ts` makes: a general renderer brings its own opinions about
 * links and its own HTML surface, and the subset actually needed here is bold,
 * code, links and line breaks.
 *
 * **No HTML is parsed and none is emitted.** The output is a list of spans the
 * component renders as React elements, so there is no `dangerouslySetInnerHTML`
 * anywhere in the panel and nothing the agent writes can become markup.
 *
 * An href that is not allow-listed **keeps its words** and loses its link,
 * rather than vanishing: text disappearing is how somebody comes to distrust
 * the whole feed, and the link was probably a mistake rather than an attack.
 */

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** `javascript:` and `data:` are the two that matter; relative is fine. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:)?\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  return null;
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let at = 0;

  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > at) spans.push({ kind: 'text', text: text.slice(at, start) });
    const token = match[0];

    if (token.startsWith('**')) {
      spans.push({ kind: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      spans.push({ kind: 'code', text: token.slice(1, -1) });
    } else {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      // A rejected href keeps its words. Losing the text is how a feed becomes
      // untrustworthy; losing the link is a link nobody could follow anyway.
      spans.push(href ? { kind: 'link', text: label, href } : { kind: 'text', text: label });
    }
    at = start + token.length;
  }

  if (at < text.length) spans.push({ kind: 'text', text: text.slice(at) });
  return spans;
}

/** Paragraphs of spans. Blank lines split; single newlines are breaks. */
export function parseMarkdown(source: string): Span[][] {
  return source
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => parseInline(block));
}
