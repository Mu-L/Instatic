# Plugin System

End-to-end description of the plugin system: what plugins are, how they ship, how they run sandboxed, what they can do, and how to author them.

A plugin is a zip package containing a `plugin.json` manifest and one or more JavaScript entrypoints. The CMS host loads installed plugins at boot and runs the server entrypoint inside a **QuickJS-WASM sandbox** — no Node, no Bun, no host file system, no environment variables, no network unless explicitly granted. Plugins reach the CMS through one SDK surface: `api.plugin.*` and `api.cms.*`.

---

## TL;DR

- **Package shape:** a zip containing `plugin.json` plus entrypoint bundles (`server/index.js`, `editor/index.js`, `admin/dashboard.js`, `modules/index.js`, `frontend/*.js`, optional `pack/site.json`).
- **Runtime:** server entrypoint runs in **QuickJS-WASM** (`server/plugins/quickjsHost.ts`). Canvas module packs run in a separate QuickJS VM (`server/plugins/modulePackVm.ts`). No host APIs leak.
- **SDK:** every API call goes through `api` — `api.plugin.*` for plugin metadata + logging, `api.cms.*` for routes, storage, hooks, loops, settings, schedule, pages.
- **Lifecycle:** `install` → `activate` → (optionally `deactivate` / `migrate`) → `uninstall`. Each hook is async-capable and isolated; if one throws, the host rolls back and parks the plugin in `error`.
- **Permissions:** declared in `plugin.json`, approved by the site owner at install time, enforced by the SDK at runtime. Outbound network also requires `networkAllowedHosts` allowlist.
- **CLI:** `bun pb-plugin init|lint|build|dev` covers scaffolding, sandbox validation, bundle build, and hot-sync to a running CMS.
- **Source of truth for permissions:** `src/core/plugin-sdk/capabilities.ts`. Source of truth for manifest shape: `src/core/plugins/manifest.ts`.

---

## Where the code lives

| Concern                        | Lives in                                  |
|--------------------------------|-------------------------------------------|
| SDK (author-facing API surface)| `src/core/plugin-sdk/`                    |
| `pb-plugin` CLI                | `src/core/plugin-sdk/cli/`                |
| Manifest schema + parser       | `src/core/plugins/manifest.ts`            |
| Host-side plugin runtime       | `src/core/plugins/`                       |
| Sandbox host (server entrypoint)| `server/plugins/quickjsHost.ts`          |
| Sandbox host (module pack VMs) | `server/plugins/modulePackVm.ts`          |
| Plugin lifecycle (boot, install, activate, uninstall) | `server/plugins/runtime.ts`, `package.ts` |
| Plugin scheduler               | `server/plugins/scheduler.ts`             |
| HTTP route bridge              | `server/handlers/cms/runtime.ts`          |
| Plugin pages in admin          | `src/admin/pages/plugins/`                |
| Plugin host UI primitives      | `src/admin/plugin-host-ui/`               |
| Plugin host React hooks        | `src/admin/plugin-host-hooks/`            |
| Example template plugin        | `examples/plugins/template/`              |
| Installed plugins on disk      | `uploads/plugins/<id>/<version>/`         |

---

## Package shape

A plugin zip extracted on disk looks like:

```text
plugin.json
server/index.js          ← server entrypoint
editor/index.js          ← editor entrypoint (optional)
admin/dashboard.js       ← admin pages entrypoint (optional)
modules/index.js         ← canvas module pack (optional)
frontend/tracker.js      ← published-page asset (optional)
pack/site.json           ← Visual Components / pages / classes pack (optional)
assets/                  ← static assets shipped in the zip (optional)
```

All `.js` entrypoints are pre-bundled IIFEs that assign to a host-recognized global (`__plugin_exports` for the server entrypoint, `__module_pack` for module packs). `bun pb-plugin build` produces them. The host scans the bundle for forbidden literals before activation.

---

## Manifest (`plugin.json`)

```jsonc
{
  "id": "acme.workflow",                        // namespaced, lowercase
  "name": "Workflow",                           // display name
  "version": "1.0.0",                           // semver-like
  "apiVersion": 1,                              // only `1` currently
  "description": "Approval workflow for posts.",

  "permissions": [
    "cms.routes",
    "cms.storage",
    "cms.hooks"
  ],

  "entrypoints": {
    "server":  "server/index.js",
    "editor":  "editor/index.js",
    "admin":   "admin/dashboard.js",
    "modules": "modules/index.js"
  },

  "resources": [
    { "id": "approvals", "label": "Approvals", "fields": [/* … */] }
  ],

  "adminPages": [
    { "id": "dashboard", "label": "Approval Queue", "icon": "checkmark" }
  ],

  "settings": [
    { "id": "apiKey", "type": "string", "label": "API key", "secret": true }
  ],

  "frontend": {
    "assets": [
      { "kind": "script", "src": "frontend/tracker.js",
        "placement": "body-end", "strategy": "defer" }
    ]
  },

  "networkAllowedHosts": [
    "api.weather.example.com",
    "*.cdn.weather.example.com"
  ],

  "pack": { "path": "pack/site.json" }
}
```

### ID rules

| Where the ID appears        | Rule                                                       | Examples                  |
|-----------------------------|------------------------------------------------------------|---------------------------|
| `plugin.json` top-level `id`| Namespaced, lowercase (`vendor.product[.subname]`)         | `acme.workflow`           |
| `resources[].id`, `adminPages[].id` | URL path segment — lowercase kebab-case             | `seo-entries`, `subscribers` |
| `resources[].fields[].id`   | JSON key — any common identifier convention                | `email`, `subscribedAt`   |
| Pack `classes[].id`         | Namespaced under the plugin ID                             | `acme.workflow/hero-root` |

`parsePluginManifest` validates all of these and produces a clear error message. `bun pb-plugin lint` runs the same checks before upload.

---

## Lifecycle

```text
Fresh install:    install → activate
Disable:          deactivate
Enable again:     activate
Upgrade to v2:    (old) deactivate → (new) migrate({fromVersion}) → (new) activate
Uninstall:        (if active) deactivate → uninstall
```

Each hook receives the `api` object (see below). All hooks may be sync or async. If any hook throws, the host:

1. Rolls back to the previous lifecycle state.
2. Records the error in the plugin row's `lastError`.
3. Sets `lifecycleStatus = 'error'`.

| Status       | Meaning                                                                          |
|--------------|----------------------------------------------------------------------------------|
| `installed`  | Package on disk, `install` succeeded, `activate` not run yet.                    |
| `active`     | Plugin enabled, `activate` succeeded, routes/hooks/loops live.                   |
| `disabled`   | Plugin disabled by the owner (`deactivate` succeeded if exported).               |
| `error`      | A hook threw or the worker crashed past its budget. `lastError` carries details. |

### Hook signatures

```js
export function install(api)        {}
export function activate(api)       {}
export function deactivate(api)     {}
export function uninstall(api)      {}
export function migrate(ctx, api)   {} // ctx = { fromVersion: '1.0.0' }
```

### Crash recovery

Each plugin's server entrypoint runs in its own worker. If the worker crashes:

1. The host logs `[plugin:<id>]` and records a `plugin_crash_events` row.
2. The worker is terminated. Sibling plugins are unaffected.
3. The host auto-respawns the worker and re-runs `activate`.
4. If the same plugin crashes more than `CRASH_THRESHOLD` (3) times within `CRASH_WINDOW_MS` (5 minutes), auto-respawn stops and the plugin is parked in `error`. The owner restarts it manually from the Plugins admin page.

---

## The sandbox

Plugin server code and canvas module packs run inside QuickJS compiled to WebAssembly. The sandbox is a separate JavaScript engine — it has its own globals, its own runtime, no FFI, no syscalls.

### What's available inside

- **The SDK** — `api.plugin.*` and `api.cms.*` (see next section).
- **Standard JavaScript** — `JSON`, `Math`, `Date`, `Promise`, `async`/`await`, `Map`, `Set`, `WeakMap`, `WeakSet`, ES2020+ syntax (optional chaining, nullish coalescing, BigInt literals).
- **`console.{log, info, warn, error, debug, trace}`** — routes to `api.plugin.log`.
- **`fetch(url, init)`** — opt-in: requires `network.outbound` permission AND the URL host on the `networkAllowedHosts` allowlist.

### What's denied

These produce a build-time error and a runtime error if attempted:

| Forbidden                                | Replacement                                          |
|------------------------------------------|------------------------------------------------------|
| `import 'node:fs'`, any `node:*`         | `api.cms.storage.*` for plugin data                  |
| `import 'bun:*'`                         | The SDK                                              |
| `Bun.spawn`, `Bun.connect`, `Bun.serve`, `Bun.sql`, `Bun.write`, `Bun.$` | `api.cms.hooks.emit` / `api.cms.storage.*` |
| `process.env`, `process.exit`, `process.binding` | `api.cms.settings.*`                          |
| `require()`                              | ES module imports (resolved at build time)           |
| `globalThis.fetch` without permission    | Declare `network.outbound` + `networkAllowedHosts`   |
| `WebSocket`, `XMLHttpRequest`            | Not in the VM                                        |
| `eval`, `new Function(...)`              | Blocked                                              |

### Three layers of enforcement

1. **`pb-plugin build`** emits IIFE bundles and scans for the forbidden literals above.
2. **`pb-plugin lint`** runs the same scan plus manifest + permission/allowlist coherence checks. Run this before upload.
3. **Install handler** (`server/plugins/package.ts → assertSandboxSafe`) scans **again** when the zip is uploaded — defense in depth in case the dev skipped `lint`.

Sandbox invariants are gated by `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`.

---

## The `api` object

Every lifecycle hook receives one `api` object. Its surface:

### Plugin metadata + logging

```js
api.plugin.id              // 'acme.workflow'
api.plugin.version         // '1.0.0'
api.plugin.permissions     // ['cms.routes', 'cms.storage']
api.plugin.log(...args)    // routes to host's [plugin:<id>] logger
api.plugin.assetUrl(p)     // '/uploads/plugins/<id>/<version>/<path>'
```

### CMS routes — requires `cms.routes`

```js
api.cms.routes.get('/status', 'plugins.manage', handler)
api.cms.routes.post('/action', 'plugins.manage', handler)
api.cms.routes.patch('/item/:id', 'plugins.manage', handler)
api.cms.routes.delete('/item/:id', 'plugins.manage', handler)
api.cms.routes.getPublic('/health', handler)  // skips auth
```

Routes mount under `/admin/api/cms/plugins/<id>/runtime/*`. The host enforces the admin session check + the declared capability before invoking the handler. Handlers receive `{ req, body, user }`. The `user` is `null` for public routes.

Custom responses (status, headers, non-JSON bodies) use the raw-response escape hatch: return `{ raw: { status, headers, body } }` instead of a plain object.

### Plugin-owned records — requires `cms.storage`

```js
const items = api.cms.storage.collection('items')
const all   = await items.list()
const one   = await items.get(id)
const made  = await items.create({ title: 'Draft', status: 'pending' })
await items.update(made.id, { status: 'approved' })
await items.delete(made.id)
```

Plugin storage is per-plugin, per-collection. The collection name must match a `resources[].id` declared in the manifest.

### CMS hooks — requires `cms.hooks`

```js
api.cms.hooks.on('publish.after', async (event) => { /* … */ })
api.cms.hooks.filter('publish.html', async (html) => html + '<!-- plugin -->')
await api.cms.hooks.emit('my.plugin.signal', { /* … */ })
```

Hook channels include `publish.before`, `publish.html`, `publish.after`, `media.uploaded`, plus plugin-emitted custom channels.

### Loop sources — requires `loops.register`

```js
api.cms.loops.registerSource({
  id: 'acme.products',
  label: 'Acme products',
  fields: [/* LoopSourceField[] */],
  filterSchema: { /* PropertySchema */ },
  orderByOptions: [/* allowed sort keys */],
  fetch: async (ctx) => ({ items: [/* LoopItem[] */] }),
  // Optional. Default false. Set true when the source returns data that
  // varies per visitor request (live API, time-of-day data, per-user
  // results). Marking a loop source as request-dependent makes the
  // publisher treat any `base.loop` using it as a Layer C "hole" — the
  // page emits a placeholder + a tiny client runtime fetches the rendered
  // loop fragment lazily via /_pb/hole/<nodeId>. Sources backed by CMS
  // data (`cms.storage.collection(...).list()`) should stay false so the
  // loop bakes into the static disk artefact at publish time.
  requestDependent: false,
})
```

Loop sources back the `base.loop` module. Plugin fetch handlers run inside the sandbox — use `api.cms.storage.*` or permitted `fetch(...)` to source items.

### Module packs (canvas modules) — dynamic + placeholder

Modules registered via `entrypoints.modules` (canvas module packs) can opt their render into the per-request lifecycle:

```js
defineModule({
  id: 'acme.live-clock',
  category: 'widgets',
  // ...
  render: ({ props }) => `<time>${new Date().toISOString()}</time>`,

  // Optional. Default false. Set true when the module's render output
  // varies per visitor request — `Date.now()` examples, live API reads,
  // viewer-specific data. The publisher emits a <pb-hole> placeholder
  // instead of running `render` at publish time; the actual render fires
  // inside /_pb/hole/<nodeId> at request time (with the result cached
  // per (nodeId, publishVersion) in Layer B's LRU).
  dynamic: true,

  // Optional. Static HTML baked into the placeholder at publish time so
  // visitors see a meaningful skeleton/fallback while the hole loads.
  // Sanitized through DOMPurify. Omit for an empty placeholder.
  staticPlaceholder: ({ /* props */ }) => `<time>Loading…</time>`,
})
```

The placeholder uses `display: contents` so it doesn't introduce a wrapper box. The hole runtime is injected ONLY on pages that have at least one `<pb-hole>`; fully-static pages ship zero JS from the publisher. See [docs/features/publisher.md](publisher.md) for the full pipeline.

### Settings — declared in `plugin.json`

```js
const key = api.cms.settings.get('apiKey')
const all = api.cms.settings.getAll()
await api.cms.settings.replace({ apiKey: 'new-value' })
```

Settings are typed (`string` / `number` / `boolean` / `secret`) and rendered automatically on the plugin admin page.

### Scheduled jobs — requires `cms.schedule`

```js
api.cms.schedule.daily('cleanup', '03:00', async () => { /* … */ })
api.cms.schedule.hourly('refresh', async () => { /* … */ })
api.cms.schedule.every(5, 'poll', async () => { /* … */ })

// Full form with overlap policy + duration override:
api.cms.schedule.register({
  id: 'shopify-sync',
  cadence: { interval: 'monthly', at: '02:00', dayOfMonth: 1 },
  overlap: 'skip',          // 'skip' | 'queue' | 'parallel'
  maxDurationMs: 60_000,    // default 5s budget
  handler: async () => { /* … */ },
})
```

All times are UTC. Each fire runs inside the sandbox with a wall-clock budget. The host's `server/plugins/scheduler.ts` drives dispatch and records run history.

### Published pages — requires `cms.pages.read` / `cms.pages.publish`

```js
const pages = await api.cms.pages.list()           // requires cms.pages.read
await api.cms.pages.republish(id)                  // requires cms.pages.publish
await api.cms.pages.republishAll()                 // requires cms.pages.publish
```

`republish` fires the full pipeline (`publish.before` → `publish.html` → `publish.after`), so other plugins' filters and listeners participate.

### Outbound HTTP — requires `network.outbound` + `networkAllowedHosts`

```js
const res  = await fetch('https://api.example.com/data')
const data = await res.json()
```

The permission alone is insufficient — the URL host must also be on the manifest's `networkAllowedHosts` allowlist. Wildcards (`*.cdn.example.com`) are supported. Calls to non-allowlisted hosts are rejected at the host bridge.

---

## Permissions

Permissions are requested in `plugin.json` and approved by the site owner at install time. Granted permissions are stored on the plugin row. Every SDK call checks the **granted** permission set, not just the request.

Risk levels:

- **Low** — visible UI additions with limited data access
- **Medium** — reads/writes plugin-owned data or changes editor UI
- **High** — mutates editor state, registers backend behavior, runs code on visitor browsers
- **Dangerous** — reserved for trusted first-party plugins

### Capability matrix (summary)

| Permission                  | Surface              | Risk      | Meaning                                                                 |
|-----------------------------|----------------------|-----------|-------------------------------------------------------------------------|
| `admin.navigation`          | Admin                | Low       | Add admin navigation entries                                            |
| `cms.storage`               | Admin / editor / server| Medium  | Read/write plugin-owned records                                         |
| `cms.routes`                | Server               | High      | Register authenticated backend routes                                   |
| `cms.hooks`                 | Server               | High      | Listen to CMS events / filter values                                    |
| `cms.schedule`              | Server               | High      | Register cadence-driven handlers                                        |
| `cms.pages.read`            | Server               | Low       | List published pages                                                    |
| `cms.pages.publish`         | Server               | Medium    | Trigger republish (fires full pipeline)                                 |
| `editor.toolbar`            | Editor               | Medium    | Add toolbar buttons                                                     |
| `editor.commands`           | Editor               | Medium    | Register editor commands + Spotlight palette commands / providers       |
| `editor.store.read`         | Editor               | Medium    | Read editor store state                                                 |
| `editor.store.write`        | Editor               | High      | Mutate editor store state through a host transaction                    |
| `editor.canvas`             | Editor               | High      | Register canvas overlay React components                                |
| `editor.panels`             | Editor               | Medium    | Register left-sidebar panels                                            |
| `modules.register`          | Editor / manifest    | High      | Ship new modules to the canvas module library                           |
| `loops.register`            | Editor / server / manifest | Medium | Register custom `base.loop` sources                                  |
| `visualComponents.register` | Admin / manifest     | Medium    | Ship VCs / page templates / class packs (via `pack/site.json`)          |
| `frontend.assets`           | Frontend / manifest  | High      | Inject declarative tags into every published page                       |
| `network.outbound`          | Server               | High      | Make outbound HTTP requests (with `networkAllowedHosts` allowlist)      |
| `unstable.internals`        | Admin / editor / server | Dangerous | Reserved for trusted first-party plugins                            |

Full descriptions and labels live in `src/core/plugin-sdk/capabilities.ts` — the source of truth.

---

## CLI workflow

`bun pb-plugin <command>` runs the SDK CLI at `src/core/plugin-sdk/cli/`.

```sh
bun pb-plugin init my-plugin    # scaffold a new plugin
bun pb-plugin lint              # validate manifest + sources + bundles (sandbox-safe)
bun pb-plugin build             # produce dist/ + .plugin.zip
bun pb-plugin dev               # watch + sync into a running CMS
```

### Local dev with hot sync

`pb-plugin dev` writes built files **directly** into the host's `uploads/plugins/<id>/<version>/`. Subsequent rebuilds are picked up on the next activation cycle.

When running inside the page-builder monorepo, the CLI auto-detects the host's `uploads/` by walking up the tree. From a separate plugin repo:

```sh
PB_UPLOADS_DIR=../page-builder/uploads bun pb-plugin dev
# or
bun pb-plugin dev --uploads ../page-builder/uploads
```

First install still goes through the admin UI (`/admin/plugins` → Upload Plugin) so the owner approves permissions. Every `pb-plugin dev` rebuild after that flows in without another upload.

---

## Adding a new plugin

1. **Scaffold:**
   ```sh
   bun pb-plugin init my-plugin
   cd my-plugin
   ```
2. **Set the manifest.** Pick a namespaced ID (`vendor.product`), set `apiVersion: 1`, declare the permissions you'll actually use.
3. **Write the server entrypoint** in `server/index.js`. Export `activate(api)` and register what you need (routes, hooks, storage collections, scheduled jobs).
4. **(Optional) Add editor / admin / modules entrypoints.** Declare them in `entrypoints` and import from the SDK.
5. **Lint:**
   ```sh
   bun pb-plugin lint
   ```
6. **Build:**
   ```sh
   bun pb-plugin build
   ```
7. **Install via admin UI** (`/admin/plugins` → Upload Plugin), approve permissions.
8. **Iterate** with `bun pb-plugin dev`.

### Cookbook: a server route + storage collection

```js
// server/index.js
export function activate(api) {
  const subscribers = api.cms.storage.collection('subscribers')

  api.cms.routes.post('/subscribe', 'plugins.manage', async ({ body, user }) => {
    const sub = await subscribers.create({ email: body.email, addedBy: user.id })
    return { ok: true, id: sub.id }
  })

  api.cms.routes.get('/subscribers', 'plugins.manage', async () => {
    return { rows: await subscribers.list() }
  })
}
```

Manifest:

```json
{
  "id": "acme.subscribers",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["cms.routes", "cms.storage"],
  "resources": [
    {
      "id": "subscribers",
      "label": "Subscribers",
      "fields": [
        { "id": "email", "type": "string", "label": "Email" },
        { "id": "addedBy", "type": "string", "label": "Added by" }
      ]
    }
  ],
  "entrypoints": { "server": "server/index.js" }
}
```

---

## Forbidden patterns

| Pattern                                                                  | Use instead                                                  |
|--------------------------------------------------------------------------|--------------------------------------------------------------|
| `import fs from 'node:fs'` or any Node API                               | `api.cms.storage.*` for data, `api.plugin.assetUrl(p)` for files |
| `import { Database } from 'bun:sqlite'` or any `bun:*` module            | The SDK                                                      |
| `Bun.spawn` / `Bun.serve` / `Bun.write` / `Bun.sql` / `Bun.$`            | Hooks (`api.cms.hooks.emit`) for cross-plugin signals        |
| `process.env.SECRET_KEY`                                                 | `api.cms.settings.get('secretKey')`                          |
| `require('module')`                                                      | ES module `import` (resolved at build time)                  |
| `globalThis.fetch(...)` without permission                               | Declare `network.outbound` + `networkAllowedHosts`           |
| `eval(...)` / `new Function(...)`                                        | Blocked — no replacement                                     |
| Calling a host capability without the matching permission                | Declare it in `plugin.json`'s `permissions`                  |
| Reaching the DB directly from a plugin                                   | Use `api.cms.storage.*`                                      |
| Skipping `pb-plugin lint` before upload                                  | Always lint — the host scans anyway and refuses the upload   |
| Calling host APIs from inside a constructor / module top-level           | Use lifecycle hooks (`activate(api)`) — host APIs are only bound there |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — server runtime (plugins activate during server boot)
- [docs/editor.md](../editor.md) — admin / editor frontend (plugin host UI + hooks)
- Source-of-truth files:
  - `src/core/plugin-sdk/` — SDK API surface
  - `src/core/plugin-sdk/capabilities.ts` — permission catalog
  - `src/core/plugin-sdk/cli/` — `pb-plugin` CLI
  - `src/core/plugins/manifest.ts` — manifest parser + validator
  - `src/core/plugins/` — host-side runtime
  - `server/plugins/runtime.ts` — boot-time plugin activation
  - `server/plugins/quickjsHost.ts` — server entrypoint sandbox
  - `server/plugins/modulePackVm.ts` — module pack sandbox
  - `server/plugins/package.ts` — install / `assertSandboxSafe`
  - `server/plugins/scheduler.ts` — scheduled job dispatcher
  - `server/handlers/cms/runtime.ts` — plugin HTTP route bridge
  - `examples/plugins/template/` — example plugin
- Gate tests:
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/architecture/plugin-boot-resilience.test.ts`
  - `src/__tests__/architecture/plugin-cms-pages-surface.test.ts`
  - `src/__tests__/architecture/plugin-host-ui-runtime-parity.test.ts`
  - `src/__tests__/architecture/plugin-schedule-invariants.test.ts`
  - `src/__tests__/architecture/no-plugin-tab-shells.test.ts`
  - `src/__tests__/architecture/sandbox-crypto-bridge.test.ts`
  - `src/__tests__/architecture/phase-g-bridge-security.test.ts`
