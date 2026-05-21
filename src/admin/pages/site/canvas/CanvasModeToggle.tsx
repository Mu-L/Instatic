/**
 * CanvasModeToggle — Design / Preview switch for the canvas surface.
 *
 * - Design mode: the live React-based module renderer is shown. Property edits
 *   are reactive, no scripts are executed in the canvas.
 * - Preview mode: the runtime-preview iframe is shown. Site scripts run in
 *   their sandbox and authors can interact with them. Property/class edits do
 *   not auto-rebuild the iframe; the user clicks Refresh (or navigates page,
 *   breakpoint, or edits scripts/deps) to rebuild.
 *
 * The two modes are mutually exclusive. Design mode keeps the multi-breakpoint
 * canvas; preview mode replaces it with a single full-bleed iframe (see
 * CanvasPreviewSurface). When preview is active this toggle additionally
 * surfaces a row of breakpoint icon buttons inline so the user can switch the
 * previewed device without leaving the canvas chrome.
 */
import { useCallback, type SyntheticEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { Breakpoint } from '@core/page-tree'
import { CursorMinimalSolidIcon } from 'pixel-art-icons/icons/cursor-minimal-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { SmartphoneSolidIcon } from 'pixel-art-icons/icons/smartphone-solid'
import { TabletSolidIcon } from 'pixel-art-icons/icons/tablet-solid'
import { MonitorSolidIcon } from 'pixel-art-icons/icons/monitor-solid'
import { LaptopSolidIcon } from 'pixel-art-icons/icons/laptop-solid'
import { TvSolidIcon } from 'pixel-art-icons/icons/tv-solid'
import { cn } from '@ui/cn'
import { Tooltip } from '@ui/components/Tooltip'
import styles from './CanvasModeToggle.module.css'

const EMPTY_BREAKPOINTS: Breakpoint[] = []

export function CanvasModeToggle() {
  const view = useEditorStore((s) => s.canvasView)
  const setView = useEditorStore((s) => s.setCanvasView)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)

  // The toggle lives inside the canvas surface, which has its own click /
  // keyboard handlers (deselect, shortcuts, etc.). Stop propagation so the
  // tab buttons feel like chrome, not "clicks on empty canvas".
  const stopCanvasInteraction = useCallback((event: SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  return (
    <div
      className={styles.shell}
      role="tablist"
      aria-label="Canvas mode"
      data-testid="canvas-mode-toggle"
      onClick={stopCanvasInteraction}
    >
      <Tooltip content="Design mode (edit page visually)">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'design'}
          aria-label="Design"
          data-testid="canvas-mode-toggle-design"
          className={cn(styles.tab, view === 'design' && styles.tabActive)}
          onClick={() => setView('design')}
        >
          <CursorMinimalSolidIcon size={14} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip content="Preview mode (run site scripts in sandboxed iframe)">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'preview'}
          aria-label="Preview"
          data-testid="canvas-mode-toggle-preview"
          className={cn(styles.tab, view === 'preview' && styles.tabActive)}
          onClick={() => setView('preview')}
        >
          <EyeSolidIcon size={14} aria-hidden="true" />
        </button>
      </Tooltip>

      {/* Breakpoint switcher — only in preview mode. Design mode keeps its
          existing breakpoint context selector elsewhere on the canvas chrome. */}
      {view === 'preview' && breakpoints.length > 0 && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <div
            role="radiogroup"
            aria-label="Preview breakpoint"
            className={styles.breakpointGroup}
            data-testid="canvas-preview-breakpoints"
          >
            {breakpoints.map((breakpoint) => {
              const active = breakpoint.id === activeBreakpointId
              return (
                <Tooltip
                  key={breakpoint.id}
                  content={`${breakpoint.label} · ${breakpoint.width}px`}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`Preview at ${breakpoint.label} (${breakpoint.width}px)`}
                    data-testid={`canvas-preview-breakpoint-${breakpoint.id}`}
                    className={cn(styles.tab, active && styles.tabActive)}
                    onClick={() => setActiveBreakpoint(breakpoint.id)}
                  >
                    <BreakpointIcon name={breakpoint.icon} />
                  </button>
                </Tooltip>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function BreakpointIcon({ name }: { name: string }) {
  switch (name) {
    case 'smartphone':
      return <SmartphoneSolidIcon size={14} aria-hidden="true" />
    case 'tablet':
      return <TabletSolidIcon size={14} aria-hidden="true" />
    case 'laptop':
      return <LaptopSolidIcon size={14} aria-hidden="true" />
    case 'tv':
      return <TvSolidIcon size={14} aria-hidden="true" />
    case 'monitor':
    default:
      return <MonitorSolidIcon size={14} aria-hidden="true" />
  }
}
