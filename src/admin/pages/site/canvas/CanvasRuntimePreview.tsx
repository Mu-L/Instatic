/**
 * CanvasRuntimePreview — presentational shell for the sandboxed runtime
 * iframe. Owns no state of its own; receives the build output from the
 * parent (BreakpointFrame), which calls useRuntimePreviewBuild and also
 * renders the status pill in the frame's chrome row so the iframe area
 * itself stays uncluttered.
 *
 * Preview mode always renders the page (the publisher emits a complete
 * HTML document for any page, scripts or no scripts) so the user sees a
 * live, scrollable rendering of their work. The only time we render
 * nothing is the brief window before the first build resolves; the
 * "Building" status in the frame chrome covers that beat.
 */

import type { Page } from '@core/page-tree'
import styles from './CanvasPreviewSurface.module.css'

interface CanvasRuntimePreviewProps {
  page: Page
  srcDoc: string
}

export function CanvasRuntimePreview({ page, srcDoc }: CanvasRuntimePreviewProps) {
  if (!srcDoc) return null

  return (
    <iframe
      title={`Runtime preview: ${page.title}`}
      data-testid="canvas-runtime-preview"
      className={styles.runtimePreviewFrame}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
    />
  )
}
