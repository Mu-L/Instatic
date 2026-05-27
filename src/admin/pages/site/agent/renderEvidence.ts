import type {
  AgentLayoutImageContext,
  AgentLayoutNodeContext,
  AgentLayoutRect,
  AgentLayoutReportContext,
  AgentLayoutWarningContext,
  AgentRenderSnapshotPayload,
  AgentScreenshotContext,
} from './types'

const MAX_TEXT_LENGTH = 300
const OVERFLOW_TOLERANCE_PX = 2

interface CaptureRenderSnapshotOptions {
  /** Configured breakpoint id to capture. Defaults to the first canvas frame. */
  breakpointId?: string
  /** When false, only layout is collected (no html-to-image) — faster. */
  captureScreenshot?: boolean
}

/**
 * Capture a single canvas frame on demand: layout report + optional screenshot.
 *
 * Called by the browser-bridge `render_snapshot` tool path when Claude
 * actually asks for visual feedback — never on every prompt build (that's
 * the expensive html-to-image cost we used to pay regardless).
 *
 * Returns null when no matching canvas frame exists in the DOM (e.g. when
 * the editor isn't mounted, or the requested breakpoint isn't on screen).
 */
export async function captureAgentRenderSnapshot({
  breakpointId,
  captureScreenshot = true,
}: CaptureRenderSnapshotOptions = {}): Promise<AgentRenderSnapshotPayload | null> {
  if (typeof document === 'undefined') return null

  const frame = findCanvasFrame(breakpointId)
  if (!frame) return null

  const resolvedBreakpointId = frame.dataset.breakpointId ?? breakpointId ?? ''
  const layout = collectLayoutReport(frame, resolvedBreakpointId)
  const screenshot = captureScreenshot
    ? await captureFrameScreenshot(frame)
    : unavailableScreenshot('Screenshot capture not requested.')

  return {
    breakpointId: resolvedBreakpointId,
    label: resolvedBreakpointId,
    width: Math.round(frame.getBoundingClientRect().width),
    capturedAt: Date.now(),
    screenshot,
    layout,
  }
}

function findCanvasFrame(breakpointId?: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  if (breakpointId) {
    const exact = document.querySelector<HTMLElement>(
      `[data-breakpoint-id="${cssAttrEscape(breakpointId)}"]`,
    )
    if (exact) return exact
  }
  return document.querySelector<HTMLElement>('[data-breakpoint-id]')
}

function cssAttrEscape(value: string): string {
  // Escape attribute-value double quotes/backslashes so the selector parses.
  return value.replace(/[\\"]/g, '\\$&')
}

function collectLayoutReport(frame: HTMLElement, breakpointId: string): AgentLayoutReportContext {
  const frameRect = frame.getBoundingClientRect()
  const viewport = {
    width: Math.round(frameRect.width || frame.clientWidth),
    height: Math.round(frameRect.height || frame.clientHeight),
    scrollWidth: frame.scrollWidth,
    scrollHeight: frame.scrollHeight,
  }

  const warnings: AgentLayoutWarningContext[] = []
  if (frame.scrollWidth > frame.clientWidth + OVERFLOW_TOLERANCE_PX) {
    warnings.push({
      type: 'horizontal-overflow',
      severity: 'warning',
      message: 'The breakpoint viewport has horizontal overflow.',
    })
  }
  if (frame.scrollHeight > frame.clientHeight + OVERFLOW_TOLERANCE_PX) {
    warnings.push({
      type: 'vertical-overflow',
      severity: 'info',
      message: 'The breakpoint viewport has vertical overflow.',
    })
  }

  const nodes = Array.from(frame.querySelectorAll<HTMLElement>('[data-node-id]'))
    .map((nodeEl) => collectNodeLayout(frameRect, viewport, nodeEl, warnings))

  const images = Array.from(frame.querySelectorAll<HTMLImageElement>('img'))
    .map((img) => collectImageLayout(frameRect, img, warnings))

  return {
    breakpointId,
    viewport,
    nodes,
    images,
    warnings,
  }
}

function collectNodeLayout(
  frameRect: DOMRect,
  viewport: AgentLayoutReportContext['viewport'],
  nodeEl: HTMLElement,
  warnings: AgentLayoutWarningContext[],
): AgentLayoutNodeContext {
  const rect = relativeRect(frameRect, nodeEl.getBoundingClientRect())
  // `nodeEl` IS the rendered element — `data-node-id` is spread directly onto
  // the module's own root tag, so its computed style and overflow geometry
  // describe what the user sees. (Previous code peeked at `firstElementChild`
  // back when a `<div class="nodeWrapper">` sat between `data-node-id` and
  // the rendered tag; that wrapper is gone.)
  const contentEl = nodeEl
  const computed = getComputedStyle(contentEl)
  const text = trimText(nodeEl.textContent ?? '')
  const visible = rect.width > 0 && rect.height > 0 && computed.display !== 'none' && computed.visibility !== 'hidden'
  const nodeId = nodeEl.dataset.nodeId ?? ''

  if (!visible && text) {
    warnings.push({
      type: 'invisible-node',
      severity: 'warning',
      message: 'Node has text content but no visible layout box.',
      nodeId,
    })
  }

  if (rect.x < -OVERFLOW_TOLERANCE_PX || rect.x + rect.width > viewport.width + OVERFLOW_TOLERANCE_PX) {
    warnings.push({
      type: 'horizontal-overflow',
      severity: 'warning',
      message: 'Node extends beyond the breakpoint viewport.',
      nodeId,
    })
  }

  if (
    (computed.overflow === 'hidden' || computed.overflowX === 'hidden' || computed.overflowY === 'hidden') &&
    (contentEl.scrollWidth > contentEl.clientWidth + OVERFLOW_TOLERANCE_PX ||
      contentEl.scrollHeight > contentEl.clientHeight + OVERFLOW_TOLERANCE_PX)
  ) {
    warnings.push({
      type: 'hidden-overflow',
      severity: 'warning',
      message: 'Node content appears clipped by hidden overflow.',
      nodeId,
    })
  }

  return {
    nodeId,
    moduleId: nodeEl.dataset.moduleId,
    label: nodeEl.getAttribute('aria-label') ?? undefined,
    text,
    rect,
    visible,
    computed: {
      display: computed.display,
      position: computed.position,
      overflow: computed.overflow,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
    },
  }
}

function collectImageLayout(
  frameRect: DOMRect,
  img: HTMLImageElement,
  warnings: AgentLayoutWarningContext[],
): AgentLayoutImageContext {
  const wrapper = img.closest<HTMLElement>('[data-node-id]')
  const nodeId = wrapper?.dataset.nodeId
  const image: AgentLayoutImageContext = {
    nodeId,
    src: img.currentSrc || img.src,
    alt: img.alt || undefined,
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    rect: relativeRect(frameRect, img.getBoundingClientRect()),
  }

  if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
    warnings.push({
      type: 'broken-image',
      severity: 'warning',
      message: 'Image is not loaded or has no natural dimensions.',
      nodeId,
    })
  }

  return image
}

async function captureFrameScreenshot(frame: HTMLElement): Promise<AgentScreenshotContext> {
  try {
    const { toPng } = await import('html-to-image')
    const rect = frame.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return unavailableScreenshot('Frame has no visible size.')
    }

    const pixelRatio = Math.min(1, 900 / Math.max(1, rect.width))
    const dataUrl = await toPng(frame, {
      cacheBust: true,
      pixelRatio,
      backgroundColor: '#ffffff',
      imagePlaceholder: '',
    })
    const marker = 'base64,'
    const markerIndex = dataUrl.indexOf(marker)
    return {
      status: 'ok',
      mimeType: 'image/png',
      data: markerIndex >= 0 ? dataUrl.slice(markerIndex + marker.length) : dataUrl,
      width: Math.round(rect.width * pixelRatio),
      height: Math.round(rect.height * pixelRatio),
    }
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : 'Screenshot capture failed.',
    }
  }
}

function unavailableScreenshot(error: string): AgentScreenshotContext {
  return {
    status: 'unavailable',
    error,
  }
}

function relativeRect(frameRect: DOMRectReadOnly, rect: DOMRectReadOnly): AgentLayoutRect {
  return {
    x: round(rect.left - frameRect.left),
    y: round(rect.top - frameRect.top),
    width: round(rect.width),
    height: round(rect.height),
  }
}

function trimText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > MAX_TEXT_LENGTH
    ? `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}...`
    : normalized
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
