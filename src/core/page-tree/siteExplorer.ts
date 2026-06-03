import { nanoid } from 'nanoid'
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import type { SiteFile } from '@core/files/schemas'
import type { Page } from './page'
import type { SiteDocument } from './siteDocument'
import type { VisualComponent } from '@core/visualComponents'
import { isHomePage } from './slugs'

export const SITE_EXPLORER_SECTION_IDS = [
  'pages',
  'templates',
  'components',
  'styles',
  'scripts',
] as const

export type SiteExplorerSectionId = (typeof SITE_EXPLORER_SECTION_IDS)[number]

const SiteExplorerFolderSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  order: Type.Number({ default: 0 }),
})

const SiteExplorerItemPlacementSchema = Type.Object({
  id: Type.String(),
  parentFolderId: Type.Optional(Type.String()),
  order: Type.Number(),
})

const SiteExplorerSectionSchema = Type.Object({
  folders: Type.Array(SiteExplorerFolderSchema),
  items: Type.Array(SiteExplorerItemPlacementSchema),
})

export const SiteExplorerOrganizationSchema = Type.Object({
  pages: SiteExplorerSectionSchema,
  templates: SiteExplorerSectionSchema,
  components: SiteExplorerSectionSchema,
  styles: SiteExplorerSectionSchema,
  scripts: SiteExplorerSectionSchema,
})

export type SiteExplorerFolder = Static<typeof SiteExplorerFolderSchema>
export type SiteExplorerItemPlacement = Static<typeof SiteExplorerItemPlacementSchema>
type SiteExplorerSection = Static<typeof SiteExplorerSectionSchema>
export type SiteExplorerOrganization = Static<typeof SiteExplorerOrganizationSchema>

type SiteExplorerRootEntry =
  | { kind: 'folder'; folder: SiteExplorerFolder; order: number }
  | { kind: 'item'; item: SiteExplorerItemPlacement; order: number }

interface SiteExplorerSources {
  pages: readonly Page[]
  visualComponents: readonly VisualComponent[]
  files: readonly SiteFile[]
}

export function createDefaultSiteExplorerOrganization(): SiteExplorerOrganization {
  return {
    pages: createEmptySection(),
    templates: createEmptySection(),
    components: createEmptySection(),
    styles: createEmptySection(),
    scripts: createEmptySection(),
  }
}

function createEmptySection(): SiteExplorerSection {
  return { folders: [], items: [] }
}

export function parseSiteExplorerOrganization(raw: unknown): SiteExplorerOrganization {
  const parsed = createDefaultSiteExplorerOrganization()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return parsed
  const record = raw as Record<string, unknown>

  for (const sectionId of SITE_EXPLORER_SECTION_IDS) {
    parsed[sectionId] = parseSection(record[sectionId])
  }

  return parsed
}

function parseSection(raw: unknown): SiteExplorerSection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createEmptySection()
  const record = raw as Record<string, unknown>
  const folders = parseFolders(record.folders)
  const folderIds = new Set(folders.map((folder) => folder.id))
  const items = parseItems(record.items, folderIds)
  return normalizeSection({ folders, items })
}

function parseFolders(raw: unknown): SiteExplorerFolder[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const folders: SiteExplorerFolder[] = []
  for (const entry of raw) {
    let folder: SiteExplorerFolder
    try {
      folder = Value.Parse(SiteExplorerFolderSchema, entry) as SiteExplorerFolder
    } catch {
      continue
    }
    const id = folder.id.trim()
    if (!id || seen.has(id) || !Number.isFinite(folder.order)) continue
    seen.add(id)
    folders.push({ id, name: folder.name.trim() || 'Folder', order: folder.order })
  }
  return folders
}

function parseItems(raw: unknown, folderIds: ReadonlySet<string>): SiteExplorerItemPlacement[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const items: SiteExplorerItemPlacement[] = []
  for (const entry of raw) {
    if (!Value.Check(SiteExplorerItemPlacementSchema, entry)) continue
    const item = Value.Decode(SiteExplorerItemPlacementSchema, entry) as SiteExplorerItemPlacement
    const id = item.id.trim()
    if (!id || seen.has(id) || !Number.isFinite(item.order)) continue
    seen.add(id)
    const parentFolderId = item.parentFolderId?.trim()
    items.push({
      id,
      ...(parentFolderId && folderIds.has(parentFolderId) ? { parentFolderId } : {}),
      order: item.order,
    })
  }
  return items
}

export function reconcileSiteExplorerOrganization(
  organization: SiteExplorerOrganization | undefined,
  sources: SiteExplorerSources,
): SiteExplorerOrganization {
  const base = parseSiteExplorerOrganization(organization)
  const pages = reconcileSection(base.pages, pageIds(sources.pages, false))
  const homePageId = sources.pages.find((page) => !page.template && isHomePage(page))?.id
  if (homePageId) pinItemAtSectionRoot(pages, homePageId)

  return {
    pages,
    templates: reconcileSection(base.templates, pageIds(sources.pages, true)),
    components: reconcileSection(base.components, sources.visualComponents.map((component) => component.id)),
    styles: reconcileSection(base.styles, fileIds(sources.files, 'style')),
    scripts: reconcileSection(base.scripts, fileIds(sources.files, 'script')),
  }
}

function pageIds(pages: readonly Page[], templates: boolean): string[] {
  return pages
    .filter((page) => Boolean(page.template) === templates)
    .map((page) => page.id)
}

function fileIds(files: readonly SiteFile[], type: 'style' | 'script'): string[] {
  return files
    .filter((file) => file.type === type && (!file.generated || file.ejected))
    .map((file) => file.id)
}

function reconcileSection(section: SiteExplorerSection, sourceIds: readonly string[]): SiteExplorerSection {
  const sourceSet = new Set(sourceIds)
  const folderIds = new Set(section.folders.map((folder) => folder.id))
  const seen = new Set<string>()
  const items: SiteExplorerItemPlacement[] = []

  for (const item of sortItems(section.items)) {
    if (!sourceSet.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    const parentFolderId = item.parentFolderId && folderIds.has(item.parentFolderId)
      ? item.parentFolderId
      : undefined
    items.push({
      id: item.id,
      ...(parentFolderId ? { parentFolderId } : {}),
      order: item.order,
    })
  }

  const reconciled = normalizeSection({ folders: section.folders, items })
  for (const id of sourceIds) {
    if (seen.has(id)) continue
    seen.add(id)
    reconciled.items.push({ id, order: nextRootOrder(reconciled) })
    normalizeSectionInPlace(reconciled)
  }

  return reconciled
}

export function createExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: SiteExplorerSectionId,
  name: string,
): string {
  const id = nanoid()
  const section = organization[sectionId]
  section.folders.push({ id, name: name.trim() || 'Folder', order: nextRootOrder(section) })
  normalizeSectionInPlace(section)
  return id
}

export function renameExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: SiteExplorerSectionId,
  folderId: string,
  name: string,
): void {
  const folder = organization[sectionId].folders.find((candidate) => candidate.id === folderId)
  if (!folder) return
  folder.name = name.trim() || 'Folder'
}

export function deleteExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: SiteExplorerSectionId,
  folderId: string,
): void {
  const section = organization[sectionId]
  const index = section.folders.findIndex((folder) => folder.id === folderId)
  if (index === -1) return
  section.folders.splice(index, 1)
  for (const item of section.items) {
    if (item.parentFolderId === folderId) delete item.parentFolderId
  }
  normalizeSectionInPlace(section)
}

export function moveExplorerFolder(
  organization: SiteExplorerOrganization,
  sectionId: SiteExplorerSectionId,
  folderId: string,
  nextIndex: number,
): void {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const folder = section.folders.find((candidate) => candidate.id === folderId)
  if (!folder) return

  const rootEntries = rootEntriesForSection(section)
    .filter((entry) => entry.kind !== 'folder' || entry.folder.id !== folderId)
  rootEntries.splice(clampIndex(nextIndex, rootEntries.length), 0, {
    kind: 'folder',
    folder,
    order: folder.order,
  })
  applyRootEntryOrder(rootEntries)
  normalizeSectionInPlace(section)
}

export function moveExplorerItem(
  organization: SiteExplorerOrganization,
  sectionId: SiteExplorerSectionId,
  itemId: string,
  parentFolderId: string | null,
  nextIndex: number,
): void {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const item = section.items.find((candidate) => candidate.id === itemId)
  if (!item) return
  const targetParentId = parentFolderId && section.folders.some((folder) => folder.id === parentFolderId)
    ? parentFolderId
    : undefined

  if (!targetParentId) {
    delete item.parentFolderId
    const rootEntries = rootEntriesForSection(section)
      .filter((entry) => entry.kind !== 'item' || entry.item.id !== itemId)
    rootEntries.splice(clampIndex(nextIndex, rootEntries.length), 0, {
      kind: 'item',
      item,
      order: item.order,
    })
    applyRootEntryOrder(rootEntries)
  } else {
    item.parentFolderId = targetParentId
    const siblings = section.items
      .filter((candidate) => candidate.id !== itemId && candidate.parentFolderId === targetParentId)
      .sort((a, b) => a.order - b.order)
    siblings.splice(clampIndex(nextIndex, siblings.length), 0, item)
    siblings.forEach((candidate, order) => {
      candidate.order = order
    })
  }
  normalizeSectionInPlace(section)
}

export function moveExplorerItems(
  organization: SiteExplorerOrganization,
  sectionId: SiteExplorerSectionId,
  itemIds: readonly string[],
  parentFolderId: string | null,
  nextIndex: number,
): void {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const selectedIds = uniqueExistingItemIds(section, itemIds)
  if (selectedIds.length === 0) return

  const targetParentId = parentFolderId && section.folders.some((folder) => folder.id === parentFolderId)
    ? parentFolderId
    : undefined
  const selected = orderedSelectedItems(section, selectedIds)

  if (!targetParentId) {
    for (const item of selected) delete item.parentFolderId
    const selectedSet = new Set(selectedIds)
    const rootEntries = rootEntriesForSection(section)
      .filter((entry) => entry.kind !== 'item' || !selectedSet.has(entry.item.id))
    rootEntries.splice(
      clampIndex(nextIndex, rootEntries.length),
      0,
      ...selected.map((item) => ({
        kind: 'item' as const,
        item,
        order: item.order,
      })),
    )
    applyRootEntryOrder(rootEntries)
  } else {
    for (const item of selected) item.parentFolderId = targetParentId
    const selectedSet = new Set(selectedIds)
    const siblings = section.items
      .filter((candidate) => candidate.parentFolderId === targetParentId && !selectedSet.has(candidate.id))
      .sort((a, b) => a.order - b.order)
    siblings.splice(clampIndex(nextIndex, siblings.length), 0, ...selected)
    siblings.forEach((candidate, order) => {
      candidate.order = order
    })
  }

  normalizeSectionInPlace(section)
}

export function wrapExplorerItemsInFolder(
  organization: SiteExplorerOrganization,
  sectionId: SiteExplorerSectionId,
  itemIds: readonly string[],
  name: string,
): string | null {
  const section = organization[sectionId]
  normalizeSectionInPlace(section)
  const selectedIds = uniqueExistingItemIds(section, itemIds)
  if (selectedIds.length === 0) return null

  const selected = orderedSelectedItems(section, selectedIds)
  const selectedSet = new Set(selectedIds)
  const rootEntries = rootEntriesForSection(section)
  const firstSelectedRootIndex = rootEntries.findIndex((entry) => {
    if (entry.kind === 'item') return selectedSet.has(entry.item.id)
    return section.items.some((item) => item.parentFolderId === entry.folder.id && selectedSet.has(item.id))
  })
  const insertIndex = rootEntries
    .slice(0, firstSelectedRootIndex === -1 ? rootEntries.length : firstSelectedRootIndex)
    .filter((entry) => entry.kind !== 'item' || !selectedSet.has(entry.item.id))
    .length

  const folderId = nanoid()
  const folder: SiteExplorerFolder = { id: folderId, name: name.trim() || 'Folder', order: 0 }
  section.folders.push(folder)

  const nextRootEntries = rootEntries
    .filter((entry) => entry.kind !== 'item' || !selectedSet.has(entry.item.id))
  nextRootEntries.splice(clampIndex(insertIndex, nextRootEntries.length), 0, {
    kind: 'folder',
    folder,
    order: folder.order,
  })
  applyRootEntryOrder(nextRootEntries)

  selected.forEach((item, order) => {
    item.parentFolderId = folderId
    item.order = order
  })
  normalizeSectionInPlace(section)
  return folderId
}

function normalizeSection(section: SiteExplorerSection): SiteExplorerSection {
  const folders = section.folders.map((folder) => ({
    id: folder.id,
    name: folder.name.trim() || 'Folder',
    order: Number.isFinite(folder.order) ? folder.order : 0,
  }))
  const folderIds = new Set(folders.map((folder) => folder.id))
  const items = section.items.map((item) => ({
    id: item.id,
    ...(item.parentFolderId && folderIds.has(item.parentFolderId) ? { parentFolderId: item.parentFolderId } : {}),
    order: Number.isFinite(item.order) ? item.order : 0,
  }))

  const rootEntries = [
    ...folders.map((folder) => ({
      kind: 'folder' as const,
      folder,
      order: folder.order,
    })),
    ...items
      .filter((item) => !item.parentFolderId)
      .map((item) => ({
        kind: 'item' as const,
        item,
        order: item.order,
      })),
  ]
  applyRootEntryOrder(sortRootEntries(rootEntries))

  const normalizedItems: SiteExplorerItemPlacement[] = []
  for (const entry of rootEntriesForSection({ folders, items })) {
    if (entry.kind === 'item') {
      normalizedItems.push({ id: entry.item.id, order: entry.item.order })
      continue
    }

    const children = items
      .filter((item) => item.parentFolderId === entry.folder.id)
      .sort((a, b) => a.order - b.order)
    children.forEach((item, order) => {
      normalizedItems.push({
        id: item.id,
        parentFolderId: entry.folder.id,
        order,
      })
    })
  }

  return {
    folders: [...folders].sort((a, b) => a.order - b.order),
    items: normalizedItems,
  }
}

function normalizeSectionInPlace(section: SiteExplorerSection): void {
  const normalized = normalizeSection(section)
  section.folders = normalized.folders
  section.items = normalized.items
}

function pinItemAtSectionRoot(section: SiteExplorerSection, itemId: string): void {
  normalizeSectionInPlace(section)
  const item = section.items.find((candidate) => candidate.id === itemId)
  if (!item) return
  delete item.parentFolderId
  const rootEntries = rootEntriesForSection(section)
    .filter((entry) => entry.kind !== 'item' || entry.item.id !== itemId)
  rootEntries.unshift({ kind: 'item', item, order: 0 })
  applyRootEntryOrder(rootEntries)
  normalizeSectionInPlace(section)
}

function sortItems(items: readonly SiteExplorerItemPlacement[]): SiteExplorerItemPlacement[] {
  return [...items].sort((a, b) => a.order - b.order)
}

function rootEntriesForSection(section: SiteExplorerSection): SiteExplorerRootEntry[] {
  return sortRootEntries([
    ...section.folders.map((folder) => ({
      kind: 'folder' as const,
      folder,
      order: folder.order,
    })),
    ...section.items
      .filter((item) => !item.parentFolderId)
      .map((item) => ({
        kind: 'item' as const,
        item,
        order: item.order,
      })),
  ])
}

function sortRootEntries(entries: readonly SiteExplorerRootEntry[]): SiteExplorerRootEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.order - b.entry.order || a.index - b.index)
    .map(({ entry }) => entry)
}

function applyRootEntryOrder(entries: readonly SiteExplorerRootEntry[]): void {
  entries.forEach((entry, order) => {
    if (entry.kind === 'folder') {
      entry.folder.order = order
    } else {
      entry.item.order = order
    }
  })
}

function nextRootOrder(section: SiteExplorerSection): number {
  return rootEntriesForSection(section).length
}

function clampIndex(index: number, max: number): number {
  return Math.max(0, Math.min(index, max))
}

function uniqueExistingItemIds(
  section: SiteExplorerSection,
  itemIds: readonly string[],
): string[] {
  const existingIds = new Set(section.items.map((item) => item.id))
  const seen = new Set<string>()
  const selectedIds: string[] = []
  for (const id of itemIds) {
    if (!existingIds.has(id) || seen.has(id)) continue
    seen.add(id)
    selectedIds.push(id)
  }
  return selectedIds
}

function orderedSelectedItems(
  section: SiteExplorerSection,
  itemIds: readonly string[],
): SiteExplorerItemPlacement[] {
  const selectedIds = new Set(itemIds)
  return section.items.filter((item) => selectedIds.has(item.id))
}

export function reconcileSiteExplorerInPlace(site: SiteDocument): void {
  site.explorer = reconcileSiteExplorerOrganization(site.explorer, site)
}
