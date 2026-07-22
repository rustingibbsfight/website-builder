import type { Theme, WbNode } from '@wb/schema';
import { DEFAULT_THEME } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { getComponent, parseProps, type RenderCtx } from '../index.js';

const ctx: RenderCtx = {
  theme: DEFAULT_THEME as Theme,
  resolveAsset: (ref) => ref?.url ?? (ref?.assetId ? `/assets/${ref.assetId}` : ''),
  renderNode: (node: WbNode) => `<!--child:${node.id}-->`,
};

function render(type: string, props: Record<string, unknown>): string {
  const parsed = parseProps(type, props);
  const node: WbNode = { id: 'w123456789', type, props: parsed, children: [] };
  return getComponent(type).render(node, parsed, ctx);
}

describe('widget components', () => {
  it('statRow renders each metric value and label', () => {
    const html = render('statRow', {
      heading: 'By the numbers',
      stats: [
        { value: '10k+', label: 'Patients' },
        { value: '98%', label: 'Satisfaction', description: 'Across all clinics' },
      ],
    });
    expect(html).toContain('10k+');
    expect(html).toContain('Satisfaction');
    expect(html).toContain('Across all clinics');
  });

  it('logoWall falls back to text when a logo has no image', () => {
    const html = render('logoWall', { logos: [{ name: 'Acme' }] });
    expect(html).toContain('wb-logo-text');
    expect(html).toContain('Acme');
  });

  it('pricingTable marks the highlighted plan and lists features + CTA', () => {
    const html = render('pricingTable', {
      plans: [
        {
          name: 'Pro',
          price: '$29',
          period: '/mo',
          features: ['Unlimited projects', 'Priority support'],
          cta: { label: 'Choose Pro', href: '/signup' },
          highlighted: true,
        },
      ],
    });
    expect(html).toContain('wb-plan-hl');
    expect(html).toContain('Popular');
    expect(html).toContain('Unlimited projects');
    expect(html).toContain('href="/signup"');
  });

  it('gallery lightbox=true emits a :target overlay per image; false does not', () => {
    const withLb = render('gallery', { lightbox: true, images: [{ url: '/a.jpg', alt: 'A' }] });
    expect(withLb).toContain('id="wb-lb-w123456789-0"');
    expect(withLb).toContain('wb-gal-lb');

    const noLb = render('gallery', { lightbox: false, images: [{ url: '/a.jpg', alt: 'A' }] });
    expect(noLb).not.toContain('wb-gal-lb');
    expect(noLb).toContain('<figure');
  });

  it('escapes user text — no HTML injection through widget props', () => {
    const html = render('statRow', { stats: [{ value: '<script>x</script>', label: '"><img>' }] });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('"><img>');
  });

  it('ships zero JavaScript — no <script> or on* handlers in output', () => {
    for (const type of ['statRow', 'logoWall', 'pricingTable', 'gallery']) {
      const def = getComponent(type);
      const html = render(type, def.defaultProps as Record<string, unknown>);
      expect(html, type).not.toMatch(/<script/i);
      expect(html, type).not.toMatch(/\son[a-z]+=/i);
    }
  });
});
