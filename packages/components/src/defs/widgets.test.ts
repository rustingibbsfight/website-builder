import type { Theme, WbNode } from '@wb/schema';
import { DEFAULT_THEME } from '@wb/schema';
import { describe, expect, it } from 'vitest';
import { getComponent, parseProps, type RenderCtx } from '../index.js';

const ctx: RenderCtx = {
  theme: DEFAULT_THEME as Theme,
  resolveAsset: (ref) => ref?.url ?? (ref?.assetId ? `/assets/${ref.assetId}` : ''),
  renderNode: (node: WbNode) => `<!--child:${node.id}-->`,
};

function render(type: string, props: Record<string, unknown>, ctxOverride: Partial<RenderCtx> = {}): string {
  const parsed = parseProps(type, props);
  const node: WbNode = { id: 'w123456789', type, props: parsed, children: [] };
  return getComponent(type).render(node, parsed, { ...ctx, ...ctxOverride });
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

  it('accordion renders a <details> per item and honours open/exclusive', () => {
    const html = render('accordion', {
      exclusive: true,
      items: [
        { title: 'First', body: 'One', open: true },
        { title: 'Second', body: 'Two', open: false },
      ],
    });
    // Two collapsible rows, first starts open.
    expect(html.match(/<details/g)?.length).toBe(2);
    expect(html).toContain('<details class="wb-acc-item" open');
    // Exclusive → native single-open grouping via matching name= on each <details>.
    expect(html.match(/name="wb-acc-w123456789"/g)?.length).toBe(2);
    expect(html).toContain('First');
    expect(html).toContain('Two');
  });

  it('accordion exclusive=false omits the grouping name', () => {
    const html = render('accordion', { exclusive: false, items: [{ title: 'A', body: 'a' }] });
    expect(html).not.toContain('name="wb-acc');
  });

  it('tabs emits one radio per tab, first checked, mapped to labels + panels', () => {
    const html = render('tabs', {
      tabs: [
        { label: 'Overview', body: 'Summary' },
        { label: 'Details', body: 'Specifics' },
      ],
    });
    const radios = html.match(/type="radio"/g)?.length;
    expect(radios).toBe(2);
    // Exactly one selected by default (the first).
    expect(html.match(/\schecked/g)?.length).toBe(1);
    expect(html).toContain('id="wb-tabs-w123456789-0"');
    expect(html).toContain('for="wb-tabs-w123456789-1"');
    expect(html).toContain('Overview');
    expect(html).toContain('Specifics');
    // Per-node CSS maps checked radio → active label + shown panel (no JS).
    const css = getComponent('tabs').nodeCss?.(
      { id: 'w123456789', type: 'tabs', props: {}, children: [] } as unknown as WbNode,
      parseProps('tabs', {
        tabs: [
          { label: 'Overview', body: 'Summary' },
          { label: 'Details', body: 'Specifics' },
        ],
      }),
      '.c-tabs',
    );
    expect(css).toContain('#wb-tabs-w123456789-0:checked');
    expect(css).toContain('.wb-tabpanel:nth-of-type(2){display:block}');
  });

  it('contactForm store=true posts to the wb-api submissions endpoint with a honeypot', () => {
    const html = render(
      'contactForm',
      { store: true, fields: [{ name: 'email', label: 'Email', type: 'email', required: true }] },
      { siteId: 'site42', formEndpoint: 'https://api.example.com/' },
    );
    expect(html).toContain('action="https://api.example.com/sites/site42/submissions/w123456789"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="_hp"'); // spam honeypot
    // Zero-JS: still no scripts or handlers.
    expect(html).not.toMatch(/<script|\son[a-z]+=/i);
  });

  it('contactForm store=true honours an explicit formId', () => {
    const html = render(
      'contactForm',
      { store: true, formId: 'newsletter', fields: [{ name: 'email', label: 'Email', type: 'email' }] },
      { siteId: 'site42', formEndpoint: 'https://api.example.com' },
    );
    expect(html).toContain('/sites/site42/submissions/newsletter"');
  });

  it('contactForm without store (or endpoint) keeps the external action and no honeypot', () => {
    const external = render('contactForm', { action: 'https://formspree.io/f/abc', fields: [{ name: 'email', label: 'E', type: 'email' }] });
    expect(external).toContain('action="https://formspree.io/f/abc"');
    expect(external).not.toContain('name="_hp"');
    // store=true but no endpoint configured → no store action, no honeypot.
    const noEndpoint = render('contactForm', { store: true, fields: [{ name: 'email', label: 'E', type: 'email' }] });
    expect(noEndpoint).not.toContain('submissions/');
    expect(noEndpoint).not.toContain('name="_hp"');
  });

  it('image emits lazy + async decoding, intrinsic dims when known, and a focal crop', () => {
    const html = render('image', { image: { url: '/p.jpg', alt: 'P', width: 800, height: 600 }, aspect: 'square', focal: 'top' });
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
    const css = getComponent('image').nodeCss?.(
      { id: 'w1', type: 'image', props: {}, children: [] } as unknown as WbNode,
      parseProps('image', { image: { url: '/p.jpg', alt: 'P' }, aspect: 'square', focal: 'top' }),
      '.c-image',
    );
    expect(css).toContain('object-position:50% 0');
  });

  it('image omits dims when unknown and object-position when centered', () => {
    const html = render('image', { image: { url: '/p.jpg', alt: 'P' } });
    expect(html).not.toContain('width=');
    const css = getComponent('image').nodeCss?.(
      { id: 'w1', type: 'image', props: {}, children: [] } as unknown as WbNode,
      parseProps('image', { image: { url: '/p.jpg', alt: 'P' } }),
      '.c-image',
    );
    expect(css).not.toContain('object-position');
  });

  it('escapes user text — no HTML injection through widget props', () => {
    const html = render('statRow', { stats: [{ value: '<script>x</script>', label: '"><img>' }] });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('"><img>');
  });

  it('ships zero JavaScript — no <script> or on* handlers in output', () => {
    for (const type of ['statRow', 'logoWall', 'pricingTable', 'gallery', 'accordion', 'tabs']) {
      const def = getComponent(type);
      const html = render(type, def.defaultProps as Record<string, unknown>);
      expect(html, type).not.toMatch(/<script/i);
      expect(html, type).not.toMatch(/\son[a-z]+=/i);
    }
  });
});
