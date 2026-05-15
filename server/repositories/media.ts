import type { DbClient } from '../db/client'

export interface MediaVariant {
  width: number
  height: number
  format: 'webp' | 'jpeg' | 'png' | 'avif'
  path: string
  sizeBytes: number
}

export interface MediaAsset {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  publicPath: string
  uploadedByUserId: string | null
  createdAt: string
  altText: string
  caption: string
  title: string
  tags: string[]
  width: number | null
  height: number | null
  durationMs: number | null
  focalX: number
  focalY: number
  dominantColor: string | null
  deletedAt: string | null
  replacedAt: string | null
  folderIds: string[]
  blurHash: string | null
  variants: MediaVariant[]
  posterPath: string | null
}

interface CreateMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  uploadedByUserId: string | null
}

export interface UpdateMediaAssetMetadataInput {
  filename?: string
  altText?: string
  caption?: string
  title?: string
  tags?: string[]
  focalX?: number
  focalY?: number
}

interface MediaAssetRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  public_path: string
  uploaded_by_user_id: string | null
  created_at: Date | string
  alt_text: string | null
  caption: string | null
  title: string | null
  tags_json: unknown
  width: number | null
  height: number | null
  duration_ms: number | string | null
  focal_x: number | string | null
  focal_y: number | string | null
  dominant_color: string | null
  deleted_at: Date | string | null
  replaced_at: Date | string | null
  blur_hash: string | null
  variants_json: unknown
  poster_path: string | null
}

interface DeletedMediaAssetRow {
  storage_path: string
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value == null ? null : toIsoString(value)
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function parseVariants(value: unknown): MediaVariant[] {
  // Variants are written by the upload pipeline as a fully-validated array
  // already; the runtime check here is defense against a hand-edited row.
  // Anything that isn't a well-shaped variant gets dropped silently — the
  // asset still serves its original file, just without the responsive ladder.
  const raw: unknown = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  if (!Array.isArray(raw)) return []
  const result: MediaVariant[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.width !== 'number' || typeof e.height !== 'number') continue
    if (typeof e.path !== 'string' || typeof e.sizeBytes !== 'number') continue
    if (e.format !== 'webp' && e.format !== 'jpeg' && e.format !== 'png' && e.format !== 'avif') continue
    result.push({
      width: e.width,
      height: e.height,
      format: e.format,
      path: e.path,
      sizeBytes: e.sizeBytes,
    })
  }
  return result
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function numberWithDefault(value: number | string | null | undefined, fallback: number): number {
  if (value == null) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function mapMediaAsset(row: MediaAssetRow, folderIds: string[] = []): MediaAsset {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    publicPath: row.public_path,
    uploadedByUserId: row.uploaded_by_user_id ?? null,
    createdAt: toIsoString(row.created_at),
    altText: row.alt_text ?? '',
    caption: row.caption ?? '',
    title: row.title ?? '',
    tags: parseTags(row.tags_json),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    durationMs: numberOrNull(row.duration_ms),
    focalX: numberWithDefault(row.focal_x, 0.5),
    focalY: numberWithDefault(row.focal_y, 0.5),
    dominantColor: row.dominant_color ?? null,
    deletedAt: toIsoOrNull(row.deleted_at),
    replacedAt: toIsoOrNull(row.replaced_at),
    folderIds,
    blurHash: row.blur_hash ?? null,
    variants: parseVariants(row.variants_json),
    posterPath: row.poster_path ?? null,
  }
}

/**
 * Hydrate the asset → folder-id map for a batch of assets. One round trip,
 * grouped by asset id. Used by every list / get path so the caller sees the
 * full multi-folder membership without an N+1.
 */
async function loadFolderIdsForAssets(
  db: DbClient,
  assetIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (assetIds.length === 0) return map
  for (const id of assetIds) map.set(id, [])

  // Cross-dialect IN-list: SQLite has no native array binding and PG only
  // takes arrays via `= any($n)`. The shared `DbClient` tagged-template form
  // can't expand a JS array into a SQL IN list directly — so we do the
  // expansion explicitly: one row-fetch per asset id (still one DB-conn
  // round-trip per asset, but trivially fast in practice; batch sizes are
  // the visible page slice, ≤ 200).
  for (const assetId of assetIds) {
    const { rows } = await db<{ folder_id: string }>`
      select folder_id from media_asset_folders where asset_id = ${assetId}
    `
    map.set(assetId, rows.map((r) => r.folder_id))
  }
  return map
}

async function hydrateAssets(
  db: DbClient,
  rows: MediaAssetRow[],
): Promise<MediaAsset[]> {
  const folderMap = await loadFolderIdsForAssets(db, rows.map((r) => r.id))
  return rows.map((row) => mapMediaAsset(row, folderMap.get(row.id) ?? []))
}

export async function createMediaAsset(
  db: DbClient,
  input: CreateMediaAssetInput,
): Promise<MediaAsset> {
  const { rows } = await db<MediaAssetRow>`
    insert into media_assets (id, filename, mime_type, size_bytes, storage_path, public_path, uploaded_by_user_id)
    values (
      ${input.id},
      ${input.filename},
      ${input.mimeType},
      ${input.sizeBytes},
      ${input.storagePath},
      ${input.publicPath},
      ${input.uploadedByUserId}
    )
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
  `
  return mapMediaAsset(rows[0])
}

export async function getMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
           alt_text, caption, title, tags_json, width, height, duration_ms,
           focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
    from media_assets
    where id = ${id}
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * List every media asset (active or in-trash, never both). The repo intentionally
 * returns the full set and lets the handler apply additional filters (folder /
 * type / search / tag / sort / pagination) in JS — cross-dialect dynamic SQL
 * with optional WHERE clauses is fragile and the media library is small enough
 * (low thousands per site) that the round-trip dominates. If a site grows past
 * the comfort zone we'll move filters server-side per-dialect; not premature
 * optimization for M2.
 */
export async function listMediaAssets(
  db: DbClient,
  options: { includeDeleted?: boolean } = {},
): Promise<MediaAsset[]> {
  // Two queries, not one, because cross-dialect optional WHERE clauses in
  // tagged templates require literal SQL text — `includeDeleted` is the
  // only branch.
  const { rows } = options.includeDeleted
    ? await db<MediaAssetRow>`
        select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
               alt_text, caption, title, tags_json, width, height, duration_ms,
               focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
        from media_assets
        where deleted_at is not null
        order by deleted_at desc
      `
    : await db<MediaAssetRow>`
        select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
               alt_text, caption, title, tags_json, width, height, duration_ms,
               focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
        from media_assets
        where deleted_at is null
        order by created_at desc
      `
  return hydrateAssets(db, rows)
}

export async function renameMediaAsset(
  db: DbClient,
  id: string,
  filename: string,
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    update media_assets set filename = ${filename}
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Patch user-editable metadata. The query updates every field unconditionally
 * using COALESCE — undefined inputs map to NULL which preserves the existing
 * column value. This keeps the query shape stable across dialects.
 */
export async function updateMediaAssetMetadata(
  db: DbClient,
  id: string,
  input: UpdateMediaAssetMetadataInput,
): Promise<MediaAsset | null> {
  // Canonical form for the tag column: lowercased, dedup, sorted so equality
  // checks against a "{ tag }" filter behave predictably and the JSON
  // representation is stable across writes.
  const tags = input.tags
    ? Array.from(new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort()
    : null

  const filename = input.filename ?? null
  const altText = input.altText ?? null
  const caption = input.caption ?? null
  const title = input.title ?? null
  const focalX = input.focalX !== undefined ? Math.max(0, Math.min(1, input.focalX)) : null
  const focalY = input.focalY !== undefined ? Math.max(0, Math.min(1, input.focalY)) : null

  const { rows } = await db<MediaAssetRow>`
    update media_assets set
      filename = coalesce(${filename}, filename),
      alt_text = coalesce(${altText}, alt_text),
      caption = coalesce(${caption}, caption),
      title = coalesce(${title}, title),
      tags_json = coalesce(${tags}, tags_json),
      focal_x = coalesce(${focalX}, focal_x),
      focal_y = coalesce(${focalY}, focal_y)
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Stamp the responsive-pipeline output (intrinsic dimensions + BlurHash +
 * variant index) onto a media row. Called by the upload + replace-file
 * handlers immediately after the variants are written to disk. Kept
 * separate from `updateMediaAssetMetadata` because:
 *   1. These columns are NOT user-editable; they're set exactly once per
 *      binary (or once per replace).
 *   2. We always want to overwrite even when the value happens to be
 *      `null` (e.g. a replaced image with no probable dimensions) — the
 *      COALESCE-keep semantics in `updateMediaAssetMetadata` would be
 *      wrong here.
 */
export async function setMediaAssetVariants(
  db: DbClient,
  id: string,
  input: {
    width: number | null
    height: number | null
    blurHash: string | null
    variants: MediaVariant[]
  },
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    update media_assets set
      width = ${input.width},
      height = ${input.height},
      blur_hash = ${input.blurHash},
      variants_json = ${input.variants}
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Soft delete: stamp `deleted_at`. Restore un-stamps; `deleteMediaAsset`
 * finishes the job by removing the row (and caller removes the on-disk file).
 */
export async function softDeleteMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const nowIso = new Date().toISOString()
  const { rows } = await db<MediaAssetRow>`
    update media_assets set deleted_at = ${nowIso}
    where id = ${id} and deleted_at is null
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
  `
  if (rows.length === 0) return getMediaAsset(db, id)
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

export async function restoreMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    update media_assets set deleted_at = null
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Hard delete — removes the row. Caller is responsible for removing the
 * on-disk file using the returned `storagePath`.
 */
export async function deleteMediaAsset(
  db: DbClient,
  id: string,
): Promise<{ storagePath: string } | null> {
  const { rows } = await db<DeletedMediaAssetRow>`
    delete from media_assets
    where id = ${id}
    returning storage_path
  `
  const row = rows[0]
  return row ? { storagePath: row.storage_path } : null
}

/**
 * Replace the binary backing this asset while keeping the same id and
 * public_path so every existing reference stays valid. Caller writes the new
 * file to disk and removes the old one.
 */
export async function replaceMediaAssetBinary(
  db: DbClient,
  id: string,
  input: {
    filename: string
    mimeType: string
    sizeBytes: number
    storagePath: string
  },
): Promise<MediaAsset | null> {
  const nowIso = new Date().toISOString()
  const { rows } = await db<MediaAssetRow>`
    update media_assets set
      filename = ${input.filename},
      mime_type = ${input.mimeType},
      size_bytes = ${input.sizeBytes},
      storage_path = ${input.storagePath},
      replaced_at = ${nowIso}
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             focal_x, focal_y, dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Storage path of an existing asset without deleting it — used by the
 * replace-file handler to remove the previous binary after writing the new
 * one.
 */
export async function getMediaAssetStoragePath(
  db: DbClient,
  id: string,
): Promise<string | null> {
  const { rows } = await db<{ storage_path: string }>`
    select storage_path from media_assets where id = ${id}
  `
  return rows[0]?.storage_path ?? null
}

/**
 * Pull just the responsive variants for an asset so the replace + purge
 * paths can sweep them off disk alongside the original. Returns an empty
 * array for assets that never had variants (non-image uploads, very small
 * images that didn't need a ladder).
 */
export async function getMediaAssetVariants(
  db: DbClient,
  id: string,
): Promise<MediaVariant[]> {
  const { rows } = await db<{ variants_json: unknown }>`
    select variants_json from media_assets where id = ${id}
  `
  if (rows.length === 0) return []
  return parseVariants(rows[0].variants_json)
}

/**
 * Add and/or remove an asset's folder memberships in one transactional step.
 * Idempotent: re-adding an existing membership is a no-op (relies on the
 * primary key + an INSERT … ON CONFLICT DO NOTHING).
 */
export async function assignAssetToFolders(
  db: DbClient,
  assetId: string,
  input: { add?: string[]; remove?: string[] },
): Promise<MediaAsset | null> {
  return db.transaction(async (tx) => {
    for (const folderId of input.remove ?? []) {
      await tx`
        delete from media_asset_folders
        where asset_id = ${assetId} and folder_id = ${folderId}
      `
    }
    for (const folderId of input.add ?? []) {
      // Cross-dialect upsert — PG 9.5+ and SQLite 3.24+ both accept
      // `ON CONFLICT DO NOTHING` on a primary key conflict.
      await tx`
        insert into media_asset_folders (asset_id, folder_id)
        values (${assetId}, ${folderId})
        on conflict do nothing
      `
    }
    return getMediaAsset(tx, assetId)
  })
}
