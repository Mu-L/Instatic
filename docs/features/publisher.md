# Publisher

The publisher — the page-tree-to-HTML/CSS renderer. Takes a `Page` (a `NodeTree<PageNode>`) plus a `SiteDocument` and emits a clean, standalone HTML document with a single per-page CSS bundle.

The published output has **no framework runtime**, **no client-side hydration of layout**, and **no decorative markup** the browser doesn't need. Plugins can inject frontend assets at four anchor points (`head`, `head-end`, `body-start`, `body-end`), but the page structure itself is static.

---

## TL;DR

- Entry point: `publishPage(page, ctx)` in `src/core/publisher/render.ts`. Returns the full HTML document string.
- Recursion: `renderNode(nodeId, ctx)` in `renderNode.ts`. Bottom-up walk. Two specialized renderers hook in for `base.visual-component-ref` and `base.loop`.
- Hidden nodes (`node.hidden`) are pruned at the top of `renderNode`, before unknown-module comments, dynamic holes, specialized renderers, standard rendering, or CSS collection.
- Per-node flow: render children → resolve effective + dynamic props → `escapeProps` → call `module.render(props, renderedChildren)` → collect deduped CSS → inject author class names.
- CSS is deduped by `moduleId` via `CssCollector` (~60–80% size reduction on typical pages).
- Module `render()` is a **pure function**: no DOM, no React, no side effects (Constraint #179).
- Every node's props pass through `escapeProps` before `render()` (Constraint #211).
- Server-side wrappers (`server/publish/publicRouter.ts` → `publicRenderer.ts` → `publishedHtmlPipeline.ts`) call `publishPage`, run plugin filters, and return the HTML in the visitor response.
- Output is routed through a three-layer publishing pipeline: **Layer A** bakes fully-static pages to `uploads/published/current/<route>.html` at publish time (atomic two-slot symlink swap). **Layer B** memoises dynamic pages in an in-memory LRU keyed by `(urlPath, queryString)` with per-entry version tracking; `bumpPublishVersion()` evicts lazily and version capture at render start discards results from mid-flight publishes. **Layer C** emits `<instatic-hole>` placeholders for nodes auto-classified as request-dependent; a ~668 B `IntersectionObserver` runtime lazy-loads each fragment via `/_instatic/hole/<nodeId>`.
- Auto-classification lives in `src/core/publisher/dynamicDetection.ts:findDynamicNodesWithReasons` — one walker, four rules, used by `isFullyStaticPage` (Layer A) and `renderNode`'s placeholder emission (Layer C). Authors don't toggle anything.

---

## Where the code lives

```text
src/core/publisher/
├── render.ts                       — publishPage (entry point + page-level orchestration)
├── renderNode.ts                   — recursive node walker; emits <instatic-hole> for nodes in dynamicNodeIds
├── renderContext.ts                — RenderContext shape (includes dynamicNodeIds + publishVersion)
├── renderVisualComponentRef.ts     — inline a Visual Component instance into the page
├── renderLoop.ts                   — iterate a loop source, round-robin child variants
├── escapeProps.ts                  — HTML-escape string props at the render boundary
├── classInjection.ts               — inject author classIds into rendered HTML
├── classCss.ts                     — compile user StyleRule → CSS
├── cssCollector.ts                 — CssCollector + collectClassCSS + sanitizeModuleCSS
├── reset.ts                        — PUBLISHER_RESET_CSS (cross-browser baseline)
├── frameworkCss.ts                 — site framework CSS (spacing scale, typography)
├── userStylesheets.ts              — site-level user stylesheets
├── siteCssBundle.ts                — hash-named bundle composition (reset + framework + style)
├── sizesResolver.ts                — `<img sizes>` auto-resolution from viewport contexts
├── dynamicDetection.ts             — Single walker for the 4 auto-detection rules; powers Layers A and C
├── staticAnalysis.ts               — Thin projections: isFullyStaticPage (predicate) + staticReasons (diagnostics)
└── utils.ts                        — escapeHtml, isSafeUrl

server/publish/
├── publicRouter.ts                 — gateway: Layer A disk fast-path → Layer B LRU → live resolver
├── staticArtefact.ts               — two-slot symlink swap + read/write/purge artefacts (Layer A); all URL-derived paths are validated by `resolveArtefactPath` (URL-decode + `..`-rejection + containment check after `path.join`)
├── renderCache.ts                  — in-memory LRU + publishVersion bump + single-flight (Layer B)
├── holeRuntime.ts                  — Layer C client runtime; exports runInstaticHoleRuntime (TS source) + HOLE_RUNTIME_JS (IIFE-serialized, ~668 B)
├── publicRenderer.ts               — renderPublishedSnapshot, renderPublishedDataRowTemplate
├── publishedHtmlPipeline.ts        — post-process (sanitize + plugin filters + injections)
├── siteCssBundle.ts                — server-side hashing + file emission
├── frontendInjections.ts           — splice plugin <script>/<link>/<meta> into HTML
├── mediaPresentation.ts            — <picture>/<srcset> materialization at publish time
├── mediaPrefetch.ts, loopPrefetch.ts — pre-warm caches needed by the renderer
├── republish.ts                    — bulk re-publish on site-level changes
├── publishScheduler.ts             — scheduled publish jobs
├── runtime/                        — per-site bun install workspace serving
└── loopRuntime.ts                  — loop runtime asset
```

---

## The `publishPage` flow

```text
publishPage(page, ctx)             ← src/core/publisher/render.ts
    │
    ├─→ resolve template-context frames (page / site / route)
    ├─→ inject root node's classIds into <body> tag
    ├─→ build <head>: title, description, favicon, lang, importmap, runtime <script>s, CSP
    ├─→ renderNode(rootNodeId, ctx)
    │       │
    │       ├─→ if node.hidden, return '' before any renderer or CSS path
    │       ├─→ specialised renderer for `base.visual-component-ref`  → renderVisualComponentRef
    │       ├─→ specialised renderer for `base.loop`                  → renderLoop
    │       └─→ renderStandardNode for everything else (the bulk of the tree)
    │
    ├─→ collect deduped module CSS via CssCollector
    ├─→ collect author class CSS via collectClassCSS
    ├─→ assemble: reset CSS + framework CSS + module CSS + class CSS + user stylesheets
    └─→ emit final HTML document
```

### `renderStandardNode` per-node flow

```text
For each node, bottom-up:

  1. children = node.children.map(renderNode)            ← recurse first
  2. resolvedProps  = resolveProps(node, breakpoint)     ← merge breakpoint overrides
  3. dynamicProps   = resolveDynamicProps(...)           ← apply data bindings
  4. safeProps      = escapeProps(dynamicProps, schema)  ← HTML-escape strings
  5. attachResolvedMediaByKey(safeProps, def, ...)       ← attach <picture>/<srcset>
  6. attachAutoSizes(safeProps, def, ...)                ← auto <img sizes>
  7. { html, css } = def.render(safeProps, children)                  ← MODULE BOUNDARY
  8. css = sanitizeModuleCSS(css)                        ← DOMPurify
  9. cssCollector.add(moduleId, css)                     ← dedup by moduleId
 10. html = injectNodeClassIds(html, node, site)         ← splice classIds into root tag
 11. return html
```

The walker is recursive, but every step is local — there's no global state mutation, no cross-node coupling. Each node's output is a function of its node + its already-rendered children.

---

## Module render API

A module's `render()` is the only thing the walker calls per node. It's a **pure** function:

```ts
type ModuleRender<TProps> = (
  props:             TProps,       // already HTML-escaped + bindings resolved
  renderedChildren:  string[],     // pre-rendered child HTML strings
) => { html: string; css?: string }
```

- **No DOM access**, **no React**, **no side effects**. The result is a string of HTML and an optional string of CSS.
- String props are HTML-safe after `escapeProps` — interpolate them directly. For URL attributes (`href`, `src`, `action`) use `safeUrl(value)` from `src/core/publisher/utils.ts`.
- Join children as `renderedChildren.join('')`; leaf modules receive an empty array.
- The returned `css` is collected and deduped — emitting the same CSS for every instance of a module is fine; it appears once in the page bundle.

Constraints (gated by tests):

- **Constraint #179** — render() is pure.
- **Constraint #211** — `escapeProps` runs on every node before render(); modules can trust string props are HTML-safe.

---

## Specialised renderers

### `base.visual-component-ref` — Visual Component instances

When the walker hits a `base.visual-component-ref` node, it calls `renderVisualComponentRef`:

1. Resolves the target Visual Component from the site's `components` table.
2. Builds an inner `RenderContext` whose tree is the VC's `tree` and whose `instanceProps` are taken from the ref node's props.
3. Walks the VC tree via `renderNode`, with prop bindings (`{paramId}`) substituted against the instance props.
4. Pairs each `base.slot-instance` (in the consumer page tree, beneath the VC ref) with its matching `base.slot-outlet` (in the VC definition tree) by `slotName` and inlines the consumer-supplied content.

See [docs/features/visual-components.md](visual-components.md) for the VC modeling details.

### `base.loop` — loop sources

When the walker hits a `base.loop` node, it calls `renderLoop`:

1. Resolves the loop's entity source (a built-in source like `content.entries`, `site.pages`, `site.media`, or a plugin-registered source).
2. Pulls items from the loop fetch result (pre-warmed by `loopPrefetch.ts` during publish).
3. Walks the loop's child variants in round-robin, pushing each item onto the entry stack so child nodes' `dynamicBindings` resolve `currentEntry.<field>` against that item.
4. Concatenates the rendered variant HTML and returns it.

See [docs/features/loops.md](loops.md) for sources, filters, and registration.

---

## CSS pipeline

A published page links **four** hashed CSS bundles (`buildSiteCssBundle`), in
cascade order. Source order resolves specificity ties: user CSS wins over the
class registry, which wins over framework, which wins over reset.

```text
reset-<hash>.css       = PUBLISHER_RESET_CSS                       ← reset.ts (cross-browser baseline)
framework-<hash>.css   = buildSiteFrameworkCss(site)               ← frameworkCss.ts (spacing, typography, …)
                       + collectModuleCSS(via CssCollector)        ← deduped per-moduleId CSS
style-<hash>.css       = collectClassCSS(site)                     ← user-defined StyleRule entries
userStyles-<hash>.css  = collectUserStylesheetCss(site, page)      ← author stylesheets, scoped to this page
```

`reset` / `framework` / `style` are page-invariant — every page on the site
shares the same hash. `userStyles` is **page-scoped**: each author stylesheet
(`site.files[type === 'style']`) carries a `SiteStyleRuntimeConfig` (in
`site.runtime.styles[fileId]`) with an enable flag, a page/template scope, and
a cascade priority. `collectUserStylesheetCss(site, page)` selects the
stylesheets that target `page`, orders them by `priority` then `path`, and
concatenates them — so two pages with different stylesheet targeting get
different `userStyles` content (and hash). This mirrors how scripts are scoped
per page; the shared `assetScopeAppliesToPage` helper decides targeting for
both.

### CSS dedup via `CssCollector`

```ts
const collector = new CssCollector()
collector.add(moduleId, css)   // first call per moduleId is stored; subsequent calls are no-ops
collector.flush()              // returns the deduped CSS string
```

This is what shrinks published CSS by ~60–80% on typical pages (Decision #308). Every `<button>` module instance emits the same CSS once.

### CSS sanitization

`sanitizeModuleCSS(css)` runs DOMPurify-style filtering at the module boundary — modules can't smuggle `@import` of arbitrary URLs, `expression()` IE leftovers, or `javascript:` URLs into the published bundle.

### Hashed bundle filenames

The server's `siteCssBundle.ts` and the client's `siteCssBundle.ts` together name each bundle file `<group>-<contentHash>.css`. The publisher emits `<link rel="stylesheet" href="/_instatic/css/<bundle>-<hash>.css">` per non-empty bundle. `Cache-Control: immutable` (1 year) is safe because the hash changes whenever the content does.

Four bundles per page (each hashed independently): `reset`, `framework`,
`style`, `userStyles` — see the cascade table above.

### Static publishing — everything baked to disk

A full publish (`publishDraftSite`) bakes **every page** plus all of its assets
into the publish slot:

- **HTML** — fully-static pages bake to a complete document; pages with dynamic
  nodes bake their static **shell** with `<instatic-hole>` placeholders (the hole
  runtime hydrates each fragment from `/_instatic/hole/`). Either way the HTML is on
  disk. A page that fails to render (e.g. a VC ref cycle) is skipped and falls
  through to the live renderer.
- **CSS bundles** — `/_instatic/css/<bundle>-<hash>.css`, for every page.
- **Runtime JS** — `/_instatic/assets/<versionId>/…`, for every page.

The visitor router serves all of these straight off disk (`readArtefact` /
`readStaticAsset`) — no DB round-trip, no per-request rebuild. The slot is a
self-contained static export: **a published page never hits the server to
generate its HTML, CSS, or JS. The only request that touches the DB is the
`/_instatic/hole/` fragment fetch** for a page's dynamic islands.

Hole shells are stamped with the *next* publish version (`getPublishVersion() +
1`) at bake time, because `bumpPublishVersion()` runs as the synchronous
statement right after the slot swap — so a baked `<instatic-hole data-instatic-version>`
always matches what the hole endpoint expects (a mismatch would make the
endpoint refuse to hydrate).

The exclusive namespaces `/_instatic/css/*` (`serveSiteCss`) and `/_instatic/assets/*`
(`tryServeRuntimeAsset`) are served **disk-first**, falling back to a rebuild
(`serveSiteCss`) or the DB (`published_runtime_assets`) only for preview or a
publish whose disk write failed. Unknown paths under either prefix 404 rather
than falling through.

---

## `<head>` assembly

The publisher emits `<head>` in this order:

1. `<meta charset="utf-8">`
2. `<meta name="viewport" content="width=device-width, initial-scale=1">`
3. `<title>` from `page.title`
4. `<meta name="description">` if present in page settings
5. `<link rel="icon">` if a favicon is configured
6. `<script type="importmap">` mapping bare specifiers (e.g. `three`) to `/_instatic/runtime/cache/<hash>/...` URLs
7. Runtime asset `<script>` tags (`scriptTagsForRuntimeAssets`)
8. `<link rel="stylesheet" href="/_instatic/css/<bundle>-<hash>.css">` per bundle
9. **`head` placement** plugin-injected tags (after the publisher's own head, before custom user head content)
10. `<meta http-equiv="Content-Security-Policy" content="...">` — assembled based on what's actually in the page

Installed fonts are emitted through the CSS bundle, not external `<link>` tags. The font CSS includes self-hosted `@font-face` rules for `site.settings.fonts.items` plus `:root` declarations for editable tokens such as `--font-primary`. A page rule can therefore keep `font-family: var(--font-primary)` while the token assignment changes site-wide.

Plugins inject at four anchors. The order matters — see [docs/features/plugin-system.md](plugin-system.md) for the splicing rules.

### CSP

The CSP `<meta>` tag is built dynamically based on what the page contains:

- Always: `default-src 'self'`, restricted script sources, restricted style sources
- Add `worker-src 'self' blob:` if any module uses workers
- Add `connect-src` entries from plugin `network.outbound` allowlists
- Add font / image hosts derived from referenced URLs

Editing the CSP manually is **not** safe — it's a derived value. Edit the source list and re-emit.

---

## Server-side wrappers

`src/core/publisher/` is pure (no Bun, no Node, no fs). The server wraps it.

| File                                            | Role                                                                |
|-------------------------------------------------|---------------------------------------------------------------------|
| `server/publish/publicRouter.ts`                | Gateway: Layer A disk fast-path → Layer B LRU → live `resolvePublicRoute` + `renderPublicResolution`. |
| `server/publish/staticArtefact.ts`              | Two-slot symlink swap (`swapSlot`), per-file atomic writes (`writeArtefact`, `updateArtefactInPlace`), and reads (`readArtefact`). Layer A. |
| `server/publish/renderCache.ts`                 | In-memory LRU keyed by `(urlPath, queryString)`, entries versioned. `getOrRender` (single-flight) + `bumpPublishVersion`. Version captured at render start — a publish landing mid-render discards the result rather than caching stale HTML. Layer B. |
| `server/publish/holeRuntime.ts`                 | Exports `runInstaticHoleRuntime` (the TypeScript source of the Layer C runtime) and `HOLE_RUNTIME_JS` (IIFE-serialized string, ~668 B, served to browsers). Tests call `runInstaticHoleRuntime()` directly to avoid dynamic eval. |
| `server/publish/publicRenderer.ts`              | `renderPublishedSnapshot`, `renderPublishedDataRowTemplate`. Calls `publishPage`. |
| `server/publish/publishedHtmlPipeline.ts`       | Post-process: DOMPurify the final HTML, run plugin `publish.html` filter, splice in declarative tags from plugin manifests, inject runtime assets. Runs at publish time only — never per-request. |
| `server/publish/siteCssBundle.ts`               | Hash the three CSS strings, write `uploads/css/...` files.          |
| `server/publish/republish.ts`                   | Bulk re-publish on settings change (touches every page).            |
| `server/publish/publishScheduler.ts`            | Scheduled publish jobs (cron-style).                                |
| `server/publish/frontendInjections.ts`          | Compute plugin `<script>`/`<link>`/`<meta>` tags + CSP entries.     |
| `server/publish/mediaPresentation.ts`           | At publish time, build `<picture>` / `<img srcset>` markup from `media_assets.variants_json`. |
| `server/publish/mediaPrefetch.ts`               | Resolve all referenced media into a `Map<url, ResolvedMedia>` before render. |
| `server/publish/loopPrefetch.ts`                | Fetch every loop source's items before render so the walker is purely synchronous. |
| `server/publish/runtime/packageServer.ts`       | Serve per-site `bun install` workspace under `/_instatic/runtime/cache/`. |
| `server/publish/loopRuntime.ts`                 | The loop runtime asset (small JS shim used by certain loop variants).|
| `server/handlers/cms/hole.ts`                   | `GET /_instatic/hole-runtime.js` (serves `HOLE_RUNTIME_JS`) and `GET /_instatic/hole/<nodeId>` (renders a node subtree at request time for Layer C islands). |
| `server/richtextSanitizer.ts`                   | Installs the server's happy-dom-backed DOMPurify runtime without global DOM objects. |

### `publishedHtmlPipeline.ts` — the plugin filter point

After `publishPage` returns, the server runs:

```text
publishPage(page, ctx) → rawHtml
    │
    ▼
applyPublishedHtmlPipeline(rawHtml, ctx)
    │
    ├─→ DOMPurify-sanitize the entire document
    ├─→ Emit `publish.before` hook (plugins can prepare state)
    ├─→ Run `publish.html` filters in registration order (plugins transform the HTML string)
    ├─→ Splice in declarative tags from plugin manifests' `frontend.assets[]`
    ├─→ Emit `publish.after` hook
    └─→ Return final HTML
```

Plugins shouldn't need to know about the publisher internals — they get the HTML string and return the transformed string.

---

## Publishing a single page

```text
POST /admin/api/cms/publish/site
    │
    ▼
publishDraftSite (server/repositories/publish.ts)
    │
    ├─→ load draft site shell + all page-table rows + all VC rows
    ├─→ build runtime scripts + runtime package importmap
    ├─→ for each page: freeze into a PublishedPageSnapshot (JSON)
    ├─→ insert into data_row_versions with snapshot_json = that snapshot
    ├─→ flip data_rows.status = 'published', set active_version_id
    │
    ├─→ Layer A bake — CSS bundles + runtime JS → writeStaticAsset(<slot>)
    │
    ├─→ Layer A bake — every page (complete doc, or static shell with <instatic-hole>):
    │     ├── renderPublishedSnapshot(snapshot, { db, url, publishVersion }) → HTML
    │     ├── applyPublishedHtmlPipeline(rendered, db) → final HTML
    │     │   (plugin filters + frontend asset injection baked in)
    │     └── writeArtefact(<inactiveSlot>, urlPath, html)
    │         (atomic per-file: tmp + rename; per-page try/catch)
    │
    ├─→ swapSlot(uploadsDir, newActiveSlot)
    │     uploads/published/current → flips atomically (rename of a symlink
    │     is a single-inode swap; in-flight readers keep fds into the OLD
    │     slot until they close)
    │
    └─→ bumpPublishVersion() → Layer B LRU evicts lazily on next read

— and on the visitor request side —

GET /<slug>  OR  /<route-base>/<row-slug>
    │
    ▼
tryServePublicRoute (server/router.ts)
    │
    └─→ server/publish/publicRouter.ts:renderPublicResolution
          │
          ├─→ Layer A disk fast-path (only if url.search === ''):
          │     readArtefact(uploadsDir, url.pathname)
          │     hit → stream HTML (~0.6–1.4 ms, no DB, no render, no filter)
          │
          ├─→ resolvePublicRoute(db, url) → page | row | redirect | not-found
          │     redirects → 301 (not cached)
          │     not-found → null (router falls through to next handler)
          │
          └─→ Layer B in-memory LRU:
                getOrRender({urlPath, queryString}, async () => {
                  publishPage(page, ctx) using snapshot bytes
                  applyPublishedHtmlPipeline (plugin filters)
                  return { body, headers, status: 200 }
                })
                hit → return cached body (~0.8 ms)
                miss → factory runs once (single-flight on concurrent keys)
                publishVersion bumped at publish → entries evict lazily on next read
                version captured at factory start → mid-flight publish discards result (not cached)
```

The visitor-facing artefacts are:
1. **Disk files in the active slot** (`uploads/published/current/<route>.html`) — for fully-static routes. Final HTML, post-filter, frontend assets baked in. Rebuilt on each full publish.
2. **In-memory LRU entries** — for dynamic routes (loops, request-dependent bindings). Filled lazily, evicted on every publish.
3. **`<instatic-hole>` fragment responses** at `/_instatic/hole/<nodeId>` — for dynamic nodes inside otherwise-cacheable pages. Fetched lazily by the IntersectionObserver runtime; also cached in Layer B.

The `PublishedPageSnapshot` (JSON) in `data_row_versions.snapshot_json` remains the canonical audit record — all three layers derive from it.

---

## Adding a new module renderer

The publisher doesn't know about specific modules — it asks the registry. To add a new first-party module that renders correctly:

1. Define a `ModuleDefinition<TProps>` and call `registry.registerOrReplace(...)` from `src/modules/base/index.ts` (see [docs/features/modules.md](modules.md) and [docs/reference/module-engine.md](../reference/module-engine.md)).
2. Implement `render(props, renderedChildren) → { html, css? }` as a pure function.

That's it. The walker, escape, class injection, and CSS dedup all work automatically.

### Adding a new specialised renderer (rare)

The two existing specialised renderers (`renderVisualComponentRef`, `renderLoop`) hook in because they fundamentally **replace** the normal walk — VC ref inlines a different tree; loop iterates and round-robins. If you have a new module that needs to replace the walk:

1. Write the renderer in `src/core/publisher/<your>Renderer.ts`.
2. Take `renderNode` as a callback to keep the file graph acyclic.
3. Hook into `renderNode.ts`'s dispatch on `moduleId`.

This is rare and requires architectural review — most "new behavior" fits within the standard module render contract.

---

## Forbidden patterns

| Pattern                                                       | Use instead                                                |
|---------------------------------------------------------------|------------------------------------------------------------|
| Mutating the page tree inside a module's `render()`           | Render is pure. Compute, don't mutate.                     |
| Reading `document` / `window` inside `render()`               | The publisher runs server-side. There is no DOM.           |
| Calling `await` inside `render()`                             | Render is synchronous. Pre-warm async data via prefetch (loop, media). |
| Hardcoding `<link>` to a CSS file the publisher didn't emit   | Add a CSS string to the module's `render()` return — collected and deduped automatically. |
| Bypassing `escapeProps` by reading `node.props` directly inside `render()` | Read from the `props` argument — it's already escaped. |
| Hand-writing `<picture>` / `<img srcset>` in a module         | Set `props.<key>` to a media URL; `mediaPresentation.ts` materializes the markup. |
| Adding `@import url(...)` to module CSS                       | DOMPurify-style filter strips it. Add it to the site's user stylesheets instead. |
| Editing the CSP meta tag string manually                      | Edit the CSP source list — the tag is derived.             |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — server-side publishing wrappers
- [docs/features/visual-components.md](visual-components.md) — VC instances + slots
- [docs/features/loops.md](loops.md) — loop sources + the round-robin walk
- [docs/features/modules.md](modules.md) — defining a module
- [docs/features/media.md](media.md) — media variants + presentation
- [docs/features/plugin-system.md](plugin-system.md) — `publish.before/.html/.after` filters
- Source-of-truth files:
  - `src/core/publisher/render.ts` — `publishPage`
  - `src/core/publisher/renderNode.ts` — the walker
  - `src/core/publisher/renderContext.ts` — `RenderContext`
  - `src/core/publisher/cssCollector.ts` — `CssCollector` + sanitization
  - `src/core/publisher/escapeProps.ts` — Constraint #211 enforcement
  - `server/publish/publishedHtmlPipeline.ts` — plugin filter point
  - `server/publish/publicRenderer.ts` — server wrappers
- Gate tests:
  - `src/__tests__/architecture/dispatcher-html-pipeline.test.ts`
  - `src/__tests__/architecture/publish-html-filter-context.test.ts`
  - `src/__tests__/architecture/media-presentation-pipeline.test.ts`
