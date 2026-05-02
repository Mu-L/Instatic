# Self-Hosted Site Runtime And Dependencies Design

## Summary

The Dependencies panel should become the site runtime package manager, and `src/scripts/*.ts` files should become real browser entrypoints that can run in both canvas preview and published pages. Runtime packages must be self-hosted: the CMS resolves and installs site dependencies into a controlled server-side cache, bundles user scripts with those packages, and serves hashed JavaScript assets from the same deployment as the generated site.

This design intentionally avoids CDN import maps. The end state is that a site can declare packages, write scripts that import them, see those scripts run in the canvas, and publish a site whose JavaScript is served by the CMS itself.

## Current State

- `site.packageJson` already exists and is persisted with the `SiteDocument`.
- The Dependencies panel can add and remove dependency entries, but it does not install, resolve, bundle, or publish them.
- Module insertion can auto-add dependencies declared by module metadata, but the production base modules do not currently declare runtime dependencies.
- `site.files[]` already supports `script` files. The Site Explorer creates `src/scripts/*.ts` files and opens them in the Code Editor.
- The Code Editor stores script contents as plaintext. It does not build or execute scripts.
- The publisher currently emits static HTML and CSS only. Published pages use `script-src 'none'`.

## Product Goals

- End users can add browser packages from the Dependencies panel.
- End users can create scripts in Site Explorer and import declared packages from those scripts.
- Scripts can run live in the canvas so authors can see behavior while building.
- Each script can be enabled or disabled independently.
- Each script can choose where it loads: all pages, selected pages, selected templates, or future component scopes.
- Each script can choose load placement and timing.
- Published sites ship self-hosted bundled JavaScript assets, not CDN package imports.
- The same runtime builder is used for canvas preview and publishing.
- Build diagnostics are understandable to non-expert users.

## Non-Goals

- Do not run user scripts in the editor application's host DOM.
- Do not expose server-side Node or Bun APIs to site scripts.
- Do not support arbitrary package lifecycle scripts during dependency installation.
- Do not make the Dependencies panel edit the builder app's own `package.json`.
- Do not implement a full npm client from scratch.

## Architecture Decision

Use a shared Site Runtime Builder with two consumers:

- Canvas preview builds transient runtime bundles and runs them inside a sandboxed page iframe in the canvas area.
- Publishing builds immutable runtime assets, stores them with the published snapshot, and injects script tags into generated HTML.

The runtime builder owns dependency resolution, dependency cache management, TypeScript/ESM bundling, script diagnostics, and asset manifest generation. Preview and publish must not have separate script semantics.

## Data Model

Add a top-level optional `runtime` field to `SiteDocument`.

```ts
interface SiteRuntimeConfig {
  dependencyLock: SiteDependencyLock
  scripts: Record<string, SiteScriptRuntimeConfig>
}

interface SiteDependencyLock {
  version: 1
  packages: Record<string, LockedSiteDependency>
  updatedAt: number
}

interface LockedSiteDependency {
  name: string
  requested: string
  version: string
  integrity?: string
  tarballUrl?: string
  resolvedAt: number
}

interface SiteScriptRuntimeConfig {
  enabled: boolean
  runInCanvas: boolean
  placement: 'head' | 'body-end'
  timing: 'immediate' | 'dom-ready' | 'idle'
  scope: SiteScriptScope
  priority: number
}

type SiteScriptScope =
  | { type: 'all-pages' }
  | { type: 'pages'; pageIds: string[] }
  | { type: 'templates'; templatePageIds: string[] }
```

Script configs are keyed by `SiteFile.id`, not by path, so renaming a script does not lose runtime settings.

Validation should default missing runtime data:

- Missing `runtime` becomes an empty runtime config.
- Script files without explicit config get default config when shown in the UI.
- Runtime config entries for deleted files are ignored or cleaned up by store actions.

Default script config:

- `enabled: true`
- `runInCanvas: true`
- `placement: 'body-end'`
- `timing: 'dom-ready'`
- `scope: { type: 'all-pages' }`
- `priority: 100`

## Dependency Semantics

`site.packageJson.dependencies` is the user-facing desired dependency manifest. It stores requested ranges such as `^1.9.3`.

`site.runtime.dependencyLock` stores exact resolved versions. Builds use the lock, not loose ranges.

When a dependency is added or updated:

1. Validate the package name with the existing safe package-name validator.
2. Resolve the requested range against the npm registry.
3. Store the requested range in `site.packageJson.dependencies`.
4. Store the exact selected version and integrity metadata in `site.runtime.dependencyLock`.
5. Mark runtime diagnostics stale.

`devDependencies` should stay hidden from the main end-user workflow for now. The current defaults can be migrated away from the visible runtime dependency list because React, Vite, TypeScript, and type packages are builder implementation details, not site runtime packages.

## Server-Side Dependency Cache

The CMS maintains a dependency cache outside the repo and outside uploaded media.

Suggested path:

```text
RUNTIME_CACHE_DIR=/var/lib/page-builder/runtime-cache
runtime-cache/
  deps/
    <dependency-lock-hash>/
      package.json
      bun.lock
      node_modules/
  builds/
    preview/
    publish/
```

The dependency lock hash is computed from exact package names and versions.

Installation strategy:

1. Generate a temporary package workspace with exact dependencies from the lock.
2. Run the package manager with lifecycle scripts disabled.
3. Use a timeout, size limits, and concurrency control.
4. Cache the completed `node_modules` directory by lock hash.
5. Reuse the cache for preview and publish builds.

The initial implementation uses Bun because the application already runs on Bun and `bun install --ignore-scripts` skips lifecycle scripts. The cache installer must run Bun in an isolated generated workspace, never in the project root.

Security requirements:

- Never run package `preinstall`, `install`, `postinstall`, or prepare scripts.
- Never install into the project root.
- Never expose server environment variables to package builds.
- Limit install time, package count, extracted size, and concurrent installs.
- Treat package code as untrusted browser code.

## Runtime Builder

Add a focused runtime builder module.

Suggested boundaries:

```text
src/core/site-runtime/
  types.ts
  scriptConfig.ts
  importAnalysis.ts
  assetManifest.ts
  diagnostics.ts

server/cms/runtime/
  dependencyResolver.ts
  dependencyCache.ts
  virtualSiteWorkspace.ts
  bundleScripts.ts
  previewRuntime.ts
  publishRuntime.ts
```

The build pipeline:

1. Collect enabled `script` files from `site.files[]`.
2. Filter scripts by page scope and canvas/publish target.
3. Analyze static and literal dynamic imports.
4. Reject undeclared bare imports with a clear diagnostic.
5. Materialize virtual site files into a temporary workspace.
6. Ensure the dependency cache for the exact lock exists.
7. Bundle scripts with esbuild for the browser.
8. Enable code splitting for shared vendor chunks.
9. Emit an asset manifest with entry chunks, shared chunks, CSS side effects if any, sourcemaps for preview, and diagnostics.

esbuild should be used directly. It gives the project TypeScript support, browser bundling, code splitting, metafile analysis, and clean error reporting without turning each site into its own Vite project.

Browser target:

```ts
{
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  bundle: true,
  splitting: true,
  sourcemap: preview ? 'inline' : false,
}
```

Disallowed imports:

- Node builtins such as `fs`, `path`, `child_process`, `process`, and `crypto`.
- Undeclared bare package imports.
- Local imports that escape `site.files[]`.

Allowed imports:

- Relative imports between site script files.
- Declared runtime dependencies.
- Future generated helper modules exposed through explicit virtual module IDs.

## Script Loading Semantics

Each enabled script becomes an entrypoint. The runtime builder wraps each entrypoint according to its `timing`.

`immediate`:

```ts
await import('./entry')
```

`dom-ready`:

```ts
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void import('./entry'), { once: true })
} else {
  void import('./entry')
}
```

`idle`:

```ts
const run = () => void import('./entry')
if ('requestIdleCallback' in window) requestIdleCallback(run)
else setTimeout(run, 1)
```

Entrypoints are ordered by `priority`, then by path for deterministic output.

Placement controls where the script tags are injected:

- `head`: emitted in `<head>` as `type="module"`.
- `body-end`: emitted before `</body>`.

For module scripts, execution is deferred by default, but placement still matters for scripts that intentionally register early observers or set globals.

## Canvas Runtime Preview

Scripts should run in the canvas area, but inside a page runtime iframe rather than the editor host DOM.

The iframe renders the actual page HTML produced by the publisher and injects preview runtime bundles. This gives user scripts the DOM they will see on the published site, not React editor wrappers, selection handles, panels, or internal builder controls.

Canvas preview flow:

1. The active page changes, site files change, script settings change, or dependencies change.
2. The editor requests a preview runtime build from the server.
3. The server returns an iframe document or a preview document URL plus diagnostics.
4. The canvas displays the page runtime iframe in the canvas area.
5. Runtime errors are captured inside the iframe and posted to the editor.
6. The editor shows build errors and runtime errors as a canvas overlay and in the script settings sidebar.

The canvas should support two authoring modes:

- Design mode: current module editor surface for selection, drag/drop, and property editing.
- Runtime preview mode: real generated DOM plus user scripts.

When a script is open and `runInCanvas` is enabled, runtime preview mode should be easy to enter and can become the default preview surface for that script. The user can disable `runInCanvas` for scripts that are disruptive while editing.

Preview isolation requirements:

- User scripts must not access the parent editor window.
- User scripts must not mutate editor DOM.
- Preview should not reuse published immutable assets.
- V1 preview builds inline bundled JavaScript into a sandboxed `srcdoc` iframe.
- The preview iframe must not use `allow-same-origin`.

## Script Editor Sidebar

When a script file is open in the Code Editor, show a script settings sidebar or inspector surface.

Controls:

- Enabled
- Run in canvas
- Load on all pages
- Load on selected pages
- Load on selected templates
- Placement: head or body end
- Timing: immediate, DOM ready, or idle
- Priority/order
- Dependency diagnostics
- Build diagnostics
- Runtime errors from canvas preview

Useful actions:

- Add missing dependency from diagnostic.
- Open Dependencies panel.
- Rebuild preview.
- Disable script.

The sidebar should not force users to understand bundling. It should speak in website terms: where this script loads, when it runs, and what packages it uses.

## Dependencies Panel Upgrade

The Dependencies panel should show runtime usage and health.

Rows should include:

- Package name.
- Requested range.
- Locked version.
- Status: resolved, unresolved, unused, missing from scripts, install failed.
- Usage: script files and future module runtimes that import or declare the package.

Actions:

- Add package.
- Change requested version.
- Resolve/update package.
- Remove package.
- Open files that use the package.

Validation:

- Unsafe names are rejected client-side and server-side.
- `*` and `latest` are allowed only if the resolver immediately records an exact locked version.
- Publishing is blocked when runtime scripts have unresolved or undeclared dependencies.

## Publishing

Publishing must build runtime assets before writing page versions.

Publish flow:

1. Load and validate the draft site.
2. Resolve runtime config defaults.
3. Build runtime bundles for all publish-enabled scripts.
4. Store immutable runtime assets in Postgres.
5. Store a runtime asset manifest with the page snapshot.
6. Render each page with the runtime manifest for that page.
7. Inject script tags according to script scope, placement, timing, and priority.

Published asset paths should not conflict with admin static assets. Use a dedicated public prefix.

Suggested prefix:

```text
/_pb/assets/<site-or-version-id>/<hash>/<filename>
```

V1 stores published runtime assets in Postgres `bytea` rows. This keeps publish transactional and preserves old page versions without requiring another storage service. A later storage adapter can move the bytes to local filesystem or S3-compatible object storage while keeping the same runtime asset manifest shape.

The published snapshot must include enough manifest data to render old published pages even after the draft changes.

## Publisher Changes

`publishPage` should accept an optional runtime manifest.

```ts
publishPage(page, site, registry, {
  breakpointId,
  templateContext,
  runtimeAssets,
})
```

HTML behavior:

- No runtime assets: keep `script-src 'none'`.
- Runtime assets present: emit `script-src 'self'`.
- Inject `type="module"` script tags for the page.
- Keep existing CSS and module rendering behavior unchanged.

The publisher should not build scripts. It only consumes a prepared runtime manifest.

## API Endpoints

Add authenticated CMS endpoints:

- `POST /api/cms/runtime/dependencies/resolve`
- `POST /api/cms/runtime/dependencies/install`
- `POST /api/cms/runtime/preview-build`

Add public immutable asset endpoint:

- `GET /_pb/assets/:versionId/:hash/:file`

Preview builds use a `srcdoc` iframe with inlined bundled JavaScript in V1, so no preview asset endpoint is needed initially. Published asset endpoints are public and immutable.

## Error Handling And Diagnostics

Diagnostics should have stable codes and file references.

Examples:

- `runtime.missing_dependency`: `src/scripts/confetti.ts imports "canvas-confetti", but it is not declared in Dependencies.`
- `runtime.unresolved_dependency`: `"canvas-confetti" is declared but has not been resolved yet.`
- `runtime.install_failed`: `"three" could not be installed.`
- `runtime.node_builtin`: `Browser scripts cannot import "fs".`
- `runtime.local_file_missing`: `Cannot resolve "./helpers" from src/scripts/main.ts.`
- `runtime.build_error`: esbuild message with file, line, and column.
- `runtime.execution_error`: runtime exception posted from canvas iframe.

Publish should fail on build-blocking diagnostics. Canvas preview should show blocking diagnostics without losing the rest of the editor.

## Tests

Unit tests:

- Runtime config validation defaults.
- Script scope matching.
- Import analysis for package, relative, and disallowed imports.
- Dependency manifest and lock normalization.
- Script ordering by priority and path.
- Runtime asset manifest generation.

Server tests:

- Dependency cache uses exact lock hash.
- Installer rejects lifecycle-script execution.
- Bundler rejects undeclared imports.
- Bundler rejects Node builtins.
- Bundler emits shared vendor chunks.
- Publish stores runtime assets and injects page-specific script tags.
- Published pages without scripts keep `script-src 'none'`.
- Published pages with scripts emit `script-src 'self'`.

Editor tests:

- Creating a script creates default runtime config.
- Deleting a script cleans or ignores runtime config.
- Script settings sidebar updates runtime config.
- Dependencies panel shows usage from script imports.
- Canvas runtime preview displays build diagnostics.

End-to-end smoke:

1. Add `canvas-confetti`.
2. Create `src/scripts/confetti.ts`.
3. Import `canvas-confetti`.
4. Attach behavior to a page button.
5. See behavior in canvas runtime preview.
6. Publish.
7. Load public page.
8. Confirm script asset is served from `/_pb/assets/...`.
9. Confirm no request goes to an external package CDN.

## Rollout Plan

Phase 1 - Data model and diagnostics:

- Add `site.runtime`.
- Add script runtime config defaults.
- Add import analysis.
- Upgrade Dependencies panel to show script usage and missing dependency diagnostics.

Phase 2 - Dependency resolution and cache:

- Add server-side dependency resolver.
- Add lock metadata.
- Add isolated dependency cache installer.
- Add install diagnostics and tests.

Phase 3 - Bundler:

- Add virtual site workspace.
- Add esbuild bundling for `src/scripts/*.ts`.
- Add self-hosted asset manifest.
- Add build diagnostics.

Phase 4 - Canvas runtime preview:

- Add page runtime iframe in the canvas area.
- Add preview build endpoint.
- Add runtime error reporting.
- Add script editor sidebar controls.

Phase 5 - Publish integration:

- Build runtime assets during publish.
- Store immutable assets.
- Inject runtime assets into published pages.
- Serve assets from `/_pb/assets/...`.
- Update CSP behavior.

Phase 6 - Polish:

- Better dependency version UI.
- Rebuild progress and cache status.
- Source mapped runtime errors.
- Optional dependency update workflow.

## Resolved Implementation Decisions

- Published runtime assets are stored in Postgres `bytea` rows for V1.
- Canvas preview uses a sandboxed `srcdoc` iframe with inlined bundled JavaScript for V1.
- The canvas gets an explicit Design / Runtime Preview control. When a script file is active and `runInCanvas` is true, the Runtime Preview option is emphasized but not forced.

The required invariant is that both preview and publish use the same runtime builder and dependency lock.
