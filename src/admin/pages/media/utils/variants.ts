/**
 * Variant-picking + BlurHash helpers shared by every admin surface that
 * renders a media asset (canvas grid, viewer body, picker, focal-point).
 *
 * The single rule for picking a variant: pick the smallest variant whose
 * width is greater-than-or-equal-to the target rendered width, accounting
 * for devicePixelRatio. If no variant is large enough (or the asset has no
 * variants at all), fall back to the original `publicPath`.
 */
import { decode as decodeBlurHash } from 'blurhash'
import type { CmsMediaAsset, CmsMediaVariant } from '@core/persistence/cmsMedia'

/**
 * Choose the smallest variant ≥ targetWidth (in CSS pixels, scaled by DPR).
 * Returns the original `publicPath` when no variant is suitable — guarantees
 * the caller always has SOME url to display.
 */
export function pickVariantUrl(
  asset: Pick<CmsMediaAsset, 'publicPath' | 'variants'>,
  targetCssWidth: number,
): string {
  if (!asset.variants.length) return asset.publicPath
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1
  const targetPx = Math.ceil(targetCssWidth * dpr)
  const sorted: CmsMediaVariant[] = [...asset.variants].sort((a, b) => a.width - b.width)
  // First variant ≥ target wins. Falls back to the largest variant (or the
  // original) when nothing's big enough — handles the "browser wants 4K,
  // we only have 1024" case gracefully.
  for (const v of sorted) {
    if (v.width >= targetPx) return v.path
  }
  // No variant is large enough → the original is necessarily larger
  // (variants are only generated for widths strictly less than the
  // original), so prefer that over the biggest variant.
  return asset.publicPath
}

/**
 * Build the `srcset` attribute string from the variant ladder. Includes
 * the original asset as the largest entry (so it stays selectable when the
 * browser wants the full resolution). Returns `undefined` when there are
 * no variants — callers should omit the attribute entirely in that case.
 */
export function buildVariantSrcset(
  asset: Pick<CmsMediaAsset, 'publicPath' | 'variants' | 'width'>,
): string | undefined {
  if (!asset.variants.length) return undefined
  const entries = asset.variants
    .slice()
    .sort((a, b) => a.width - b.width)
    .map((v) => `${v.path} ${v.width}w`)
  if (asset.width) entries.push(`${asset.publicPath} ${asset.width}w`)
  return entries.join(', ')
}

// ──────────────────────────────────────────────────────────────────────────
// BlurHash → data URL
// ──────────────────────────────────────────────────────────────────────────

const BLUR_PREVIEW_SIZE = 32

/**
 * In-memory cache so the same BlurHash decodes only once per session. Most
 * users see the same handful of assets across the canvas grid + picker +
 * viewer, so caching by hash string is a meaningful win.
 *
 * LRU isn't strictly needed because BlurHash strings are ~30 chars and the
 * generated data URLs are <2 KB each. A few hundred entries is fine.
 */
const blurHashCache = new Map<string, string>()

/**
 * Decode a BlurHash to a small PNG data URL suitable for use as a CSS
 * `background-image`. Returns `null` when the hash is invalid (defensive —
 * malformed rows shouldn't crash the UI).
 *
 * SSR-safe: returns null when `document` is undefined, callers should
 * tolerate that.
 */
export function blurHashToDataUrl(hash: string | null | undefined): string | null {
  if (!hash) return null
  const cached = blurHashCache.get(hash)
  if (cached) return cached
  if (typeof document === 'undefined') return null
  try {
    const pixels = decodeBlurHash(hash, BLUR_PREVIEW_SIZE, BLUR_PREVIEW_SIZE)
    const canvas = document.createElement('canvas')
    canvas.width = BLUR_PREVIEW_SIZE
    canvas.height = BLUR_PREVIEW_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const imageData = ctx.createImageData(BLUR_PREVIEW_SIZE, BLUR_PREVIEW_SIZE)
    imageData.data.set(pixels)
    ctx.putImageData(imageData, 0, 0)
    const url = canvas.toDataURL('image/png')
    blurHashCache.set(hash, url)
    return url
  } catch (err) {
    console.error('[variants] blurhash decode failed:', err)
    return null
  }
}
