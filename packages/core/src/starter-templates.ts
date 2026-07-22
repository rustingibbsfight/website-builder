import { materializeNode, type NodeInput, type SiteInput, type Theme, type ThemeColors, type WbNode } from '@wb/schema';
import type { BrandOverrides } from '@wb/template-breakthrough-medical';
import type { TemplateInfo } from './core.js';

/**
 * Built-in starter templates beyond breakthrough-medical, composed from the
 * standard components/blocks. Registered in core's TEMPLATES map, so they are
 * exposed identically to REST (`GET /templates`, `POST /sites/from-template`),
 * MCP (`list_templates`, `create_site`), and the CLI.
 */

const mat = (input: NodeInput): WbNode => materializeNode(input, new Set());
const root = (children: NodeInput[]): WbNode => mat({ type: 'page-root', props: {}, children });

function theme(brandName: string, colors: ThemeColors, fonts: Theme['fonts'], radiusScale: Theme['radiusScale']): Theme {
  return { brandName, colors, fonts, spacingScale: 8, radiusScale };
}

function makeTheme(brand: BrandOverrides, defaults: {
  brandName: string;
  colors: ThemeColors;
  fonts: Theme['fonts'];
  radiusScale: Theme['radiusScale'];
}): Theme {
  return theme(
    brand.brandName ?? defaults.brandName,
    { ...defaults.colors, ...brand.colors },
    { heading: brand.fonts?.heading ?? defaults.fonts.heading, body: brand.fonts?.body ?? defaults.fonts.body },
    defaults.radiusScale,
  );
}

function header(nav: Array<{ label: string; href: string }>, cta: { label: string; href: string }): WbNode {
  return mat({ type: 'header', props: { links: nav, cta, showLogo: true, sticky: true } });
}

function footer(brandName: string, about: string, columns: Array<{ heading: string; links: Array<{ label: string; href: string }> }>): WbNode {
  return mat({ type: 'footer', props: { about, columns, legal: `© 2026 ${brandName}`, showLogo: true } });
}

// ── SaaS landing ─────────────────────────────────────────────────────────────
function buildSaasLanding(brand: BrandOverrides = {}): SiteInput {
  const th = makeTheme(brand, {
    brandName: 'Northwind',
    colors: {
      primary: '#5b4ee6',
      secondary: '#14142b',
      accent: '#17c0a8',
      background: '#ffffff',
      surface: '#f4f3fb',
      text: '#16151f',
      textMuted: '#6b6a7d',
    },
    fonts: { heading: 'sans-geometric', body: 'sans-modern' },
    radiusScale: 'soft',
  });
  const nav = [
    { label: 'Features', href: '/#features' },
    { label: 'Pricing', href: '/pricing/' },
    { label: 'Contact', href: '/contact/' },
  ];
  const cta = { label: 'Start free', href: '/pricing/' };
  return {
    name: th.brandName,
    theme: th,
    header: header(nav, cta),
    footer: footer(th.brandName, 'The all-in-one platform your team will actually enjoy using.', [
      { heading: 'Product', links: [{ label: 'Features', href: '/#features' }, { label: 'Pricing', href: '/pricing/' }] },
      { heading: 'Company', links: [{ label: 'Contact', href: '/contact/' }] },
    ]),
    pages: [
      {
        slug: '',
        title: 'Home',
        meta: { description: 'Northwind — the all-in-one platform your team will actually enjoy using.' },
        tree: root([
          {
            type: 'hero',
            props: {
              headline: 'Ship faster, together',
              subhead: 'One workspace for planning, building, and shipping — so your team spends less time in tools and more time on work that matters.',
              primaryCta: { label: 'Start free', href: '/pricing/' },
              secondaryCta: { label: 'See features', href: '/#features' },
              imagePosition: 'none',
            },
          },
          { type: 'statRow', props: { stats: [
            { value: '12k+', label: 'Teams' },
            { value: '4.9★', label: 'Avg. rating' },
            { value: '99.99%', label: 'Uptime' },
          ] } },
          {
            type: 'featureGrid',
            props: { heading: 'Everything in one place', subhead: 'Stop stitching tools together.' },
            children: [
              { type: 'card', props: { title: 'Plan', body: 'Roadmaps, sprints, and priorities your whole team can see.', icon: '🗺️' } },
              { type: 'card', props: { title: 'Build', body: 'Track work from idea to done without the busywork.', icon: '🛠️' } },
              { type: 'card', props: { title: 'Ship', body: 'Automate releases and keep everyone in the loop.', icon: '🚀' } },
            ],
          },
          { type: 'faq', props: { heading: 'Questions', items: [
            { question: 'Is there a free plan?', answer: 'Yes — start free, no credit card required.' },
            { question: 'Can I import my data?', answer: 'Yes, from most popular tools in a few clicks.' },
          ] } },
        ]),
      },
      {
        slug: 'pricing',
        title: 'Pricing',
        meta: { description: 'Simple, transparent pricing for teams of any size.' },
        tree: root([
          {
            type: 'pricingTable',
            props: {
              heading: 'Simple pricing',
              subhead: 'Start free, upgrade when you grow.',
              plans: [
                { name: 'Free', price: '$0', period: '/mo', features: ['Up to 3 members', 'Core features', 'Community support'], highlighted: false },
                { name: 'Team', price: '$12', period: '/user/mo', features: ['Unlimited members', 'Automations', 'Priority support'], cta: { label: 'Start free', href: '/contact/' }, highlighted: true },
                { name: 'Enterprise', price: 'Custom', features: ['SSO & SCIM', 'Advanced security', 'Dedicated support'], cta: { label: 'Contact sales', href: '/contact/' }, highlighted: false },
              ],
            },
          },
        ]),
      },
      {
        slug: 'contact',
        title: 'Contact',
        meta: { description: 'Get in touch with the Northwind team.' },
        tree: root([
          { type: 'contactForm', props: { heading: 'Talk to us', fields: [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'email', label: 'Work email', type: 'email', required: true },
            { name: 'message', label: 'How can we help?', type: 'textarea', required: true },
          ], submitLabel: 'Send', netlifyForms: false } },
        ]),
      },
    ],
  };
}

// ── Local service business ───────────────────────────────────────────────────
function buildLocalService(brand: BrandOverrides = {}): SiteInput {
  const th = makeTheme(brand, {
    brandName: 'Evergreen Landscaping',
    colors: {
      primary: '#2f855a',
      secondary: '#22372f',
      accent: '#dd8b3a',
      background: '#ffffff',
      surface: '#f1f6f2',
      text: '#1c2b24',
      textMuted: '#5c6b63',
    },
    fonts: { heading: 'serif-modern', body: 'sans-humanist' },
    radiusScale: 'round',
  });
  const nav = [
    { label: 'Services', href: '/#services' },
    { label: 'About', href: '/about/' },
    { label: 'Contact', href: '/contact/' },
  ];
  const cta = { label: 'Get a quote', href: '/contact/' };
  return {
    name: th.brandName,
    theme: th,
    header: header(nav, cta),
    footer: footer(th.brandName, 'Family-owned landscaping and lawn care, serving the area since 2008.', [
      { heading: 'Services', links: [{ label: 'Lawn care', href: '/#services' }, { label: 'Design', href: '/#services' }] },
      { heading: 'Company', links: [{ label: 'About', href: '/about/' }, { label: 'Contact', href: '/contact/' }] },
    ]),
    pages: [
      {
        slug: '',
        title: 'Home',
        meta: { description: 'Evergreen Landscaping — reliable lawn care and landscape design, done right.' },
        tree: root([
          {
            type: 'hero',
            props: {
              headline: 'A yard you’ll love, without the work',
              subhead: 'Reliable lawn care, thoughtful design, and tidy crews who show up on time. Serving the area since 2008.',
              primaryCta: { label: 'Get a free quote', href: '/contact/' },
              secondaryCta: { label: 'Our services', href: '/#services' },
              imagePosition: 'none',
            },
          },
          {
            type: 'featureGrid',
            props: { heading: 'What we do' },
            children: [
              { type: 'card', props: { title: 'Lawn care', body: 'Mowing, edging, fertilizing, and seasonal cleanups.', icon: '🌱' } },
              { type: 'card', props: { title: 'Landscape design', body: 'Beds, plantings, and hardscape that fit your home.', icon: '🌳' } },
              { type: 'card', props: { title: 'Maintenance', body: 'Ongoing care plans so your yard always looks its best.', icon: '✂️' } },
            ],
          },
          {
            type: 'featureGrid',
            props: { heading: 'What neighbors say' },
            children: [
              { type: 'testimonial', props: { quote: 'Best decision we made for our home. Always on time and the yard looks incredible.', name: 'Dana P.', role: 'Homeowner' } },
              { type: 'testimonial', props: { quote: 'Honest pricing and great work. Highly recommend to anyone nearby.', name: 'Marcus T.', role: 'Homeowner' } },
            ],
          },
        ]),
      },
      {
        slug: 'about',
        title: 'About',
        meta: { description: 'A family-owned crew that treats your yard like our own.' },
        tree: root([
          { type: 'heading', props: { text: 'About Evergreen', level: 1, align: 'center' } },
          { type: 'text', props: { text: 'We’re a family-owned team that has cared for local lawns and gardens since 2008. We show up when we say we will, do careful work, and stand behind it.', align: 'center' } },
        ]),
      },
      {
        slug: 'contact',
        title: 'Contact',
        meta: { description: 'Request a free quote from Evergreen Landscaping.' },
        tree: root([
          { type: 'contactForm', props: { heading: 'Request a free quote', fields: [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'email', label: 'Email', type: 'email', required: true },
            { name: 'phone', label: 'Phone', type: 'tel', required: false },
            { name: 'message', label: 'What do you need?', type: 'textarea', required: true },
          ], submitLabel: 'Send request', netlifyForms: false } },
        ]),
      },
    ],
  };
}

// ── Portfolio ────────────────────────────────────────────────────────────────
function buildPortfolio(brand: BrandOverrides = {}): SiteInput {
  const th = makeTheme(brand, {
    brandName: 'Jordan Ellis',
    colors: {
      primary: '#e5484d',
      secondary: '#1a1a1a',
      accent: '#e5484d',
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#17171a',
      textMuted: '#70707a',
    },
    fonts: { heading: 'sans-modern', body: 'serif-classic' },
    radiusScale: 'sharp',
  });
  const nav = [
    { label: 'Work', href: '/#work' },
    { label: 'About', href: '/#about' },
    { label: 'Contact', href: '/contact/' },
  ];
  const cta = { label: 'Get in touch', href: '/contact/' };
  return {
    name: th.brandName,
    theme: th,
    header: header(nav, cta),
    footer: footer(th.brandName, 'Designer & art director. Currently open to select freelance projects.', [
      { heading: 'Elsewhere', links: [{ label: 'Contact', href: '/contact/' }] },
    ]),
    pages: [
      {
        slug: '',
        title: 'Home',
        meta: { description: 'Jordan Ellis — designer & art director. Selected work and contact.' },
        tree: root([
          {
            type: 'hero',
            props: {
              headline: 'Design that gets out of the way',
              subhead: 'I’m Jordan — a designer and art director helping brands look clear, considered, and unmistakably theirs.',
              primaryCta: { label: 'See work', href: '/#work' },
              secondaryCta: { label: 'Get in touch', href: '/contact/' },
              imagePosition: 'none',
            },
          },
          { type: 'heading', props: { text: 'Selected work', level: 2, align: 'center' } },
          { type: 'gallery', props: { columns: 3, lightbox: true, images: [
            { alt: 'Project one' }, { alt: 'Project two' }, { alt: 'Project three' },
            { alt: 'Project four' }, { alt: 'Project five' }, { alt: 'Project six' },
          ] } },
          { type: 'logoWall', props: { heading: 'Selected clients', logos: [
            { name: 'Aperture' }, { name: 'Monogram' }, { name: 'Field Notes' }, { name: 'Kinfolk' },
          ] } },
        ]),
      },
      {
        slug: 'contact',
        title: 'Contact',
        meta: { description: 'Start a project with Jordan Ellis.' },
        tree: root([
          { type: 'contactForm', props: { heading: 'Start a project', fields: [
            { name: 'name', label: 'Name', type: 'text', required: true },
            { name: 'email', label: 'Email', type: 'email', required: true },
            { name: 'message', label: 'Tell me about your project', type: 'textarea', required: true },
          ], submitLabel: 'Send', netlifyForms: false } },
        ]),
      },
    ],
  };
}

export const STARTER_TEMPLATES: Record<string, { meta: TemplateInfo; build: (brand?: BrandOverrides) => SiteInput }> = {
  'saas-landing': {
    meta: {
      name: 'saas-landing',
      title: 'SaaS landing',
      description: 'Modern SaaS marketing site: hero, stats, features, FAQ, a pricing page, and a contact page. Indigo palette.',
      pages: ['home (/)', 'pricing', 'contact'],
      brandable: ['brandName', 'colors.*', 'fonts.heading', 'fonts.body', 'logoUrl', 'baseUrl'],
    },
    build: buildSaasLanding,
  },
  'local-service': {
    meta: {
      name: 'local-service',
      title: 'Local service business',
      description: 'Service-business site (landscaping example): hero, services, testimonials, about, and a quote/contact form. Green palette.',
      pages: ['home (/)', 'about', 'contact'],
      brandable: ['brandName', 'colors.*', 'fonts.heading', 'fonts.body', 'logoUrl', 'baseUrl'],
    },
    build: buildLocalService,
  },
  portfolio: {
    meta: {
      name: 'portfolio',
      title: 'Portfolio',
      description: 'Minimal personal/creative portfolio: hero, work gallery with lightbox, client logos, and a contact page. High-contrast palette.',
      pages: ['home (/)', 'contact'],
      brandable: ['brandName', 'colors.*', 'fonts.heading', 'fonts.body', 'logoUrl', 'baseUrl'],
    },
    build: buildPortfolio,
  },
};
