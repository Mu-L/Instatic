/**
 * ImageViewer — the viewer body for image assets.
 *
 * - Click-and-drag the crosshair (FocalPointPicker) to set the focal point;
 *   commits via the supplied callback.
 * - Reuses the existing FocalPointPicker so the focal-edit UX matches what
 *   the docked inspector previously offered.
 * - Picks a viewer-appropriate variant + BlurHash so the picker doesn't
 *   block on the full original.
 */
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { blurHashToDataUrl, buildVariantSrcset, pickVariantUrl } from '../../utils/variants'
import { FocalPointPicker } from '../FocalPointPicker/FocalPointPicker'
import styles from './ImageViewer.module.css'

interface ImageViewerProps {
  asset: CmsMediaAsset
  focalX: number
  focalY: number
  onFocalChange: (x: number, y: number) => void
}

// Viewer preview area: ~600 CSS px wide inside the 880-px window minus the
// 300-px sidebar minus padding. The picker grabs the smallest variant ≥
// 600 (scaled by DPR), which is `w1024` on a 1× display and `w1600` on 2×.
const VIEWER_CSS_WIDTH = 600

export function ImageViewer({ asset, focalX, focalY, onFocalChange }: ImageViewerProps) {
  const src = pickVariantUrl(asset, VIEWER_CSS_WIDTH)
  const srcset = buildVariantSrcset(asset)
  const blurHashUrl = blurHashToDataUrl(asset.blurHash)
  return (
    <div className={styles.root}>
      <FocalPointPicker
        src={src}
        srcset={srcset}
        blurHashUrl={blurHashUrl}
        alt={asset.altText || asset.filename}
        focalX={focalX}
        focalY={focalY}
        onChange={onFocalChange}
      />
    </div>
  )
}
