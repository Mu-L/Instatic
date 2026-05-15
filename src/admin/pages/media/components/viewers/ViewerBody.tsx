/**
 * ViewerBody — picks the right viewer for an asset's MIME type.
 *
 * Today: `image/*` → ImageViewer (with focal-point picker),
 *        `video/*` → VideoViewer,
 *        everything else → FallbackViewer.
 *
 * The dispatcher lives in one file so adding a new viewer type later (text,
 * PDF, 3D, …) is a single edit here.
 */
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { bucketForMime } from '../../utils/filters'
import { ImageViewer } from './ImageViewer'
import { VideoViewer } from './VideoViewer'
import { FallbackViewer } from './FallbackViewer'

interface ViewerBodyProps {
  asset: CmsMediaAsset
  /** Live focal coords during a drag (the parent owns the debounced save). */
  focalX: number
  focalY: number
  onFocalChange: (x: number, y: number) => void
}

export function ViewerBody({ asset, focalX, focalY, onFocalChange }: ViewerBodyProps) {
  const bucket = bucketForMime(asset.mimeType)
  if (bucket === 'image') {
    return (
      <ImageViewer
        asset={asset}
        focalX={focalX}
        focalY={focalY}
        onFocalChange={onFocalChange}
      />
    )
  }
  if (bucket === 'video') {
    return <VideoViewer src={asset.publicPath} />
  }
  return (
    <FallbackViewer
      publicPath={asset.publicPath}
      filename={asset.filename}
      mimeType={asset.mimeType}
    />
  )
}
