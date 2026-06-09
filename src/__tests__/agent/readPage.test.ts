import { describe, expect, it, beforeAll } from 'bun:test'
import type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'
import { classKindSelector } from '@core/page-tree'
import { makePage, makeSite } from '../publisher/helpers'

let renderAgentPage: typeof import('../../../server/ai/tools/site/render')['renderAgentPage']

beforeAll(async () => {
  await import('../../../src/modules/base') // register base modules in this process
  ;({ renderAgentPage } = await import('../../../server/ai/tools/site/render'))
})

function snap(): SiteAgentSnapshot {
  const page = makePage({
    root: { moduleId: 'base.body', children: ['t'] },
    t: { moduleId: 'base.text', props: { text: 'Hi', tag: 'h1' } },
  })
  const site = makeSite({
    pages: [page],
    styleRules: {
      r1: { id: 'r1', name: 'heading', kind: 'ambient', selector: 'h1', order: 0, styles: { color: 'red' } },
    },
  })
  return { page, site, selectedNodeId: null, activeBreakpointId: 'desktop' }
}

describe('renderAgentPage', () => {
  it('returns an annotated body with uid attributes and a <style> css bundle', () => {
    const { html, css } = renderAgentPage(snap())
    expect(html).toContain('uid="t"') // node addressable
    expect(html).toContain('Hi') // content present
    expect(html).not.toContain('<head>') // body only, not full document
    expect(css.startsWith('<style>')).toBe(true)
    expect(css).toContain('</style>')
  })

  it('omits ambient CSS selectors that cannot apply to the active page class tokens', () => {
    const heroClass = {
      id: 'hero',
      name: 'hero',
      kind: 'class' as const,
      selector: classKindSelector('hero'),
      order: 0,
      styles: { color: 'green' },
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const titleClass = {
      id: 'title',
      name: 'title',
      kind: 'class' as const,
      selector: classKindSelector('title'),
      order: 1,
      styles: {},
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const page = makePage({
      root: { moduleId: 'base.body', children: ['heroNode'] },
      heroNode: { moduleId: 'base.container', classIds: ['hero'], children: ['titleNode'] },
      titleNode: { moduleId: 'base.text', classIds: ['title'], props: { text: 'Hi', tag: 'h1' } },
    })
    const site = makeSite({
      pages: [page],
      styleRules: {
        hero: heroClass,
        title: titleClass,
        relevant: {
          id: 'relevant',
          name: '.hero .title',
          kind: 'ambient',
          selector: '.hero .title',
          order: 2,
          styles: { letterSpacing: '1px' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
        globalElement: {
          id: 'globalElement',
          name: 'h1',
          kind: 'ambient',
          selector: 'h1',
          order: 3,
          styles: { fontWeight: '700' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
        unrelated: {
          id: 'unrelated',
          name: '.pricing-card .price',
          kind: 'ambient',
          selector: '.pricing-card .price',
          order: 4,
          styles: { color: 'red' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
        partlyUnrelated: {
          id: 'partlyUnrelated',
          name: '.hero .missing',
          kind: 'ambient',
          selector: '.hero .missing',
          order: 5,
          styles: { color: 'orange' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
      },
    })

    const { css } = renderAgentPage({
      page,
      site,
      selectedNodeId: null,
      activeBreakpointId: 'desktop',
    })

    expect(css).toContain('.hero {')
    expect(css).toContain('.hero .title {')
    expect(css).toContain('h1 {')
    expect(css).not.toContain('.pricing-card .price')
    expect(css).not.toContain('.hero .missing')
  })

  it('keeps font token variables but omits browser-only font-face blocks', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['t'] },
      t: { moduleId: 'base.text', props: { text: 'Hi', tag: 'h1' } },
    })
    const site = makeSite({
      pages: [page],
      settings: {
        ...makeSite().settings,
        fonts: {
          items: [{
            id: 'font-1',
            source: 'custom',
            family: 'Example Sans',
            variants: ['400'],
            subsets: ['latin'],
            files: [{
              path: '/uploads/example.woff2',
              format: 'woff2',
              variant: '400',
            }],
            createdAt: 0,
            updatedAt: 0,
          }],
          tokens: [{
            id: 'token-1',
            name: 'Heading',
            variable: 'font-heading',
            familyId: 'font-1',
            fallback: 'sans-serif',
            order: 0,
            createdAt: 0,
            updatedAt: 0,
          }],
        },
      },
    })

    const { css } = renderAgentPage({
      page,
      site,
      selectedNodeId: null,
      activeBreakpointId: 'desktop',
    })

    expect(css).toContain('--font-heading:')
    expect(css).toContain('"Example Sans", sans-serif')
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain('/uploads/example.woff2')
  })
})

describe('catalog derivations', () => {
  it('describes modules from the registry (base.text present, base.body excluded)', async () => {
    const { describeAgentModules } = await import('../../../server/ai/tools/site/render')
    const mods = describeAgentModules()
    const ids = mods.map((m) => m.id)
    expect(ids).toContain('base.text')
    expect(ids).not.toContain('base.body')
  })

  it('describes tokens from site.settings', async () => {
    const { describeAgentTokens } = await import('../../../server/ai/tools/site/render')
    const tokens = describeAgentTokens(snap().site)
    expect(tokens).toHaveProperty('colors')
    expect(tokens).toHaveProperty('fonts')
  })

  it('filterTokenFamily narrows to one family', async () => {
    const { describeAgentTokens, filterTokenFamily } = await import(
      '../../../server/ai/tools/site/render'
    )
    const tokens = describeAgentTokens(snap().site)
    const onlyColors = filterTokenFamily(tokens, 'colors')
    expect(onlyColors.colors).toBe(tokens.colors)
    expect(onlyColors.typography).toEqual([])
    expect(onlyColors.spacing).toEqual([])
    expect(onlyColors.fonts).toEqual([])
  })
})
