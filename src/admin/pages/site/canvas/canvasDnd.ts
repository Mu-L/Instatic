import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree/treeSchema'
import {
  resolvePageTreeDropTarget,
  type PageTreeDropPosition,
  type PageTreeDropTarget,
} from '@core/page-tree/dnd'

export interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type CanvasDropAxis = 'vertical' | 'horizontal'

export interface CanvasDropCandidate {
  nodeId: string
  depth: number
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasDropTarget extends PageTreeDropTarget {
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasInvalidDropTarget {
  overId: string
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasDropResolution {
  target: CanvasDropTarget | null
  invalid: CanvasInvalidDropTarget | null
}

interface ResolveCanvasDropTargetInput {
  tree: NodeTree<PageNode>
  draggedId: string
  draggedIds: string[]
  candidates: CanvasDropCandidate[]
  point: CanvasPoint
  canHaveChildren: (moduleId: string) => boolean
}

const MIN_EDGE_HIT_ZONE = 8
const MAX_EDGE_HIT_ZONE = 20
const EDGE_ZONE_RATIO = 0.26

export function getCanvasDropZone(
  candidate: CanvasDropCandidate,
  point: CanvasPoint,
): PageTreeDropPosition {
  const { rect, axis } = candidate
  const size = axis === 'horizontal' ? rect.width : rect.height
  const edgeBand = Math.max(
    MIN_EDGE_HIT_ZONE,
    Math.min(MAX_EDGE_HIT_ZONE, size * EDGE_ZONE_RATIO),
  )

  if (axis === 'horizontal') {
    const offset = point.x - rect.left
    if (offset <= edgeBand) return 'before'
    if (offset >= rect.width - edgeBand) return 'after'
    return 'inside'
  }

  const offset = point.y - rect.top
  if (offset <= edgeBand) return 'before'
  if (offset >= rect.height - edgeBand) return 'after'
  return 'inside'
}

export function resolveCanvasDropTarget({
  tree,
  draggedId,
  draggedIds,
  candidates,
  point,
  canHaveChildren,
}: ResolveCanvasDropTargetInput): CanvasDropResolution {
  const candidate = findCanvasDropCandidate(candidates, point)
  if (!candidate) return { target: null, invalid: null }

  const zone = getCanvasDropZone(candidate, point)
  const target = resolvePageTreeDropTarget({
    tree,
    draggedId,
    draggedIds,
    overId: candidate.nodeId,
    zone,
    canHaveChildren,
  })

  if (!target) {
    return {
      target: null,
      invalid: {
        overId: candidate.nodeId,
        rect: candidate.rect,
        axis: candidate.axis,
      },
    }
  }

  return {
    target: {
      ...target,
      rect: candidate.rect,
      axis: candidate.axis,
    },
    invalid: null,
  }
}

function findCanvasDropCandidate(
  candidates: CanvasDropCandidate[],
  point: CanvasPoint,
): CanvasDropCandidate | null {
  const containing = candidates.filter((candidate) => containsPoint(candidate.rect, point))
  if (containing.length === 0) return null

  return containing.sort((a, b) => {
    const depthDiff = b.depth - a.depth
    if (depthDiff !== 0) return depthDiff
    return area(a.rect) - area(b.rect)
  })[0] ?? null
}

function containsPoint(rect: CanvasRect, point: CanvasPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  )
}

function area(rect: CanvasRect): number {
  return rect.width * rect.height
}
