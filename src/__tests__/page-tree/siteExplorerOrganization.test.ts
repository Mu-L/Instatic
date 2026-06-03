import { describe, expect, it } from 'bun:test'
import type { VisualComponent } from '@core/visualComponents'
import {
  createDefaultSiteExplorerOrganization,
  createExplorerFolder,
  moveExplorerItem,
  moveExplorerItems,
  parseSiteExplorerOrganization,
  reconcileSiteExplorerOrganization,
  wrapExplorerItemsInFolder,
} from '@core/page-tree'
import { makePage, makeSite } from '../fixtures'

function makeVisualComponent(id: string, name: string): VisualComponent {
  const rootNodeId = `${id}-root`
  return {
    id,
    name,
    tree: {
      rootNodeId,
      nodes: {
        [rootNodeId]: {
          id: rootNodeId,
          moduleId: 'base.body',
          props: {},
          children: [],
          breakpointOverrides: {},
          classIds: [],
        },
      },
    },
    params: [],
    classIds: [],
    createdAt: 1,
  }
}

describe('site explorer organization', () => {
  it('parses missing explorer data to empty sections', () => {
    expect(parseSiteExplorerOrganization(undefined).pages).toEqual({
      folders: [],
      items: [],
    })
  })

  it('reconciles page template component style and script placements from current site data', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index', title: 'Home' }),
        makePage({ id: 'pricing', slug: 'pricing', title: 'Pricing' }),
        makePage({
          id: 'post-template',
          slug: 'post-template',
          title: 'Post Template',
          template: {
            enabled: true,
            context: 'entry',
            tableSlug: 'posts',
            priority: 0,
            conditions: [],
          },
        }),
      ],
      visualComponents: [makeVisualComponent('hero', 'Hero')],
      files: [
        {
          id: 'theme',
          path: 'src/styles/theme.css',
          type: 'style',
          content: '',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'analytics',
          path: 'src/scripts/analytics.ts',
          type: 'script',
          content: '',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'asset',
          path: 'public/logo.svg',
          type: 'asset',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    const explorer = reconcileSiteExplorerOrganization(
      createDefaultSiteExplorerOrganization(),
      site,
    )

    expect(explorer.pages.items.map((item) => item.id)).toEqual(['home', 'pricing'])
    expect(explorer.templates.items.map((item) => item.id)).toEqual(['post-template'])
    expect(explorer.components.items.map((item) => item.id)).toEqual(['hero'])
    expect(explorer.styles.items.map((item) => item.id)).toEqual(['theme'])
    expect(explorer.scripts.items.map((item) => item.id)).toEqual(['analytics'])
  })

  it('moves items into folders without changing site item arrays', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'pricing', slug: 'pricing' }),
      ],
    })
    const explorer = reconcileSiteExplorerOrganization(
      createDefaultSiteExplorerOrganization(),
      site,
    )

    const folderId = createExplorerFolder(explorer, 'pages', 'Marketing')
    moveExplorerItem(explorer, 'pages', 'pricing', folderId, 0)

    expect(explorer.pages.items.find((item) => item.id === 'pricing')?.parentFolderId).toBe(folderId)
    expect(site.pages.map((page) => page.id)).toEqual(['home', 'pricing'])
  })

  it('wraps selected root items in a new folder at the first selected item position', () => {
    const explorer = createDefaultSiteExplorerOrganization()
    explorer.pages = {
      folders: [{ id: 'folder-1', name: 'Existing', order: 2 }],
      items: [
        { id: 'home', order: 0 },
        { id: 'pricing', order: 1 },
        { id: 'about', order: 3 },
      ],
    }

    const folderId = wrapExplorerItemsInFolder(explorer, 'pages', ['pricing', 'about'], 'Marketing')

    expect(typeof folderId).toBe('string')
    expect(explorer.pages.folders).toEqual([
      { id: folderId, name: 'Marketing', order: 1 },
      { id: 'folder-1', name: 'Existing', order: 2 },
    ])
    expect(explorer.pages.items).toEqual([
      { id: 'home', order: 0 },
      { id: 'pricing', parentFolderId: folderId, order: 0 },
      { id: 'about', parentFolderId: folderId, order: 1 },
    ])
  })

  it('moves selected items as one ordered group', () => {
    const explorer = createDefaultSiteExplorerOrganization()
    const folderId = createExplorerFolder(explorer, 'pages', 'Marketing')
    explorer.pages.folders[0].order = 4
    explorer.pages.items = [
      { id: 'home', order: 0 },
      { id: 'pricing', order: 1 },
      { id: 'about', order: 2 },
      { id: 'contact', order: 3 },
    ]

    moveExplorerItems(explorer, 'pages', ['about', 'pricing'], folderId, 0)

    expect(explorer.pages.items).toEqual([
      { id: 'home', order: 0 },
      { id: 'contact', order: 1 },
      { id: 'pricing', parentFolderId: folderId, order: 0 },
      { id: 'about', parentFolderId: folderId, order: 1 },
    ])
  })

  it('moves root items before and after root folders in the same section order', () => {
    const explorer = createDefaultSiteExplorerOrganization()
    explorer.components = {
      folders: [{ id: 'folder-1', name: 'Marketing', order: 0 }],
      items: [
        { id: 'hero', parentFolderId: 'folder-1', order: 0 },
        { id: 'footer', order: 1 },
      ],
    }

    moveExplorerItem(explorer, 'components', 'hero', null, 0)

    expect(explorer.components.folders).toEqual([
      { id: 'folder-1', name: 'Marketing', order: 1 },
    ])
    expect(explorer.components.items).toEqual([
      { id: 'hero', order: 0 },
      { id: 'footer', order: 2 },
    ])

    moveExplorerItem(explorer, 'components', 'hero', null, 2)

    expect(explorer.components.folders).toEqual([
      { id: 'folder-1', name: 'Marketing', order: 0 },
    ])
    expect(explorer.components.items).toEqual([
      { id: 'footer', order: 1 },
      { id: 'hero', order: 2 },
    ])
  })

  it('drops stale placements and appends missing items in current item order', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'pricing', slug: 'pricing' }),
        makePage({ id: 'about', slug: 'about' }),
      ],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          folders: [{ id: 'folder-1', name: 'Marketing', order: 0 }],
          items: [
            { id: 'missing', order: 0 },
            { id: 'about', parentFolderId: 'folder-1', order: 1 },
          ],
        },
      },
    })

    const explorer = reconcileSiteExplorerOrganization(site.explorer, site)

    expect(explorer.pages.items).toEqual([
      { id: 'home', order: 0 },
      { id: 'about', parentFolderId: 'folder-1', order: 0 },
      { id: 'pricing', order: 2 },
    ])
  })

  it('pins the homepage at the page section root during reconciliation', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'pricing', slug: 'pricing' }),
        makePage({ id: 'home', slug: 'index' }),
      ],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          folders: [{ id: 'folder-1', name: 'Marketing', order: 0 }],
          items: [
            { id: 'pricing', order: 0 },
            { id: 'home', parentFolderId: 'folder-1', order: 1 },
          ],
        },
      },
    })

    const explorer = reconcileSiteExplorerOrganization(site.explorer, site)

    expect(explorer.pages.items).toEqual([
      { id: 'home', order: 0 },
      { id: 'pricing', order: 2 },
    ])
  })
})
