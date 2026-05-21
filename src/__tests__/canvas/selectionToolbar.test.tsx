import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { CanvasViewportActionsContext } from '@site/canvas/CanvasContexts'
import { useEditorStore } from '@site/store/store'
import type { Page } from '@core/page-tree'
import '@modules/base/index'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    activeClassId: null,
    activeBreakpointId: 'desktop',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function createSelectedTextPage(): { page: Page; textId: string } {
  const site = useEditorStore.getState().createSite('Toolbar Test')
  const rootId = site.pages[0].rootNodeId
  const textId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'Selected text', tag: 'p' },
    rootId,
  )
  const page = useEditorStore.getState().site!.pages[0]
  useEditorStore.setState({
    selectedNodeId: textId,
    selectedNodeIds: [textId],
    activeBreakpointId: 'desktop',
  } as Parameters<typeof useEditorStore.setState>[0])
  return { page, textId }
}

function createSortableTextPage(): {
  page: Page
  rootId: string
  firstId: string
  secondId: string
  thirdId: string
} {
  const site = useEditorStore.getState().createSite('Canvas Drag Test')
  const rootId = site.pages[0].rootNodeId
  const firstId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'First', tag: 'p' },
    rootId,
  )
  const secondId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'Second', tag: 'p' },
    rootId,
  )
  const thirdId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'Third', tag: 'p' },
    rootId,
  )
  const page = useEditorStore.getState().site!.pages[0]
  useEditorStore.setState({
    selectedNodeId: secondId,
    selectedNodeIds: [secondId],
    activeBreakpointId: 'desktop',
  } as Parameters<typeof useEditorStore.setState>[0])
  return { page, rootId, firstId, secondId, thirdId }
}

function createMultiSortableTextPage(): {
  page: Page
  rootId: string
  firstId: string
  secondId: string
  thirdId: string
  fourthId: string
} {
  const site = useEditorStore.getState().createSite('Canvas Multi Drag Test')
  const rootId = site.pages[0].rootNodeId
  const firstId = useEditorStore.getState().insertNode('base.text', { text: 'First', tag: 'p' }, rootId)
  const secondId = useEditorStore.getState().insertNode('base.text', { text: 'Second', tag: 'p' }, rootId)
  const thirdId = useEditorStore.getState().insertNode('base.text', { text: 'Third', tag: 'p' }, rootId)
  const fourthId = useEditorStore.getState().insertNode('base.text', { text: 'Fourth', tag: 'p' }, rootId)
  const page = useEditorStore.getState().site!.pages[0]
  useEditorStore.setState({
    selectedNodeId: thirdId,
    selectedNodeIds: [secondId, thirdId],
    activeBreakpointId: 'desktop',
  } as Parameters<typeof useEditorStore.setState>[0])
  return { page, rootId, firstId, secondId, thirdId, fourthId }
}

function installCanvasRects(rects: Record<string, DOMRectInit>) {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement
    if (element.dataset.canvasTestRoot === 'true') {
      return testRect({ x: 0, y: 0, width: 200, height: 200 })
    }
    if (element.dataset.breakpointId === 'desktop') {
      return testRect({ x: 0, y: 0, width: 400, height: 400 })
    }
    const owner = element.closest('[data-node-id]') as HTMLElement | null
    const nodeId = owner?.dataset.nodeId
    const rect = nodeId ? rects[nodeId] : null
    return testRect(rect ?? { x: 0, y: 0, width: 0, height: 0 })
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}

function CanvasActionsTestProvider({
  children,
  panBy,
}: {
  children: ReactNode
  panBy: (dx: number, dy: number) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef} data-canvas-test-root="true">
      <CanvasViewportActionsContext.Provider value={{ canvasRootRef: rootRef, panBy }}>
        {children}
      </CanvasViewportActionsContext.Provider>
    </div>
  )
}

function installRafQueue() {
  const originalRaf = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const callbacks: FrameRequestCallback[] = []
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callbacks.push(callback)
    return callbacks.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
  return {
    flushOne: () => callbacks.shift()?.(performance.now()),
    restore: () => {
      globalThis.requestAnimationFrame = originalRaf
      globalThis.cancelAnimationFrame = originalCancel
    },
  }
}

function testRect(rect: DOMRectInit): DOMRect {
  const x = rect.x ?? 0
  const y = rect.y ?? 0
  const width = rect.width ?? 0
  const height = rect.height ?? 0
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(resetStore)
afterEach(() => {
  cleanup()
  resetStore()
})

describe('canvas selection toolbar', () => {
  it('renders one drag handle on the active breakpoint frame only', () => {
    const { page } = createSelectedTextPage()

    render(
      <>
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' }}
          isActive={false}
          onActivate={() => {}}
        />
      </>,
    )

    expect(screen.getAllByRole('button', { name: 'Drag selected layers' })).toHaveLength(1)
  })

  it('renders selection actions and positions the toolbar above the selected layer even outside the frame', () => {
    const { page, textId } = createSelectedTextPage()
    const restoreRects = installCanvasRects({
      [textId]: { x: 20, y: 10, width: 160, height: 40 },
    })
    const raf = installRafQueue()

    try {
      render(
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />,
      )

      act(() => {
        raf.flushOne()
      })

      const toolbar = screen.getByRole('group', { name: 'Selection actions' })
      expect(toolbar.parentElement).toBe(document.body)
      expect(toolbar.style.getPropertyValue('--canvas-toolbar-x')).toBe('20px')
      expect(toolbar.style.getPropertyValue('--canvas-toolbar-y')).toBe('-20px')
      expect(screen.getByRole('button', { name: 'Drag selected layers' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Duplicate selected layers' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Delete selected layers' })).toBeTruthy()
    } finally {
      raf.restore()
      restoreRects()
    }
  })

  it('duplicates selected layers from the selection toolbar', () => {
    const { page, textId } = createSelectedTextPage()
    const rootId = page.rootNodeId

    render(
      <BreakpointFrame
        page={page}
        breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
        isActive
        onActivate={() => {}}
      />,
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Duplicate selected layers' }))
    })

    const currentPage = useEditorStore.getState().site!.pages[0]
    const children = currentPage.nodes[rootId].children
    expect(children).toHaveLength(2)
    expect(children[0]).toBe(textId)
    expect(currentPage.nodes[children[1]].moduleId).toBe('base.text')
  })

  it('deletes selected layers from the selection toolbar', () => {
    const { page, textId } = createSelectedTextPage()
    const rootId = page.rootNodeId

    render(
      <BreakpointFrame
        page={page}
        breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
        isActive
        onActivate={() => {}}
      />,
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete selected layers' }))
    })

    const currentPage = useEditorStore.getState().site!.pages[0]
    expect(currentPage.nodes[rootId].children).toEqual([])
    expect(currentPage.nodes[textId]).toBeUndefined()
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
  })

  it('moves the selected layer when its drag handle is released over a canvas after-zone', () => {
    const { page, rootId, firstId, secondId, thirdId } = createSortableTextPage()
    const restoreRects = installCanvasRects({
      [rootId]: { x: 0, y: 0, width: 400, height: 300 },
      [firstId]: { x: 20, y: 10, width: 160, height: 40 },
      [secondId]: { x: 20, y: 60, width: 160, height: 40 },
      [thirdId]: { x: 20, y: 120, width: 160, height: 40 },
    })

    try {
      render(
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />,
      )

      const handle = screen.getByRole('button', { name: 'Drag selected layers' })
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 32, clientY: 64 })
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 32, clientY: 156 })
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 32, clientY: 156 })
      })

      const currentPage = useEditorStore.getState().site!.pages[0]
      expect(currentPage.nodes[rootId].children).toEqual([firstId, thirdId, secondId])
    } finally {
      restoreRects()
    }
  })

  it('moves a multi-selection as one ordered batch from the canvas drag handle', () => {
    const { page, rootId, firstId, secondId, thirdId, fourthId } = createMultiSortableTextPage()
    const restoreRects = installCanvasRects({
      [rootId]: { x: 0, y: 0, width: 400, height: 360 },
      [firstId]: { x: 20, y: 10, width: 160, height: 40 },
      [secondId]: { x: 20, y: 60, width: 160, height: 40 },
      [thirdId]: { x: 20, y: 110, width: 160, height: 40 },
      [fourthId]: { x: 20, y: 170, width: 160, height: 40 },
    })

    try {
      render(
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />,
      )

      const handle = screen.getByRole('button', { name: 'Drag selected layers' })
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 32, clientY: 114 })
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 32, clientY: 206 })
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 32, clientY: 206 })
      })

      const currentPage = useEditorStore.getState().site!.pages[0]
      expect(currentPage.nodes[rootId].children).toEqual([firstId, fourthId, secondId, thirdId])
    } finally {
      restoreRects()
    }
  })

  it('auto-pans the canvas when a handle drag moves near the canvas edge', () => {
    const { page, rootId, firstId, secondId, thirdId } = createSortableTextPage()
    const restoreRects = installCanvasRects({
      [rootId]: { x: 0, y: 0, width: 400, height: 300 },
      [firstId]: { x: 20, y: 10, width: 160, height: 40 },
      [secondId]: { x: 20, y: 60, width: 160, height: 40 },
      [thirdId]: { x: 20, y: 120, width: 160, height: 40 },
    })
    let raf: ReturnType<typeof installRafQueue> | null = null
    const panCalls: Array<[number, number]> = []

    try {
      render(
        <CanvasActionsTestProvider panBy={(dx, dy) => panCalls.push([dx, dy])}>
          <BreakpointFrame
            page={page}
            breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
            isActive
            onActivate={() => {}}
          />
        </CanvasActionsTestProvider>,
      )

      raf = installRafQueue()
      const handle = screen.getByRole('button', { name: 'Drag selected layers' })
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 32, clientY: 64 })
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 196, clientY: 100 })
        raf.flushOne()
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 196, clientY: 100 })
      })

      expect(panCalls.length).toBeGreaterThan(0)
      expect(panCalls[0][0]).toBeLessThan(0)
    } finally {
      raf?.restore()
      restoreRects()
    }
  })
})
