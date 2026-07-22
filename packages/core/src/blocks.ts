import { n, type NodeInput } from '@wb/schema';

/**
 * Block library — pre-composed section subtrees a user or agent can drop into a
 * page in one action. Each block is an ordinary component subtree (validated
 * against the registry on insert), so blocks are exposed identically to the
 * REST API, MCP (list_blocks / insert_block), and the editor's block picker.
 */
export interface Block {
  id: string;
  name: string;
  category: string;
  description: string;
  /** The subtree to insert; ids are assigned when it lands in a page. */
  node: NodeInput;
}

export interface BlockSummary {
  id: string;
  name: string;
  category: string;
  description: string;
}

export const BLOCKS: Block[] = [
  {
    id: 'hero-centered',
    name: 'Centered hero',
    category: 'Hero',
    description: 'A big centered headline, a supporting line, and two call-to-action buttons.',
    node: n('hero', {
      headline: 'A clear, compelling headline',
      subhead: 'One supporting sentence that explains the value and invites the visitor to take the next step.',
      primaryCta: { label: 'Get started', href: '/contact' },
      secondaryCta: { label: 'Learn more', href: '/services' },
      imagePosition: 'none',
    }),
  },
  {
    id: 'features-3',
    name: 'Three features',
    category: 'Features',
    description: 'A heading and three feature cards with icons.',
    node: n('featureGrid', { heading: 'Why choose us', subhead: 'Three reasons that matter.' }, {}, [
      n('card', { title: 'Fast', body: 'Describe the first benefit in a sentence or two.', icon: '⚡' }),
      n('card', { title: 'Reliable', body: 'Describe the second benefit in a sentence or two.', icon: '🛡️' }),
      n('card', { title: 'Supported', body: 'Describe the third benefit in a sentence or two.', icon: '💬' }),
    ]),
  },
  {
    id: 'stats-band',
    name: 'Stats band',
    category: 'Social proof',
    description: 'A row of headline metrics.',
    node: n('statRow', {
      heading: 'By the numbers',
      stats: [
        { value: '10k+', label: 'Happy customers' },
        { value: '99.9%', label: 'Uptime' },
        { value: '24/7', label: 'Support' },
      ],
    }),
  },
  {
    id: 'logo-wall',
    name: 'Logo wall',
    category: 'Social proof',
    description: 'A strip of partner or press logos.',
    node: n('logoWall', {
      heading: 'Trusted by',
      logos: [{ name: 'Acme' }, { name: 'Globex' }, { name: 'Initech' }, { name: 'Umbrella' }, { name: 'Hooli' }],
    }),
  },
  {
    id: 'testimonials',
    name: 'Testimonials',
    category: 'Social proof',
    description: 'A grid of customer testimonials.',
    node: n('featureGrid', { heading: 'What people say' }, {}, [
      n('testimonial', {
        quote: 'This changed how we work — I recommend it to everyone.',
        name: 'Alex Rivera',
        role: 'Founder, Acme',
      }),
      n('testimonial', {
        quote: 'Support is fantastic and the results speak for themselves.',
        name: 'Sam Chen',
        role: 'Director, Globex',
      }),
    ]),
  },
  {
    id: 'pricing',
    name: 'Pricing',
    category: 'Pricing',
    description: 'A two-tier pricing table with a highlighted plan.',
    node: n('pricingTable', {
      heading: 'Simple pricing',
      subhead: 'Choose the plan that fits.',
      plans: [
        { name: 'Starter', price: '$0', period: '/mo', features: ['1 project', 'Community support'], highlighted: false },
        {
          name: 'Pro',
          price: '$29',
          period: '/mo',
          features: ['Unlimited projects', 'Priority support', 'Custom domain'],
          cta: { label: 'Choose Pro', href: '/contact' },
          highlighted: true,
        },
      ],
    }),
  },
  {
    id: 'faq',
    name: 'FAQ',
    category: 'FAQ',
    description: 'A few frequently asked questions (native accordion, zero JS).',
    node: n('faq', {
      heading: 'Frequently asked questions',
      items: [
        { question: 'How does it work?', answer: 'Explain the process in a couple of sentences.' },
        { question: 'How much does it cost?', answer: 'Point to your pricing, or explain the model.' },
        { question: 'How do I get started?', answer: 'Tell the visitor the very first step to take.' },
      ],
    }),
  },
  {
    id: 'cta-band',
    name: 'Call to action',
    category: 'CTA',
    description: 'A centered heading and paragraph with a prominent button.',
    node: n(
      'section',
      {},
      {
        layout: { direction: 'stack', gap: 'md', padding: 'xl', align: 'center', maxWidth: 'wide' },
        style: { background: 'surface' },
      },
      [
        n('heading', { text: 'Ready to get started?', level: 2, align: 'center' }),
        n('text', { text: 'Book a consultation with our team today — it only takes a minute.', align: 'center' }),
        n('button', { label: 'Get started', href: '/contact', variant: 'primary', size: 'lg' }),
      ],
    ),
  },
  {
    id: 'contact',
    name: 'Contact form',
    category: 'Contact',
    description: 'A name / email / message contact form.',
    node: n('contactForm', {
      heading: 'Get in touch',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'message', label: 'Message', type: 'textarea', required: true },
      ],
      submitLabel: 'Send message',
      netlifyForms: false,
    }),
  },
];

export function listBlocks(): BlockSummary[] {
  return BLOCKS.map(({ node: _node, ...summary }) => summary);
}

export function getBlock(id: string): Block {
  const block = BLOCKS.find((b) => b.id === id);
  if (!block) {
    throw new Error(`unknown block "${id}" — valid: ${BLOCKS.map((b) => b.id).join(', ')}`);
  }
  return block;
}
