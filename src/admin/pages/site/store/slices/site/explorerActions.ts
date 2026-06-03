import {
  createExplorerFolder as createExplorerFolderInOrganization,
  createUniquePageSlug,
  deleteExplorerFolder as deleteExplorerFolderInOrganization,
  findHomePage,
  isHomePage,
  moveExplorerFolder as moveExplorerFolderInOrganization,
  moveExplorerItem as moveExplorerItemInOrganization,
  moveExplorerItems as moveExplorerItemsInOrganization,
  reconcileSiteExplorerInPlace,
  renameExplorerFolder as renameExplorerFolderInOrganization,
  renamePage as renamePageInSite,
  wrapExplorerItemsInFolder as wrapExplorerItemsInFolderInOrganization,
} from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'

export type ExplorerActions = Pick<
  SiteSlice,
  | 'createExplorerFolder'
  | 'renameExplorerFolder'
  | 'deleteExplorerFolder'
  | 'moveExplorerFolder'
  | 'moveExplorerItem'
  | 'moveExplorerItems'
  | 'wrapExplorerItemsInFolder'
  | 'setPageAsHomepage'
>

export function createExplorerActions({ mutateSite }: SiteSliceHelpers): ExplorerActions {
  return {
    createExplorerFolder: (sectionId, name) => {
      let folderId = ''
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        folderId = createExplorerFolderInOrganization(site.explorer, sectionId, name)
        return true
      })
      return folderId
    },

    renameExplorerFolder: (sectionId, folderId, name) => {
      mutateSite((site) => {
        const folder = site.explorer[sectionId].folders.find((candidate) => candidate.id === folderId)
        if (!folder) return false
        const nextName = name.trim() || 'Folder'
        if (folder.name === nextName) return false
        renameExplorerFolderInOrganization(site.explorer, sectionId, folderId, nextName)
        return true
      })
    },

    deleteExplorerFolder: (sectionId, folderId) => {
      mutateSite((site) => {
        if (!site.explorer[sectionId].folders.some((folder) => folder.id === folderId)) return false
        deleteExplorerFolderInOrganization(site.explorer, sectionId, folderId)
        return true
      })
    },

    moveExplorerFolder: (sectionId, folderId, nextIndex) => {
      mutateSite((site) => {
        const folders = site.explorer[sectionId].folders
        const currentIndex = folders.findIndex((folder) => folder.id === folderId)
        if (currentIndex === -1) return false
        moveExplorerFolderInOrganization(site.explorer, sectionId, folderId, nextIndex)
        return true
      })
    },

    moveExplorerItem: (sectionId, itemId, parentFolderId, nextIndex) => {
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        const item = site.explorer[sectionId].items.find((candidate) => candidate.id === itemId)
        if (!item) return false
        if (sectionId === 'pages' && site.pages.some((page) => page.id === itemId && isHomePage(page))) return false
        moveExplorerItemInOrganization(site.explorer, sectionId, itemId, parentFolderId, nextIndex)
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },

    moveExplorerItems: (sectionId, itemIds, parentFolderId, nextIndex) => {
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        const movableIds = itemIds.filter(
          (itemId) => !(sectionId === 'pages' && site.pages.some((page) => page.id === itemId && isHomePage(page))),
        )
        if (movableIds.length === 0) return false
        moveExplorerItemsInOrganization(site.explorer, sectionId, movableIds, parentFolderId, nextIndex)
        reconcileSiteExplorerInPlace(site)
        return true
      })
    },

    wrapExplorerItemsInFolder: (sectionId, itemIds, name) => {
      let folderId: string | null = null
      mutateSite((site) => {
        reconcileSiteExplorerInPlace(site)
        const wrappableIds = itemIds.filter(
          (itemId) => !(sectionId === 'pages' && site.pages.some((page) => page.id === itemId && isHomePage(page))),
        )
        if (wrappableIds.length === 0) return false
        folderId = wrapExplorerItemsInFolderInOrganization(site.explorer, sectionId, wrappableIds, name)
        if (!folderId) return false
        reconcileSiteExplorerInPlace(site)
        return true
      })
      return folderId
    },

    setPageAsHomepage: (pageId) => {
      mutateSite((site) => {
        const target = site.pages.find((page) => page.id === pageId)
        if (!target) return false
        const currentHome = findHomePage(site.pages)
        if (currentHome?.id === target.id) return false

        if (currentHome) {
          const slugSource = site.pages.filter((page) => page.id !== currentHome.id && page.id !== target.id)
          currentHome.slug = createUniquePageSlug(currentHome.title, slugSource)
        }
        renamePageInSite(site, target.id, target.title, 'index')
        reconcileSiteExplorerInPlace(site)
        const placement = site.explorer.pages.items.find((item) => item.id === target.id)
        if (placement) delete placement.parentFolderId
        return true
      })
    },
  }
}
