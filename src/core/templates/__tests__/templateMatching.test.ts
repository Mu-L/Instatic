import { describe, expect, it } from 'bun:test'
import { resolveTemplateChain, isTemplatePage, primaryTemplateTableSlug } from '../templateMatching'
import type { Page, SiteDocument } from '@core/page-tree'

const tpl = (id: string, target: Page['template'], priority = 0): Page => ({
  id, slug: id, title: id, nodes: {}, rootNodeId: '',
  template: { ...(target as object), priority } as Page['template'],
})
const site = (pages: Page[]): SiteDocument => ({ id: 's', pages } as unknown as SiteDocument)

const everywhere = (id: string, p = 0) => tpl(id, { enabled: true, target: { kind: 'everywhere' } } as never, p)
const forPosts = (id: string, p = 0) => tpl(id, { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] } } as never, p)

describe('resolveTemplateChain', () => {
  it('returns [] for a page route with no everywhere template', () => {
    expect(resolveTemplateChain(site([forPosts('e')]), { kind: 'page' })).toEqual([])
  })

  it('wraps a page route in the everywhere layout', () => {
    const s = site([everywhere('layout'), forPosts('entry')])
    expect(resolveTemplateChain(s, { kind: 'page' }).map((p) => p.id)).toEqual(['layout'])
  })

  it('nests everywhere outside the post entry template', () => {
    const s = site([forPosts('entry'), everywhere('layout')])
    expect(resolveTemplateChain(s, { kind: 'entry', tableSlug: 'posts' }).map((p) => p.id)).toEqual(['layout', 'entry'])
  })

  it('picks the highest-priority template per breadth level', () => {
    const s = site([everywhere('lowL', 1), everywhere('highL', 9), forPosts('lowE', 1), forPosts('highE', 9)])
    expect(resolveTemplateChain(s, { kind: 'entry', tableSlug: 'posts' }).map((p) => p.id)).toEqual(['highL', 'highE'])
  })

  it('does not match a post entry template for a different table', () => {
    const s = site([forPosts('entry')])
    expect(resolveTemplateChain(s, { kind: 'entry', tableSlug: 'authors' })).toEqual([])
  })

  it('isTemplatePage flags template-configured pages', () => {
    expect(isTemplatePage(everywhere('x'))).toBe(true)
    expect(isTemplatePage(tpl('plain', undefined as never))).toBe(false)
  })
})

describe('primaryTemplateTableSlug', () => {
  it('returns the first targeted slug for a postTypes template', () => {
    const s = tpl('e', { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts', 'news'] } } as never, 0)
    expect(primaryTemplateTableSlug(s)).toBe('posts')
  })
  it('returns null for an everywhere layout', () => {
    expect(primaryTemplateTableSlug(everywhere('x'))).toBeNull()
  })
  it('returns null for a non-template page', () => {
    expect(primaryTemplateTableSlug(tpl('plain', undefined as never))).toBeNull()
  })
})
