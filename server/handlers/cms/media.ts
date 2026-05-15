/**
 * Media library endpoints (gated by `media.manage`).
 *
 *   GET    /admin/api/cms/media                — list every uploaded asset
 *                                                  (?trash=1 → trashed items only)
 *   POST   /admin/api/cms/media                — upload a new image/video
 *                                                  (multipart `file=`, max 50MB)
 *   PATCH  /admin/api/cms/media/:id            — rename / edit metadata
 *   DELETE /admin/api/cms/media/:id            — soft delete by default,
 *                                                  ?purge=1 hard-deletes (only
 *                                                  permitted on already-trashed
 *                                                  assets) and removes the file
 *   POST   /admin/api/cms/media/:id/restore    — restore a soft-deleted asset
 *   POST   /admin/api/cms/media/:id/folders    — add/remove folder memberships
 *                                                  body: { add?: string[], remove?: string[] }
 *
 * The upload pipeline (multipart parse, magic-byte MIME sniff, sanitised
 * on-disk filename, media row insert) lives in `./mediaUpload.ts` and is
 * shared with the avatar endpoint in `./me.ts`. Anything that writes to
 * `uploads/` MUST go through `acceptUploadedMedia` so the byte-level checks
 * stay in one place.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import {
  assignAssetToFolders,
  deleteMediaAsset,
  getMediaAsset,
  listMediaAssets,
  restoreMediaAsset,
  softDeleteMediaAsset,
  updateMediaAssetMetadata,
  type UpdateMediaAssetMetadataInput,
} from '../../repositories/media'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'
import { readString, type CmsHandlerOptions } from './shared'
import {
  EXTENSION_FOR_MIME,
  acceptReplacementMedia,
  acceptUploadedMedia,
  readUploadedFile,
  uploadsDirRequired,
} from './mediaUpload'
import { removeVariantFiles } from './mediaVariants'

const MAX_MEDIA_BYTES = 50 * 1024 * 1024

const MEDIA_LIBRARY_MIMES = Object.keys(EXTENSION_FOR_MIME) as Array<
  keyof typeof EXTENSION_FOR_MIME
>

function readOptionalStringArray(body: Record<string, unknown>, key: string): string[] | null {
  const value = body[key]
  if (value === undefined) return null
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function readOptionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  if (value === undefined) return null
  return typeof value === 'string' ? value : null
}

function readOptionalUnitNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key]
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // The repo also clamps, but we reject obviously-out-of-range payloads up
  // front so a buggy client gets a clean validation error rather than a
  // silently-clamped value.
  if (value < 0 || value > 1) return null
  return value
}

export async function handleMediaRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/media') {
    const user = await requireCapability(req, db, 'media.manage')
    if (user instanceof Response) return user

    if (req.method === 'GET') {
      const trash = url.searchParams.get('trash') === '1' || url.searchParams.get('trash') === 'true'
      const assets = await listMediaAssets(db, { includeDeleted: trash })
      return jsonResponse({ assets })
    }

    if (req.method === 'POST') {
      if (!options.uploadsDir) return uploadsDirRequired()

      const file = await readUploadedFile(req)
      if (!file) return badRequest('Missing file')

      const result = await acceptUploadedMedia(db, {
        file,
        maxBytes: MAX_MEDIA_BYTES,
        allowedMimes: MEDIA_LIBRARY_MIMES,
        uploadsDir: options.uploadsDir,
        uploadedByUserId: user.id,
        oversizedMessage: 'File exceeds the 50 MB hard limit',
        unsupportedMessage:
          'Only JPEG, PNG, GIF, WebP, MP4, and WebM files can be uploaded',
      })
      if (result instanceof Response) return result
      return jsonResponse({ asset: result }, { status: 201 })
    }

    return methodNotAllowed()
  }

  const restoreMatch = url.pathname.match(/^\/admin\/api\/cms\/media\/([^/]+)\/restore$/)
  if (restoreMatch) {
    const user = await requireCapability(req, db, 'media.manage')
    if (user instanceof Response) return user

    if (req.method !== 'POST') return methodNotAllowed()

    const assetId = decodeURIComponent(restoreMatch[1])
    const restored = await restoreMediaAsset(db, assetId)
    if (!restored) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
    return jsonResponse({ asset: restored })
  }

  const replaceMatch = url.pathname.match(/^\/admin\/api\/cms\/media\/([^/]+)\/replace$/)
  if (replaceMatch) {
    const user = await requireCapability(req, db, 'media.manage')
    if (user instanceof Response) return user

    if (req.method !== 'POST') return methodNotAllowed()
    if (!options.uploadsDir) return uploadsDirRequired()

    const assetId = decodeURIComponent(replaceMatch[1])
    const file = await readUploadedFile(req)
    if (!file) return badRequest('Missing file')

    const result = await acceptReplacementMedia(db, assetId, {
      file,
      maxBytes: MAX_MEDIA_BYTES,
      allowedMimes: MEDIA_LIBRARY_MIMES,
      uploadsDir: options.uploadsDir,
      uploadedByUserId: user.id,
      oversizedMessage: 'File exceeds the 50 MB hard limit',
      unsupportedMessage:
        'Only JPEG, PNG, GIF, WebP, MP4, and WebM files can be uploaded',
    })
    if (result instanceof Response) return result
    return jsonResponse({ asset: result })
  }

  const foldersMatch = url.pathname.match(/^\/admin\/api\/cms\/media\/([^/]+)\/folders$/)
  if (foldersMatch) {
    const user = await requireCapability(req, db, 'media.manage')
    if (user instanceof Response) return user

    if (req.method !== 'POST') return methodNotAllowed()

    const assetId = decodeURIComponent(foldersMatch[1])
    const body = await readJsonObject(req)
    const add = readOptionalStringArray(body, 'add') ?? []
    const remove = readOptionalStringArray(body, 'remove') ?? []
    if (add.length === 0 && remove.length === 0) {
      return badRequest('Provide `add` or `remove` folder ids')
    }
    const asset = await assignAssetToFolders(db, assetId, { add, remove })
    if (!asset) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
    return jsonResponse({ asset })
  }

  const mediaItemMatch = url.pathname.match(/^\/admin\/api\/cms\/media\/([^/]+)$/)
  if (mediaItemMatch) {
    const user = await requireCapability(req, db, 'media.manage')
    if (user instanceof Response) return user

    const assetId = decodeURIComponent(mediaItemMatch[1])

    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      // PATCH accepts any subset of:
      //   filename, altText, caption, title, tags (string[]), focalX, focalY
      // Filename keeps the historical contract: when present-but-empty, that's
      // a 400. Other fields tolerate empty strings (clearing alt-text / caption
      // is a real operation).
      const patch: UpdateMediaAssetMetadataInput = {}
      if (body['filename'] !== undefined) {
        const filename = readString(body, 'filename')
        if (!filename) return badRequest('Filename is required')
        patch.filename = filename
      }
      const altText = readOptionalString(body, 'altText')
      if (altText !== null) patch.altText = altText
      const caption = readOptionalString(body, 'caption')
      if (caption !== null) patch.caption = caption
      const title = readOptionalString(body, 'title')
      if (title !== null) patch.title = title
      const tags = readOptionalStringArray(body, 'tags')
      if (tags !== null) patch.tags = tags
      const focalX = readOptionalUnitNumber(body, 'focalX')
      if (focalX !== null) patch.focalX = focalX
      const focalY = readOptionalUnitNumber(body, 'focalY')
      if (focalY !== null) patch.focalY = focalY

      if (Object.keys(patch).length === 0) return badRequest('No editable fields supplied')

      const asset = await updateMediaAssetMetadata(db, assetId, patch)
      if (!asset) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
      return jsonResponse({ asset })
    }

    if (req.method === 'DELETE') {
      const purge = url.searchParams.get('purge') === '1' || url.searchParams.get('purge') === 'true'

      if (purge) {
        // Hard delete — only legal on already-trashed assets so a single
        // click can't bypass the trash safety net. Caller must explicitly
        // soft-delete first and then purge from the Trash view.
        if (!options.uploadsDir) return uploadsDirRequired()

        const existing = await getMediaAsset(db, assetId)
        if (!existing) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
        if (!existing.deletedAt) {
          return badRequest('Asset must be soft-deleted before purge')
        }

        // Snapshot the variant list BEFORE deletion so we know which
        // extra files to sweep off disk alongside the original.
        const variants = existing.variants
        const deleted = await deleteMediaAsset(db, assetId)
        if (!deleted) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })

        await rm(join(options.uploadsDir, deleted.storagePath), { force: true })
        await removeVariantFiles(variants, options.uploadsDir)
        return jsonResponse({ ok: true })
      }

      const asset = await softDeleteMediaAsset(db, assetId)
      if (!asset) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
      return jsonResponse({ asset })
    }

    return methodNotAllowed()
  }

  return null
}
