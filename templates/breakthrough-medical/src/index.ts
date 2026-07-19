import {
  materializeNode,
  type FontStackName,
  type NodeInput,
  type SiteInput,
  type Theme,
  type ThemeColors,
  type WbNode,
} from '@wb/schema';
import { buildAssets } from './assets.js';

export interface BrandOverrides {
  brandName?: string;
  colors?: Partial<ThemeColors>;
  fonts?: { heading?: FontStackName; body?: FontStackName };
  /** External logo URL; replaces the bundled placeholder logo. */
  logoUrl?: string;
  baseUrl?: string;
}

export const TEMPLATE_META = {
  name: 'breakthrough-medical',
  title: 'Breakthrough Medical',
  description:
    'Medical weight-loss clinic site: home, services, about, contact. Teal medical palette, physician-supervised program copy, contact form, FAQ.',
  pages: ['home (/)', 'services', 'about', 'contact'],
  brandable: ['brandName', 'colors.*', 'fonts.heading', 'fonts.body', 'logoUrl', 'baseUrl'],
};

const DEFAULT_COLORS: ThemeColors = {
  primary: '#0e7c66',
  secondary: '#123f36',
  accent: '#d9962e',
  background: '#ffffff',
  surface: '#f0f6f4',
  text: '#1d2b28',
  textMuted: '#5b6f69',
};

function mat(input: NodeInput): WbNode {
  return materializeNode(input, new Set());
}

export function buildBreakthroughMedical(brand: BrandOverrides = {}): SiteInput {
  const brandName = brand.brandName ?? 'Breakthrough Medical';
  const colors: ThemeColors = { ...DEFAULT_COLORS, ...brand.colors };
  const theme: Theme = {
    brandName,
    colors,
    fonts: { heading: brand.fonts?.heading ?? 'serif-modern', body: brand.fonts?.body ?? 'sans-humanist' },
    spacingScale: 8,
    radiusScale: 'soft',
    logo: brand.logoUrl ? { url: brand.logoUrl } : { assetId: 'logo' },
  };

  const header = mat({
    type: 'header',
    props: {
      links: [
        { label: 'Home', href: '/' },
        { label: 'Services', href: '/services/' },
        { label: 'About', href: '/about/' },
        { label: 'Contact', href: '/contact/' },
      ],
      cta: { label: 'Book a Consult', href: '/contact/' },
      showLogo: true,
      sticky: true,
    },
  });

  const footer = mat({
    type: 'footer',
    props: {
      about:
        'A physician-supervised medical weight management clinic. Every program starts with a medical evaluation and is tailored to you.',
      columns: [
        {
          heading: 'Explore',
          links: [
            { label: 'Services', href: '/services/' },
            { label: 'About us', href: '/about/' },
            { label: 'Contact', href: '/contact/' },
          ],
        },
        {
          heading: 'Visit us',
          links: [
            { label: 'Book a consultation', href: '/contact/' },
            { label: 'Get directions', href: '/contact/' },
          ],
        },
      ],
      legal: `© 2026 ${brandName}, LLC. All rights reserved. Individual results vary. All treatments require an in-person or telehealth medical evaluation and are prescribed only when clinically appropriate.`,
      showLogo: true,
    },
  });

  const home = mat({
    type: 'page-root',
    children: [
      {
        type: 'hero',
        props: {
          headline: 'Weight loss, guided by medical experts',
          subhead:
            'Physician-supervised weight management programs built around your health history, your goals, and your life — with ongoing clinical support at every step.',
          primaryCta: { label: 'Book a Consultation', href: '/contact/' },
          secondaryCta: { label: 'Explore Services', href: '/services/' },
          image: { assetId: 'hero', alt: 'Illustration of a medical heart and pulse line' },
          imagePosition: 'right',
        },
        style: { background: 'surface' },
      },
      {
        type: 'featureGrid',
        props: {
          heading: `Why ${brandName}`,
          subhead: 'Care designed and monitored by licensed medical providers — not a one-size-fits-all plan.',
        },
        children: [
          {
            type: 'card',
            props: {
              icon: '🩺',
              title: 'Physician-supervised',
              body: 'Licensed providers review your health history, order appropriate labs, and monitor your progress throughout your program.',
            },
          },
          {
            type: 'card',
            props: {
              icon: '📋',
              title: 'Personalized plans',
              body: 'Your plan is tailored to your medical profile and goals, and adjusted as your needs change.',
            },
          },
          {
            type: 'card',
            props: {
              icon: '🤝',
              title: 'Ongoing support',
              body: 'Regular follow-ups, check-ins, and a care team that knows you by name — you are never on your own.',
            },
          },
        ],
      },
      {
        type: 'section',
        props: {},
        layout: { direction: 'grid', columns: 2, gap: 'lg', padding: 'xl', maxWidth: 'wide' },
        style: { background: 'surface' },
        children: [
          {
            type: 'testimonial',
            props: {
              quote:
                'The team took the time to understand my health history before recommending anything. I always feel heard and supported.',
              name: 'Maria G.',
              role: 'Patient',
            },
          },
          {
            type: 'testimonial',
            props: {
              quote:
                'Professional, kind, and thorough. The regular check-ins keep me accountable and the plan realistic for my life.',
              name: 'James R.',
              role: 'Patient',
            },
          },
        ],
      },
      {
        type: 'section',
        props: {},
        layout: { direction: 'stack', gap: 'md', padding: '2xl', align: 'center', maxWidth: 'content' },
        style: { background: 'primary', color: 'white' },
        children: [
          { type: 'heading', props: { text: 'Ready to take the first step?', level: 2, align: 'center' } },
          {
            type: 'text',
            props: {
              text: 'Schedule a consultation with our clinical team to find out which program fits you.',
              size: 'lg',
              align: 'center',
            },
          },
          { type: 'button', props: { label: 'Book a Consultation', href: '/contact/', variant: 'secondary', size: 'lg' } },
        ],
      },
    ],
  });

  const services = mat({
    type: 'page-root',
    children: [
      {
        type: 'section',
        props: {},
        layout: { direction: 'stack', gap: 'sm', padding: 'xl', align: 'center', maxWidth: 'content' },
        style: { background: 'surface' },
        children: [
          { type: 'heading', props: { text: 'Our Services', level: 1, align: 'center' } },
          {
            type: 'text',
            props: {
              text: 'Every service begins with a medical evaluation. Treatments are prescribed only when clinically appropriate for you.',
              size: 'lg',
              align: 'center',
            },
          },
        ],
      },
      {
        type: 'featureGrid',
        props: {},
        children: [
          {
            type: 'card',
            props: {
              icon: '🧑‍⚕️',
              title: 'Medical weight management consultation',
              body: 'A comprehensive evaluation of your health history, lifestyle, and goals with a licensed provider — the starting point for every program.',
              href: '/contact/',
              linkLabel: 'Book now',
            },
          },
          {
            type: 'card',
            props: {
              icon: '💉',
              title: 'GLP-1 medication programs',
              body: 'Prescription GLP-1 medications (such as semaglutide or tirzepatide), prescribed when clinically appropriate and monitored with regular provider follow-ups.',
              href: '/contact/',
              linkLabel: 'Ask about eligibility',
            },
          },
          {
            type: 'card',
            props: {
              icon: '🧪',
              title: 'Lab work & health monitoring',
              body: 'Baseline and follow-up labs to keep your program safe and grounded in your real health data.',
            },
          },
          {
            type: 'card',
            props: {
              icon: '💊',
              title: 'Vitamin B12 support',
              body: 'B12 injections offered as a supportive add-on where appropriate as part of your overall plan.',
            },
          },
          {
            type: 'card',
            props: {
              icon: '📅',
              title: 'Ongoing follow-ups',
              body: 'Scheduled check-ins to review progress, manage side effects, and adjust your plan with your provider.',
            },
          },
          {
            type: 'card',
            props: {
              icon: '🥗',
              title: 'Lifestyle & nutrition guidance',
              body: 'Practical, sustainable nutrition and activity guidance that works alongside any medical treatment.',
            },
          },
        ],
      },
      {
        type: 'faq',
        props: {
          heading: 'Frequently asked questions',
          items: [
            {
              question: 'Do I need a consultation before starting any program?',
              answer:
                'Yes. Every patient starts with a medical evaluation so our providers can review your health history and determine which options are clinically appropriate for you.',
            },
            {
              question: 'Are GLP-1 medications right for me?',
              answer:
                'GLP-1 medications are prescription treatments and are not appropriate for everyone. Our providers will evaluate your health profile, discuss risks and benefits, and only prescribe when clinically indicated.',
            },
            {
              question: 'How often will I be seen?',
              answer:
                'Most programs include regular follow-up visits — typically monthly — so your provider can monitor progress, labs, and any side effects, and adjust your plan.',
            },
            {
              question: 'What results can I expect?',
              answer:
                'Individual results vary. Weight management outcomes depend on many factors, including adherence, lifestyle, and your individual health profile. Your provider will help you set realistic, healthy goals.',
            },
          ],
        },
      },
      {
        type: 'section',
        props: {},
        layout: { direction: 'stack', padding: 'lg', maxWidth: 'content' },
        children: [
          {
            type: 'text',
            props: {
              text: 'Safety information: All medications carry potential risks and side effects. Our providers review these with you before any prescription. This website is for general information and is not medical advice.',
              size: 'sm',
              align: 'center',
            },
            style: { color: 'textMuted' },
          },
        ],
      },
    ],
  });

  const about = mat({
    type: 'page-root',
    children: [
      {
        type: 'section',
        props: {},
        layout: { direction: 'row', gap: '2xl', padding: 'xl', align: 'center', maxWidth: 'wide' },
        children: [
          {
            type: 'stack',
            props: {},
            layout: { direction: 'stack', gap: 'md' },
            children: [
              { type: 'heading', props: { text: `About ${brandName}`, level: 1 } },
              {
                type: 'richText',
                props: {
                  markdown: `We founded ${brandName} on a simple belief: **lasting weight management is medical care**, not a fad.

Our clinic combines evidence-based treatment, honest conversations, and consistent follow-up. We take the time to understand your health history before recommending anything, and we stay with you through every step of your program.

Whether you are exploring medical weight management for the first time or looking for a clinical team that treats you as a partner, we are here to help you make informed decisions about your health.`,
                },
              },
            ],
          },
          {
            type: 'image',
            props: {
              image: { assetId: 'about', alt: 'Illustration of a caring clinician' },
              rounded: true,
            },
          },
        ],
      },
      {
        type: 'featureGrid',
        props: { heading: 'What we stand for' },
        children: [
          {
            type: 'card',
            props: {
              icon: '🔬',
              title: 'Evidence-based care',
              body: 'Treatment decisions grounded in current clinical evidence and your individual health data.',
            },
          },
          {
            type: 'card',
            props: {
              icon: '💬',
              title: 'Honest guidance',
              body: 'Clear conversations about what treatments can and cannot do — no exaggerated promises.',
            },
          },
          {
            type: 'card',
            props: {
              icon: '🧭',
              title: 'Long-term partnership',
              body: 'We measure success in sustainable health improvements, not quick fixes.',
            },
          },
        ],
      },
      {
        type: 'section',
        props: {},
        layout: { direction: 'stack', gap: 'md', padding: 'xl', align: 'center', maxWidth: 'content' },
        style: { background: 'surface' },
        children: [
          { type: 'heading', props: { text: 'Meet your care team', level: 2, align: 'center' } },
          {
            type: 'text',
            props: {
              text: 'Our programs are directed by licensed medical providers supported by an experienced clinical staff. You will get to know your care team personally — and they will get to know you.',
              align: 'center',
            },
          },
          { type: 'button', props: { label: 'Book a Consultation', href: '/contact/', variant: 'primary', size: 'md' } },
        ],
      },
    ],
  });

  const contact = mat({
    type: 'page-root',
    children: [
      {
        type: 'section',
        props: {},
        layout: { direction: 'stack', gap: 'sm', padding: 'xl', align: 'center', maxWidth: 'content' },
        style: { background: 'surface' },
        children: [
          { type: 'heading', props: { text: 'Contact Us', level: 1, align: 'center' } },
          {
            type: 'text',
            props: {
              text: 'Book a consultation or ask us a question — we usually respond within one business day.',
              size: 'lg',
              align: 'center',
            },
          },
        ],
      },
      {
        type: 'section',
        props: {},
        layout: { direction: 'row', gap: '2xl', padding: 'xl', maxWidth: 'wide' },
        children: [
          {
            type: 'contactForm',
            props: {
              heading: 'Send us a message',
              fields: [
                { name: 'name', label: 'Full name', type: 'text', required: true },
                { name: 'email', label: 'Email', type: 'email', required: true },
                { name: 'phone', label: 'Phone', type: 'tel', required: false },
                {
                  name: 'interest',
                  label: 'I am interested in',
                  type: 'select',
                  required: false,
                  options: ['New patient consultation', 'GLP-1 program eligibility', 'B12 support', 'Other question'],
                },
                { name: 'message', label: 'Message', type: 'textarea', required: true },
              ],
              submitLabel: 'Send message',
              netlifyForms: false,
            },
          },
          {
            type: 'stack',
            props: {},
            layout: { direction: 'stack', gap: 'lg' },
            children: [
              {
                type: 'mapEmbed',
                props: { heading: 'Visit the clinic', address: '2 Executive Blvd Suite 201, Suffern, NY 10901' },
              },
              {
                type: 'richText',
                props: {
                  markdown: `#### Office hours

- Monday – Friday: 9:00 AM – 5:00 PM
- Saturday: By appointment
- Sunday: Closed

#### Reach us

- Phone: [ (845) 553-9550](tel:+18455539550)
- Email: [info@breakthroughmedicalny.com](mailto:info@breakthroughmedicalny.com)`,
                },
              },
            ],
          },
        ],
      },
    ],
  });

  return {
    name: brandName,
    theme,
    header,
    footer,
    settings: brand.baseUrl ? { baseUrl: brand.baseUrl } : {},
    pages: [
      {
        slug: '',
        title: 'Physician-Supervised Weight Management',
        meta: {
          description: `${brandName} offers physician-supervised medical weight management programs with personalized plans and ongoing clinical support.`,
        },
        tree: home,
      },
      {
        slug: 'services',
        title: 'Services',
        meta: {
          description: `Medical weight management consultations, GLP-1 medication programs, lab monitoring, and B12 support at ${brandName}.`,
        },
        tree: services,
      },
      {
        slug: 'about',
        title: 'About Us',
        meta: {
          description: `Learn about ${brandName}: an evidence-based, physician-supervised medical weight management clinic.`,
        },
        tree: about,
      },
      {
        slug: 'contact',
        title: 'Contact',
        meta: {
          description: `Book a consultation with ${brandName} or ask our clinical team a question.`,
        },
        tree: contact,
      },
    ],
    assets: buildAssets(colors, brandName),
  };
}
