/**
 * base.image editor preview component.
 *
 * Mirrors what the publisher emits so the canvas WYSIWYG reflects what's
 * actually shipped:
 *   - smaller variant (by render size + DPR) instead of the original
 *   - srcset + sizes so the browser can pick the right rung
 *   - intrinsic width / height to prevent CLS in the canvas
 *   - BlurHash data-URL backdrop while the variant streams in
 *   - fallback to the library's `alt` text when the module's `alt` is blank
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import React, { useMemo } from 'react'
import type { ModuleComponentProps } from '@core/module-engine/types'
import { cn } from '@ui/cn'
import {
  blurHashToDataUrl,
  buildVariantSrcset,
  pickVariantUrl,
} from '@admin/pages/media/utils/variants'
import { useCmsMediaAssetByPath } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import styles from './image.module.css'

interface ImageProps extends Record<string, unknown> {
  src: string
  alt: string
  loading: 'lazy' | 'eager'
}

// Best-guess CSS width for the canvas preview tile. Triggers DPR-aware
// variant pick: 1× → w320, 2× → w640. The browser still uses srcset to
// pick the actual variant when the layout is known; this is just the
// initial `src`.
const CANVAS_CSS_WIDTH = 320

export const ImageEditor: React.FC<ModuleComponentProps<ImageProps>> = ({ props, mcClassName }) => {
  // Resolve the asset row server-side metadata is cached in a module-
  // level map, so dozens of image modules on one page share a single
  // round trip. `null` until the cache is populated — render shows the
  // raw src in the meantime so there's no flash of "No image selected".
  const asset = useCmsMediaAssetByPath(props.src || null)

  const responsive = useMemo(() => {
    if (!asset) return null
    return {
      src: pickVariantUrl(asset, CANVAS_CSS_WIDTH),
      srcset: buildVariantSrcset(asset),
      blurUrl: blurHashToDataUrl(asset.blurHash),
      width: asset.width,
      height: asset.height,
      libraryAlt: asset.altText,
    }
  }, [asset])

  if (!props.src) {
    return <div className={cn(styles.placeholder, mcClassName)}>No image selected</div>
  }

  // Alt text: module override wins, library fallback otherwise. Matches
  // the published-render behaviour so the canvas preview never disagrees
  // with the published HTML.
  const altOverride = (props.alt ?? '').trim()
  const alt = altOverride || responsive?.libraryAlt || ''

  // No resolved asset yet (cache loading, external URL, or row missing).
  // Render the raw src so the user never sees a flash of blank.
  if (!responsive) {
    return (
      <img
        src={props.src}
        alt={alt}
        className={mcClassName}
        loading={props.loading}
        decoding="async"
      />
    )
  }

  const style = responsive.blurUrl
    ? ({
        backgroundImage: `url(${responsive.blurUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      } as React.CSSProperties)
    : undefined

  return (
    <img
      src={responsive.src}
      srcSet={responsive.srcset ?? undefined}
      sizes={responsive.srcset ? '100vw' : undefined}
      alt={alt}
      width={responsive.width ?? undefined}
      height={responsive.height ?? undefined}
      className={mcClassName}
      loading={props.loading}
      decoding="async"
      style={style}
    />
  )
}
