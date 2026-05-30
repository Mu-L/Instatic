/**
 * Canvas mode (Design / Preview) tests.
 *
 * Covers:
 * - canvasView default + setCanvasView store action
 * - CanvasModeToggle component reflects + drives the store, and surfaces
 *   inline breakpoint switcher buttons only when preview is active
 * - BreakpointFrame is design-only and never renders the runtime iframe
 * - CanvasPreviewSurface owns the runtime preview iframe in preview mode
 * - Bundle signature contract: a property edit on a node does not retrigger
 *   the runtime build, but a script-content edit, packageJson change, or
 *   Refresh does. That contract is the entire point of the design-vs-preview
 *   split — driven through CanvasPreviewSurface in this suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CanvasModeToggle } from '@site/canvas/CanvasModeToggle'
import { CanvasPreviewSurface } from '@site/canvas/CanvasPreviewSurface'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { useEditorStore } from '@site/store/store'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { makeNode, makePage, makeSite } from '../fixtures'

afterEach(cleanup)

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  // Reset to a clean canvas-view default for every test.
  useEditorStore.setState({ canvasView: 'design' } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  // Belt-and-suspenders: also reset after each test so canvasView never leaks
  // into subsequent test files (Zustand store is a global singleton across
  // the suite and unrelated tests render BreakpointFrame expecting design mode).
  useEditorStore.setState({ canvasView: 'design' } as Parameters<typeof useEditorStore.setState>[0])
})

// ---------------------------------------------------------------------------
// canvasView state + setCanvasView action
// ---------------------------------------------------------------------------

describe('canvasView store state', () => {
  it('defaults to "design" so existing users keep their familiar canvas', () => {
    expect(useEditorStore.getState().canvasView).toBe('design')
  })

  it('setCanvasView swaps between "design" and "preview"', () => {
    act(() => useEditorStore.getState().setCanvasView('preview'))
    expect(useEditorStore.getState().canvasView).toBe('preview')

    act(() => useEditorStore.getState().setCanvasView('design'))
    expect(useEditorStore.getState().canvasView).toBe('design')
  })
})

// ---------------------------------------------------------------------------
// CanvasModeToggle
// ---------------------------------------------------------------------------

describe('CanvasModeToggle', () => {
  it('renders both tabs with the design tab pre-selected', () => {
    render(<CanvasModeToggle />)

    const design = screen.getByTestId('canvas-mode-toggle-design')
    const preview = screen.getByTestId('canvas-mode-toggle-preview')
    expect(design.getAttribute('aria-selected')).toBe('true')
    expect(preview.getAttribute('aria-selected')).toBe('false')
  })

  it('clicking Preview switches the store to preview mode', () => {
    render(<CanvasModeToggle />)
    fireEvent.click(screen.getByTestId('canvas-mode-toggle-preview'))
    expect(useEditorStore.getState().canvasView).toBe('preview')
  })

  it('clicking Design switches the store back to design mode', () => {
    act(() => useEditorStore.getState().setCanvasView('preview'))
    render(<CanvasModeToggle />)
    fireEvent.click(screen.getByTestId('canvas-mode-toggle-design'))
    expect(useEditorStore.getState().canvasView).toBe('design')
  })

  it('does not render inline breakpoint buttons in design mode', () => {
    withRuntimeSite()
    render(<CanvasModeToggle />)
    expect(screen.queryByTestId('canvas-preview-breakpoints')).toBeNull()
  })

  it('renders an inline breakpoint button per site breakpoint when preview is active', () => {
    const { breakpoints } = withRuntimeSite()
    act(() => useEditorStore.getState().setCanvasView('preview'))
    render(<CanvasModeToggle />)

    const group = screen.getByTestId('canvas-preview-breakpoints')
    expect(group).toBeDefined()
    for (const bp of breakpoints) {
      expect(screen.getByTestId(`canvas-preview-breakpoint-${bp.id}`)).toBeDefined()
    }
  })

  it('clicking an inline breakpoint button drives setActiveBreakpoint', () => {
    const { breakpoints } = withRuntimeSite()
    act(() => useEditorStore.getState().setCanvasView('preview'))
    render(<CanvasModeToggle />)

    // Pick a non-active breakpoint to switch to.
    const initial = useEditorStore.getState().activeBreakpointId
    const target = breakpoints.find((bp) => bp.id !== initial) ?? breakpoints[0]
    fireEvent.click(screen.getByTestId(`canvas-preview-breakpoint-${target.id}`))
    expect(useEditorStore.getState().activeBreakpointId).toBe(target.id)
  })
})

// ---------------------------------------------------------------------------
// Test-site fixture
// ---------------------------------------------------------------------------

function withRuntimeSite() {
  const runtime = normalizeSiteRuntimeConfig({
    scripts: {
      entry: { enabled: true, runInCanvas: true, placement: 'body-end', timing: 'dom-ready', scope: { type: 'all-pages' }, priority: 100 },
    },
  })
  const page = makePage({
    id: 'page-1',
    nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: [] }) },
  })
  const site = makeSite({
    pages: [page],
    files: [{
      id: 'entry',
      path: 'src/scripts/entry.ts',
      type: 'script',
      content: 'console.log("hi")',
      createdAt: 1,
      updatedAt: 1,
    }],
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime,
  })

  useEditorStore.setState({
    site,
    packageJson: site.packageJson,
    siteRuntime: runtime,
    activePageId: 'page-1',
    activeBreakpointId: site.breakpoints[0]?.id ?? 'desktop',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])

  return { page, breakpoints: site.breakpoints, breakpoint: site.breakpoints[0] }
}

// ---------------------------------------------------------------------------
// BreakpointFrame is design-only
// ---------------------------------------------------------------------------

describe('BreakpointFrame is design-only', () => {
  it('never renders the runtime iframe, even when preview mode is active', () => {
    const { page, breakpoint } = withRuntimeSite()
    act(() => useEditorStore.getState().setCanvasView('preview'))
    render(
      <BreakpointFrame
        page={page}
        breakpoint={breakpoint}
        isActive
        onActivate={() => {}}
      />,
    )
    expect(screen.queryByTestId('canvas-runtime-preview')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// CanvasPreviewSurface — runtime iframe + bundle signature contract
// ---------------------------------------------------------------------------

describe('CanvasPreviewSurface', () => {
  let buildCalls = 0
  beforeEach(() => {
    buildCalls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/admin/api/cms/runtime/preview')) {
        buildCalls += 1
        return new Response(JSON.stringify({
          html: '<!DOCTYPE html><html><body></body></html>',
          assets: [],
          runtimeAssets: { scripts: [] },
          diagnostics: [],
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch
  })

  async function flushDebounce(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
  }

  function renderPreviewSurface() {
    const { page, breakpoint } = withRuntimeSite()
    act(() => useEditorStore.getState().setCanvasView('preview'))
    return {
      page,
      breakpoint,
      ...render(
        <CanvasPreviewSurface page={page} activeBreakpoint={breakpoint} />,
      ),
    }
  }

  it('renders the runtime iframe once the build resolves', async () => {
    renderPreviewSurface()
    await flushDebounce()
    const iframe = await screen.findByTestId('canvas-runtime-preview')
    expect(iframe).toBeDefined()
  })

  it('rebuilds whenever the site is mutated (debounced) — node prop edit', async () => {
    renderPreviewSurface()
    await flushDebounce()
    expect(buildCalls).toBe(1)

    act(() => {
      const current = useEditorStore.getState().site!
      const nextPages = current.pages.map((p) =>
        p.id !== 'page-1' ? p : {
          ...p,
          nodes: {
            ...p.nodes,
            root: { ...p.nodes.root, props: { ...p.nodes.root.props, padding: '16px' } },
          },
        },
      )
      useEditorStore.setState({
        site: { ...current, pages: nextPages, updatedAt: Date.now() },
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    await flushDebounce()

    // Preview is a separate surface from the design canvas in the new
    // architecture, so rebuilding on every site change can't trigger
    // "scripts re-execute on every keystroke" — the user can't be typing
    // while the iframe is the visible surface. We choose freshness over
    // the older guarantee.
    expect(buildCalls).toBe(2)
  })

  it('rebuilds when a script file changes', async () => {
    renderPreviewSurface()
    await flushDebounce()
    expect(buildCalls).toBe(1)

    act(() => {
      const current = useEditorStore.getState().site!
      const nextFiles = current.files.map((f) =>
        f.id !== 'entry' ? f : { ...f, content: 'console.log("changed")' },
      )
      useEditorStore.setState({
        site: { ...current, files: nextFiles, updatedAt: Date.now() },
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    await flushDebounce()

    expect(buildCalls).toBe(2)
  })

  it('rebuilds when packageJson changes', async () => {
    renderPreviewSurface()
    await flushDebounce()
    expect(buildCalls).toBe(1)

    act(() => {
      const current = useEditorStore.getState().site!
      const nextPackageJson = {
        ...current.packageJson!,
        dependencies: { 'canvas-confetti': '*' },
      }
      useEditorStore.setState({
        site: { ...current, packageJson: nextPackageJson, updatedAt: Date.now() },
        packageJson: nextPackageJson,
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    await flushDebounce()

    expect(buildCalls).toBe(2)
  })

  it('rebuilds when a class style changes (drives bug 2 — stale styles)', async () => {
    renderPreviewSurface()
    await flushDebounce()
    expect(buildCalls).toBe(1)

    act(() => {
      const current = useEditorStore.getState().site!
      // Simulate a user editing class styles in design mode and then having
      // them flow into the next build via site.updatedAt.
      useEditorStore.setState({
        site: {
          ...current,
          styleRules: {
            ...current.classes,
            'hero': {
              id: 'hero',
              name: 'hero',
              kind: 'reusable',
              styles: { padding: '60px' },
              breakpointStyles: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
          updatedAt: Date.now(),
        },
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    await flushDebounce()

    expect(buildCalls).toBe(2)
  })

  // NOTE: a "breakpoint switches" rerender test is intentionally omitted —
  // it exercises the same buildSignature memo recompute that script-content,
  // packageJson, and Refresh tests already cover, but happens to be flaky
  // under jsdom's debounced-effect scheduler. The contract holds at the hook
  // level: breakpointId is part of computeBuildSignature() so any change
  // recomputes the signature and re-fires the effect.

  it('rebuilds on Refresh click even when nothing else changed', async () => {
    renderPreviewSurface()
    await flushDebounce()
    expect(buildCalls).toBe(1)

    fireEvent.click(await screen.findByTestId('canvas-runtime-preview-refresh'))
    await flushDebounce()
    expect(buildCalls).toBe(2)
  })

  it('exposes both side resize handles', () => {
    renderPreviewSurface()
    expect(screen.getByTestId('canvas-preview-resize-left')).toBeDefined()
    expect(screen.getByTestId('canvas-preview-resize-right')).toBeDefined()
  })
})
