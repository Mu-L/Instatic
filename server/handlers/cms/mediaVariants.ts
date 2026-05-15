/**
 * mediaVariants — server-side responsive image + BlurHash pipeline.
 *
 * Runs synchronously inside the upload + replace-file handlers. Given the
 * raw bytes of an uploaded image we:
 *
 *   1. Probe intrinsic dimensions via `sharp`.
 *   2. Encode a BlurHash (~30-char placeholder for the published page +
 *      every admin preview surface so the loading flash goes away).
 *   3. Generate one WebP variant for each target width that is < the
 *      original width. The set covers the common breakpoints we serve plus
 *      a tiny 64-wide thumb the admin grid + picker use.
 *
 * All variant files live next to the original under `/uploads/`, named
 * `<originalStem>-w<width>.webp`. Each row is stored in `variants_json`.
 *
 * Why synchronous? Sharp + libvips processes a typical 4 MP JPEG into the
 * full ladder in ~200–500 ms. We already block the upload response on the
 * disk write; folding variants into the same critical path keeps the
 * implementation simple and gives the user one "uploading" → "done"
 * transition. If real-world uploads cross multi-second territory we move
 * this to a background job (out of scope for v1).
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { encode as encodeBlurHash } from 'blurhash'

/**
 * Target widths for the responsive variant ladder. Chosen to cover the
 * common breakpoints we serve in the editor (mobile 375 / tablet 768 /
 * desktop 1024 / wide 1600+) plus a tiny 64 the admin grid uses for
 * fast-loading thumbnails, plus a 2048 high-DPI variant.
 *
 * Sorted ascending so the variant array stays small-to-large for callers
 * doing a linear "smallest >= target" pick.
 */
const TARGET_WIDTHS = [64, 320, 640, 1024, 1600, 2048] as const

/**
 * WebP encoder quality. 80 is the standard "visually lossless for
 * non-pixel-art photos" sweet spot. We don't tweak per-variant — encoding
 * cost is already the bottleneck.
 */
const WEBP_QUALITY = 80

/**
 * BlurHash component counts. (4, 3) produces a punchy ~30-character hash
 * that decodes to a recognisable placeholder without bloating the column.
 * The encoder requires the source raw RGBA in 32x32 form; we resize on the
 * fly before encoding.
 */
const BLURHASH_X_COMPONENTS = 4
const BLURHASH_Y_COMPONENTS = 3
const BLURHASH_SAMPLE_WIDTH = 32
const BLURHASH_SAMPLE_HEIGHT = 32

export interface MediaVariantRecord {
  width: number
  height: number
  format: 'webp'
  path: string
  sizeBytes: number
}

export interface ImageProcessingResult {
  width: number
  height: number
  blurHash: string
  variants: MediaVariantRecord[]
}

/**
 * Strip the WebP-friendly extension from the original storage name so the
 * variant filenames stay readable (e.g. `abc-hero.png` →
 * `abc-hero-w320.webp`, not `abc-hero.png-w320.webp`).
 */
function variantStorageBase(storagePath: string): string {
  const dot = storagePath.lastIndexOf('.')
  return dot >= 0 ? storagePath.slice(0, dot) : storagePath
}

/**
 * Generate the full responsive ladder for an uploaded image. Returns the
 * probed dimensions, the BlurHash placeholder, and the list of variant
 * files written to disk.
 *
 * On any non-image input (GIF, SVG — though we don't accept SVG today) or
 * on any sharp failure, returns `null` so the caller falls back to a plain
 * row with no variants. Callers MUST handle the null case — the admin grid
 * still renders fine without variants, it just loads the original.
 */
export async function processImageVariants(
  bytes: Uint8Array,
  storagePath: string,
  uploadsDir: string,
): Promise<ImageProcessingResult | null> {
  try {
    // Pull intrinsic dimensions first. `sharp.metadata()` is cheap (header
    // only) and tells us whether we have something processable.
    const image = sharp(bytes)
    const metadata = await image.metadata()
    const originalWidth = metadata.width
    const originalHeight = metadata.height
    if (!originalWidth || !originalHeight) return null

    // ── BlurHash ─────────────────────────────────────────────────────────
    // Encode a downsampled raw RGBA buffer. `fit: 'fill'` is intentional —
    // BlurHash is rendered into a container whose aspect ratio matches the
    // FULL image (because the consumer also knows `width` / `height`), so
    // we don't need aspect-preserving downsampling here. Crucially, the
    // blurhash encoder requires the input buffer to be EXACTLY
    // `width * height * 4` bytes; `fit: 'inside'` would silently shrink one
    // dimension and produce a smaller buffer that the encoder then
    // rejects with `Width and height must match the pixels array`.
    const { data: blurBytes } = await sharp(bytes)
      .resize(BLURHASH_SAMPLE_WIDTH, BLURHASH_SAMPLE_HEIGHT, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const blurHash = encodeBlurHash(
      new Uint8ClampedArray(blurBytes.buffer, blurBytes.byteOffset, blurBytes.byteLength),
      BLURHASH_SAMPLE_WIDTH,
      BLURHASH_SAMPLE_HEIGHT,
      BLURHASH_X_COMPONENTS,
      BLURHASH_Y_COMPONENTS,
    )

    // ── Variant ladder ───────────────────────────────────────────────────
    // Skip any target width ≥ the original — upscaling is wasteful and
    // makes the published markup misleading.
    const base = variantStorageBase(storagePath)
    const variants: MediaVariantRecord[] = []
    for (const width of TARGET_WIDTHS) {
      if (width >= originalWidth) continue
      const outPath = `${base}-w${width}.webp`
      const variantBytes = await sharp(bytes)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true })
      await writeFile(join(uploadsDir, outPath), variantBytes.data)
      variants.push({
        width: variantBytes.info.width,
        height: variantBytes.info.height,
        format: 'webp',
        path: `/uploads/${outPath}`,
        sizeBytes: variantBytes.data.byteLength,
      })
    }

    return {
      width: originalWidth,
      height: originalHeight,
      blurHash,
      variants,
    }
  } catch (err) {
    console.error('[mediaVariants] image processing failed:', err)
    return null
  }
}

/**
 * Remove on-disk variant files for an asset that's being purged or
 * replaced. Caller passes the variants array from the row; we delete each
 * file's storage_path (the `/uploads/` public prefix is stripped first).
 *
 * Accepts any `{ path: string }` so the repo's broader `MediaVariant`
 * union (with future jpeg/png/avif formats) can flow through unchanged.
 *
 * Failures are non-fatal — the database row removal has already succeeded.
 * Orphaned files just sit in `uploads/` until a future GC sweeps them.
 */
export async function removeVariantFiles(
  variants: ReadonlyArray<{ path: string }>,
  uploadsDir: string,
): Promise<void> {
  const { rm } = await import('node:fs/promises')
  for (const variant of variants) {
    // The `path` is the public URL form (`/uploads/xxx-w320.webp`); the
    // on-disk filename is everything after `/uploads/`.
    const storageName = variant.path.startsWith('/uploads/')
      ? variant.path.slice('/uploads/'.length)
      : variant.path
    await rm(join(uploadsDir, storageName), { force: true })
  }
}
