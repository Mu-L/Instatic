# Templates

Templates are pages that wrap other content — every page on the site (everywhere layouts) or every entry in a post type. They are the mechanism for shared headers, footers, and layout chrome.

A template is an ordinary `pages` row carrying a `target` (everywhere or one/more post types) and a `priority`. When the public router resolves a URL, it collects every matching template, orders them broadest→narrowest, and a composer splices each inner tree into the outer template's single `base.outlet`, producing one merged page tree. That tree feeds the existing `publishPage` pipeline unchanged.

---

## TL;DR

- A template declares `target: { kind: 'everywhere' } | { kind: 'postTypes', tableSlugs }` and a `priority`.
- **Chain resolver:** `resolveTemplateChain(site, ctx)` in `src/core/templates/templateMatching.ts` → `Page[]` ordered outer → inner. At most one template per breadth level (highest priority wins, document order breaks ties). Two breadth levels today: `everywhere` (outermost) → `postTypes` (innermost).
- **Chain composer:** `composeTemplateChain(chain, terminal)` in `src/core/templates/templateCompose.ts` → one merged `Page` ready for `publishPage`.
- **`base.outlet`** is the single polymorphic outlet every template must contain. Exactly one is required; zero or two is an authoring error blocked at save time.
- Template pages are never served at their own slug; the live router and the static bake both skip them.
- Dynamic bindings and token interpolation work exactly as before — the merged tree is a plain page tree.
- **`templateTargetLabel(page)`** returns a short human-readable string for a template's target (e.g. `"Everywhere"` or `"posts, news"`); import from `@core/templates`.

---

## Where the code lives

```text
src/core/page-tree/pageTemplate.ts     — TemplateTarget, PageTemplateConfig, parsePageTemplate
src/core/templates/
├── templateMatching.ts                — resolveTemplateChain, isTemplatePage, templateTargetLabel, RouteResolutionContext
├── templateCompose.ts                 — composeTemplateChain, TerminalContent
├── templateValidation.ts              — findOutletIds, assertSingleOutlet, TemplateOutletError
├── contextFrames.ts                   — PageFrame, SiteFrame, RouteFrame + builders
├── dynamicBindings.ts                 — TemplateRenderDataContext + resolveDynamicProps
├── templatePreviewData.ts             — buildPreviewCells, dataTablePreviewToLoopItem
└── tokenInterpolation.ts             — parseTokenString, interpolateTokens, walkFieldPath

src/modules/base/outlet/               — base.outlet module (Content Outlet)
server/repositories/data/templateSeeding.ts  — seed + backfill for default entry templates
server/publish/publicRouter.ts         — isTemplatePage guard on direct slug routing
server/publish/publicRenderer.ts       — chain-aware render paths
```

---

## Template schema

```ts
// src/core/page-tree/pageTemplate.ts
type TemplateTarget =
  | { kind: 'everywhere' }
  | { kind: 'postTypes'; tableSlugs: string[] }   // ≥1 slug

interface PageTemplateConfig {
  enabled: true
  target: TemplateTarget
  priority: number   // higher = preferred when multiple match the same breadth level
}
```

A `Page` carries `template?: PageTemplateConfig`. When `template.enabled === true` the page is a template; `isTemplatePage(page)` is the single predicate used everywhere.

`parsePageTemplate(raw)` is the tolerant boundary parser — the single validator; row⇄page adapters delegate to it. A stray `conditions` key in stored data is silently ignored (conditions were cut from the model; there is no `conditions` field).

### Storage columns

In the `data_rows` table the `pages` system table stores template config in three columns:

| Column            | Type    | Description                                           |
|-------------------|---------|-------------------------------------------------------|
| `templateEnabled` | boolean | `true` when this page is a template                   |
| `templateTarget`  | JSON    | Serialized `TemplateTarget` — `{ kind, tableSlugs? }` |
| `templatePriority`| number  | Higher wins when multiple templates match one level   |

`templateTarget` is a single JSON column that replaced three earlier separate fields (`templateContext`, `templateTableSlug`, `templateConditions`). The row⇄page adapter parses it through `parsePageTemplate`.

---

## Chain resolution

`resolveTemplateChain(site, ctx)` walks the two breadth levels (outer → inner) and picks the highest-priority matching template at each level:

```ts
type RouteResolutionContext =
  | { kind: 'page' }
  | { kind: 'entry'; tableSlug: string }
```

| Route kind | Breadth 0 (everywhere) | Breadth 1 (postTypes) |
|------------|------------------------|------------------------|
| `page`     | matched if exists      | never matched          |
| `entry`    | matched if exists      | matched if `tableSlugs.includes(tableSlug)` |

Within a level, the template with the highest `priority` wins; document order breaks ties.

**Adding a new breadth level** (e.g. path-prefix sections) means inserting a new entry into the `LEVELS` constant in `templateMatching.ts` — the resolver loop is level-agnostic.

---

## Chain composition

`composeTemplateChain(chain, terminal)` merges the ordered template list + a terminal into one `Page`:

```ts
type TerminalContent =
  | { kind: 'page'; page: Page }   // inject a normal page's content into the chain
  | { kind: 'entry' }              // leave the innermost base.outlet to render currentEntry.body
```

Splice rule (applied from innermost outward):
- Each template's **single `base.outlet` node** is located (throws `TemplateOutletError` if there are 0 or 2).
- The inner content is spliced at the outlet position. Inner node ids are re-keyed with a prefix so merged trees never have collisions.
- **Inner `base.body` drop:** the inner tree's `base.body` wrapper is removed on splice — the outermost template owns the document `<body>`. If the inner `base.body` carries non-empty `props` or `breakpointOverrides`, its children are wrapped in a `base.container` bearing those values so body-level styling is not lost.

Result: one merged `Page` consumed by `publishPage` unchanged — one CSS bundle pass, one media prefetch, one HTML emit.

---

## base.outlet

`base.outlet` is the single, polymorphic outlet module:

- **Render:** emits `<article data-instatic-content-region>{props.html}</article>`. When `props.html` is empty, the empty `<article>` is the live-edit anchor for the Content workspace.
- **Binding (entry route):** the seed attaches `dynamicBindings: { html: { source: 'currentEntry', field: 'body', format: 'html' } }` to the outlet node so the entry's body flows in at render time. This keeps the Content workspace's Tiptap mount working via the `data-instatic-content-region` marker.
- **Splice (page route):** `composeTemplateChain` removes the `base.outlet` node and inserts the page's content in its place before `publishPage` is called. No outlet node reaches the renderer on page routes.
- **Canvas preview:** the `OutletEditor` component shows a labelled placeholder in the editor.

Every template must contain **exactly one** `base.outlet`. The `TemplateSettingsDialog` validates this at save time via `findOutletIds(page)` and blocks save with a `role="alert"` message when the count is not 1.

---

## Routing — templates are not directly accessible

Template pages are never served at their own slug:

- **Live router** (`server/publish/publicRouter.ts`): after fetching `pageSnapshot` by slug, skips the page if `isTemplatePage(page)` and falls through to the row/redirect/not-found path.
- **Static bake** (`server/repositories/publish.ts`): the `publishDraftSiteLocked` bake loop skips any page where `isTemplatePage(page)` so no `/<template-slug>.html` artefact is written.

---

## Render paths

```text
public GET /<slug>  →  resolvePublicRoute
                            │
                    (page route) pageSnapshot
                            │
                    resolveTemplateChain(site, { kind: 'page' })
                    composeTemplateChain(chain, { kind: 'page', page })
                    publishPage(merged, …)

public GET /<routeBase>/<rowSlug>  →  resolvePublicRoute
                            │
                    (entry route) dataRow + tableSlug
                            │
                    resolveTemplateChain(site, { kind: 'entry', tableSlug })
                    composeTemplateChain(chain, { kind: 'entry' })
                    publishPage(merged, …, templateContext: { entryStack: [row] })
```

Render paths: `server/publish/publicRenderer.ts` — `renderPublishedSnapshot` (page route), `renderPublishedDataRowTemplate` (entry route).

### Chain for each route kind (v1)

| Route | Chain (outer→inner) | Terminal |
|-------|--------------------|----|
| `/about` (page)          | `[everywhere-layout?]`                           | the `/about` page tree |
| `/posts/hello` (entry)   | `[everywhere-layout?, posts-entry-template]`     | `{ kind: 'entry' }` — outlet renders the row body |

If no `everywhere` layout exists, a plain page renders exactly as a page with no templates. If no postTypes template exists for a route, the entry URL 404s.

### Static re-bake on template edit

A full `publishDraftSite` re-bakes every non-template page through `renderPublishedSnapshot`, which runs the chain each time — so editing an `everywhere` layout and publishing re-bakes all page artefacts automatically. Entry-detail artefacts (`/posts/hello.html`) are written incrementally by `publishDataRow` (chain-aware since v1) and wiped on the next full slot swap.

---

## Context frames and dynamic bindings

Context frames are unchanged from before templates were added — the merged tree is still a plain page tree that resolves the same binding sources:

```ts
interface TemplateRenderDataContext {
  page?:        PageFrame       // page id, slug, title, templateTableSlug
  site?:        SiteFrame       // site name, settings, breakpoints
  route?:       RouteFrame      // URL parts
  entryStack:   LoopItem[]      // pushed by loops + entry route render
}
```

`resolveDynamicProps(node.props, node.dynamicBindings, ctx)` runs on every node in the merged tree. Template authors bind to `currentEntry.<field>` (top of `entryStack`) just as before.

See the "Dynamic bindings" section below for the full source table.

### Available binding sources

| Source         | Frame                     | Use case                                                |
|----------------|---------------------------|---------------------------------------------------------|
| `currentEntry` | Top of `entryStack`       | Inside loops, inside entry templates                    |
| `parentEntry`  | Second-from-top           | Nested loops                                            |
| `site`         | `ctx.site`                | Anywhere — site name, primary color                     |
| `route`        | `ctx.route`               | URL-driven (route.segments, route.slug)                 |
| `page`         | `ctx.page`                | Current page metadata                                   |

---

## Token interpolation

Text props mix literal text + tokens:

```text
"Hello {currentEntry.title} — read more at {site.name}"
```

`parseTokenString(input)` returns `TokenSegmentNode[]`; `interpolateTokens(input, ctx)` evaluates and concatenates. Tokens that resolve to `undefined` render as the empty string.

Source: `src/core/templates/tokenInterpolation.ts`.

---

## Editor canvas preview

When editing a template page, the canvas needs a `currentEntry` without a published row. `useTemplatePreviewContext` in `src/admin/pages/site/hooks/useTemplatePreviewContext.ts` builds a synthetic preview:

- **`postTypes` target:** fetches the table schema by `target.tableSlugs[0]` and synthesizes a preview row via `dataTablePreviewToLoopItem(table)`.
- **`everywhere` target:** no current entry — `base.outlet` renders as a placeholder in the canvas.

---

## Seeding — default entry templates

When a postType `data_table` is created, `seedDefaultEntryTemplate(db, table)` in `server/repositories/data/templateSeeding.ts` inserts a default template page:

- `templateEnabled: true`, `templateTarget: { kind: 'postTypes', tableSlugs: [table.slug] }`, `templatePriority: 0`
- Page tree: `base.body` > `base.heading` (bound to `currentEntry.title`) + `base.outlet` (bound to `currentEntry.body` via `html` format)

`backfillDefaultEntryTemplates(db)` at boot covers postType tables created before the template system was added.

---

## Cookbook

### Add a site-wide layout (everywhere template)

1. Create a new page. Set it as a template ("Template settings…" in the page menu).
2. Choose target: **Everywhere**.
3. Build the layout — a header block, a `base.outlet` (Content Outlet from the block list), a footer block.
4. Publish. Every page and post now renders inside this layout.

### Add an entry template for a postType

When a postType is created, the system seeds a default entry template automatically. To customize:

1. Open the template page in the visual editor.
2. Edit it like any page — bind nodes to `currentEntry.<field>` via the Properties panel.
3. Add `base.outlet` anywhere you want the post body to flow.
4. Publish.

### Share a layout across post types

Set `targetKind: 'postTypes'` and check multiple post types in the Template settings dialog. A single template can list several `tableSlugs`.

### Custom token in text

```ts
// In an editor property control:
node.props.text = 'Posted by {currentEntry.author.displayName} on {currentEntry.publishedAt}'
```

`interpolateTokens(props.text, ctx)` runs at publish time. Paths that resolve to `undefined` render as the empty string.

---

## Forbidden patterns

| Pattern | Use instead |
|---------|------------|
| Reading `currentEntry` from a module's `render` without bindings | Set `dynamicBindings` on the node — keeps the schema honest |
| Hardcoding a template's slug in server handlers | Use `resolveTemplateChain(site, ctx)` |
| Creating a template page via raw `INSERT INTO pages` | Use `seedDefaultEntryTemplate(...)` or the admin dialog |
| Walking a deep binding path with `JSON.parse(JSON.stringify(...))` | Use `walkFieldPath(frame, 'a.b.c')` |
| Expecting to visit a template page at its own slug | Template pages are never directly routable — the live router and bake loop both skip them |
| Inlining `page.template?.target.kind === 'everywhere' ? … : …` in UI code | Use `templateTargetLabel(page)` from `@core/templates` |
| Two `base.outlet` nodes in one template | Exactly one is required — `assertSingleOutlet` throws `TemplateOutletError`; the admin dialog blocks save |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/features/content-storage.md](content-storage.md) — `data_tables.routeBase` + `data_rows.slug`
- [docs/features/publisher.md](publisher.md) — walker runs on the merged tree
- [docs/features/loops.md](loops.md) — loops push items onto the same entry stack
- [docs/reference/page-tree.md](../reference/page-tree.md) — `PageNode.dynamicBindings`
- Source-of-truth files:
  - `src/core/page-tree/pageTemplate.ts` — `TemplateTarget`, `PageTemplateConfig`, `parsePageTemplate`
  - `src/core/templates/templateMatching.ts` — `resolveTemplateChain`, `isTemplatePage`, `templateTargetLabel`
  - `src/core/templates/templateCompose.ts` — `composeTemplateChain`
  - `src/core/templates/templateValidation.ts` — `findOutletIds`, `assertSingleOutlet`, `TemplateOutletError`
  - `src/core/templates/contextFrames.ts` — frame shapes + builders
  - `src/core/templates/dynamicBindings.ts` — `TemplateRenderDataContext`, `resolveDynamicProps`
  - `src/core/templates/tokenInterpolation.ts` — `parseTokenString`, `interpolateTokens`
  - `src/modules/base/outlet/index.ts` — `base.outlet` module
  - `server/repositories/data/templateSeeding.ts` — default-template seeding
  - `server/publish/publicRenderer.ts` — chain-aware render paths
