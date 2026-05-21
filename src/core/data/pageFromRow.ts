/**
 * Bidirectional adapter between `Page` (in-memory type) and `DataRow` / `DataRowCells`
 * (the unified storage layer).
 *
 * Pages are stored in `data_rows` where `table_id = 'pages'`. The `pages`
 * system table fields map to Page fields as follows:
 *
 *   cells.title              → page.title
 *   cells.slug (= row.slug)  → page.slug (denormalized on data_rows.slug)
 *   cells.body               → { nodes, rootNodeId } (pageTree field)
 *   cells.templateEnabled    → page.template.enabled
 *   cells.templateContext    → page.template.context
 *   cells.templateTableSlug  → page.template.tableSlug
 *   cells.templatePriority   → page.template.priority
 *   cells.templateConditions → page.template.conditions (stored as JSON array)
 *
 * Ownership is mapped between DataRow user-id columns and Page optional fields:
 *   row.authorUserId        → page.ownerUserId
 *   row.createdByUserId     → page.createdByUserId
 *   row.updatedByUserId     → page.updatedByUserId
 */

import type { Page, PageNode, PageTemplateConfig } from '@core/page-tree'
import type { DataRow, DataRowCells } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// DataRow → Page
// ---------------------------------------------------------------------------

/**
 * Reconstruct a `Page` from a `DataRow` (table_id = 'pages').
 *
 * The conversion is best-effort: missing or malformed cells fall back to safe
 * defaults (empty title, empty nodes, etc.) so a corrupt row doesn't prevent
 * loading the rest of the site. Structural validation (slug syntax, rootNodeId
 * presence) is enforced by `validatePages` in `@core/persistence/validate`.
 */
export function pageFromRow(row: DataRow): Page {
  const cells = row.cells

  // body field: NodeTree<PageNode>  { nodes: {...}, rootNodeId: '...' }
  let nodes: Record<string, PageNode> = {}
  let rootNodeId = ''
  const body = cells.body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>
    if (b.nodes && typeof b.nodes === 'object' && !Array.isArray(b.nodes)) {
      nodes = b.nodes as Record<string, PageNode>
    }
    if (typeof b.rootNodeId === 'string') {
      rootNodeId = b.rootNodeId
    }
  }

  const title = typeof cells.title === 'string' ? cells.title : ''

  // Template reconstruction
  const template = readTemplateFromCells(cells)

  return {
    id: row.id,
    slug: row.slug,
    title,
    nodes,
    rootNodeId,
    ...(template !== null ? { template } : {}),
    ownerUserId: row.authorUserId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
  }
}

function readTemplateFromCells(cells: DataRowCells): PageTemplateConfig | null {
  if (cells.templateEnabled !== true) return null
  if (cells.templateContext !== 'entry') return null
  if (typeof cells.templateTableSlug !== 'string' || cells.templateTableSlug.length === 0) return null

  const priority = typeof cells.templatePriority === 'number' && isFinite(cells.templatePriority)
    ? cells.templatePriority
    : 0

  // templateConditions stored as a JSON array in the cells JSONB column
  const rawConditions = Array.isArray(cells.templateConditions) ? cells.templateConditions : []
  const conditions: PageTemplateConfig['conditions'] = rawConditions.flatMap((c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return []
    const entry = c as Record<string, unknown>
    if (typeof entry.id !== 'string') return []
    if (typeof entry.field !== 'string') return []
    if (entry.operator !== 'equals') return []
    if (typeof entry.value !== 'string') return []
    return [{ id: entry.id, field: entry.field, operator: 'equals' as const, value: entry.value }]
  })

  return {
    enabled: true,
    context: 'entry',
    tableSlug: cells.templateTableSlug as string,
    priority,
    conditions,
  }
}

// ---------------------------------------------------------------------------
// Page → DataRowCells
// ---------------------------------------------------------------------------

/**
 * Convert a `Page` to the `DataRowCells` shape for storage in `data_rows`.
 *
 * The `slug` field is returned in cells AND should also be passed as the
 * `slug` parameter to `createDataRow` / `saveDataRowDraft` (the denormalized
 * column on `data_rows`).
 */
export function pageToCells(page: Page): DataRowCells {
  const cells: DataRowCells = {
    title: page.title,
    slug: page.slug,
    body: {
      nodes: page.nodes,
      rootNodeId: page.rootNodeId,
    },
  }

  if (page.template) {
    cells.templateEnabled = true
    cells.templateContext = page.template.context
    cells.templateTableSlug = page.template.tableSlug
    cells.templatePriority = page.template.priority
    cells.templateConditions = page.template.conditions
  }

  return cells
}
