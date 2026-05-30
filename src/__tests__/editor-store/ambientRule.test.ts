/**
 * Phase 0 — Selectors System: ambient style rule tests.
 *
 * Covers the runtime behaviour the model extension unlocks:
 *   - `createAmbientRule` writes a kind:'ambient' entry with the verbatim
 *     selector and a cascade `order` strictly greater than every existing rule.
 *   - `addNodeClass` refuses an ambient classId (the invariant that
 *     `node.classIds` only holds class-kind ids — otherwise the publisher
 *     would emit a selector like `h1 > span` as a class-attribute token).
 *   - `classNamesForClassIds` filters ambient ids out of the class attribute.
 *   - The publisher's `collectClassCSS` includes every ambient rule even when
 *     no node references it via `classIds` (tree-shaking by classIds alone
 *     would silently drop ambient rules).
 *   - Cascade order: `generateClassCSS` emits rules in ascending `order`.
 */

import { describe, it, expect } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { classNamesForClassIds } from '@core/page-tree/classNames'
import { collectClassCSS } from '@core/publisher/cssCollector'
import { generateClassCSS } from '@core/publisher/classCss'
import type { StyleRule } from '@core/page-tree'
import '@modules/base'

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    hasUnsavedChanges: false,
  })
  useEditorStore.getState().createSite('Test')
}

describe('createAmbientRule', () => {
  it('creates a kind:"ambient" rule with the verbatim selector', () => {
    freshStore()
    const rule = useEditorStore
      .getState()
      .createAmbientRule({ selector: 'h1 > span', styles: { color: 'red' } })

    expect(rule.kind).toBe('ambient')
    expect(rule.selector).toBe('h1 > span')
    expect(rule.styles).toEqual({ color: 'red' })
    expect(rule.name).toBe('h1 > span') // defaults to selector text
  })

  it('uses the explicit name when provided', () => {
    freshStore()
    const rule = useEditorStore.getState().createAmbientRule({
      selector: '.hero .title',
      name: 'Hero headline',
    })
    expect(rule.name).toBe('Hero headline')
    expect(rule.selector).toBe('.hero .title')
  })

  it('rejects an empty or whitespace-only selector', () => {
    freshStore()
    expect(() =>
      useEditorStore.getState().createAmbientRule({ selector: '   ' }),
    ).toThrow('Ambient selector cannot be empty')
  })

  it('rejects a syntactically invalid selector', () => {
    freshStore()
    expect(() =>
      useEditorStore.getState().createAmbientRule({ selector: 'h1 >>> span' }),
    ).toThrow('Invalid CSS selector')
  })

  it('appends to the cascade — order strictly greater than every existing rule', () => {
    freshStore()
    const store = useEditorStore.getState()
    const a = store.createClass('a', { color: 'a' })
    const b = store.createClass('b', { color: 'b' })
    const amb = store.createAmbientRule({ selector: 'h1' })
    expect(amb.order).toBeGreaterThan(a.order!)
    expect(amb.order).toBeGreaterThan(b.order!)
  })
})

describe('node.classIds → class attribute', () => {
  it('classNamesForClassIds filters ambient rules', () => {
    freshStore()
    const cls = useEditorStore.getState().createClass('hero')
    const amb = useEditorStore.getState().createAmbientRule({ selector: 'h1' })

    const site = useEditorStore.getState().site!
    expect(classNamesForClassIds(site.styleRules, [cls.id, amb.id])).toEqual(['hero'])
  })

  it('addNodeClass refuses ambient ids and does not mutate the node', () => {
    freshStore()
    const store = useEditorStore.getState()
    const site = store.site!
    const rootId = site.pages[0].rootNodeId
    const amb = store.createAmbientRule({ selector: 'h1' })

    const before = store.site!.pages[0].nodes[rootId].classIds ?? []
    store.addNodeClass(rootId, amb.id)
    const after = store.site!.pages[0].nodes[rootId].classIds ?? []
    expect(after).toEqual(before)
    expect(after).not.toContain(amb.id)
  })
})

describe('publisher emits ambient rules', () => {
  it('collectClassCSS includes ambient rules even when no node references them', () => {
    freshStore()
    useEditorStore.getState().createAmbientRule({
      selector: 'h1 > span',
      styles: { color: '#f00' },
    })

    // Re-read state AFTER the mutation — `getState()` returns an immutable
    // snapshot, not a live ref.
    const css = collectClassCSS(useEditorStore.getState().site!)
    expect(css).toContain('h1 > span')
    expect(css).toContain('color: #f00')
  })

  it('emits rules in cascade order (ascending `order` field)', () => {
    // Direct call into generateClassCSS gives a deterministic ordering view
    // without depending on classSlice's internal append-at-end behavior.
    const now = Date.now()
    const make = (id: string, name: string, order: number, color: string): StyleRule => ({
      id,
      name,
      kind: 'class',
      selector: `.${name}`,
      order,
      styles: { color },
      breakpointStyles: {},
      createdAt: now,
      updatedAt: now,
    })
    const classes: Record<string, StyleRule> = {
      late: make('late', 'late', 99, '#late'),
      early: make('early', 'early', 1, '#early'),
      middle: make('middle', 'middle', 50, '#middle'),
    }

    const css = generateClassCSS(classes, [])
    const earlyIdx = css.indexOf('.early')
    const middleIdx = css.indexOf('.middle')
    const lateIdx = css.indexOf('.late')
    expect(earlyIdx).toBeGreaterThan(-1)
    expect(middleIdx).toBeGreaterThan(earlyIdx)
    expect(lateIdx).toBeGreaterThan(middleIdx)
  })

  it('emits the verbatim selector for ambient rules (not `.${name}`)', () => {
    const now = Date.now()
    const cls: StyleRule = {
      id: 'a',
      name: 'a-name',
      kind: 'ambient',
      selector: 'a:hover',
      order: 0,
      styles: { color: '#abc' },
      breakpointStyles: {},
      createdAt: now,
      updatedAt: now,
    }
    const css = generateClassCSS({ a: cls }, [])
    expect(css).toContain('a:hover {')
    // The `name` field should NOT bleed into the selector.
    expect(css).not.toContain('.a-name')
  })
})

describe('legacy backfill — old classes without kind/selector/order still render', () => {
  it('parseStyleRule backfills sensible defaults for legacy data', async () => {
    const { parseStyleRule } = await import('@core/page-tree/styleRule')
    const cls = parseStyleRule({
      id: 'x',
      name: 'legacy-name',
      styles: { color: 'red' },
      breakpointStyles: {},
      createdAt: 0,
      updatedAt: 0,
    })
    expect(cls).not.toBeNull()
    expect(cls!.kind).toBe('class')
    expect(cls!.selector).toBe('.legacy-name')
    expect(cls!.order).toBe(0)
  })
})
