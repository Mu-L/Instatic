/**
 * CMS content handlers — implements every `cms.content.*` api-call.
 *
 * The handlers expose the host's content tables (`data_tables` + `data_rows`)
 * to plugins through a permissioned, per-table-allowlisted surface. Each
 * handler:
 *
 *   1. Calls `assertHostPluginPermission` — kernel-of-correctness for the
 *      `cms.content.*` permission family.
 *   2. Calls `assertContentTableAccess` — enforces the manifest's
 *      `contentAccess[]` allowlist for the targeted table + mode.
 *   3. Delegates to a repository function in `server/repositories/data/`.
 *   4. Emits the matching `content.entry.*` hook event so plugins can react.
 *   5. Replies via `replyApiOk` / lets the dispatcher's try/catch reply
 *      `replyApiError` on throw.
 *
 * Pre-release rule (CLAUDE.md): no backward compatibility. The legacy
 * `cms.pages.*` surface is deleted in this same change set.
 */

import type {
  ContentEntriesCreateApiCall,
  ContentEntriesCreateManyApiCall,
  ContentEntriesDeleteApiCall,
  ContentEntriesDeleteManyApiCall,
  ContentEntriesGetApiCall,
  ContentEntriesGetBySlugApiCall,
  ContentEntriesListApiCall,
  ContentEntriesMoveTableApiCall,
  ContentEntriesPublishApiCall,
  ContentEntriesUpdateApiCall,
  ContentEntriesUpdateManyApiCall,
  ContentRepublishAllApiCall,
  ContentSearchApiCall,
  ContentSnapshotApiCall,
  ContentTablesCreateApiCall,
  ContentTablesGetApiCall,
  ContentTablesListApiCall,
  ContentTreeMutateApiCall,
  ContentTreeReadApiCall,
  ContentTreeReplaceApiCall,
} from '../../protocol/apiCallSchema'
import type {
  ContentEntry,
  ContentTableSchema as ContentTableSchemaShape,
  ContentTableSummary,
  PublishedSnapshot,
} from '@core/plugin-sdk/contentSchemas'
import type { DataField, DataRow, DataTable } from '@core/data/schemas'
import type { NodeTree, PageNode } from '@core/page-tree'
import { applyTreeOperation } from '@core/page-tree'
import { hookBus } from '@core/plugins/hookBus'
import {
  listDataTables,
  listDataTablesWithCounts,
  getDataTable,
  createDataTable,
  listDataRowsWithFilter,
  getDataRow,
  getDataRowBySlug,
  searchDataRows,
  createDataRow,
  createDataRowMany,
  saveDataRowDraft,
  saveDataRowDraftMany,
  softDeleteDataRow,
  softDeleteDataRowMany,
  updateDataRowTable,
  scheduleDataRowPublish,
  publishDataRow,
} from '../../../repositories/data'
import { republishAllPages } from '../../../publish/republish'
import type { DbClient } from '../../../db/client'
import {
  assertContentTableAccess,
  assertHostPluginPermission,
} from '../registry'
import { replyApiOk } from '../workerPool'
import type { HostPluginRecord } from '../types'

// ---------------------------------------------------------------------------
// Projection helpers — DB → wire shapes
// ---------------------------------------------------------------------------

/**
 * Project the host's full `DataField` union onto the narrowed
 * `PluginContentField` projection (see `types/content.ts`). Drops the
 * recursive `fieldSchema` type and reduces `relation` / `pageTree` to
 * marker shapes the plugin can introspect.
 *
 * `tableSlugById` maps the host's internal `targetTableId` to the
 * public-facing slug so the plugin boundary never leaks DB ids.
 */
function projectFields(
  fields: DataField[],
  tableSlugById: Map<string, string>,
): ContentTableSchemaShape['fields'] {
  const out: ContentTableSchemaShape['fields'] = []
  for (const f of fields) {
    switch (f.type) {
      case 'text':
      case 'longText':
      case 'richText':
      case 'number':
        out.push({ type: f.type, id: f.id, label: f.label, required: f.required })
        break
      case 'boolean':
      case 'date':
      case 'dateTime':
      case 'url':
      case 'email':
      case 'media':
        out.push({ type: f.type, id: f.id, label: f.label })
        break
      case 'select':
      case 'multiSelect':
        out.push({
          type: f.type,
          id: f.id,
          label: f.label,
          options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
        })
        break
      case 'relation':
        out.push({
          type: 'relation',
          id: f.id,
          label: f.label,
          targetTableSlug: tableSlugById.get(f.targetTableId) ?? '',
        })
        break
      case 'pageTree':
        out.push({ type: 'pageTree', id: f.id, label: f.label })
        break
      case 'fieldSchema':
        // Intentionally omitted from the v1 projection — too rich/recursive
        // for the JSON RPC boundary.
        break
    }
  }
  return out
}

function tableSummary(
  table: DataTable,
  rowCount: number,
): ContentTableSummary {
  return {
    slug: table.slug,
    name: table.name,
    kind: table.kind,
    routeBase: table.routeBase,
    system: table.system,
    primaryFieldId: table.primaryFieldId,
    fieldCount: table.fields.length,
    rowCount,
  }
}

function tableSchema(
  table: DataTable,
  rowCount: number,
  tableSlugById: Map<string, string>,
): ContentTableSchemaShape {
  return {
    ...tableSummary(table, rowCount),
    singularLabel: table.singularLabel,
    pluralLabel: table.pluralLabel,
    fields: projectFields(table.fields, tableSlugById),
  }
}

async function buildTableSlugLookup(db: DbClient): Promise<Map<string, string>> {
  const tables = await listDataTables(db)
  return new Map(tables.map((t) => [t.id, t.slug]))
}

function rowToEntry(row: DataRow, tableSlug: string): ContentEntry {
  return {
    id: row.id,
    tableSlug,
    slug: row.slug,
    status: row.status,
    cells: row.cells,
    authorUserId: row.authorUserId,
    pluginActorId: (row as { pluginActorId?: string | null }).pluginActorId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    scheduledPublishAt: row.scheduledPublishAt,
  }
}

async function resolveTableBySlug(
  db: DbClient,
  slug: string,
): Promise<DataTable> {
  const all = await listDataTables(db)
  const found = all.find((t) => t.slug === slug)
  if (!found) throw new Error(`Content table "${slug}" not found`)
  return found
}

/**
 * Compute the denormalized slug for a row. Mirrors what the host's CMS
 * handlers do at the boundary: prefer `cells.slug` when the table has a
 * slug field; fall back to an empty string for tables without one.
 */
function denormalizeSlug(table: DataTable, cells: Record<string, unknown>): string {
  const hasSlugField = table.fields.some((f) => f.id === 'slug')
  if (!hasSlugField) return ''
  const value = cells['slug']
  return typeof value === 'string' ? value : ''
}

// ---------------------------------------------------------------------------
// Hook emission — actor-attributed `content.entry.*` events
// ---------------------------------------------------------------------------

interface PluginActor {
  kind: 'plugin'
  pluginId: string
}

async function emitEntryCreated(tableSlug: string, entryId: string, actor: PluginActor): Promise<void> {
  await hookBus.emit('content.entry.created', { tableSlug, entryId, actor })
}

async function emitEntryUpdated(
  tableSlug: string,
  entryId: string,
  changedFieldIds: string[],
  actor: PluginActor,
): Promise<void> {
  await hookBus.emit('content.entry.updated', {
    tableSlug,
    entryId,
    changedFieldIds,
    actor,
  })
}

async function emitEntryDeleted(tableSlug: string, entryId: string, actor: PluginActor): Promise<void> {
  await hookBus.emit('content.entry.deleted', { tableSlug, entryId, actor })
}

/** Diff two cell-bags by key. Falls back to whole-object compare per key. */
function diffCells(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const changed: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (before[key] !== after[key]) {
      // Reference equality skips deep compares for nested objects (page
      // trees, cell objects). Plugins watch this list; false positives are
      // fine, false negatives are not — fall through if the references
      // differ at all.
      changed.push(key)
    }
  }
  return changed
}

/**
 * Apply the `content.entry.cells` filter pipeline. Lets plugins
 * validate / normalize / auto-fill cells before persistence. The
 * filter context carries the table slug, entry id (or `'new'` for
 * `create`), and the actor.
 */
async function applyCellsFilter(
  cells: Record<string, unknown>,
  ctx: { tableSlug: string; entryId: string; actor: PluginActor },
): Promise<Record<string, unknown>> {
  return hookBus.applyFilter('content.entry.cells', cells, {
    tableSlug: ctx.tableSlug,
    entryId: ctx.entryId,
    actor: ctx.actor,
  })
}

// ---------------------------------------------------------------------------
// Tables — list / get / create
// ---------------------------------------------------------------------------

export async function handleContentTablesList(
  msg: ContentTablesListApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const allowedSlugs = new Set((entry.manifest.contentAccess ?? []).map((e) => e.table))
  const tables = await listDataTablesWithCounts(db)
  const summaries: ContentTableSummary[] = tables
    .filter((t) => allowedSlugs.has(t.slug))
    .map((t) => tableSummary(t, t.rowCount))
  replyApiOk(msg.pluginId, msg.correlationId, summaries)
}

export async function handleContentTablesGet(
  msg: ContentTablesGetApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const [slug] = msg.args
  assertContentTableAccess(entry, slug, 'read')
  const table = await resolveTableBySlug(db, slug).catch(() => null)
  if (!table) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  // Row count — single small query reused from listDataTablesWithCounts.
  const tables = await listDataTablesWithCounts(db)
  const enriched = tables.find((t) => t.id === table.id)
  const slugLookup = new Map(tables.map((t) => [t.id, t.slug]))
  replyApiOk(
    msg.pluginId,
    msg.correlationId,
    tableSchema(table, enriched?.rowCount ?? 0, slugLookup),
  )
}

export async function handleContentTablesCreate(
  msg: ContentTablesCreateApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.tables.manage')
  const [input] = msg.args
  // System tables are seeded only; the underlying repository does not accept
  // a `system: true` flag from this entry point — defense-in-depth here too.
  if (input.slug === 'pages' || input.slug === 'posts' || input.slug === 'components') {
    throw new Error(`Cannot create a table with the reserved system slug "${input.slug}"`)
  }
  const created = await createDataTable(db, {
    name: input.name,
    slug: input.slug,
    kind: input.kind ?? 'data',
    routeBase: input.routeBase,
    singularLabel: input.singularLabel,
    pluralLabel: input.pluralLabel,
    primaryFieldId: input.primaryFieldId ?? 'title',
    fields: (input.fields ?? []) as DataField[],
  })
  const slugLookup = await buildTableSlugLookup(db)
  replyApiOk(msg.pluginId, msg.correlationId, tableSchema(created, 0, slugLookup))
}

// ---------------------------------------------------------------------------
// Entries — CRUD + bulk
// ---------------------------------------------------------------------------

export async function handleContentEntriesList(
  msg: ContentEntriesListApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const [tableSlug, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const result = await listDataRowsWithFilter(db, table.id, options)
  replyApiOk(msg.pluginId, msg.correlationId, {
    entries: result.rows.map((r) => rowToEntry(r, tableSlug)),
    totalCount: result.totalCount,
  })
}

export async function handleContentEntriesGet(
  msg: ContentEntriesGetApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const [tableSlug, entryId] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const row = await getDataRow(db, entryId)
  if (!row || row.tableId !== table.id) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(row, tableSlug))
}

export async function handleContentEntriesGetBySlug(
  msg: ContentEntriesGetBySlugApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const [tableSlug, slug] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const row = await getDataRowBySlug(db, table.id, slug)
  replyApiOk(msg.pluginId, msg.correlationId, row ? rowToEntry(row, tableSlug) : null)
}

export async function handleContentEntriesCreate(
  msg: ContentEntriesCreateApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [tableSlug, input] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const cells = await applyCellsFilter(input.cells, {
    tableSlug,
    entryId: 'new',
    actor,
  })
  const slug = input.slug ?? denormalizeSlug(table, cells)
  const created = await createDataRow(
    db,
    { tableId: table.id, cells, slug },
    null,
    msg.pluginId,
  )
  await emitEntryCreated(tableSlug, created.id, actor)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(created, tableSlug))
}

export async function handleContentEntriesUpdate(
  msg: ContentEntriesUpdateApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [tableSlug, entryId, patch] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
  const filteredCells = await applyCellsFilter(mergedCells, {
    tableSlug,
    entryId,
    actor,
  })
  const changedIds = diffCells(existing.cells, filteredCells)
  // `denormalizeSlug` returns '' for tables without a slug field (or when the
  // slug cell is cleared); fall back to the existing slug so an update never
  // silently blanks the row's public path.
  const nextSlug = patch.slug ?? denormalizeSlug(table, filteredCells)
  const updated = await saveDataRowDraft(
    db,
    entryId,
    { cells: filteredCells, slug: nextSlug || existing.slug },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated`)
  if (changedIds.length > 0) {
    await emitEntryUpdated(tableSlug, entryId, changedIds, actor)
  }
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(updated, tableSlug))
}

export async function handleContentEntriesDelete(
  msg: ContentEntriesDeleteApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.delete')
  const [tableSlug, entryId] = msg.args
  assertContentTableAccess(entry, tableSlug, 'delete')
  const table = await resolveTableBySlug(db, tableSlug)
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const deleted = await softDeleteDataRow(db, entryId)
  if (deleted) {
    await emitEntryDeleted(tableSlug, entryId, { kind: 'plugin', pluginId: msg.pluginId })
  }
  replyApiOk(msg.pluginId, msg.correlationId, undefined)
}

export async function handleContentEntriesPublish(
  msg: ContentEntriesPublishApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.publish')
  const [tableSlug, entryId, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'publish')
  const table = await resolveTableBySlug(db, tableSlug)
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }

  if (options.scheduledFor) {
    const scheduled = await scheduleDataRowPublish(db, entryId, options.scheduledFor, null)
    if (!scheduled) throw new Error(`Entry "${entryId}" could not be scheduled`)
    await emitEntryUpdated(tableSlug, entryId, ['status'], actor)
    replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(scheduled, tableSlug))
    return
  }

  const result = await publishDataRow(db, entryId, null)
  await emitEntryUpdated(tableSlug, entryId, ['status'], actor)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(result.row, tableSlug))
}

export async function handleContentEntriesMoveTable(
  msg: ContentEntriesMoveTableApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [tableSlug, entryId, targetSlug] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  assertContentTableAccess(entry, targetSlug, 'write')
  const source = await resolveTableBySlug(db, tableSlug)
  const target = await resolveTableBySlug(db, targetSlug)
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== source.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const result = await updateDataRowTable(db, entryId, target.id, null)
  if (!result.ok) throw new Error(`moveToTable failed: ${result.reason}`)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  await emitEntryUpdated(tableSlug, entryId, ['tableId'], actor)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(result.row, targetSlug))
}

// ── Bulk ─────────────────────────────────────────────────────────────────

export async function handleContentEntriesCreateMany(
  msg: ContentEntriesCreateManyApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [tableSlug, inputs] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  // Apply the cells filter per-input before the transaction. The filter
  // runs INSIDE the same plugin's worker; running it inside the per-row
  // transaction would tie up the DB connection.
  const prepared = await Promise.all(inputs.map(async (input) => {
    const cells = await applyCellsFilter(input.cells, { tableSlug, entryId: 'new', actor })
    const slug = input.slug ?? denormalizeSlug(table, cells)
    return { tableId: table.id, cells, slug }
  }))
  const created = await createDataRowMany(db, prepared, null, msg.pluginId)
  for (const row of created) {
    await emitEntryCreated(tableSlug, row.id, actor)
  }
  replyApiOk(msg.pluginId, msg.correlationId, created.map((r) => rowToEntry(r, tableSlug)))
}

export async function handleContentEntriesUpdateMany(
  msg: ContentEntriesUpdateManyApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [tableSlug, updates] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }

  // Apply filter + diff per-row before the transaction.
  const prepared: Array<{ id: string; input: { cells: Record<string, unknown>; slug: string }; changedIds: string[] }> = []
  for (const { id, patch } of updates) {
    const existing = await getDataRow(db, id)
    if (!existing || existing.tableId !== table.id) {
      throw new Error(`Entry "${id}" not found in table "${tableSlug}"`)
    }
    const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
    const filteredCells = await applyCellsFilter(mergedCells, {
      tableSlug,
      entryId: id,
      actor,
    })
    const changedIds = diffCells(existing.cells, filteredCells)
    const nextSlug = patch.slug ?? denormalizeSlug(table, filteredCells)
    prepared.push({
      id,
      input: { cells: filteredCells, slug: nextSlug || existing.slug },
      changedIds,
    })
  }
  const updated = await saveDataRowDraftMany(
    db,
    prepared.map((p) => ({ id: p.id, input: p.input })),
    null,
    msg.pluginId,
  )
  for (const p of prepared) {
    if (p.changedIds.length > 0) {
      await emitEntryUpdated(tableSlug, p.id, p.changedIds, actor)
    }
  }
  replyApiOk(msg.pluginId, msg.correlationId, updated.map((r) => rowToEntry(r, tableSlug)))
}

export async function handleContentEntriesDeleteMany(
  msg: ContentEntriesDeleteManyApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.delete')
  const [tableSlug, ids] = msg.args
  assertContentTableAccess(entry, tableSlug, 'delete')
  const table = await resolveTableBySlug(db, tableSlug)
  // Validate every id belongs to this table BEFORE the transaction so a
  // bad id aborts cleanly without partially-applied deletes.
  for (const id of ids) {
    const row = await getDataRow(db, id)
    if (!row || row.tableId !== table.id) {
      throw new Error(`Entry "${id}" not found in table "${tableSlug}"`)
    }
  }
  const result = await softDeleteDataRowMany(db, ids, null)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  for (const id of ids) {
    await emitEntryDeleted(tableSlug, id, actor)
  }
  replyApiOk(msg.pluginId, msg.correlationId, result)
}

// ---------------------------------------------------------------------------
// Tree — read / mutate / replace
// ---------------------------------------------------------------------------

/**
 * Resolve the table + row + field meta needed for any `tree.*` call.
 * Throws if the entry doesn't exist, the field doesn't exist, or the
 * field isn't a `pageTree`-typed cell.
 */
async function resolvePageTreeField(
  db: DbClient,
  entryId: string,
  fieldId: string,
): Promise<{ row: DataRow; table: DataTable }> {
  const row = await getDataRow(db, entryId)
  if (!row) throw new Error(`Entry "${entryId}" not found`)
  const table = await getDataTable(db, row.tableId)
  if (!table) throw new Error(`Table for entry "${entryId}" missing`)
  const field = table.fields.find((f) => f.id === fieldId)
  if (!field) throw new Error(`Field "${fieldId}" not found on table "${table.slug}"`)
  if (field.type !== 'pageTree') {
    throw new Error(`Field "${fieldId}" on table "${table.slug}" is not a pageTree field`)
  }
  return { row, table }
}

export async function handleContentTreeRead(
  msg: ContentTreeReadApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const [entryId, fieldId] = msg.args
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId)
  assertContentTableAccess(entry, table.slug, 'read')
  const tree = row.cells[fieldId] ?? null
  replyApiOk(msg.pluginId, msg.correlationId, tree)
}

export async function handleContentTreeMutate(
  msg: ContentTreeMutateApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [entryId, fieldId, operations] = msg.args
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId)
  assertContentTableAccess(entry, table.slug, 'write')

  // Deep-clone so the dispatcher's in-place mutations don't surface on the
  // shared row reference held by `getDataRow`'s cache (the row's cells
  // object would otherwise be shared with the original DB read).
  const initial = row.cells[fieldId]
  if (!initial || typeof initial !== 'object') {
    throw new Error(`Field "${fieldId}" on entry "${entryId}" is empty — cannot mutate a missing tree`)
  }
  let tree = structuredClone(initial) as NodeTree<PageNode>

  const affectedNodeIds: string[] = []
  for (const op of operations) {
    const result = applyTreeOperation(tree, op as Parameters<typeof applyTreeOperation>[1])
    tree = result.tree
    affectedNodeIds.push(...result.affectedNodeIds)
  }

  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const nextCells = await applyCellsFilter(
    { ...row.cells, [fieldId]: tree },
    { tableSlug: table.slug, entryId, actor },
  )
  const updated = await saveDataRowDraft(
    db,
    entryId,
    { cells: nextCells, slug: row.slug },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated after tree mutation`)
  await emitEntryUpdated(table.slug, entryId, [fieldId], actor)
  replyApiOk(msg.pluginId, msg.correlationId, { tree, affectedNodeIds })
}

export async function handleContentTreeReplace(
  msg: ContentTreeReplaceApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [entryId, fieldId, replacement] = msg.args
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId)
  assertContentTableAccess(entry, table.slug, 'write')

  if (!replacement || typeof replacement !== 'object') {
    throw new Error(`Replacement for field "${fieldId}" must be an object`)
  }
  // Light structural validation — `nodes` map + `rootNodeId`. Deeper
  // module-level validation happens at render time via the module
  // registry; this guards against the most common shape errors.
  const candidate = replacement as { nodes?: unknown; rootNodeId?: unknown }
  if (
    !candidate.nodes ||
    typeof candidate.nodes !== 'object' ||
    typeof candidate.rootNodeId !== 'string'
  ) {
    throw new Error(`Replacement tree must have { nodes: object, rootNodeId: string }`)
  }

  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const nextCells = await applyCellsFilter(
    { ...row.cells, [fieldId]: replacement },
    { tableSlug: table.slug, entryId, actor },
  )
  const updated = await saveDataRowDraft(
    db,
    entryId,
    { cells: nextCells, slug: row.slug },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated after tree replace`)
  await emitEntryUpdated(table.slug, entryId, [fieldId], actor)
  replyApiOk(msg.pluginId, msg.correlationId, undefined)
}

// ---------------------------------------------------------------------------
// Cross-table — search / snapshot / republishAll
// ---------------------------------------------------------------------------

export async function handleContentSearch(
  msg: ContentSearchApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const [query, limit] = msg.args
  const allowedSlugs = new Set((entry.manifest.contentAccess ?? []).map((e) => e.table))
  const all = await searchDataRows(db, query, limit)
  const filtered = all
    .filter((r) => allowedSlugs.has(r.tableSlug))
    .map((r) => ({
      id: r.id,
      tableSlug: r.tableSlug,
      tableName: r.tableName,
      slug: r.slug,
      status: r.status,
      updatedAt: r.updatedAt,
    }))
  replyApiOk(msg.pluginId, msg.correlationId, filtered)
}

export async function handleContentSnapshot(
  msg: ContentSnapshotApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.read')
  const [entryId] = msg.args
  const row = await getDataRow(db, entryId)
  if (!row) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  const table = await getDataTable(db, row.tableId)
  if (!table) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  assertContentTableAccess(entry, table.slug, 'read')

  const { rows } = await db<{
    version_number: number
    cells_json: Record<string, unknown>
    slug: string
    published_at: string | Date
  }>`
    select data_row_versions.version_number,
           data_row_versions.cells_json,
           data_row_versions.slug,
           data_row_versions.published_at
    from data_rows
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    where data_rows.id = ${entryId}
      and data_rows.deleted_at is null
    limit 1
  `
  if (!rows[0]) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  const snap: PublishedSnapshot = {
    entryId: row.id,
    tableSlug: table.slug,
    versionNumber: rows[0].version_number,
    slug: rows[0].slug,
    cells: rows[0].cells_json,
    publishedAt: typeof rows[0].published_at === 'string'
      ? rows[0].published_at
      : rows[0].published_at.toISOString(),
  }
  replyApiOk(msg.pluginId, msg.correlationId, snap)
}

export async function handleContentRepublishAll(
  msg: ContentRepublishAllApiCall,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.publish')
  // `republishAll` operates on the host's full published-pages set —
  // the per-table access check would over-constrain a callee that only
  // wants to flush the publish pipeline. The kernel-of-correctness
  // remains the `cms.content.publish` permission grant.
  const count = await republishAllPages(_db)
  replyApiOk(msg.pluginId, msg.correlationId, { count })
}
