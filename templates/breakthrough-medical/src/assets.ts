import type { ThemeColors } from '@wb/schema';

/** Branded SVG placeholder assets, colored from the (possibly overridden) theme. */
export function buildAssets(colors: ThemeColors, brandName: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 64" width="340" height="64">
<rect x="2" y="8" width="48" height="48" rx="12" fill="${colors.primary}"/>
<path d="M26 20v24M14 32h24" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
<text x="62" y="41" font-family="Georgia, serif" font-size="26" font-weight="700" fill="${colors.secondary}">${esc(brandName)}</text>
</svg>`;

  const hero = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${colors.surface}"/><stop offset="1" stop-color="${colors.primary}" stop-opacity=".25"/>
</linearGradient>
</defs>
<rect width="800" height="600" rx="24" fill="url(#bg)"/>
<circle cx="620" cy="150" r="90" fill="${colors.primary}" opacity=".18"/>
<circle cx="160" cy="470" r="120" fill="${colors.accent}" opacity=".15"/>
<path d="M240 330c0-60 45-100 105-100s105 40 105 100c0 80-105 150-105 150s-105-70-105-150z" fill="${colors.primary}" opacity=".85"/>
<path d="M300 330h30l15-40 25 80 18-40h42" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

  const about = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" width="800" height="500">
<rect width="800" height="500" rx="24" fill="${colors.surface}"/>
<circle cx="400" cy="170" r="80" fill="${colors.primary}" opacity=".3"/>
<circle cx="400" cy="150" r="46" fill="${colors.primary}"/>
<path d="M310 400c0-50 40-90 90-90s90 40 90 90" stroke="${colors.secondary}" stroke-width="14" fill="none" stroke-linecap="round"/>
<path d="M560 140v40M540 160h40" stroke="${colors.accent}" stroke-width="8" stroke-linecap="round"/>
<path d="M220 220v28M206 234h28" stroke="${colors.accent}" stroke-width="6" stroke-linecap="round"/>
</svg>`;

  return [
    { id: 'logo', filename: 'logo.svg', mime: 'image/svg+xml', content: logo },
    { id: 'hero', filename: 'hero.svg', mime: 'image/svg+xml', content: hero },
    { id: 'about', filename: 'about.svg', mime: 'image/svg+xml', content: about },
  ];
}
