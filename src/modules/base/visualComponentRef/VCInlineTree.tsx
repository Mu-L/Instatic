/**
 * VCInlineTree — lightweight React renderer for an instantiated VC node map.
 *
 * Architecture source: Contribution #619 §8.5
 *
 * Renders a flat VCNode map (produced by instantiateVCAtRef) as a React subtree.
 * Nodes are rendered using the module registry — no Zustand subscriptions, no
 * NodeWrapper (inner nodes are not selectable in this context).
 *
 * base.visual-component-ref nodes are delegated back to VisualComponentRefEditor
 * via the registry, which uses the store to look up the VC and recursively
 * renders another VCInlineTree. This provides natural recursive rendering with
 * cycle safety guaranteed by the recursion guard at write boundaries.
 *
 * Class resolution:
 * - Each node's `classIds` is resolved against the site's class registry and
 *   passed to the module component as `mcClassName`. This mirrors the publisher
 *   so that user CSS classes apply identically in the editor preview and in
 *   the published HTML.
 * - The page-level ref node's own classIds (`rootMcClassName`) are merged
 *   onto the first rendered VC root element so styles on the ref instance
 *   reach the rendered output — same contract as the publisher's
 *   `injectClassIntoRootElement`.
 *
 * `base.body` is transparent in inline preview. The real iframe `<body>`
 * belongs to the page/VC edit canvas root only; a nested component body's
 * children are the component instance.
 */

import { registry } from '@core/module-engine'
import type { NodeWrapperProps as NodeWrapperPropsType } from '@core/module-engine'
import type { VCNode } from '@core/visualComponents'
import { classNamesForClassIds, type StyleRuleRegistry } from '@core/page-tree'

interface VCInlineTreeProps {
  /** Flat node map from instantiateVCAtRef */
  nodes: Record<string, VCNode>
  /** ID of the root node — entry point for traversal */
  rootNodeId: string
  /** Site class registry — used to resolve each node's classIds → class names */
  classes: StyleRuleRegistry
  /** Class string from the page-level ref node (its own classIds resolved) — merged onto the first rendered root */
  rootMcClassName?: string
  /**
   * Editor wrapper bag (data-node-id, onClick, etc.) for the PAGE-LEVEL
   * ref node — forwarded onto the VC's first rendered root element so the
   * canvas selection logic targets the rendered ref instead of a dropped
   * wrapper or the iframe body.
   */
  rootNodeWrapperProps?: NodeWrapperPropsType
}

export function VCInlineTree({ nodes, rootNodeId, classes, rootMcClassName, rootNodeWrapperProps }: VCInlineTreeProps) {
  return (
    <VCNodeRenderer
      nodeId={rootNodeId}
      nodes={nodes}
      classes={classes}
      extraClassName={rootMcClassName}
      extraNodeWrapperProps={rootNodeWrapperProps}
    />
  )
}

// ---------------------------------------------------------------------------
// VCNodeRenderer — recursive node renderer (no NodeWrapper, not selectable)
// ---------------------------------------------------------------------------

interface VCNodeRendererProps {
  nodeId: string
  nodes: Record<string, VCNode>
  classes: StyleRuleRegistry
  /** Extra class string merged onto this node's mcClassName (first rendered root only). */
  extraClassName?: string
  /**
   * Editor wrapper bag forwarded onto the first rendered root so the canvas
   * selection logic targets the rendered VC ref. Child nodes inside the VC
   * tree aren't independently selectable in page mode, so we don't forward
   * this further down the recursion.
   */
  extraNodeWrapperProps?: NodeWrapperPropsType
}

function VCNodeRenderer({ nodeId, nodes, classes, extraClassName, extraNodeWrapperProps }: VCNodeRendererProps) {
  const node = nodes[nodeId]
  if (!node) return null
  if (node.hidden) return null

  if (node.moduleId === 'base.body') {
    const firstRenderableChildId = node.children.find((childId) => isRenderableNode(nodes, childId))
    return (
      <>
        {node.children.map((childId) => (
          <VCNodeRenderer
            key={childId}
            nodeId={childId}
            nodes={nodes}
            classes={classes}
            extraClassName={childId === firstRenderableChildId ? extraClassName : undefined}
            extraNodeWrapperProps={childId === firstRenderableChildId ? extraNodeWrapperProps : undefined}
          />
        ))}
      </>
    )
  }

  const definition = registry.get(node.moduleId)
  if (!definition) return null

  const ComponentType = definition.component

  const children = node.children.map((childId) => (
    <VCNodeRenderer key={childId} nodeId={childId} nodes={nodes} classes={classes} />
  ))

  const ownClassNames = classNamesForClassIds(classes, node.classIds)
  const merged = [extraClassName, ...ownClassNames].filter(Boolean).join(' ')
  const mcClassName = merged.length > 0 ? merged : ''

  return (
    <ComponentType
      props={node.props as never}
      nodeId={node.id}
      isSelected={false}
      mcClassName={mcClassName}
      nodeWrapperProps={extraNodeWrapperProps}
    >
      {children}
    </ComponentType>
  )
}

function isRenderableNode(nodes: Record<string, VCNode>, nodeId: string): boolean {
  const node = nodes[nodeId]
  if (!node || node.hidden) return false
  if (node.moduleId === 'base.body') {
    return node.children.some((childId) => isRenderableNode(nodes, childId))
  }
  return Boolean(registry.get(node.moduleId))
}
