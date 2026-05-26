/**
 * Unit tests for src/core/publisher/staticAnalysis.ts.
 *
 * Table-driven over fixture page trees. Each case builds a minimal Page +
 * SiteDocument + IModuleRegistry and asserts the expected static/dynamic
 * classification along with supporting `staticReasons` output.
 *
 * Loop-source tests register a test source on the singleton
 * `loopSourceRegistry` before the assertion and unregister it in the `after`
 * cleanup so the global registry stays clean across tests.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import {
  isFullyStaticPage,
  staticReasons,
  isBindingSourceRequestDependent,
} from '../../core/publisher/staticAnalysis'
import { loopSourceRegistry } from '../../core/loops/registry'
import { makePage, makeSite, makeRegistry, makeModule } from '../publisher/helpers'
import type { VisualComponent } from '../../core/visualComponents/schemas'
import type { LoopEntitySource } from '../../core/loops/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal LoopEntitySource fixture. requestDependent defaults to false (unset). */
function makeLoopSource(id: string, requestDependent?: boolean): LoopEntitySource {
  return {
    id,
    label: id,
    filterSchema: {},
    orderByOptions: [],
    fields: [],
    ...(requestDependent !== undefined ? { requestDependent } : {}),
    fetch: async () => ({ items: [], totalItems: 0 }),
    preview: () => [],
  }
}

/** Minimal VCNode record for a Visual Component tree. */
function makeVcNodes(
  nodeSpecs: Record<
    string,
    { moduleId: string; props?: Record<string, unknown>; children?: string[] }
  >,
): VisualComponent['tree']['nodes'] {
  const nodes: VisualComponent['tree']['nodes'] = {}
  for (const [id, spec] of Object.entries(nodeSpecs)) {
    nodes[id] = {
      id,
      moduleId: spec.moduleId,
      props: spec.props ?? {},
      breakpointOverrides: {},
      children: spec.children ?? [],
      classIds: [],
    }
  }
  return nodes
}

/** Create a VisualComponent fixture. */
function makeVc(
  id: string,
  nodeSpecs: Record<
    string,
    { moduleId: string; props?: Record<string, unknown>; children?: string[] }
  >,
  rootNodeId = 'root',
): VisualComponent {
  return {
    id,
    name: id,
    tree: { nodes: makeVcNodes(nodeSpecs), rootNodeId },
    params: [],
    classIds: [],
    createdAt: 0,
  }
}

// ---------------------------------------------------------------------------
// Cleanup — deregister any test loop sources registered during a test
// ---------------------------------------------------------------------------

const registeredTestSourceIds: string[] = []

afterEach(() => {
  for (const id of registeredTestSourceIds) {
    loopSourceRegistry.unregister(id)
  }
  registeredTestSourceIds.length = 0
})

function registerTestSource(source: LoopEntitySource): void {
  loopSourceRegistry.registerOrReplace(source)
  registeredTestSourceIds.push(source.id)
}

// ---------------------------------------------------------------------------
// isBindingSourceRequestDependent — unit tests for the classification helper
// ---------------------------------------------------------------------------

describe('isBindingSourceRequestDependent', () => {
  it('returns false for currentEntry, parentEntry, page, site', () => {
    expect(isBindingSourceRequestDependent('currentEntry', 'title')).toBe(false)
    expect(isBindingSourceRequestDependent('parentEntry', 'title')).toBe(false)
    expect(isBindingSourceRequestDependent('page', 'title')).toBe(false)
    expect(isBindingSourceRequestDependent('site', 'name')).toBe(false)
  })

  it('returns false for route.path and route.slug', () => {
    expect(isBindingSourceRequestDependent('route', 'path')).toBe(false)
    expect(isBindingSourceRequestDependent('route', 'slug')).toBe(false)
  })

  it('returns true for route.query and route.query.*', () => {
    expect(isBindingSourceRequestDependent('route', 'query')).toBe(true)
    expect(isBindingSourceRequestDependent('route', 'query.q')).toBe(true)
    expect(isBindingSourceRequestDependent('route', 'query.page')).toBe(true)
  })

  it('returns true for viewer', () => {
    expect(isBindingSourceRequestDependent('viewer', 'name')).toBe(true)
    expect(isBindingSourceRequestDependent('viewer', 'id')).toBe(true)
  })

  it('returns false for unknown sources (conservative / static-default)', () => {
    expect(isBindingSourceRequestDependent('unknown', 'field')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isFullyStaticPage — page-level tests
// ---------------------------------------------------------------------------

describe('isFullyStaticPage', () => {
  // ── Case 1: plain static page ─────────────────────────────────────────────
  it('returns true for a page with only static modules', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['heading'] },
      heading: { moduleId: 'base.text', props: { text: 'Hello', tag: 'h1' } },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(true)
    expect(staticReasons(page, site, registry)).toEqual([])
  })

  // ── Case 2: base.loop with request-dependent source → false ───────────────
  it('returns false when a loop node uses a request-dependent source', () => {
    registerTestSource(makeLoopSource('test.live-api', true))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.live-api' },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.loop': makeModule('base.loop'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.some((r) => r.includes('test.live-api') && r.includes('request-dependent'))).toBe(
      true,
    )
  })

  // ── Case 3: base.loop with publish-time source → true (KEY case) ──────────
  it('returns true when a loop node uses a publish-time source (no requestDependent flag)', () => {
    registerTestSource(makeLoopSource('test.cms-posts'))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.cms-posts' },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.loop': makeModule('base.loop'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(true)
    expect(staticReasons(page, site, registry)).toEqual([])
  })

  it('returns true when a loop node uses a source explicitly set to requestDependent: false', () => {
    registerTestSource(makeLoopSource('test.cms-pages', false))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.cms-pages' },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({ 'base.body': makeModule('base.body') })

    expect(isFullyStaticPage(page, site, registry)).toBe(true)
  })

  // ── Case 4: module with dynamic: true flag → false ─────────────────────────
  it('returns false when a node uses a module flagged dynamic: true', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.some((r) => r.includes('plugin.live-widget') && r.includes('dynamic'))).toBe(
      true,
    )
  })

  // ── Case 5: dynamicBindings with request-dependent source → false ──────────
  it('returns false when a node has a structured dynamicBinding with a request-dependent source', () => {
    // Structured bindings survive in dynamicBindings only for non-string props
    // (booleans, numbers). Here we simulate a hidden:boolean binding on viewer.
    const page = makePage({
      root: { moduleId: 'base.body', children: ['banner'] },
      banner: {
        moduleId: 'base.text',
        props: { showCount: 0 },
        dynamicBindings: {
          showCount: { source: 'viewer', field: 'cartCount' },
        },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.some((r) => r.includes('viewer.cartCount') && r.includes('request-dependent'))).toBe(
      true,
    )
  })

  // ── Case 6: {route.query.*} token in a string prop → false ────────────────
  it('returns false when a prop contains a {route.query.*} token', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['search'] },
      search: {
        moduleId: 'base.text',
        // Inline token: migrated from a "route" binding on a string prop
        props: { text: 'Search results for: {route.query.q}' },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.some((r) => r.includes('route.query.q') && r.includes('request-dependent'))).toBe(
      true,
    )
  })

  it('returns true when props use publish-time tokens like {route.slug}', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['heading'] },
      heading: {
        moduleId: 'base.text',
        props: { text: 'Page: {route.slug}' },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(true)
    expect(staticReasons(page, site, registry)).toEqual([])
  })

  // ── Case 7: VC ref to fully static VC → true ──────────────────────────────
  it('returns true when a VC ref points to a fully static VC', () => {
    const staticVc = makeVc('vc-static', {
      root: { moduleId: 'base.container', children: ['text'] },
      text: { moduleId: 'base.text', props: { text: 'Hello from VC' } },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-static' },
      },
    })
    const site = makeSite({ visualComponents: [staticVc] })
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
      'base.container': makeModule('base.container'),
      'base.text': makeModule('base.text'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(true)
    expect(staticReasons(page, site, registry)).toEqual([])
  })

  // ── Case 8: VC ref to dynamic VC → false ──────────────────────────────────
  it('returns false when a VC ref points to a VC that contains a dynamic module', () => {
    const dynamicVc = makeVc('vc-dynamic', {
      root: { moduleId: 'plugin.live-widget' },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-dynamic' },
      },
    })
    const site = makeSite({ visualComponents: [dynamicVc] })
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.some((r) => r.includes('plugin.live-widget') && r.includes('dynamic'))).toBe(
      true,
    )
  })

  it('returns false when a VC ref points to a VC that uses a request-dependent loop source', () => {
    registerTestSource(makeLoopSource('test.live-feed', true))

    const vcWithLoop = makeVc('vc-loop', {
      root: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.live-feed' },
      },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-loop' },
      },
    })
    const site = makeSite({ visualComponents: [vcWithLoop] })
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.some((r) => r.includes('test.live-feed'))).toBe(true)
  })

  // ── Case 9: cycle in VC refs → terminates and returns false ───────────────
  it('terminates and returns false when VC refs form a cycle', () => {
    // vc-a → vc-b → vc-a (cycle)
    const vcA = makeVc('vc-a', {
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-b' },
      },
    })
    const vcB = makeVc('vc-b', {
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-a' },
      },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-a' },
      },
    })
    const site = makeSite({ visualComponents: [vcA, vcB] })
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    // Must NOT throw or hang — terminates and reports the cycle
    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.some((r) => r.includes('cycle'))).toBe(true)
  })

  it('terminates correctly for a self-referential VC (vc references itself)', () => {
    const vcSelf = makeVc('vc-self', {
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-self' },
      },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-self' },
      },
    })
    const site = makeSite({ visualComponents: [vcSelf] })
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(false)
    const reasons = staticReasons(page, site, registry)
    expect(reasons.some((r) => r.includes('cycle'))).toBe(true)
  })

  // ── Edge cases ─────────────────────────────────────────────────────────────
  it('returns true for a VC ref to an unknown VC (missing from site.visualComponents)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-missing' },
      },
    })
    // Site has no VCs at all
    const site = makeSite({ visualComponents: [] })
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    // Unknown VC → treated as static (same as publish-time render behaviour)
    expect(isFullyStaticPage(page, site, registry)).toBe(true)
  })

  it('returns true for a loop with an empty/missing sourceId', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: {}, // no sourceId
      },
    })
    const site = makeSite()
    const registry = makeRegistry({ 'base.body': makeModule('base.body') })

    expect(isFullyStaticPage(page, site, registry)).toBe(true)
  })

  it('returns true for a loop with an unregistered sourceId', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'unknown.source' },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({ 'base.body': makeModule('base.body') })

    // Unregistered source → treated as static (conservative default)
    expect(isFullyStaticPage(page, site, registry)).toBe(true)
  })

  it('returns true for a page with multiple nodes all static', () => {
    registerTestSource(makeLoopSource('test.static-items'))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['heading', 'loop1', 'footer'] },
      heading: { moduleId: 'base.text', props: { text: 'Title: {currentEntry.title}' } },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.static-items' },
        children: ['item'],
      },
      item: { moduleId: 'base.text', props: { text: '{currentEntry.name}' } },
      footer: { moduleId: 'base.text', props: { text: 'Footer' } },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
      'base.loop': makeModule('base.loop'),
    })

    expect(isFullyStaticPage(page, site, registry)).toBe(true)
    expect(staticReasons(page, site, registry)).toEqual([])
  })

  it('reports multiple reasons when multiple nodes are dynamic', () => {
    registerTestSource(makeLoopSource('test.live-source', true))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget', 'loop1'] },
      widget: { moduleId: 'plugin.live-widget' },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.live-source' },
      },
    })
    const site = makeSite()
    const registry = makeRegistry({
      'base.body': makeModule('base.body'),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const reasons = staticReasons(page, site, registry)
    expect(reasons.length).toBeGreaterThanOrEqual(2)
    expect(isFullyStaticPage(page, site, registry)).toBe(false)
  })
})
