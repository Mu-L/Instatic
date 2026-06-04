/**
 * Dynamic-node detection — the single source of truth for "which nodes in
 * a page tree must be deferred to request time."
 *
 * `findDynamicNodeIds(page, site, registry)` classifies every node in a
 * page tree as either static (can be pre-rendered at publish time) or
 * dynamic (must be deferred to request time via a `<instatic-hole>` placeholder).
 * It returns the SET of node IDs that are dynamic; an empty set means the
 * page is fully static.
 *
 * `findDynamicNodesWithReasons(...)` returns the same set PLUS a list of
 * human-readable reason strings for diagnostics.
 *
 * The four detection rules (per spec, "Auto-detection rules"):
 *
 *   1. Module is flagged `dynamic: true` in the registry.
 *   2. Node has a `dynamicBindings` entry whose source is request-dependent
 *      (currently: `route.query.*`).
 *   2b. A string prop value contains a `{source.field}` token whose source is
 *      request-dependent.
 *   3. `moduleId === 'base.loop'` AND the loop source has `requestDependent: true`.
 *   4. `moduleId === 'base.visual-component-ref'` whose VC definition tree
 *      contains any dynamic node (recursive check with cycle guard).
 *
 * VC ref subtlety: when the VC definition tree is dynamic, the OUTER VC ref
 * node id (in the page tree) goes into `dynamicPageNodeIds` — not the inner
 * VC node ids. The hole boundary is the VC ref, not any inner node. Diagnostic
 * reasons collected from inner VC traversal are still appended to the reason
 * list so authors can see WHICH inner construct made the VC dynamic.
 *
 * Layer A's shell-vs-complete decision and Layer C's `renderNode` placeholder
 * emission both consume the id set; diagnostics consume the reason list.
 * Keeping both behind one walker means the rules cannot drift between layers.
 */

import type { Page, SiteDocument, DynamicPropBinding } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { selectVisualComponentById } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import { containsTokens, parseTokenString } from '@core/templates/tokenInterpolation'

// ---------------------------------------------------------------------------
// Binding-source classification
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the given binding source + field resolves at request time
 * rather than at publish time.
 *
 * Single extensibility point for "what counts as request-dependent." Accepts
 * `string` (not the strict `DynamicBindingSource` union) so plugin-registered
 * sources can extend the classification without changing the union type.
 *
 * Built-in classification:
 *   - `route.query.*`     → request-time (varies with URL query string)
 *   - `currentEntry.*`    → publish-time (entry is known at publish)
 *   - `parentEntry.*`     → publish-time
 *   - `page.*`            → publish-time
 *   - `site.*`            → publish-time
 *   - `route.path`        → publish-time (fixed per static route)
 *   - `route.slug`        → publish-time
 */
function isBindingSourceRequestDependent(source: string, field: string): boolean {
  switch (source) {
    case 'route':
      // route.path and route.slug are fixed per static route.
      // route.query and route.query.* vary per visitor URL.
      return field === 'query' || field.startsWith('query.')
    case 'currentEntry':
    case 'parentEntry':
    case 'page':
    case 'site':
      return false
    default:
      // Unknown source — conservatively treated as publish-time deterministic
      // to avoid false positives forcing unnecessary dynamic rendering.
      // Plugin authors adding request-dependent sources should update this
      // function or register sources via a future plugin-source registry.
      return false
  }
}

// ---------------------------------------------------------------------------
// Internal node type
// ---------------------------------------------------------------------------

/**
 * Structural minimum shared by PageNode and VCNode, sufficient for
 * dynamic-classification logic.
 */
interface AnalysisNode {
  id: string
  moduleId: string
  props: Record<string, unknown>
  children: string[]
  dynamicBindings?: Record<string, DynamicPropBinding>
}

// ---------------------------------------------------------------------------
// Per-node rule checks (return reason strings, null if static)
// ---------------------------------------------------------------------------

/**
 * Rule 2: structured dynamicBindings whose source is request-dependent.
 * Returns the first matching reason string or null.
 */
function checkDynamicBindings(node: AnalysisNode): string | null {
  if (!node.dynamicBindings) return null
  for (const [propKey, binding] of Object.entries(node.dynamicBindings)) {
    if (isBindingSourceRequestDependent(binding.source, binding.field)) {
      return `node "${node.id}": binding "${propKey}" source "${binding.source}.${binding.field}" is request-dependent`
    }
  }
  return null
}

/**
 * Rule 2b: {source.field} tokens embedded in string prop values.
 * Returns the first matching reason string or null.
 */
function checkInlineTokens(node: AnalysisNode): string | null {
  for (const [propKey, propValue] of Object.entries(node.props)) {
    if (typeof propValue !== 'string') continue
    if (!containsTokens(propValue)) continue
    const segments = parseTokenString(propValue)
    for (const seg of segments) {
      if (seg.kind !== 'token') continue
      if (isBindingSourceRequestDependent(seg.source, seg.field)) {
        return `node "${node.id}": prop "${propKey}" contains request-dependent token "{${seg.source}.${seg.field}}"`
      }
    }
  }
  return null
}

/**
 * Rule 3: `base.loop` whose source is request-dependent or per-visitor.
 * Returns reason or null. An unregistered/empty sourceId stays static.
 * `perVisitor` implies request-dependent (it also renders at request time —
 * just uncached); both route the loop node to a Layer C hole.
 */
function checkLoopSource(node: AnalysisNode): string | null {
  if (node.moduleId !== 'base.loop') return null
  const sourceId = typeof node.props.sourceId === 'string' ? node.props.sourceId : ''
  if (!sourceId) return null
  const loopSource = loopSourceRegistry.get(sourceId)
  if (loopSource?.requestDependent === true || loopSource?.perVisitor === true) {
    const reason = loopSource?.perVisitor === true ? 'per-visitor' : 'request-dependent'
    return `node "${node.id}": loop source "${sourceId}" is ${reason}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Core walker — one pass, two outputs (ids + reasons)
// ---------------------------------------------------------------------------

interface WalkResult {
  dynamicPageNodeIds: Set<string>
  reasons: string[]
}

/**
 * Walk a node set. Page-level nodes append BOTH their id (into
 * `dynamicPageNodeIds`) AND a reason (into `reasons`). VC subtree nodes
 * append only their reason; the OUTER VC ref's id is what goes into the
 * page-level id set.
 *
 * `isPageTree=true` only on the outermost call (with the page's nodes);
 * subsequent recursive VC traversals pass `false` so we don't accidentally
 * pollute `dynamicPageNodeIds` with inner VC node ids.
 *
 * `activeVcStack` accumulates VC component-ids on the DFS call stack so
 * VC → VC cycles terminate without infinite recursion. A cycle is treated
 * as dynamic (defensive — terminates cleanly).
 */
/**
 * True if the subtree under `loopNode` contains any request-dependent node
 * (per Rules 1/2/2b/3, descending through nested loops and into referenced VC
 * trees). Collects every page-tree descendant id into `bodyIds` so the caller
 * can suppress them — when a static loop body is request-dependent the LOOP is
 * the single hole, never the repeated children (ISS-021).
 */
function loopBodyIsRequestDependent(
  loopNode: AnalysisNode,
  nodes: Record<string, AnalysisNode>,
  site: SiteDocument,
  registry: IModuleRegistry,
  activeVcStack: ReadonlySet<string>,
  bodyIds: Set<string>,
): boolean {
  let dynamic = false
  const visit = (curNodes: Record<string, AnalysisNode>, nodeId: string, seenVcs: ReadonlySet<string>, isPage: boolean): void => {
    const node = curNodes[nodeId]
    if (!node) return
    if (isPage) bodyIds.add(node.id)
    const def = registry.get(node.moduleId)
    if (def?.dynamic || checkDynamicBindings(node) || checkInlineTokens(node) || checkLoopSource(node)) {
      dynamic = true
    }
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
      if (componentId && !seenVcs.has(componentId)) {
        const vc = selectVisualComponentById(site, componentId)
        if (vc) {
          const next = new Set(seenVcs).add(componentId)
          visit(vc.tree.nodes as Record<string, AnalysisNode>, vc.tree.rootNodeId, next, /* isPage */ false)
        }
      }
    }
    for (const childId of node.children) visit(curNodes, childId, seenVcs, isPage)
  }
  for (const childId of loopNode.children) visit(nodes, childId, activeVcStack, true)
  return dynamic
}

function walk(
  nodes: Record<string, AnalysisNode>,
  site: SiteDocument,
  registry: IModuleRegistry,
  result: WalkResult,
  activeVcStack: Set<string>,
  isPageTree: boolean,
): void {
  // Pre-pass: a static base.loop whose body contains a request-dependent node
  // is promoted to a single hole (Rule 3.5), and its body descendant ids are
  // suppressed so the flat iteration below doesn't emit a separate hole per
  // iteration (ISS-021). Loops with a dynamic source are handled by Rule 3.
  const suppressed = new Set<string>()
  const promotedLoops = new Set<string>()
  for (const node of Object.values(nodes)) {
    if (node.moduleId !== 'base.loop' || checkLoopSource(node)) continue
    const bodyIds = new Set<string>()
    if (loopBodyIsRequestDependent(node, nodes, site, registry, activeVcStack, bodyIds)) {
      promotedLoops.add(node.id)
      for (const id of bodyIds) suppressed.add(id)
    }
  }

  for (const node of Object.values(nodes)) {
    // Covered by an enclosing promoted loop hole — never a hole on its own.
    if (suppressed.has(node.id)) continue

    // ── Rule 3.5: static loop with a request-dependent body ─────────────
    if (promotedLoops.has(node.id)) {
      if (isPageTree) result.dynamicPageNodeIds.add(node.id)
      result.reasons.push(`node "${node.id}": static loop body contains a request-dependent node`)
      continue
    }

    // ── Rule 1: module flagged dynamic ──────────────────────────────────
    const def = registry.get(node.moduleId)
    if (def?.dynamic) {
      if (isPageTree) result.dynamicPageNodeIds.add(node.id)
      result.reasons.push(
        `node "${node.id}" (${node.moduleId}): module is flagged dynamic`,
      )
      // A dynamic module is a leaf for our purposes — no need to check
      // bindings / loop source / VC ref since the whole node is already
      // a hole. Move to the next sibling.
      continue
    }

    // ── Rule 2: structured dynamicBindings ──────────────────────────────
    const bindingReason = checkDynamicBindings(node)
    if (bindingReason) {
      if (isPageTree) result.dynamicPageNodeIds.add(node.id)
      result.reasons.push(bindingReason)
      continue
    }

    // ── Rule 2b: inline {source.field} tokens ───────────────────────────
    const tokenReason = checkInlineTokens(node)
    if (tokenReason) {
      if (isPageTree) result.dynamicPageNodeIds.add(node.id)
      result.reasons.push(tokenReason)
      continue
    }

    // ── Rule 3: base.loop with request-dependent source ─────────────────
    const loopReason = checkLoopSource(node)
    if (loopReason) {
      if (isPageTree) result.dynamicPageNodeIds.add(node.id)
      result.reasons.push(loopReason)
      continue
    }

    // ── Rule 4: base.visual-component-ref → recurse into VC tree ────────
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId =
        typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
      if (!componentId) continue

      if (activeVcStack.has(componentId)) {
        // Cycle — treat as dynamic. The OUTER ref node id is what goes
        // into the page-level id set (the cycle is on a VC inside the
        // tree).
        if (isPageTree) result.dynamicPageNodeIds.add(node.id)
        result.reasons.push(
          `node "${node.id}": cycle detected in VC ref chain (VC "${componentId}" is already being analysed)`,
        )
        continue
      }

      const vc = selectVisualComponentById(site, componentId)
      if (!vc) continue // Unknown VC → silently skipped, matches render behaviour

      // Probe the VC subtree with a CHILD result so we can decide whether
      // to mark the OUTER ref as dynamic. We keep the inner reasons (they
      // help authors understand "the VC contains X dynamic node") but the
      // id set passed up only carries the OUTER ref id.
      const subResult: WalkResult = { dynamicPageNodeIds: new Set(), reasons: [] }
      activeVcStack.add(componentId)
      walk(
        vc.tree.nodes as Record<string, AnalysisNode>,
        site,
        registry,
        subResult,
        activeVcStack,
        /* isPageTree */ false,
      )
      activeVcStack.delete(componentId)

      // The inner walk uses isPageTree=false so subResult.dynamicPageNodeIds
      // is always empty; the dynamism signal lives in subResult.reasons.
      if (subResult.reasons.length > 0) {
        if (isPageTree) result.dynamicPageNodeIds.add(node.id)
        // Surface inner reasons so diagnostics can tell the author
        // WHICH inner construct made the VC dynamic.
        for (const r of subResult.reasons) result.reasons.push(r)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Single pass over `page.nodes` that returns BOTH the set of page-level
 * node ids needing `<instatic-hole>` placeholders AND the human-readable reason
 * strings. Layer A's shell-vs-complete decision and Layer C's `renderNode`
 * placeholder emission both derive from this one walker — the rules cannot
 * drift between layers.
 */
function findDynamicNodesWithReasons(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): WalkResult {
  const result: WalkResult = { dynamicPageNodeIds: new Set(), reasons: [] }
  walk(
    page.nodes as Record<string, AnalysisNode>,
    site,
    registry,
    result,
    new Set<string>(),
    /* isPageTree */ true,
  )
  return result
}

/**
 * Returns the set of PAGE node ids whose subtree must be deferred to a
 * `<instatic-hole>` placeholder. Empty set means the page is fully static.
 *
 * Public wrapper for callers that only need the ids. The shared walker also
 * keeps reason strings internally so diagnostics can reuse the same rule path.
 */
export function findDynamicNodeIds(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): Set<string> {
  return findDynamicNodesWithReasons(page, site, registry).dynamicPageNodeIds
}
