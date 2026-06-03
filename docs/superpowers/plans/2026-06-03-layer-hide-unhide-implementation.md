# Layer Hide / Unhide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Layers panel Hide / Unhide so hidden nodes stay inspectable in the tree but are pruned from canvas and published output.

**Architecture:** Reuse the existing `node.hidden?: boolean` page-tree metadata and `toggleNodeHidden` mutation. The Layers context menu normalizes selected nodes to one target state. The publisher adds a top-level prune guard before unknown-module handling, dynamic holes, special renderers, and CSS collection.

**Tech Stack:** Bun test, TypeScript, React 19, Zustand editor store, CSS Modules, existing `@ui/components/ContextMenu`, pixel-art icon imports.

---

## File Structure

- Modify `src/core/publisher/renderNode.ts`: add the publisher hidden-node prune guard.
- Modify `src/__tests__/publisher/render.test.ts`: add hidden-node output and CSS/dynamic-hole regression tests.
- Modify `src/__tests__/publisher/visualComponentRef.test.ts`: add hidden Visual Component and hidden slot-fill tests.
- Modify `src/admin/pages/site/panels/DomPanel/LayerNodeContextMenu.tsx`: add Hide / Unhide action and multi-select target-state dispatch.
- Modify `src/__tests__/dom-panel/layerNodeContextMenu.test.tsx`: add context-menu single, root, and multi-select coverage.
- Modify `src/admin/pages/site/panels/DomPanel/LayerTreeNodeContent.tsx`: render a text `hidden` badge for hidden rows.
- Modify `src/admin/pages/site/panels/DomPanel/TreeNode.module.css`: style the hidden badge using editor tokens.

## Task 1: Publisher Pruning

**Files:**
- Modify: `src/core/publisher/renderNode.ts`
- Test: `src/__tests__/publisher/render.test.ts`
- Test: `src/__tests__/publisher/visualComponentRef.test.ts`

- [ ] **Step 1: Add failing renderNode tests**

Add these tests inside the existing `describe('renderNode', () => { ... })` block in `src/__tests__/publisher/render.test.ts`:

```ts
  it('returns empty string for a hidden node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hidden', level: 1 }, hidden: true },
    })
    const c = ctx(page)
    expect(renderNode('root', c)).toBe('')
  })

  it('does not collect CSS for a hidden node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hidden', level: 1 }, hidden: true },
    })
    const c = ctx(page)
    renderNode('root', c)
    expect(c.cssMap.size).toBe(0)
  })

  it('renders visible children while omitting hidden children', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: 'wrapper' },
        children: ['shown', 'hidden'],
      },
      shown: { moduleId: 'base.text', props: { text: 'Shown', level: 2 } },
      hidden: { moduleId: 'base.text', props: { text: 'Hidden', level: 2 }, hidden: true },
    })
    const c = ctx(page)
    expect(renderNode('root', c)).toBe('<div class="wrapper"><h2>Shown</h2></div>')
  })

  it('prunes a hidden parent without mutating child hidden flags', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: 'wrapper' },
        children: ['shown-child', 'hidden-child'],
        hidden: true,
      },
      'shown-child': { moduleId: 'base.text', props: { text: 'Shown', level: 2 } },
      'hidden-child': {
        moduleId: 'base.text',
        props: { text: 'Hidden child', level: 2 },
        hidden: true,
      },
    })
    const c = ctx(page)
    expect(renderNode('root', c)).toBe('')
    expect(page.nodes['shown-child'].hidden).toBe(false)
    expect(page.nodes['hidden-child'].hidden).toBe(true)
  })

  it('emits nothing for a hidden unknown module', () => {
    const page = makePage({
      root: { moduleId: 'unknown.widget', props: {}, hidden: true },
    })
    const c = ctx(page)
    expect(renderNode('root', c)).toBe('')
  })

  it('does not emit a dynamic hole for a hidden dynamic node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Dynamic', level: 1 }, hidden: true },
    })
    const c = ctx(page)
    const holeNodeIds = new Set<string>()
    const html = renderNode('root', {
      ...c,
      dynamicNodeIds: new Set(['root']),
      holeNodeIds,
      publishVersion: 7,
    })
    expect(html).toBe('')
    expect(holeNodeIds.size).toBe(0)
  })
```

- [ ] **Step 2: Add failing Visual Component pruning tests**

Add these tests to `src/__tests__/publisher/visualComponentRef.test.ts`:

```ts
describe('VC inlining — hidden nodes', () => {
  it('omits hidden nodes from a Visual Component definition', () => {
    const visibleText = makeVCNode({
      id: 'vc-visible-text',
      moduleId: 'base.text',
      props: { text: 'Visible VC text', tag: 'p' },
    })
    const hiddenText = makeVCNode({
      id: 'vc-hidden-text',
      moduleId: 'base.text',
      props: { text: 'Hidden VC text', tag: 'p' },
      hidden: true,
    })
    const container = makeVCNode({
      id: 'vc-hidden-root',
      moduleId: 'base.container',
      children: ['vc-visible-text', 'vc-hidden-text'],
    })
    const vc = makeVC({
      id: 'vc-hidden',
      name: 'Hidden Nodes',
      nodes: [container, visibleText, hiddenText],
      rootId: 'vc-hidden-root',
    })
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-hidden', propOverrides: {} },
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })

    const { html } = publishPage(page, site, registry)

    expect(html).toContain('Visible VC text')
    expect(html).not.toContain('Hidden VC text')
  })

  it('omits hidden slot-fill nodes from slot outlet output', () => {
    const slotOutletNode = makeVCNode({
      id: 'hidden-slot-outlet',
      moduleId: 'base.slot-outlet',
      props: { slotName: 'children' },
    })
    const container = makeVCNode({
      id: 'hidden-slot-root',
      moduleId: 'base.container',
      children: ['hidden-slot-outlet'],
    })
    const vc = makeVC({
      id: 'vc-hidden-slot',
      name: 'Hidden Slot',
      nodes: [container, slotOutletNode],
      rootId: 'hidden-slot-root',
      params: [makeParam({
        id: 'param-children',
        name: 'children',
        type: 'slot',
        defaultValue: [],
      })],
    })
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-hidden-slot', propOverrides: {} },
        children: ['slot-inst'],
      },
      'slot-inst': {
        moduleId: 'base.slot-instance',
        props: { slotName: 'children' },
        children: ['shown-slot-text', 'hidden-slot-text'],
        locked: true,
      },
      'shown-slot-text': {
        moduleId: 'base.text',
        props: { text: 'Shown slot text', tag: 'p' },
      },
      'hidden-slot-text': {
        moduleId: 'base.text',
        props: { text: 'Hidden slot text', tag: 'p' },
        hidden: true,
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })

    const { html } = publishPage(page, site, registry)

    expect(html).toContain('Shown slot text')
    expect(html).not.toContain('Hidden slot text')
  })
})
```

- [ ] **Step 3: Run publisher tests and verify they fail**

Run:

```sh
bun test src/__tests__/publisher/render.test.ts src/__tests__/publisher/visualComponentRef.test.ts
```

Expected: at least the new hidden publisher tests fail because `renderNode` still renders hidden nodes.

- [ ] **Step 4: Add minimal publisher guard**

In `src/core/publisher/renderNode.ts`, update `renderNode`:

```ts
export function renderNode(nodeId: string, ctx: RenderContext): string {
  const node = ctx.page.nodes[nodeId]
  if (!node) return ''
  if (node.hidden) return ''

  const def = ctx.registry.get(node.moduleId)
  ...
}
```

- [ ] **Step 5: Run publisher tests and verify they pass**

Run:

```sh
bun test src/__tests__/publisher/render.test.ts src/__tests__/publisher/visualComponentRef.test.ts
```

Expected: all tests in those files pass.

## Task 2: Layers Context Menu Action

**Files:**
- Modify: `src/admin/pages/site/panels/DomPanel/LayerNodeContextMenu.tsx`
- Test: `src/__tests__/dom-panel/layerNodeContextMenu.test.tsx`

- [ ] **Step 1: Add failing context-menu tests**

Add a new `describe('LayerNodeContextMenu — Hide / Unhide', () => { ... })` block to `src/__tests__/dom-panel/layerNodeContextMenu.test.tsx`:

```tsx
describe('LayerNodeContextMenu — Hide / Unhide', () => {
  function setupHideMenuPage() {
    localStorage.clear()
    const home = makePage({
      id: 'page-hide',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b', 'c'] }),
        a: makeNode({ id: 'a', moduleId: 'base.text' }),
        b: makeNode({ id: 'b', moduleId: 'base.text', hidden: true }),
        c: makeNode({ id: 'c', moduleId: 'base.text', hidden: true }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [home], files: [], visualComponents: [] }),
      activePageId: 'page-hide',
      selectedNodeId: 'a',
      selectedNodeIds: [],
      hoveredNodeId: null,
      activeDocument: null,
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  function renderHideMenu(nodeId: string) {
    return render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId={nodeId}
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
  }

  it('shows Hide for a visible node and marks it hidden when clicked', () => {
    setupHideMenuPage()
    renderHideMenu('a')

    fireEvent.click(screen.getByRole('menuitem', { name: /^hide$/i }))

    expect(useEditorStore.getState().site?.pages[0].nodes.a.hidden).toBe(true)
  })

  it('shows Unhide for a hidden node and marks it visible when clicked', () => {
    setupHideMenuPage()
    renderHideMenu('b')

    fireEvent.click(screen.getByRole('menuitem', { name: /^unhide$/i }))

    expect(useEditorStore.getState().site?.pages[0].nodes.b.hidden).toBe(false)
  })

  it('does not show Hide for the structural root node', () => {
    setupHideMenuPage()
    renderHideMenu('root')

    expect(screen.queryByRole('menuitem', { name: /^hide$/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^unhide$/i })).toBeNull()
  })

  it('hides every selected node when a multi-selection contains a visible node', () => {
    setupHideMenuPage()
    useEditorStore.setState({
      selectedNodeId: 'a',
      selectedNodeIds: ['a', 'b'],
    } as Parameters<typeof useEditorStore.setState>[0])
    renderHideMenu('a')

    fireEvent.click(screen.getByRole('menuitem', { name: /^hide selected$/i }))

    const nodes = useEditorStore.getState().site?.pages[0].nodes
    expect(nodes?.a.hidden).toBe(true)
    expect(nodes?.b.hidden).toBe(true)
  })

  it('unhides every selected node when all selected nodes are hidden', () => {
    setupHideMenuPage()
    useEditorStore.setState({
      selectedNodeId: 'b',
      selectedNodeIds: ['b', 'c'],
    } as Parameters<typeof useEditorStore.setState>[0])
    renderHideMenu('b')

    fireEvent.click(screen.getByRole('menuitem', { name: /^unhide selected$/i }))

    const nodes = useEditorStore.getState().site?.pages[0].nodes
    expect(nodes?.b.hidden).toBe(false)
    expect(nodes?.c.hidden).toBe(false)
  })
})
```

- [ ] **Step 2: Run context-menu tests and verify they fail**

Run:

```sh
bun test src/__tests__/dom-panel/layerNodeContextMenu.test.tsx
```

Expected: the new Hide / Unhide tests fail because the menu item is not present.

- [ ] **Step 3: Implement context-menu action**

In `src/admin/pages/site/panels/DomPanel/LayerNodeContextMenu.tsx`:

- Import `EyeSolidIcon` from `pixel-art-icons/icons/eye-solid`.
- Determine `hideActionTargetIds`, `canToggleHidden`, `shouldHideSelection`, and `hideActionLabel` from the active page and selected ids.
- Add `dispatchToggleHidden` that calls `useEditorStore.getState().toggleNodeHidden(id)` only when a node's current hidden state differs from the target.
- Render the menu item before the copy/cut separator.

The core logic should be:

```ts
  const hideActionTargetIds = isMulti ? targetIds : nodeId ? [nodeId] : []
  const canToggleHidden = hideActionTargetIds.some((id) => id !== activePage?.rootNodeId)
  const shouldHideSelection = hideActionTargetIds.some((id) => {
    if (id === activePage?.rootNodeId) return false
    return !activePage?.nodes[id]?.hidden
  })
  const hideActionLabel = isMulti
    ? shouldHideSelection ? 'Hide selected' : 'Unhide selected'
    : shouldHideSelection ? 'Hide' : 'Unhide'

  const dispatchToggleHidden = () => {
    const { toggleNodeHidden } = useEditorStore.getState()
    for (const id of hideActionTargetIds) {
      if (id === activePage?.rootNodeId) continue
      const current = Boolean(activePage?.nodes[id]?.hidden)
      if (current !== shouldHideSelection) {
        toggleNodeHidden(id)
      }
    }
    onClose()
  }
```

- [ ] **Step 4: Run context-menu tests and verify they pass**

Run:

```sh
bun test src/__tests__/dom-panel/layerNodeContextMenu.test.tsx
```

Expected: all tests in the file pass.

## Task 3: Hidden Badge And Final Verification

**Files:**
- Modify: `src/admin/pages/site/panels/DomPanel/LayerTreeNodeContent.tsx`
- Modify: `src/admin/pages/site/panels/DomPanel/TreeNode.module.css`
- Test: `src/__tests__/panels/domPanel.test.tsx`

- [ ] **Step 1: Add failing DOM panel badge test**

Add this test near the existing DomPanel tree-row tests in `src/__tests__/panels/domPanel.test.tsx`:

```tsx
  it('keeps hidden nodes in the tree and marks them with a hidden badge', () => {
    loadContainerSite()
    act(() => {
      useEditorStore.getState().toggleNodeHidden('container-1')
    })

    render(<DomPanel />)

    expect(screen.getByRole('treeitem', { name: /container, hidden/i })).toBeDefined()
    expect(screen.getByText('hidden')).toBeDefined()
  })
```

- [ ] **Step 2: Run DomPanel test and verify it fails**

Run:

```sh
bun test src/__tests__/panels/domPanel.test.tsx
```

Expected: the hidden badge text assertion fails because the current indicator uses an icon/title rather than visible badge text.

- [ ] **Step 3: Implement the badge**

In `src/admin/pages/site/panels/DomPanel/LayerTreeNodeContent.tsx`, replace the current hidden indicator with:

```tsx
      {hidden && (
        <span aria-hidden="true" className={styles.hiddenBadge}>
          hidden
        </span>
      )}
```

In `src/admin/pages/site/panels/DomPanel/TreeNode.module.css`, add:

```css
.hiddenBadge {
    flex-shrink: 0;
    border-radius: var(--editor-radius-sm);
    background: var(--editor-surface-3);
    color: var(--editor-text-subtle);
    padding: 1px 5px;
    font-size: 10px;
    line-height: 1.3;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```sh
bun test src/__tests__/publisher/render.test.ts src/__tests__/publisher/visualComponentRef.test.ts src/__tests__/dom-panel/layerNodeContextMenu.test.tsx src/__tests__/panels/domPanel.test.tsx
```

Expected: all focused tests pass.

- [ ] **Step 5: Run React Doctor diff scan**

Run:

```sh
npx react-doctor@latest --verbose --diff
```

Expected: no score regression attributable to the changed React files.

- [ ] **Step 6: Run end-of-task verification**

Run:

```sh
bun test
bun run build
bun run lint
```

Expected: failures, if any, are triaged against the files changed for this feature versus pre-existing unrelated worktree changes.
