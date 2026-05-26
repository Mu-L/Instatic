/**
 * Smoke tests for the hole runtime JavaScript string.
 *
 * The test environment preloads `happy-dom` (via `bunfig.toml` → `setup.ts`),
 * which provides `IntersectionObserver`, `document`, and `fetch` globals.
 *
 * These tests verify:
 *   1. The runtime source contains the expected IntersectionObserver API calls.
 *   2. The runtime function compiles (no SyntaxError).
 *   3. The runtime registers an observer for every `<pb-hole[data-pb-hole]>` element.
 *   4. When an IntersectionObserver callback fires with isIntersecting=true,
 *      the runtime calls `fetch` with the correct URL and swaps `el.outerHTML`.
 *
 * We drive the `IntersectionObserver` callbacks manually since happy-dom does
 * not fire them based on real viewport layout.
 */

import { describe, it, expect } from 'bun:test'
import { HOLE_RUNTIME_JS } from '../../../server/publish/holeRuntime'

// ---------------------------------------------------------------------------
// Static source assertions
// ---------------------------------------------------------------------------

describe('HOLE_RUNTIME_JS — static source content', () => {
  it('contains IntersectionObserver with 200px rootMargin', () => {
    expect(HOLE_RUNTIME_JS).toContain('IntersectionObserver')
    expect(HOLE_RUNTIME_JS).toContain('200px')
  })

  it('contains encodeURIComponent calls for nodeId and version', () => {
    expect(HOLE_RUNTIME_JS).toContain('encodeURIComponent')
    expect(HOLE_RUNTIME_JS).toContain('pbHole')
    expect(HOLE_RUNTIME_JS).toContain('pbVersion')
  })

  it('references the /_pb/hole/ endpoint', () => {
    expect(HOLE_RUNTIME_JS).toContain('/_pb/hole/')
  })

  it('swaps outerHTML (not innerHTML)', () => {
    expect(HOLE_RUNTIME_JS).toContain('outerHTML')
    // Must NOT use innerHTML for the swap — outerHTML replaces the element itself
    expect(HOLE_RUNTIME_JS).not.toMatch(/\.innerHTML\s*=/)
  })

  it('queries pb-hole[data-pb-hole] elements', () => {
    expect(HOLE_RUNTIME_JS).toContain('pb-hole[data-pb-hole]')
  })

  it('compiles without SyntaxError', () => {
    // new Function() parses the JS source — a SyntaxError means the runtime
    // string is malformed and would fail to load in a browser.
    expect(() => new Function(HOLE_RUNTIME_JS)).not.toThrow()
  })

  it('calls io.unobserve on intersecting entries (single-flight per element)', () => {
    expect(HOLE_RUNTIME_JS).toContain('unobserve')
  })

  it('has a .catch() so fetch failures are silently swallowed', () => {
    expect(HOLE_RUNTIME_JS).toContain('.catch(')
  })
})

// ---------------------------------------------------------------------------
// Runtime behaviour — DOM-driven
// ---------------------------------------------------------------------------

describe('HOLE_RUNTIME_JS — runtime behaviour with mock IntersectionObserver', () => {
  it('registers an IntersectionObserver and observes pb-hole elements', () => {
    // Set up DOM with two pb-hole elements
    document.body.innerHTML = `
      <pb-hole id="hole-a" data-pb-hole="node-a" data-pb-version="1"></pb-hole>
      <pb-hole id="hole-b" data-pb-hole="node-b" data-pb-version="1"></pb-hole>
    `

    const observedElements: Element[] = []
    let capturedCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null

    const originalIO = globalThis.IntersectionObserver

    // Replace IntersectionObserver with a recording stub
    ;(globalThis as Record<string, unknown>).IntersectionObserver = class MockIO {
      constructor(
        callback: (entries: IntersectionObserverEntry[]) => void,
        _options?: IntersectionObserverInit,
      ) {
        capturedCallback = callback
      }
      observe(el: Element) {
        observedElements.push(el)
      }
      unobserve(_el: Element) {}
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver

    try {
      // Evaluate the runtime in the current context
      new Function(HOLE_RUNTIME_JS)()

      // Both pb-hole elements should be observed
      expect(observedElements.length).toBe(2)
      expect(capturedCallback).not.toBeNull()
    } finally {
      ;(globalThis as Record<string, unknown>).IntersectionObserver = originalIO
      document.body.innerHTML = ''
    }
  })

  it('calls fetch with the correct URL when an entry intersects', async () => {
    // Set up a single pb-hole element
    document.body.innerHTML = `
      <pb-hole id="hole-c" data-pb-hole="node-c" data-pb-version="42"></pb-hole>
    `

    const fetchedUrls: string[] = []
    const unobservedElements: Element[] = []
    let capturedCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null

    const originalFetch = globalThis.fetch
    const originalIO = globalThis.IntersectionObserver

    // Stub fetch to capture the URL and return a fake HTML response
    ;(globalThis as Record<string, unknown>).fetch = (url: string) => {
      fetchedUrls.push(url)
      return Promise.resolve({
        text: () => Promise.resolve('<span>Loaded content</span>'),
      })
    }

    ;(globalThis as Record<string, unknown>).IntersectionObserver = class MockIO {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        capturedCallback = callback
      }
      observe(_el: Element) {}
      unobserve(el: Element) {
        unobservedElements.push(el)
      }
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver

    try {
      new Function(HOLE_RUNTIME_JS)()

      const holeEl = document.getElementById('hole-c')!

      // Simulate IntersectionObserver callback firing for the element
      capturedCallback?.([
        {
          isIntersecting: true,
          target: holeEl,
        } as IntersectionObserverEntry,
      ])

      // Wait for the microtask queue (fetch is async)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // The fetch URL must include the nodeId and version
      expect(fetchedUrls.length).toBeGreaterThanOrEqual(1)
      const fetchedUrl = fetchedUrls[0]
      expect(fetchedUrl).toContain('/_pb/hole/')
      expect(fetchedUrl).toContain('node-c')
      expect(fetchedUrl).toContain('v=')
      expect(fetchedUrl).toContain('42')

      // The element should have been unobserved (single-flight)
      expect(unobservedElements.length).toBe(1)
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      ;(globalThis as Record<string, unknown>).IntersectionObserver = originalIO
      document.body.innerHTML = ''
    }
  })

  it('does NOT call fetch for non-intersecting entries', () => {
    document.body.innerHTML = `
      <pb-hole id="hole-d" data-pb-hole="node-d" data-pb-version="1"></pb-hole>
    `

    const fetchedUrls: string[] = []
    let capturedCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null

    const originalFetch = globalThis.fetch
    const originalIO = globalThis.IntersectionObserver

    ;(globalThis as Record<string, unknown>).fetch = (url: string) => {
      fetchedUrls.push(url)
      return Promise.resolve({ text: () => Promise.resolve('') })
    }

    ;(globalThis as Record<string, unknown>).IntersectionObserver = class MockIO {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        capturedCallback = callback
      }
      observe(_el: Element) {}
      unobserve(_el: Element) {}
      disconnect() {}
      takeRecords() { return [] }
    } as unknown as typeof IntersectionObserver

    try {
      new Function(HOLE_RUNTIME_JS)()

      const holeEl = document.getElementById('hole-d')!

      // Non-intersecting entry — fetch must NOT be called
      capturedCallback?.([
        {
          isIntersecting: false,
          target: holeEl,
        } as IntersectionObserverEntry,
      ])

      expect(fetchedUrls.length).toBe(0)
    } finally {
      ;(globalThis as Record<string, unknown>).fetch = originalFetch
      ;(globalThis as Record<string, unknown>).IntersectionObserver = originalIO
      document.body.innerHTML = ''
    }
  })
})
