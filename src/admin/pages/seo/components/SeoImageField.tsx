/**
 * SeoImageField — social-image picker for OG/X images.
 *
 * Primary affordance: the media library picker (same `MediaPickerModal` the
 * favicon picker uses). A URL input stays available as the secondary path
 * for externally-hosted images. Empty value falls back through the resolver
 * chain — the inherited value renders as a muted preview row.
 */
import { lazy, Suspense, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import type { CmsMediaAsset } from '@core/persistence'
import styles from './SeoImageField.module.css'

const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)

interface SeoImageFieldProps {
  label: string
  /** Id for the URL input — lets the improvements list focus this field. */
  inputId?: string
  /** Explicit value ('' when inheriting). */
  value: string
  /** Resolved fallback shown when no explicit value is set. */
  inheritedValue: string | null
  disabled: boolean
  onChange: (next: string) => void
}

export function SeoImageField({ label, inputId, value, inheritedValue, disabled, onChange }: SeoImageFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false)

  function handlePick(asset: CmsMediaAsset): void {
    onChange(asset.publicPath)
    setPickerOpen(false)
  }

  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.controls}>
        <Input
          type="text"
          id={inputId}
          value={value}
          placeholder={inheritedValue ?? 'No image — pick from the library'}
          disabled={disabled}
          aria-label={`${label} URL`}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => setPickerOpen(true)}
          aria-label={`Browse media library for ${label}`}
        >
          <ImagesSolidIcon size={13} aria-hidden="true" />
          <span>Browse</span>
        </Button>
        {value !== '' && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange('')} aria-label={`Clear ${label}`}>
            Clear
          </Button>
        )}
      </div>
      {pickerOpen && (
        <Suspense fallback={null}>
          <MediaPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            mediaKind="image"
            currentValue={value || null}
            onPick={handlePick}
          />
        </Suspense>
      )}
    </div>
  )
}
