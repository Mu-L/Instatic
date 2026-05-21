/**
 * CanvasPreviewSurface — full-bleed preview shell shown when canvasView is
 * 'preview'.
 *
 * Replaces the design canvas entirely (no pan/zoom, no transform layer, no
 * selection / hover machinery, no insert toolbar). The user is testing the
 * page, not editing it — so the surface is built around a single iframe
 * centered in the available space, plus two side handles that let the user
 * shrink the iframe width to test responsive behaviour at narrower viewports.
 *
 * Responsibilities:
 * - Owns the runtime preview build (one iframe, current active breakpoint).
 * - Computes the iframe's "natural" width as min(breakpoint.width,
 *   containerWidth) and resets the user-resized width back to it whenever the
 *   active breakpoint changes (a context switch should feel fresh).
 * - Renders side resize handles that shrink the iframe symmetrically (it
 *   stays centered) down to a minimum width.
 * - Surfaces the runtime status pill + Refresh button in its own chrome row
 *   (separate from the canvas mode toggle which lives at the canvas root).
 *
 * Architecture note:
 * BreakpointFrame is design-only after this redesign. It still exists, but it
 * no longer cares about preview mode. The preview surface owns its own iframe
 * via useRuntimePreviewBuild + CanvasRuntimePreview.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import type { Breakpoint, Page } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { CanvasRuntimePreview } from './CanvasRuntimePreview'
import {
  useRuntimePreviewBuild,
  type RuntimePreviewBuildState,
  type RuntimePreviewStatus,
} from './useRuntimePreviewBuild'
import { Tooltip } from '@ui/components/Tooltip'
import { EmptyState } from '@ui/components/EmptyState'
import styles from './CanvasPreviewSurface.module.css'

/**
 * The user-resize override is scoped to a specific breakpoint id. Switching
 * breakpoints invalidates a previous override automatically (the derivation
 * just ignores it), so the iframe snaps back to the new breakpoint's natural
 * width without us needing setState in a useEffect.
 */
interface PreviewWidthOverride {
  breakpointId: string
  width: number
}

interface CanvasPreviewSurfaceProps {
  page: Page | null
  activeBreakpoint: Breakpoint | null
  templateContext?: TemplateRenderDataContext
}

/**
 * Hard floor on the iframe width so the user can't shrink it into nothing.
 * 240px is roughly a small-phone breakpoint; below that the published page
 * tends to lose its layout entirely.
 */
const PREVIEW_MIN_WIDTH = 240

/**
 * The iframe width is symmetric around the centre of the surface — dragging
 * either handle inwards shrinks both sides simultaneously. So one pixel of
 * pointer travel changes the visible width by 2 pixels.
 */
const SYMMETRIC_DRAG_FACTOR = 2

interface ResizeDragState {
  startClientX: number
  startWidth: number
  side: 'left' | 'right'
}

export function CanvasPreviewSurface({ page, activeBreakpoint, templateContext }: CanvasPreviewSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ResizeDragState | null>(null)

  // Available horizontal space inside the preview surface. Tracked via
  // ResizeObserver so the iframe can fall back to "fill" when the breakpoint
  // is wider than the canvas.
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  // User-resized width, tagged with the breakpoint it was set on. Switching
  // breakpoints automatically invalidates this (we ignore overrides whose id
  // no longer matches), so we don't need a useEffect to reset state.
  const [widthOverride, setWidthOverride] = useState<PreviewWidthOverride | null>(null)

  useEffect(() => {
    const node = surfaceRef.current
    if (!node) return

    const update = () => setContainerWidth(node.clientWidth)
    update()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const naturalWidth = computeNaturalWidth(activeBreakpoint, containerWidth)
  const effectiveMaxWidth = naturalWidth ?? containerWidth ?? null
  // Honour the user's drag only while the breakpoint id still matches —
  // switching to a different breakpoint discards the override transparently.
  const effectiveWidth = activeBreakpoint && widthOverride?.breakpointId === activeBreakpoint.id
    ? widthOverride.width
    : naturalWidth

  const handlePointerDown = useCallback(
    (side: 'left' | 'right') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (effectiveWidth === null || !activeBreakpoint) return
      dragRef.current = {
        startClientX: event.clientX,
        startWidth: effectiveWidth,
        side,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [effectiveWidth, activeBreakpoint],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || !activeBreakpoint) return
      const max = effectiveMaxWidth ?? drag.startWidth
      setWidthOverride({
        breakpointId: activeBreakpoint.id,
        width: computeResizedWidth(drag, event.clientX, max),
      })
    },
    [effectiveMaxWidth, activeBreakpoint],
  )

  const finishDrag = useCallback(() => {
    dragRef.current = null
  }, [])

  // Build the runtime preview iframe. The hook handles a null `page` itself
  // (it idles without firing a build), so we don't need to gate the call.
  const previewBuild = useRuntimePreviewBuild({
    page,
    breakpointId: activeBreakpoint?.id ?? '',
    templateContext,
    enabled: page !== null && activeBreakpoint !== null,
  })

  const stopCanvasInteraction = useCallback((event: SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  return (
    <div
      ref={surfaceRef}
      className={styles.surface}
      data-testid="canvas-preview-surface"
      onClick={stopCanvasInteraction}
    >
      {/* Status pill — top-right of the surface. Sibling-positioned (absolute)
          so it doesn't move when the iframe width changes. */}
      <div className={styles.chromeRow} onClick={stopCanvasInteraction}>
        <RuntimePreviewChromeStatus build={previewBuild} />
      </div>

      {page && activeBreakpoint && effectiveWidth !== null ? (
        <div
          className={styles.frame}
          style={{ '--preview-width': `${effectiveWidth}px` } as CSSProperties}
        >
          <PreviewResizeHandle
            side="left"
            onPointerDown={handlePointerDown('left')}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          />

          <div className={styles.iframeViewport}>
            <CanvasRuntimePreview page={page} srcDoc={previewBuild.srcDoc} />
          </div>

          <PreviewResizeHandle
            side="right"
            onPointerDown={handlePointerDown('right')}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          />

          <div className={styles.widthBadge} aria-hidden="true">
            {Math.round(effectiveWidth)}px
          </div>
        </div>
      ) : (
        <EmptyState
          variant="centered"
          className={styles.emptyState}
          title="No page selected"
          description="Open a page to preview it."
        />
      )}
    </div>
  )
}

function computeNaturalWidth(
  breakpoint: Breakpoint | null,
  containerWidth: number | null,
): number | null {
  if (!breakpoint) return null
  if (containerWidth === null) return breakpoint.width
  return Math.min(breakpoint.width, containerWidth)
}

function computeResizedWidth(drag: ResizeDragState, clientX: number, max: number): number {
  const delta = clientX - drag.startClientX
  // Each handle drags symmetrically: moving the left handle right OR the
  // right handle left both shrink the iframe (the iframe stays centred).
  const widthDelta = drag.side === 'left'
    ? -delta * SYMMETRIC_DRAG_FACTOR
    : delta * SYMMETRIC_DRAG_FACTOR
  const next = drag.startWidth + widthDelta
  return Math.max(PREVIEW_MIN_WIDTH, Math.min(max, next))
}

// ---------------------------------------------------------------------------
// Side resize handle — vertical bar on the iframe edge. Pointer capture lets
// the drag follow the cursor even when it overshoots the handle's own bounds.
// ---------------------------------------------------------------------------

interface PreviewResizeHandleProps {
  side: 'left' | 'right'
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
}

function PreviewResizeHandle({
  side,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: PreviewResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize preview from ${side}`}
      data-side={side}
      data-testid={`canvas-preview-resize-${side}`}
      className={styles.resizeHandle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span className={styles.resizeGrip} aria-hidden="true" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status pill — same idea as the design-mode chrome status, just lifted up
// to live in the preview surface itself rather than per-frame label rows.
// ---------------------------------------------------------------------------

function statusLabel(status: RuntimePreviewStatus, build: RuntimePreviewBuildState): string {
  if (status === 'building') return 'Building'
  if (status === 'error') {
    return build.diagnostics[0]?.packageName ?? build.diagnostics[0]?.message ?? 'Runtime error'
  }
  if (status === 'idle') return 'Idle'
  return 'Live'
}

interface RuntimePreviewChromeStatusProps {
  build: RuntimePreviewBuildState
}

function RuntimePreviewChromeStatus({ build }: RuntimePreviewChromeStatusProps) {
  return (
    <div
      className={styles.statusPill}
      data-status={build.status}
      role="status"
      aria-live="polite"
    >
      <span className={styles.statusLabel}>{statusLabel(build.status, build)}</span>
      <Tooltip content="Rebuild preview from current site state">
        <button
          type="button"
          className={styles.refreshButton}
          onClick={(e) => {
            e.stopPropagation()
            build.refresh()
          }}
          disabled={build.status === 'building'}
          data-testid="canvas-runtime-preview-refresh"
          aria-label="Refresh preview"
        >
          Refresh
        </button>
      </Tooltip>
    </div>
  )
}
