/**
 * MediaLibraryControl — the property-panel control for `<img>` and `<video>`
 * `src` props. Two modes:
 *
 *   1. Library — click "Browse library…" to open the WordPress-style
 *      `MediaPickerModal` (a fullscreen Media-page modal). The control
 *      surface itself only renders a tiny preview of the currently picked
 *      asset + filename. No inline grid, no inline upload — those live
 *      inside the modal.
 *
 *   2. URL — manual entry for external assets (CDN, third-party hosts).
 *      Plain `<Input type="url">` with a small inline preview.
 *
 * The sidebar property panel is ~280 px wide; cramming a full grid in here
 * is what made the previous picker unreadable. By delegating to the modal
 * we get the same wide canvas, folder tree, sort, and clear "selected"
 * affordance as the standalone Media page.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import {
  listCmsMediaAssets,
  type CmsMediaAsset,
} from '@core/persistence/cmsMedia'
import { isValidImageUrl } from '@core/utils/urlValidation'
import type { ControlProps } from './shared'
import { ControlRow } from '@ui/components/ControlRow'
import controlRowStyles from '@ui/components/ControlRow/ControlRow.module.css'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { blurHashToDataUrl, pickVariantUrl } from '@admin/pages/media/utils/variants'
import { MediaViewerWindow } from '@admin/pages/media/components/MediaViewerWindow/MediaViewerWindow'
import { useStandaloneMediaEditor } from '@admin/pages/media/hooks/useStandaloneMediaEditor'
import styles from './controls.module.css'

// Lazy-load the modal so the entire MediaPage stack (folders / canvas /
// viewer / upload queue) doesn't ship in the eager admin-layouts chunk.
// The control surface itself is tiny — a thumbnail + a "Browse" button —
// so paying the modal's ~10 KB price only on first click is the right
// trade-off. Also lets the `layouts-*.js` bundle-size budget stay tight.
const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)

type MediaKind = 'image' | 'video'
type MediaMode = 'library' | 'url'

interface MediaLibraryControlProps extends ControlProps<string> {
  mediaKind: MediaKind
}

const MEDIA_SOURCE_OPTIONS = [
  { value: 'library', label: 'Library', ariaLabel: 'Media library' },
  { value: 'url', label: 'URL', ariaLabel: 'Custom URL' },
] satisfies ReadonlyArray<{ value: MediaMode; label: string; ariaLabel: string }>

function isLocalMediaPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (char === '\\' || code <= 31) return false
  }
  return true
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function isValidMediaUrl(value: string, mediaKind: MediaKind): boolean {
  if (!value) return true
  if (isLocalMediaPath(value)) return true
  if (mediaKind === 'image') return isValidImageUrl(value)
  return isHttpUrl(value)
}

function startsInUrlMode(value: string): boolean {
  return Boolean(value) && !value.startsWith('/uploads/')
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return ''
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 102.4) / 10} KB`
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`
}

export function MediaLibraryControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
  layout,
  mediaKind,
}: MediaLibraryControlProps) {
  const currentValue = String(value ?? '')
  const [mode, setMode] = useState<MediaMode>(() => startsInUrlMode(currentValue) ? 'url' : 'library')
  const [pickerOpen, setPickerOpen] = useState(false)
  // We still fetch the asset list ONCE on mount so the "currently picked"
  // preview can show the right thumbnail + blurhash for the field's
  // saved publicPath. The modal mounts its own workspace when opened —
  // not used here.
  const [cmsAssets, setCmsAssets] = useState<CmsMediaAsset[]>([])
  const [libraryError, setLibraryError] = useState('')
  // Viewer state: when set, the MediaViewerWindow opens with this asset.
  // The viewer is the same draggable window the Media page uses, so the
  // user can edit alt text, caption, tags, focal point, replace the file,
  // etc. — all from inside the editor canvas without leaving the page.
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null)
  const [urlDraftState, setUrlDraftState] = useState(() => ({
    sourceValue: currentValue,
    draft: currentValue,
  }))

  useEffect(() => {
    let cancelled = false
    listCmsMediaAssets()
      .then((nextAssets) => {
        if (!cancelled) setCmsAssets(nextAssets)
      })
      .catch((err) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Unable to load media library'
          setLibraryError(message === 'Unauthorized' ? 'Sign in again to use CMS media.' : message)
        }
      })
    return () => { cancelled = true }
  }, [])

  const modeLabel = mediaKind === 'image' ? 'image' : 'video'
  const validCurrentValue = isValidMediaUrl(currentValue, mediaKind)
  const currentAsset = useMemo(
    () => cmsAssets.find((asset) => asset.publicPath === currentValue) ?? null,
    [cmsAssets, currentValue],
  )
  const viewerAsset = useMemo(
    () => cmsAssets.find((asset) => asset.id === viewerAssetId) ?? null,
    [cmsAssets, viewerAssetId],
  )
  // The viewer needs a `MediaAssetEditor` handle that wraps the same
  // mutations the Media page uses. We don't track folders here (the inspector
  // doesn't care which folder an asset lives in), but tag autocomplete still
  // works because the palette is derived from the loaded asset list.
  const viewerEditor = useStandaloneMediaEditor({
    asset: viewerAsset,
    assets: cmsAssets,
    onAssetChanged: (asset) =>
      setCmsAssets((current) => current.map((item) => item.id === asset.id ? asset : item)),
    onAssetRemoved: (id) => {
      setCmsAssets((current) => current.filter((item) => item.id !== id))
      if (viewerAssetId === id) setViewerAssetId(null)
    },
  })
  const showUrlPreview = validCurrentValue && currentValue
  const urlDraft = urlDraftState.sourceValue === currentValue ? urlDraftState.draft : currentValue
  const urlError = !isValidMediaUrl(urlDraft, mediaKind)

  function openViewer() {
    if (currentAsset) setViewerAssetId(currentAsset.id)
  }

  function handleUrlChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value
    const valid = isValidMediaUrl(nextValue, mediaKind)
    setUrlDraftState({ sourceValue: currentValue, draft: nextValue })
    if (valid) onChange(propKey, nextValue)
  }

  function handlePickFromModal(asset: CmsMediaAsset) {
    // Keep the local asset cache up to date so the "currently picked"
    // preview can render the right thumb without re-fetching.
    setCmsAssets((current) => {
      if (current.some((a) => a.id === asset.id)) return current
      return [asset, ...current]
    })
    onChange(propKey, asset.publicPath)
  }

  function handleClear() {
    onChange(propKey, '')
  }

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      inputId={`ctrl-${propKey}`}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
      labelSuffix={mode === 'url' && urlError ? (
        <span className={controlRowStyles.labelError} role="alert">
          Invalid {modeLabel} URL
        </span>
      ) : undefined}
    >
      <div className={styles.mediaPicker}>
        <SegmentedControl<MediaMode>
          value={mode}
          options={MEDIA_SOURCE_OPTIONS}
          onChange={setMode}
          size="sm"
          fullWidth
          disabled={disabled}
          aria-label={`${label ?? propKey} source`}
        />

        {mode === 'library' ? (
          <div className={styles.mediaLibraryBody}>
            <CurrentPickedTile
              asset={currentAsset}
              mediaKind={mediaKind}
              currentValue={currentValue}
              onOpenViewer={currentAsset ? openViewer : null}
            />
            <div className={styles.mediaPickerActions}>
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => setPickerOpen(true)}
                aria-label={`Browse ${modeLabel} library`}
              >
                <ImagesSolidIcon size={13} />
                <span>{currentAsset ? `Change ${modeLabel}` : `Browse library…`}</span>
              </Button>
              {currentAsset && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={openViewer}
                  aria-label={`Edit ${modeLabel} in viewer`}
                  tooltip="Edit asset (alt text, caption, tags…)"
                >
                  <EditSolidIcon size={13} />
                  <span>Edit</span>
                </Button>
              )}
              {currentValue && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={handleClear}
                  aria-label={`Clear ${modeLabel}`}
                >
                  Clear
                </Button>
              )}
            </div>
            {libraryError && (
              <p className={styles.mediaStatus} role="alert">{libraryError}</p>
            )}
          </div>
        ) : (
          <div className={styles.mediaUrlBody}>
            {showUrlPreview && mediaKind === 'image' && (
              <div className={styles.imagePreview}>
                <img
                  src={currentValue}
                  alt="preview"
                  className={styles.imagePreviewImg}
                  onError={(event) => {
                    ;(event.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              </div>
            )}
            {showUrlPreview && mediaKind === 'video' && (
              <div className={styles.videoPreview} aria-hidden="true">
                <VideoSolidIcon size={16} />
                <span>{currentValue}</span>
              </div>
            )}
            <Input
              id={`ctrl-${propKey}`}
              type="url"
              value={urlDraft}
              placeholder={mediaKind === 'image' ? 'https://example.com/image.png' : 'https://example.com/video.mp4'}
              disabled={disabled}
              onChange={handleUrlChange}
              invalid={urlError}
            />
          </div>
        )}
      </div>

      {pickerOpen && (
        <Suspense fallback={null}>
          <MediaPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            mediaKind={mediaKind}
            currentValue={currentValue}
            onPick={handlePickFromModal}
          />
        </Suspense>
      )}

      <MediaViewerWindow
        editor={viewerEditor}
        open={viewerAsset !== null}
        onClose={() => setViewerAssetId(null)}
      />
    </ControlRow>
  )
}

interface CurrentPickedTileProps {
  asset: CmsMediaAsset | null
  mediaKind: MediaKind
  currentValue: string
  /**
   * Called when the user clicks the tile. Only wired when an asset is
   * loaded — the tile renders as a non-interactive `<div>` for empty /
   * unresolved states so it doesn't pretend to be clickable when the
   * viewer has nothing to show.
   */
  onOpenViewer: (() => void) | null
}

function CurrentPickedTile({ asset, mediaKind, currentValue, onOpenViewer }: CurrentPickedTileProps) {
  // The "currently picked" affordance gets a proper thumbnail + filename so
  // the user can never guess what's saved on the field. Three states:
  //   1. asset matched in the library → real thumb + blurhash bg, clickable
  //      (opens the MediaViewerWindow for editing alt text, caption, tags,
  //      focal point, replace file…)
  //   2. publicPath set but library hasn't matched yet (loading / stale) →
  //      filename derived from the path, non-interactive
  //   3. nothing saved → empty hint, non-interactive
  if (!asset && !currentValue) {
    return (
      <div className={styles.mediaCurrentEmpty}>
        <span className={styles.mediaCurrentEmptyIcon} aria-hidden="true">
          {mediaKind === 'image' ? <ImagesSolidIcon size={18} /> : <VideoSolidIcon size={18} />}
        </span>
        <span>No {mediaKind} selected</span>
      </div>
    )
  }

  if (!asset) {
    // We have a saved URL but no matched asset (probably a /uploads/ path
    // that got deleted, or the library is still loading).
    const filename = currentValue.split('/').pop() ?? currentValue
    return (
      <div className={styles.mediaCurrent}>
        <span className={styles.mediaCurrentThumb} aria-hidden="true">
          {mediaKind === 'image' ? <ImagesSolidIcon size={18} /> : <VideoSolidIcon size={18} />}
        </span>
        <span className={styles.mediaCurrentMeta}>
          <span className={styles.mediaCurrentName}>{filename}</span>
          <span className={styles.mediaCurrentSub}>Saved path</span>
        </span>
      </div>
    )
  }

  const thumbUrl = mediaKind === 'image' ? pickVariantUrl(asset, 48) : null
  const blurUrl = mediaKind === 'image' ? blurHashToDataUrl(asset.blurHash) : null
  const thumbStyle = blurUrl
    ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as React.CSSProperties)
    : undefined
  const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : null
  const subParts = [
    asset.mimeType,
    formatBytes(asset.sizeBytes),
    dimensions,
  ].filter(Boolean).join(' · ')

  // Tile body content — same shape whether it renders inside a Button
  // primitive or a plain <div>. Pulled out so we don't duplicate the JSX.
  const body = (
    <>
      <span className={styles.mediaCurrentThumb} aria-hidden="true" style={thumbStyle}>
        {mediaKind === 'image' && thumbUrl ? (
          <img src={thumbUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <VideoSolidIcon size={18} />
        )}
      </span>
      <span className={styles.mediaCurrentMeta}>
        <span className={styles.mediaCurrentName}>{asset.filename}</span>
        {subParts && <span className={styles.mediaCurrentSub}>{subParts}</span>}
      </span>
    </>
  )

  if (onOpenViewer) {
    return (
      <Button
        variant="ghost"
        size="sm"
        shape="flush"
        align="start"
        className={styles.mediaCurrentClickable}
        onClick={onOpenViewer}
        aria-label={`Edit ${asset.filename} in viewer`}
        tooltip="Click to edit this asset (alt text, caption, tags…)"
      >
        {body}
      </Button>
    )
  }

  return <div className={styles.mediaCurrent}>{body}</div>
}
