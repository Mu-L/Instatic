/**
 * Allowlist of API targets the host accepts from a worker.
 *
 * `ALLOWED_API_TARGETS` is the canonical list of dotted RPC names. Anything
 * not in this list is rejected before any host-side side effect. The
 * architecture test `plugin-sandbox-invariants.test.ts` locks the exact
 * contents of this array — do not add targets without updating that test.
 */

const ALLOWED_API_TARGETS = [
  // Routes — recorded but not actually invoked from worker (worker is the
  // origin of registration; main is the consumer). Host stores route
  // handler ids per pluginId+method+path.
  'cms.routes.register',
  // Hooks
  'cms.hooks.on',
  'cms.hooks.filter',
  'cms.hooks.emit',
  // Loops
  'cms.loops.registerSource',
  // Storage
  'cms.storage.list',
  'cms.storage.create',
  'cms.storage.update',
  'cms.storage.delete',
  // Settings (read is local to worker via settings cache; replace is RPC)
  'cms.settings.replace',
  // Network — gated by `network.outbound` permission + manifest's
  // `networkAllowedHosts`. Host validates the URL host BEFORE making the
  // outbound request.
  'network.fetch',
  // Companion to network.fetch: cancels an in-flight request when the
  // plugin's AbortSignal fires. Cheap no-op if the host has already
  // returned for that abortId (e.g. the response landed first).
  'network.abort',
  // Scheduled jobs — gated by `cms.schedule`. Plugin calls register/cancel
  // during activate; the host upserts a row in `plugin_schedules` and the
  // scheduler tick (server/plugins/scheduler.ts) fires the registered
  // handler on cadence.
  'cms.schedule.register',
  'cms.schedule.cancel',
  // Media subsystem — three independent surfaces.
  //   • registerStorageAdapter — declares an exclusive storage backend the
  //     admin can elect per asset role. Bytes never cross the sandbox;
  //     the adapter only signs upload plans + handles delete/verify.
  //   • registerUrlTransformer — chained pure path → path rewriter.
  //   • registerVariantDelegate — replaces local variant ladder with a
  //     URL template (image-transform CDNs).
  'cms.media.registerStorageAdapter',
  'cms.media.registerUrlTransformer',
  'cms.media.registerVariantDelegate',
  // CMS content — read/write/publish/delete content tables.
  // Gated by `cms.content.read` / `cms.content.write` / `cms.content.publish`
  // / `cms.content.delete` / `cms.content.tables.manage` plus the manifest's
  // `contentAccess[]` allowlist. The host enforces both as the
  // kernel-of-correctness check.
  'cms.content.tables.list',
  'cms.content.tables.get',
  'cms.content.tables.create',
  'cms.content.entries.list',
  'cms.content.entries.get',
  'cms.content.entries.getBySlug',
  'cms.content.entries.create',
  'cms.content.entries.update',
  'cms.content.entries.delete',
  'cms.content.entries.publish',
  'cms.content.entries.moveTable',
  'cms.content.entries.createMany',
  'cms.content.entries.updateMany',
  'cms.content.entries.deleteMany',
  'cms.content.tree.read',
  'cms.content.tree.mutate',
  'cms.content.tree.replace',
  'cms.content.search',
  'cms.content.snapshot',
  'cms.content.republishAll',
  // ── Crypto primitives ────────────────────────────────────────────────
  // SHA-256 / HMAC-SHA256 are needed for AWS Sigv4, OAuth1.0a, JWT signing,
  // S3 presigned URL generation, etc. — the kind of work storage / auth
  // plugins do routinely. Without these the plugin would have to vendor
  // a pure-JS HMAC implementation; not impossible but error-prone enough
  // that we expose a thin host bridge instead. No permission gate — these
  // are pure computation, no I/O, no privilege escalation (same shape as
  // `Math` or `JSON`).
  'crypto.digest',
  'crypto.signHmac',
] as const

export type AllowedApiTarget = typeof ALLOWED_API_TARGETS[number]

export function isAllowedApiTarget(target: string): target is AllowedApiTarget {
  return (ALLOWED_API_TARGETS as readonly string[]).includes(target)
}

export { ALLOWED_API_TARGETS }
