/**
 * Focused tests for `isFullyStaticPage` returning `false` when a page tree
 * contains dynamic constructs.
 *
 * These tests verify that Layer A's static-analysis gate correctly delegates
 * to `findDynamicNodeIds` and classifies pages as non-static when they
 * contain any of the four dynamic-detection rules.
 *
 * More exhaustive rule coverage lives in `dynamicDetection.test.ts`. This
 * file is intentionally compact — one canonical case per rule so the
 * delegation contract is locked in place.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { isFullyStaticPage } from '../../core/publisher/staticAnalysis'
import { loopSourceRegistry } from '../../core/loops/registry'
import { makePage, makeSite, makeRegistry, makeModule } from '../publisher/helpers'
import type { LoopEntitySource } from '../../core/loops/types'
import type { VisualComponent } from '../../core/visualComponents/schemas'

// ---------------------------------------------------------------------------
// Loop-source helper
// ---------------------------------------------------------------------------

function makeLoopSource(id: string, requestDependent: boolean): LoopEntitySource {
  return {
    id,
    label: id,
    filterSchema: {},
    orderByOptions: [],
    fields: [],
    requestDependent,
    fetch: async () => ({ items: [], totalItems: 0 }),
    preview: () => [],
  }
}

const registeredTestSourceIds: string[] = []
afterEach(() => {
  for (const id of registeredTestSourceIds) {
    loopSourceRegistry.unregister(id)
  }
  registeredTestSourceIds.length = 0
})
function registerSource(src: LoopEntitySource): void {
  loopSourceRegistry.registerOrReplace(src)
  registeredTestSourceIds.push(src.id)
}

// ---------------------------------------------------------------------------
// VC fixture helper
// ---------------------------------------------------------------------------

function makeVc(id: string, moduleId: string): VisualComponent {
  return {
    id,
    name: id,
    tree: {
      nodes: {
        root: {
          id: 'root',
          moduleId,
          props: {},
          breakpointOverrides: {},
          children: [],
          classIds: [],
        },
      },
      rootNodeId: 'root',
    },
    params: [],
    classIds: [],
    createdAt: 0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isFullyStaticPage returns false for dynamic-bearing trees', () => {
  it('returns false — Rule 1: node uses a module with dynamic: true', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['w'] },
      w: { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })
    expect(isFullyStaticPage(page, site, reg)).toBe(false)
  })

  it('returns false — Rule 2: node has a dynamicBinding to viewer source', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['banner'] },
      banner: {
        moduleId: 'base.text',
        props: { count: 0 },
        dynamicBindings: { count: { source: 'viewer', field: 'cartCount' } },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })
    expect(isFullyStaticPage(page, site, reg)).toBe(false)
  })

  it('returns false — Rule 2b: string prop contains {route.query.*} token', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['result'] },
      result: {
        moduleId: 'base.text',
        props: { text: 'Results for: {route.query.q}' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })
    expect(isFullyStaticPage(page, site, reg)).toBe(false)
  })

  it('returns false — Rule 3: base.loop with requestDependent: true source', () => {
    registerSource(makeLoopSource('test.live-api', true))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: { moduleId: 'base.loop', props: { sourceId: 'test.live-api' } },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.loop': makeModule('base.loop'),
    })
    expect(isFullyStaticPage(page, site, reg)).toBe(false)
  })

  it('returns false — Rule 4: base.visual-component-ref to a VC with a dynamic module', () => {
    const vc = makeVc('vc-dyn', 'plugin.live-widget')
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-dyn' },
      },
    })
    const site = makeSite({ visualComponents: [vc] })
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })
    expect(isFullyStaticPage(page, site, reg)).toBe(false)
  })

  it('returns true — baseline: all modules static, no request-dependent bindings', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['h'] },
      h: { moduleId: 'base.text', props: { text: 'Hello' } },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })
    expect(isFullyStaticPage(page, site, reg)).toBe(true)
  })
})
