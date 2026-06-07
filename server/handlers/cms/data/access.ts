/**
 * Capability guards for data table and row endpoints.
 *
 * Two capability families:
 *
 *   content.*  — row-level editorial: who can create / edit / publish rows,
 *                including the own-vs-any split. Drives the Content
 *                workspace and the per-row gating in the Data grid.
 *
 *     content.create       — create new rows
 *     content.edit.own     — read / edit own rows
 *     content.edit.any     — read / edit all rows
 *     content.publish.own  — publish own rows
 *     content.publish.any  — publish all rows
 *     content.manage       — every row operation (super-set of the above)
 *
 *   data.*     — structural / workspace-level: schema design, cross-table
 *                row moves, bundle export/import. Decoupled from `content.*`
 *                so a "data architect" persona can design tables without
 *                being able to read/write row content.
 *
 *     data.tables.read     — open Data workspace, browse tables + fields
 *     data.tables.manage   — create/rename/delete tables, edit fields
 *     data.rows.move       — cross-collection row move
 *     data.export          — bundle export + import preview (read-only)
 *     data.import          — bundle import (replace mode also needs
 *                            `content.manage` AND step-up)
 */
import type { CoreCapability } from '../../../auth/capabilities'
import {
  requireAnyCapability,
  requireCapability,
  userHasAnyCapability,
  userHasCapability,
} from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { jsonResponse } from '../../../http'
import type { AuthUser } from '../../../repositories/users'

const DATA_ACCESS_CAPABILITIES = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_ANY_VISIBILITY_CAPABILITIES = [
  'content.edit.any',
  'content.publish.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_OWN_READ_CAPABILITIES = [
  'content.edit.own',
  'content.publish.own',
] satisfies CoreCapability[]

const DATA_EDIT_CAPABILITIES = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_REASSIGN_CAPABILITIES = [
  'content.edit.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_PUBLISH_CAPABILITIES = [
  'content.publish.own',
  'content.publish.any',
] satisfies CoreCapability[]

interface OwnedDataRow {
  authorUserId: string | null
  createdByUserId: string | null
}

export function forbidden(): Response {
  return jsonResponse({ error: 'Forbidden' }, { status: 403 })
}

export async function requireDataAccess(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_ACCESS_CAPABILITIES)
}

/**
 * Schema-level read — open the Data workspace, browse tables + their
 * field schemas. Granted independently from row content access so a
 * read-only stakeholder persona is expressible.
 */
export async function requireDataTablesRead(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, ['data.tables.read', 'data.tables.manage'])
}

/**
 * Schema-level mutation — create/rename/delete tables, edit fields.
 * Was `content.manage`; split so the table-design power is separable
 * from row-content power.
 */
export async function requireDataTablesManager(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireCapability(req, db, 'data.tables.manage')
}

/**
 * Cross-collection row move — `PATCH /data/rows/:id/table`. Split out
 * because moving a row to a different table changes its public URL
 * (different route base) and is structurally distinct from editing a
 * row's cells.
 */
export async function requireDataRowMover(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireCapability(req, db, 'data.rows.move')
}

export async function requireDataEditor(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_EDIT_CAPABILITIES)
}

export async function requireDataCreator(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireCapability(req, db, 'content.create')
}

export async function requireDataAuthorManager(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_REASSIGN_CAPABILITIES)
}

export async function requireDataPublisher(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_PUBLISH_CAPABILITIES)
}

export function canSeeAllDataRows(user: AuthUser): boolean {
  return userHasAnyCapability(user, DATA_ANY_VISIBILITY_CAPABILITIES)
}

function ownsDataRow(user: AuthUser, row: OwnedDataRow): boolean {
  return row.authorUserId === user.id || (!row.authorUserId && row.createdByUserId === user.id)
}

export function canReadDataRow(user: AuthUser, row: OwnedDataRow): boolean {
  return canSeeAllDataRows(user) ||
    (ownsDataRow(user, row) && userHasAnyCapability(user, DATA_OWN_READ_CAPABILITIES))
}

export function canEditDataRow(user: AuthUser, row: OwnedDataRow): boolean {
  return userHasAnyCapability(user, ['content.edit.any', 'content.manage']) ||
    (ownsDataRow(user, row) && userHasCapability(user, 'content.edit.own'))
}

export function canPublishDataRow(user: AuthUser, row: OwnedDataRow): boolean {
  return userHasCapability(user, 'content.publish.any') ||
    (ownsDataRow(user, row) && userHasCapability(user, 'content.publish.own'))
}
