import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree/treeSchema'
import type {
  CanvasDropAxis,
  CanvasDropCandidate,
  CanvasRect,
} from './canvasDnd'

const CANVAS_NODE_SELECTOR = '[data-node-id]'

export function getViewportLocalPoint(
  viewport: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const viewportRect = viewport.getBoundingClientRect()
  const scale = getViewportScale(viewport, viewportRect)
  return {
    x: (clientX - viewportRect.left) / scale,
    y: (clientY - viewportRect.top) / scale,
  }
}

export function measureCanvasNodeClientUnionRect(
  viewport: HTMLElement,
  nodeIds: readonly string[],
): CanvasRect | null {
  let union: CanvasRect | null = null

  for (const id of nodeIds) {
    const target = getCanvasNodeRenderElement(viewport, id)
    if (!target) continue

    const rect = target.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue

    const next = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    }
    union = union
      ? {
          left: Math.min(union.left, next.left),
          top: Math.min(union.top, next.top),
          right: Math.max(union.right, next.right),
          bottom: Math.max(union.bottom, next.bottom),
          width: Math.max(union.right, next.right) - Math.min(union.left, next.left),
          height: Math.max(union.bottom, next.bottom) - Math.min(union.top, next.top),
        }
      : next
  }

  return union
}

export function measureCanvasDropCandidates(
  viewport: HTMLElement,
  tree: NodeTree<PageNode>,
): CanvasDropCandidate[] {
  const depths = buildDepthMap(tree)
  const wrappers = Array.from(viewport.querySelectorAll<HTMLElement>(CANVAS_NODE_SELECTOR))
  const candidates: CanvasDropCandidate[] = []

  for (const wrapper of wrappers) {
    const nodeId = wrapper.dataset.nodeId
    if (!nodeId) continue
    const node = tree.nodes[nodeId]
    if (!node || node.hidden) continue

    const target = getRenderedElement(wrapper)
    const targetRect = target.getBoundingClientRect()
    if (targetRect.width === 0 && targetRect.height === 0) continue

    candidates.push({
      nodeId,
      depth: depths.get(nodeId) ?? 0,
      rect: clientRectToViewportRect(viewport, targetRect),
      axis: inferCanvasDropAxis(target),
    })
  }

  return candidates
}

function getCanvasNodeRenderElement(
  viewport: HTMLElement,
  nodeId: string,
): HTMLElement | null {
  const wrapper = viewport.querySelector<HTMLElement>(
    `[data-node-id="${escapeAttribute(nodeId)}"]`,
  )
  if (!wrapper) return null
  return getRenderedElement(wrapper)
}

function getRenderedElement(wrapper: HTMLElement): HTMLElement {
  const child = wrapper.firstElementChild
  return child instanceof HTMLElement ? child : wrapper
}

function clientRectToViewportRect(
  viewport: HTMLElement,
  rect: DOMRect,
): CanvasRect {
  const viewportRect = viewport.getBoundingClientRect()
  const scale = getViewportScale(viewport, viewportRect)
  const left = (rect.left - viewportRect.left) / scale
  const top = (rect.top - viewportRect.top) / scale
  const width = rect.width / scale
  const height = rect.height / scale

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  }
}

function getViewportScale(viewport: HTMLElement, viewportRect: DOMRect): number {
  return viewport.offsetWidth > 0 ? viewportRect.width / viewport.offsetWidth : 1
}

function inferCanvasDropAxis(target: HTMLElement): CanvasDropAxis {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return 'vertical'
  }

  const parent = findLayoutParent(target)
  if (!parent) return 'vertical'

  const style = window.getComputedStyle(parent)
  if (style.display.includes('flex') && style.flexDirection.startsWith('row')) {
    return 'horizontal'
  }

  return 'vertical'
}

function findLayoutParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(parent)
      : null
    if (style?.display !== 'contents') return parent
    parent = parent.parentElement
  }
  return null
}

function buildDepthMap(tree: NodeTree<PageNode>): Map<string, number> {
  const depths = new Map<string, number>()
  const stack: Array<{ id: string; depth: number }> = [{ id: tree.rootNodeId, depth: 0 }]

  while (stack.length > 0) {
    const { id, depth } = stack.pop()!
    if (depths.has(id)) continue
    depths.set(id, depth)
    const node = tree.nodes[id]
    if (!node) continue
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ id: node.children[i], depth: depth + 1 })
    }
  }

  return depths
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
