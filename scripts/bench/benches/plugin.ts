/**
 * Plugin system benchmark.
 *
 * Plugins are server-side code that runs inside a QuickJS-WASM sandbox.
 * The boundary cost matters: every plugin install spins up a fresh VM,
 * every `hostCall` crosses the JS ↔ sandbox bridge, and every plugin
 * route is a VM evaluation followed by host RPC.
 *
 * Scenarios:
 *   - Cold VM boot: how long from `createPluginVm` to first lifecycle
 *     hook? This is paid on plugin activation.
 *   - Host call roundtrip: how expensive is `__hostCall(target, args)`?
 *     Every plugin/host RPC pays this cost.
 *   - Lifecycle hook (activate) under a no-op plugin: minimal overhead floor.
 *   - VM dispose: how long does teardown take? Matters for short-lived
 *     plugins or those that are uninstalled often.
 */
import { performance } from 'node:perf_hooks'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from '../lib/types'
import { summarize, fmtMs, fmtNum } from '../lib/stats'
import { log } from '../lib/log'

interface RecorderEntry {
  target: string
  args: unknown[]
}

async function loadVm() {
  const { createPluginVm } = await import('../../../server/plugins/quickjs/vm')
  return { createPluginVm }
}

function makeEnv(recorder: RecorderEntry[]): {
  pluginId: string
  manifestVersion: string
  grantedPermissions: string[]
  assetBasePath: string
  settings: Record<string, string | number | boolean>
  hostCall: (target: string, args: unknown[]) => Promise<unknown>
  log: (args: unknown[]) => void
} {
  return {
    pluginId: 'bench.plugin',
    manifestVersion: '1.0.0',
    grantedPermissions: [],
    assetBasePath: '/uploads/plugins/bench.plugin/1.0.0',
    settings: {},
    hostCall: async (target, args) => {
      recorder.push({ target, args })
      return null
    },
    log: () => {
      /* swallow */
    },
  }
}

const NO_OP_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate() { /* noop */ };
    __plugin_exports.deactivate = async function deactivate() { /* noop */ };
  })();
`

// Plugin that invokes hostCall in a tight loop — used to measure
// roundtrip cost of the JS ↔ sandbox bridge.
const ROUNDTRIP_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate() {
      const N = parseInt(globalThis.__bench_n || '100');
      for (let i = 0; i < N; i++) {
        await __hostCall('test.ping', [i]);
      }
    };
  })();
`

export const pluginBench: BenchModule = {
  name: 'plugin',
  title: 'Plugin sandbox (QuickJS)',
  description: 'Cold VM boot, host-call roundtrip cost, lifecycle hook latency, dispose timing.',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const { createPluginVm } = await loadVm()

    // ---- Cold VM boot --------------------------------------------------
    log.step('Cold VM boot timing')
    const bootRows: BenchRow[] = []
    {
      const iters = ctx.quick ? 5 : 20
      const samples: number[] = []
      for (let i = 0; i < iters; i++) {
        const recorder: RecorderEntry[] = []
        const env = makeEnv(recorder)
        const t0 = performance.now()
        const vm = await createPluginVm({ env, pluginSource: NO_OP_SOURCE })
        samples.push(performance.now() - t0)
        vm.dispose()
      }
      const s = summarize(samples)
      bootRows.push({
        label: 'createPluginVm → ready',
        inputs: { iters },
        metrics: {
          mean: fmtMs(s.mean),
          p50: fmtMs(s.p50),
          p95: fmtMs(s.p95),
          p99: fmtMs(s.p99),
          min: fmtMs(s.min),
          max: fmtMs(s.max),
        },
      })
    }

    // ---- Lifecycle hook (activate, no-op) ------------------------------
    log.step('No-op activate hook latency')
    const lifecycleRows: BenchRow[] = []
    {
      const recorder: RecorderEntry[] = []
      const env = makeEnv(recorder)
      const vm = await createPluginVm({ env, pluginSource: NO_OP_SOURCE })
      try {
        const iters = ctx.quick ? 50 : 200
        // Warmup
        await vm.runLifecycle('activate')
        const samples: number[] = []
        for (let i = 0; i < iters; i++) {
          const t0 = performance.now()
          await vm.runLifecycle('activate')
          samples.push(performance.now() - t0)
        }
        const s = summarize(samples)
        lifecycleRows.push({
          label: 'activate (no-op body)',
          inputs: { iters },
          metrics: {
            mean: fmtMs(s.mean),
            p50: fmtMs(s.p50),
            p95: fmtMs(s.p95),
            p99: fmtMs(s.p99),
          },
        })
      } finally {
        vm.dispose()
      }
    }

    // ---- Host call roundtrip -------------------------------------------
    log.step('hostCall roundtrip cost (sandbox ↔ host)')
    const roundtripRows: BenchRow[] = []
    {
      const sizes = ctx.quick ? [100] : [100, 1_000, 10_000]
      for (const n of sizes) {
        const recorder: RecorderEntry[] = []
        const env = makeEnv(recorder)
        // Set the iteration count via a sneaky globalThis read inside the VM:
        // we use a per-VM wrapper that injects __bench_n before evaluating the
        // user source. Easiest is to inline the count into the source.
        const source = ROUNDTRIP_SOURCE.replace(
          "globalThis.__bench_n || '100'",
          `'${n}'`,
        )
        const vm = await createPluginVm({ env, pluginSource: source })
        try {
          // Warmup
          await vm.runLifecycle('activate')
          recorder.length = 0
          const t0 = performance.now()
          await vm.runLifecycle('activate')
          const wallMs = performance.now() - t0
          if (recorder.length !== n) {
            throw new Error(`expected ${n} host calls, got ${recorder.length}`)
          }
          roundtripRows.push({
            label: `${fmtNum(n)} hostCall(target, args) round-trips`,
            inputs: { calls: n },
            metrics: {
              wall: fmtMs(wallMs),
              per_call: fmtMs(wallMs / n),
              throughput: `${fmtNum(Math.floor((n / wallMs) * 1000))} calls/s`,
            },
          })
        } finally {
          vm.dispose()
        }
      }
    }

    // ---- VM dispose ----------------------------------------------------
    log.step('VM dispose timing')
    const disposeRows: BenchRow[] = []
    {
      const iters = ctx.quick ? 10 : 50
      const samples: number[] = []
      for (let i = 0; i < iters; i++) {
        const recorder: RecorderEntry[] = []
        const env = makeEnv(recorder)
        const vm = await createPluginVm({ env, pluginSource: NO_OP_SOURCE })
        const t0 = performance.now()
        vm.dispose()
        samples.push(performance.now() - t0)
      }
      const s = summarize(samples)
      disposeRows.push({
        label: 'vm.dispose()',
        inputs: { iters },
        metrics: {
          mean: fmtMs(s.mean),
          p50: fmtMs(s.p50),
          p95: fmtMs(s.p95),
          max: fmtMs(s.max),
        },
      })
    }

    return {
      name: this.name,
      title: this.title,
      headline: {
        'cold VM boot p95': bootRows[0].metrics.p95,
        'activate (no-op) mean': lifecycleRows[0].metrics.mean,
        'hostCall (per call)': roundtripRows[0]?.metrics.per_call ?? '—',
      },
      sections: [
        {
          title: 'Cold VM boot (createPluginVm)',
          intro: 'Paid on every plugin activation. Includes WASM module init + context creation + plugin source eval.',
          rows: bootRows,
        },
        {
          title: 'Lifecycle hook latency (no-op activate)',
          intro: 'Minimum cost of crossing the sandbox boundary for an explicit lifecycle hook.',
          rows: lifecycleRows,
        },
        {
          title: 'hostCall roundtrip',
          intro:
            'Cost of one round-trip from the QuickJS sandbox to the host and back. Drives latency of any plugin → CMS API call.',
          rows: roundtripRows,
        },
        {
          title: 'VM dispose',
          intro: 'Tear-down cost. Paid on plugin deactivation / uninstall / worker crash recovery.',
          rows: disposeRows,
        },
      ],
    }
  },
}
