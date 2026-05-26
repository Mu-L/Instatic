/**
 * Page-level static-analysis predicates — thin projections over
 * `dynamicDetection.ts`.
 *
 * Public API:
 *   `isFullyStaticPage(page, site, registry): boolean`
 *   `staticReasons(page, site, registry): string[]`
 *   `isBindingSourceRequestDependent(source, field): boolean` (re-export)
 *
 * A page is fully static iff every node in its tree (including
 * recursively referenced Visual Components) is publish-time-deterministic.
 * Both predicates here delegate to `findDynamicNodesWithReasons` so the
 * four detection rules live in exactly one place and cannot drift between
 * Layer A (disk artefacts) and Layer C (hole placeholders).
 *
 * See `dynamicDetection.ts` for the rules + the consolidated walker.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine/types'
import {
  findDynamicNodesWithReasons,
  isBindingSourceRequestDependent,
} from './dynamicDetection'

export { isBindingSourceRequestDependent }

/**
 * Returns a list of human-readable reasons why `page` is NOT fully static.
 *
 * Empty list ⇔ every node (including VC-ref'd trees) is
 * publish-time-deterministic and the page is bakeable to a Layer A disk
 * artefact at publish time.
 *
 * Useful for developer tooling and editor introspection.
 */
export function staticReasons(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): string[] {
  return findDynamicNodesWithReasons(page, site, registry).reasons
}

/**
 * Returns `true` iff the page tree contains no request-dependent constructs
 * and can be pre-rendered to a static HTML artefact at publish time
 * (Layer A).
 *
 * Returns `false` if any node is dynamic (module flag, request-dependent
 * binding, request-dependent loop source, or a VC ref to a dynamic VC), or
 * if a VC ref cycle is detected.
 */
export function isFullyStaticPage(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): boolean {
  return findDynamicNodesWithReasons(page, site, registry).dynamicPageNodeIds.size === 0
}
