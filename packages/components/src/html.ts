export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/|#|\.\/)/;

export function safeHref(href: string): string {
  const trimmed = href.trim();
  return SAFE_HREF.test(trimmed) ? escapeHtml(trimmed) : '#';
}

/**
 * Make a URL safe to embed inside a CSS url('...') without breaking out of the
 * string, declaration, or rule. Strips quotes, parens, backslashes, angle
 * brackets, semicolons, braces, and whitespace. Returns '' if nothing usable
 * remains — callers should skip emitting the declaration in that case.
 */
export function cssUrl(url: string): string {
  return url.replace(/["'()\\;{}<>]/g, '').replace(/\s+/g, '');
}

export function attrs(obj: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeHtml(String(v))}"`))
    .join('');
}
