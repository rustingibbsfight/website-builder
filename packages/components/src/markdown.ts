import { escapeHtml, safeHref } from './html.js';

/**
 * Constrained markdown → sanitized HTML. Supported: #–#### headings, paragraphs,
 * unordered (-/*) and ordered (1.) lists, **bold**, *italic*, `code`,
 * [text](href). Everything is HTML-escaped before transformation; hrefs are
 * restricted to http(s)/mailto/tel/relative/anchor.
 */
export function renderMarkdown(md: string): string {
  const blocks = md.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (lines.length === 0) return '';
      const first = lines[0]!;

      const h = first.match(/^(#{1,4})\s+(.*)$/);
      if (h && lines.length === 1) return `<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`;

      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.map((l) => inline(l)).join('<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

function inline(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, (_, c: string) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, text: string, href: string) => `<a href="${safeHref(href)}">${text}</a>`,
  );
  return s;
}
