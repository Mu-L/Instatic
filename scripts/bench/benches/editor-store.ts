/**
 * Editor store benchmark — the "is the builder laggy?" answer.
 *
 * Drives the live Zustand+Immer editor store the way the actual visual
 * builder UI drives it. Measures pure data-mutation cost (no React,
 * no DOM) — so what we observe is the algorithmic floor below which any
 * UI lag must originate from rendering, not state.
 *
 * Scenarios:
 *   - Class creation: how does `createClass()` scale to 100 / 1k / 10k / 100k?
 *   - Class lookup: random access to a node's resolved class list
 *   - Node insertion / deletion / movement at 100 / 1k / 10k node trees
 *   - History push (undo stack growth) and memory bookkeeping
 *   - Node-class assignment with huge class catalogues
 *
 * The user-facing question this answers:
 *   "If I add 10,000 CSS classes, does the builder start dropping frames?"
 *
 * The data-mutation answer ("does the algorithm scale?") is here. If a
 * mutation is microseconds, any UI jank elsewhere comes from rendering,
 * not state.
 */
import { performance } from 'node:perf_hooks'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from '../lib/types'
import { summarize, fmtMs, fmtNum, fmtBytes } from '../lib/stats'
import { log } from '../lib/log'

// Load the live editor store. Imports `@admin/state/adminUi` which is
// admin-shell only, but the actions themselves don't touch the DOM.
async function loadStore() {
  // Side effect — registers base modules so insertNode finds them.
  await import('../../../src/modules/base')
  const { useEditorStore } = await import('../../../src/admin/pages/site/store/store')
  return useEditorStore
}

function resetStore(useStore: Awaited<ReturnType<typeof loadStore>>): void {
  useStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hasUnsavedChanges: false,
    activeDocument: null,
    activePageId: null,
  })
}

function setupSite(useStore: Awaited<ReturnType<typeof loadStore>>): void {
  resetStore(useStore)
  const s = useStore.getState() as { createSite: (name: string) => void }
  s.createSite('Bench Site')
}

function estimateSiteHeap(useStore: Awaited<ReturnType<typeof loadStore>>): number {
  // Approximate the in-memory cost of the site document via JSON length —
  // useful as a "did adding N classes blow up memory?" signal. Accurate
  // bytes would need v8.getHeapStatistics() which doesn't break down by
  // owner; this approximation is good enough for trend lines.
  try {
    const site = (useStore.getState() as { site: unknown }).site
    return JSON.stringify(site ?? {}).length
  } catch {
    return -1
  }
}

interface ClassResults {
  classCount: number
  perCreateMean: number
  perCreateP95: number
  totalMs: number
  heapBytes: number
}

async function benchClassCreation(
  useStore: Awaited<ReturnType<typeof loadStore>>,
  classCount: number,
): Promise<ClassResults> {
  setupSite(useStore)
  const state = useStore.getState() as {
    createClass: (name: string, styles?: Record<string, unknown>) => unknown
  }
  // Time every create — we want to see whether the curve flattens (O(1)) or
  // grows (O(N)) as N grows. We sample every Kth call to keep memory
  // bounded but capture the trend.
  const sampleEvery = Math.max(1, Math.floor(classCount / 1000))
  const samples: number[] = []
  const totalStart = performance.now()
  for (let i = 0; i < classCount; i++) {
    const t0 = performance.now()
    state.createClass(`bench-class-${i}`, {
      color: `hsl(${(i * 137) % 360}deg 60% 50%)`,
      padding: `${(i % 4) * 4}px`,
    })
    const dur = performance.now() - t0
    if (i % sampleEvery === 0) samples.push(dur)
  }
  const totalMs = performance.now() - totalStart
  const s = summarize(samples)
  const heapBytes = estimateSiteHeap(useStore)
  return {
    classCount,
    perCreateMean: s.mean,
    perCreateP95: s.p95,
    totalMs,
    heapBytes,
  }
}

function readActivePage(useStore: Awaited<ReturnType<typeof loadStore>>): { id: string; rootNodeId: string } | null {
  const state = useStore.getState() as {
    site: { pages: Array<{ id: string; rootNodeId: string }> } | null
    activePageId: string | null
  }
  if (!state.site || !state.activePageId) return null
  return state.site.pages.find((p) => p.id === state.activePageId) ?? null
}

async function benchTreeMutations(
  useStore: Awaited<ReturnType<typeof loadStore>>,
  nodeCount: number,
): Promise<{ insertMs: number; deleteMs: number; insertSamples: number[]; deleteSamples: number[]; finalHeap: number; activePageId: string | null }> {
  setupSite(useStore)
  const state = useStore.getState() as {
    insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string, index?: number) => string
    deleteNode: (nodeId: string) => void
  }
  const page = readActivePage(useStore)
  if (!page) throw new Error('No active page after createSite — store layout has changed; update editor-store bench.')
  const rootId = page.rootNodeId

  const insertSamples: number[] = []
  const insertedIds: string[] = []
  const sampleEvery = Math.max(1, Math.floor(nodeCount / 500))
  const insertStart = performance.now()
  for (let i = 0; i < nodeCount; i++) {
    const t0 = performance.now()
    const id = state.insertNode('base.text', { text: `n${i}`, tag: 'p' }, rootId)
    const dur = performance.now() - t0
    insertedIds.push(id)
    if (i % sampleEvery === 0) insertSamples.push(dur)
  }
  const insertMs = performance.now() - insertStart

  const finalHeap = estimateSiteHeap(useStore)

  // Now delete every other inserted node — measures the deleteNode cost
  // when the tree is well-populated.
  const deleteSamples: number[] = []
  const deleteStart = performance.now()
  for (let i = 0; i < insertedIds.length; i += 2) {
    const t0 = performance.now()
    state.deleteNode(insertedIds[i])
    const dur = performance.now() - t0
    if (i % (sampleEvery * 2) === 0) deleteSamples.push(dur)
  }
  const deleteMs = performance.now() - deleteStart

  return { insertMs, deleteMs, insertSamples, deleteSamples, finalHeap, activePageId: (useStore.getState() as { activePageId: string | null }).activePageId }
}

export const editorStoreBench: BenchModule = {
  name: 'editor-store',
  title: 'Editor store — mutation + class system scaling',
  description: 'Drives the live Zustand store with realistic class & tree workloads; answers "is the builder laggy at scale?".',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const useStore = await loadStore()

    // ---- Class creation scaling -----------------------------------------
    // Current `createClass` is O(N) per op (`Object.values(site.classes).find`
    // uniqueness check) → O(N²) total. 100k full-mode is intentionally a
    // measure of that — runs ~20min at 100k. Adjust if the algorithm changes.
    const classCounts = ctx.quick ? [100, 1_000] : [100, 1_000, 10_000]
    log.step('Class creation scaling')
    const classRows: BenchRow[] = []
    let lastResult: ClassResults | null = null
    for (const n of classCounts) {
      log.step(`  creating ${fmtNum(n)} classes…`)
      const result = await benchClassCreation(useStore, n)
      lastResult = result
      classRows.push({
        label: `${fmtNum(n)} classes`,
        inputs: { classes: n },
        metrics: {
          per_create_mean: fmtMs(result.perCreateMean),
          per_create_p95: fmtMs(result.perCreateP95),
          total: fmtMs(result.totalMs),
          state_heap: fmtBytes(result.heapBytes),
          throughput: `${fmtNum(Math.floor(n / (result.totalMs / 1000)))} ops/sec`,
        },
      })
      log.detail(`    per-op mean=${fmtMs(result.perCreateMean)} p95=${fmtMs(result.perCreateP95)} total=${fmtMs(result.totalMs)}`)
    }

    // ---- Class lookup scaling -------------------------------------------
    log.step('Class lookup throughput (Record<string, CSSClass> read)')
    const lookupRows: BenchRow[] = []
    {
      // Catalogue seeding is dominated by createClass cost (O(N²) overall in
      // the current implementation), so cap quick-mode catalogues hard.
      const lookupCounts = ctx.quick ? [100, 1_000] : [100, 1_000, 10_000]
      for (const n of lookupCounts) {
        setupSite(useStore)
        const state = useStore.getState() as { createClass: (name: string) => { id: string } }
        const ids: string[] = []
        for (let i = 0; i < n; i++) ids.push(state.createClass(`lookup-${i}`).id)

        const site = (useStore.getState() as { site: { classes: Record<string, unknown> } }).site
        const iters = ctx.quick ? 50_000 : 200_000
        // Warmup
        for (let i = 0; i < 1000; i++) {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          site.classes[ids[i % ids.length]]
        }
        const t0 = performance.now()
        let sink: unknown = null
        for (let i = 0; i < iters; i++) {
          sink = site.classes[ids[i % ids.length]]
        }
        const elapsedMs = performance.now() - t0
        if (!sink) throw new Error('lookup never read a value (unreachable)')
        lookupRows.push({
          label: `${fmtNum(n)} classes`,
          inputs: { classes: n, lookups: iters },
          metrics: {
            ns_per_lookup: `${((elapsedMs * 1_000_000) / iters).toFixed(0)} ns`,
            throughput: `${fmtNum(Math.floor((iters / elapsedMs) * 1000))} lookups/s`,
          },
        })
      }
    }

    // ---- Node tree mutations --------------------------------------------
    log.step('Node tree mutations (insertNode / deleteNode)')
    const treeRows: BenchRow[] = []
    {
      const sizes = ctx.quick ? [100, 1_000] : [100, 1_000, 5_000, 10_000]
      for (const n of sizes) {
        log.step(`  ${fmtNum(n)}-node tree`)
        const r = await benchTreeMutations(useStore, n)
        const insertSummary = summarize(r.insertSamples)
        const deleteSummary = summarize(r.deleteSamples)
        treeRows.push({
          label: `${fmtNum(n)}-node tree`,
          inputs: { nodes_inserted: n },
          metrics: {
            insert_total: fmtMs(r.insertMs),
            insert_mean_per_op: fmtMs(insertSummary.mean),
            insert_p95: fmtMs(insertSummary.p95),
            delete_total: fmtMs(r.deleteMs),
            delete_mean_per_op: fmtMs(deleteSummary.mean),
            delete_p95: fmtMs(deleteSummary.p95),
            final_heap: fmtBytes(r.finalHeap),
          },
        })
        log.detail(`    insert: ${fmtMs(r.insertMs)} (${fmtMs(insertSummary.mean)}/op)  delete½: ${fmtMs(r.deleteMs)} (${fmtMs(deleteSummary.mean)}/op)`)
      }
    }

    // ---- Node-class assignment with a huge catalogue --------------------
    log.step('Node-class assignment under large catalogue')
    const assignRows: BenchRow[] = []
    {
      // Same constraint as the lookup bench — catalogue seed is the long pole.
      const cataloguePresets = ctx.quick ? [100, 1_000] : [100, 1_000, 10_000]
      for (const catalogueSize of cataloguePresets) {
        setupSite(useStore)
        const state = useStore.getState() as {
          createClass: (name: string) => { id: string }
          insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string) => string
          addNodeClass: (nodeId: string, classId: string) => void
        }
        // Seed catalogue
        const classIds: string[] = []
        for (let i = 0; i < catalogueSize; i++) classIds.push(state.createClass(`cat-${i}`).id)
        const page = readActivePage(useStore)
        if (!page) continue
        // Add one target node and assign many classes to it
        const targetId = state.insertNode('base.text', { text: 'target', tag: 'p' }, page.rootNodeId)
        const ASSIGNS = ctx.quick ? 200 : 1_000
        const samples: number[] = []
        for (let i = 0; i < ASSIGNS; i++) {
          const t0 = performance.now()
          state.addNodeClass(targetId, classIds[i % classIds.length])
          samples.push(performance.now() - t0)
        }
        const s = summarize(samples)
        assignRows.push({
          label: `${fmtNum(catalogueSize)} classes in catalogue`,
          inputs: { catalogue: catalogueSize, assignments: ASSIGNS },
          metrics: {
            mean: fmtMs(s.mean),
            p95: fmtMs(s.p95),
            p99: fmtMs(s.p99),
            throughput: `${fmtNum(Math.floor(1000 / s.mean))} ops/s`,
          },
        })
      }
    }

    // Headline picks the worst-case class creation so it's visible if it
    // ever becomes bad. The other slots pull whatever the largest tree /
    // lookup test we ran was (covers both quick and full modes).
    const worstClassN = lastResult?.classCount ?? 0
    const worstClassP95 = lastResult ? fmtMs(lastResult.perCreateP95) : '—'
    const largestTreeRow = treeRows[treeRows.length - 1]
    const largestLookupRow = lookupRows[lookupRows.length - 1]
    return {
      name: this.name,
      title: this.title,
      headline: {
        [`createClass p95 @ ${fmtNum(worstClassN)} classes`]: worstClassP95,
        [`${largestTreeRow?.label ?? 'tree'} insert mean`]: largestTreeRow?.metrics.insert_mean_per_op ?? '—',
        [`${largestLookupRow?.label ?? 'lookup'} ns/op`]: largestLookupRow?.metrics.ns_per_lookup ?? '—',
      },
      sections: [
        {
          title: 'Class creation scaling',
          intro:
            'How does `createClass()` cost grow as the existing class count grows? Watch p95 — flat means O(1)/amortized, climbing means linear scans.',
          rows: classRows,
        },
        {
          title: 'Class lookup throughput',
          intro: 'Random `site.classes[id]` lookups — the floor below which any class-related rendering must live.',
          rows: lookupRows,
        },
        {
          title: 'Node tree mutations',
          intro:
            'Sequential insertNode then delete-every-other-node on the same tree. Measures the raw store-mutation cost the visual builder pays.',
          rows: treeRows,
        },
        {
          title: 'Node-class assignment with large catalogues',
          intro:
            'Assigning class IDs to a single node when the site already has N classes defined. Tests whether classlist append is sensitive to catalogue size.',
          rows: assignRows,
        },
      ],
    }
  },
}
