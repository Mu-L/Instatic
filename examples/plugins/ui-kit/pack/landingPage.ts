/**
 * UI Kit — Landing page template.
 *
 * Pages are still hand-assembled (the SDK doesn't yet ship a page builder
 * helper because Page carries CMS-specific metadata like ownership and
 * template config). The id and slug are namespace-prefixed so re-installs
 * don't clobber the user's own home page.
 */
import type { Page } from '@core/page-tree'

export const landingPage: Page = {
  id: 'acme-ui-kit-landing',
  title: 'UI Kit Landing',
  slug: 'ui-kit-landing',
  rootNodeId: 'uk-body',
  nodes: {
    'uk-body': {
      id: 'uk-body',
      moduleId: 'base.body',
      props: {},
      breakpointOverrides: {},
      children: ['uk-hero', 'uk-features', 'uk-pricing', 'uk-testimonial-section', 'uk-cta'],
      classIds: [],
    },
    'uk-hero': {
      id: 'uk-hero',
      moduleId: 'base.visual-component-ref',
      props: { componentId: 'acme.ui-kit/hero-centered' },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    },
    'uk-features': {
      id: 'uk-features',
      moduleId: 'base.visual-component-ref',
      props: { componentId: 'acme.ui-kit/feature-row' },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    },
    'uk-pricing': {
      id: 'uk-pricing',
      moduleId: 'base.container',
      props: { tag: 'section' },
      breakpointOverrides: {},
      children: ['uk-pricing-grid'],
      classIds: ['acme.ui-kit/section'],
    },
    'uk-pricing-grid': {
      id: 'uk-pricing-grid',
      moduleId: 'base.container',
      props: { tag: 'div' },
      breakpointOverrides: {},
      children: ['uk-tier-starter', 'uk-tier-pro', 'uk-tier-enterprise'],
      classIds: ['acme.ui-kit/grid-3'],
    },
    'uk-tier-starter': {
      id: 'uk-tier-starter',
      moduleId: 'acme.ui-kit.pricing-tier',
      props: {
        name: 'Starter',
        price: '$0',
        cadence: '/ month',
        features: '1 site\n5 pages\nCommunity support',
        ctaLabel: 'Get started',
        ctaHref: '#starter',
        featured: false,
      },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    },
    'uk-tier-pro': {
      id: 'uk-tier-pro',
      moduleId: 'acme.ui-kit.pricing-tier',
      props: {
        name: 'Pro',
        price: '$29',
        cadence: '/ month',
        features: 'Unlimited pages\nCustom domain\nPriority support',
        ctaLabel: 'Start trial',
        ctaHref: '#pro',
        featured: true,
      },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    },
    'uk-tier-enterprise': {
      id: 'uk-tier-enterprise',
      moduleId: 'acme.ui-kit.pricing-tier',
      props: {
        name: 'Enterprise',
        price: 'Talk to us',
        cadence: '',
        features: 'SSO\nDedicated support\nCustom SLAs',
        ctaLabel: 'Contact sales',
        ctaHref: '#contact',
        featured: false,
      },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    },
    'uk-testimonial-section': {
      id: 'uk-testimonial-section',
      moduleId: 'base.container',
      props: { tag: 'section' },
      breakpointOverrides: {},
      children: ['uk-testimonial'],
      classIds: ['acme.ui-kit/section'],
    },
    'uk-testimonial': {
      id: 'uk-testimonial',
      moduleId: 'acme.ui-kit.testimonial',
      props: {
        quote: 'Page Builder shipped us from idea to launch in a week.',
        author: 'Jamie Rivera',
        role: 'Founder, Lumen Studio',
      },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    },
    'uk-cta': {
      id: 'uk-cta',
      moduleId: 'base.visual-component-ref',
      props: { componentId: 'acme.ui-kit/cta-band' },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    },
  },
}
