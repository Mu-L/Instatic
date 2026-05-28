import { describe, expect, it } from 'bun:test'
import {
  inspectPageClass,
  inspectPageNode,
  searchPageNodes,
} from '../../../server/ai/tools/site/snapshotHelpers'
import type { SiteSnapshot } from '../../../server/ai/tools/site'

function makeContext(): SiteSnapshot {
  return {
    pageId: 'page-home',
    pageTitle: 'Home',
    rootNodeId: 'root',
    pages: [
      { id: 'page-home', title: 'Home', slug: 'index', active: true, isHomepage: true },
      { id: 'page-about', title: 'About', slug: 'about', active: false, isHomepage: false },
    ],
    selectedNodeId: null,
    selectedNodeIds: [],
    activeBreakpointId: 'mobile',
    breakpoints: [
      { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    nodes: [
      {
        id: 'root',
        moduleId: 'base.container',
        parentId: null,
        children: ['title'],
        props: { tag: 'main' },
        breakpointOverrides: {},
        classIds: ['cls-hero'],
      },
      {
        id: 'title',
        moduleId: 'base.text',
        parentId: 'root',
        children: [],
        props: { tag: 'h1', text: 'Design tools' },
        breakpointOverrides: {
          mobile: { text: 'Design tools for mobile' },
        },
        classIds: ['cls-title'],
      },
    ],
    availableModules: [
      {
        id: 'base.text',
        name: 'Text',
        category: 'Typography',
        canHaveChildren: false,
        defaults: { tag: 'p', text: 'Text' },
        props: [{ key: 'text', type: 'text', label: 'Text' }],
        styles: [{ key: 'fontSize', type: 'text', label: 'Font size', cssProperties: ['fontSize'] }],
      },
    ],
    classes: [
      {
        id: 'cls-hero',
        name: 'hero-dark',
        styles: { backgroundColor: '#111827', color: '#ffffff' },
      },
      {
        id: 'cls-title',
        name: 'hero-title',
        styles: { fontSize: '56px', lineHeight: '1.05' },
        breakpointStyles: {
          mobile: { fontSize: '36px' },
        },
      },
    ],
  }
}

describe('page-builder agent tools', () => {
  it('builds a dynamic module, class, and page snapshot for MCP discovery tools', () => {
    const snapshot = makeContext()

    expect(snapshot.availableModules).toHaveLength(1)
    expect(snapshot.availableModules[0].id).toBe('base.text')
    expect(snapshot.availableModules[0].styles[0].cssProperties).toEqual(['fontSize'])

    expect(snapshot.classes).toHaveLength(2)
    expect(snapshot.classes[0]).toEqual({
      id: 'cls-hero',
      name: 'hero-dark',
      styles: { backgroundColor: '#111827', color: '#ffffff' },
    })

    expect(snapshot.activeBreakpointId).toBe('mobile')
    expect(snapshot.breakpoints).toEqual([
      { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ])
    expect(snapshot.nodes.map((node) => node.id)).toEqual(['root', 'title'])
  })

  it('searches existing nodes by text, module, and assigned class name', () => {
    const snapshot = makeContext()

    const byText = searchPageNodes(snapshot, { query: 'design tools' })
    expect(byText.nodes.map((node) => node.id)).toEqual(['title'])

    const byModuleAndClass = searchPageNodes(snapshot, {
      moduleId: 'base.text',
      className: 'hero-title',
    })
    expect(byModuleAndClass.nodes.map((node) => node.id)).toEqual(['title'])
  })

  it('inspects one node with resolved props and resolved breakpoint class styles', () => {
    const snapshot = makeContext()

    const inspected = inspectPageNode(snapshot, {
      nodeId: 'title',
      breakpointId: 'mobile',
    })

    // Module props are content (single value across all breakpoints), so
    // even though the fixture seeded a `mobile.text` override, the resolved
    // props at any breakpoint return the BASE text. Stale override data on
    // a non-`breakpointOverridable` prop is ignored at read time, mirroring
    // the canvas/publisher.
    expect(inspected.node?.resolvedProps).toEqual({
      tag: 'h1',
      text: 'Design tools',
    })
    expect(inspected.node?.resolvedClassStyles).toEqual({
      fontSize: '36px',
      lineHeight: '1.05',
    })
    expect(inspected.node?.classes[0].breakpointStyles).toEqual({ fontSize: '36px' })
  })

  it('returns the descendant subtree from inspect_node so the agent gets the full structure in one call', () => {
    const snapshot = makeContext()

    const inspected = inspectPageNode(snapshot, { nodeId: 'root' })

    // The focal node has full detail (resolvedProps, classes).
    expect(inspected.node?.id).toBe('root')

    // Plus its descendants as a tree of light-info objects.
    const descendants = inspected.node?.descendants ?? []
    expect(descendants).toHaveLength(1)
    expect(descendants[0]).toMatchObject({
      id: 'title',
      moduleId: 'base.text',
      classNames: ['hero-title'],
      childCount: 0,
      // Picks up `text` prop as the preview.
      textPreview: 'Design tools',
    })
    expect(descendants[0].children).toEqual([])
  })

  it('respects maxDepth on inspect_node (0 = focal node only, no descendants)', () => {
    const snapshot = makeContext()

    const inspected = inspectPageNode(snapshot, { nodeId: 'root', maxDepth: 0 })

    expect(inspected.node?.id).toBe('root')
    expect(inspected.node?.descendants).toEqual([])
  })

  it('inspects one class with resolved breakpoint styles and assigned nodes', () => {
    const snapshot = makeContext()

    const inspected = inspectPageClass(snapshot, {
      classId: 'cls-title',
      breakpointId: 'mobile',
    })

    expect(inspected.class?.resolvedStyles).toEqual({
      fontSize: '36px',
      lineHeight: '1.05',
    })
    expect(inspected.class?.assignedNodes.map((node) => node.id)).toEqual(['title'])
  })

  // render_snapshot is now an on-demand browser-bridge tool — captured lazily
  // when Claude calls it, not pre-loaded into PageContext. The browser-side
  // capture is exercised by agentSlice's toolRequest path.
})
