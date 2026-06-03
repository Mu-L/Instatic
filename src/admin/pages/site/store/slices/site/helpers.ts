/**
 * Closure-shared helpers for the site slice.
 *
 * `buildSiteHelpers(set, get)` returns the shared mutation helpers packaged
 * into a single object that gets passed to every per-domain action factory.
 *
 * `reconcileVCRefsForVc` and `depthInTree` are pure utilities consumed by the
 * helpers / action factories — they live here so they sit next to the active
 * tree code that uses them.
 */

import { nanoid } from 'nanoid'
import type { StoreApi } from 'zustand'
import type {
  BaseNode,
  NodeTree,
  Page,
  PageNode,
  StyleRule,
  SiteDocument,
  FrameworkColorToken,
} from '@core/page-tree'
import type { SiteRuntimeConfig } from '@core/site-runtime'
import { addPage, createNode, reconcileSiteExplorerInPlace } from '@core/page-tree'
import { syncSlotInstances, applySlotSyncResult } from '@core/visualComponents'
import type { Draft } from 'immer'
import type { ImportFragment } from '@core/htmlImport'
import type {
  NewStyleRule,
  ImportColorToken,
  ImportScript,
} from '@core/siteImport'
import type { SiteFile } from '@core/files/schemas'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import { normalizeFrameworkColorSlug } from '@core/framework/colors'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG } from '@core/site-runtime'
import type { EditorStore } from '@site/store/types'
import { MAX_HISTORY } from './defaults'
import { reconcileFrameworkClasses } from './framework/reconcile'
import { indexStyleRulesByName, linkImportedClassNames } from './importLinking'
import { addImportedFonts, addImportedFontTokens } from './importedFonts'
import type { SiteMutationResult, SiteSliceHelpers, SiteSliceImmerRecipe, SuperImportHelpers } from './types'

/**
 * Walk every page's tree, find every `base.visual-component-ref` that points
 * at the given vcId, and run `syncSlotInstances` on each so its slot-instance
 * children match the VC's current set of slot-outlets.
 *
 * MUST be called inside an Immer producer (operates on draft state).
 */
function reconcileVCRefsForVc(
  state: { site: SiteDocument | null },
  vcId: string,
): void {
  if (!state.site) return
  const vc = state.site.visualComponents.find((v) => v.id === vcId)
  if (!vc) return

  for (const page of state.site.pages) {
    const treeNodes = page.nodes as Record<string, BaseNode>
    // Snapshot ids first — applySlotSyncResult mutates the map.
    const refIds = Object.keys(treeNodes).filter((id) => {
      const n = treeNodes[id]
      return (
        n?.moduleId === 'base.visual-component-ref' &&
        (n.props as Record<string, unknown>).componentId === vcId
      )
    })
    for (const refId of refIds) {
      const refNode = treeNodes[refId]
      if (!refNode) continue
      const syncResult = syncSlotInstances(refNode, vc, treeNodes)
      applySlotSyncResult(treeNodes, syncResult, refId)
    }
  }
}

/**
 * Compute a node's depth in the active tree by walking up to root.
 * Used by `deleteNodes` to delete leaves before parents within a single batch
 * so descendants aren't double-removed (which would throw inside the helper).
 *
 * Returns 0 for the root, +Infinity for orphans (sorts last in DESC order →
 * effectively a no-op when the orphan slot is reached).
 */
export function depthInTree(tree: NodeTree<PageNode>, nodeId: string): number {
  if (nodeId === tree.rootNodeId) return 0
  let current = nodeId
  let depth = 0
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const parent = Object.values(tree.nodes).find((n) => n.children.includes(current))
    if (!parent) return Infinity
    depth++
    if (parent.id === tree.rootNodeId) return depth
    current = parent.id
  }
  return depth
}

/**
 * Build the closure-shared helpers passed to every per-domain action factory.
 *
 * The `mutate*` helpers snapshot the current site before running the recipe,
 * then commit that snapshot to undo history only when the recipe reports a
 * semantic mutation. Recipes return `false` for explicit no-ops; `void` keeps
 * the historical default of "changed" so existing mutating recipes remain
 * concise. They differ only in what they hand the recipe:
 *
 *   - `mutateSite`:       the SiteDocument draft.
 *   - `mutateSiteState`:  the full editor-state draft plus the SiteDocument draft.
 *   - `mutatePage`:       the active page (legacy single-document mode).
 *   - `mutateActiveTree`: the active NodeTree<PageNode>, routed by `activeDocument`.
 *
 * `mutateActiveTree` is the SOLE place that branches on `kind === 'visualComponent'`
 * — every named tree-mutation action delegates to it. Gated by
 * `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`.
 */
export function buildSiteHelpers(
  set: (recipe: SiteSliceImmerRecipe) => void,
  get: StoreApi<EditorStore>['getState'],
): SiteSliceHelpers {
  function recipeDidMutate(result: SiteMutationResult): boolean {
    return result !== false
  }

  function pushHistorySnapshot(
    state: Parameters<SiteSliceImmerRecipe>[0],
    snapshot: SiteDocument,
  ): void {
    state._historyPast.push(snapshot)
    if (state._historyPast.length > MAX_HISTORY) {
      state._historyPast.shift() // evict oldest
    }
    state._historyFuture = []
    state.canUndo = true
    state.canRedo = false
  }

  function snapshotCurrentSite(): SiteDocument | null {
    const { site } = get()
    return site ? structuredClone(site) : null
  }

  /** Snapshot current site into undo history, then clear redo stack. */
  function pushHistory(): void {
    const { site } = get()
    if (!site) return
    set((state) => {
      pushHistorySnapshot(state, structuredClone(site))
    })
  }

  /** Mutate the active page — auto-snapshots undo history on real changes. */
  function mutatePage(fn: (page: Page) => SiteMutationResult): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const page = state.site.pages.find((p) => p.id === state.activePageId)
      if (!page) return
      const result = fn(page)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /**
   * Mutate the active node tree — auto-snapshots undo history on real changes.
   *
   * Routes to the correct tree based on `activeDocument`:
   *   - Page mode (null or kind === 'page'): passes the active Page directly —
   *     Page IS NodeTree<PageNode> so no conversion needed.
   *   - VC mode (kind === 'visualComponent'): passes vc.tree directly —
   *     VCNode (= BaseNode) is structurally compatible with PageNode (which only
   *     adds optional `dynamicBindings`), so the cast is safe for all tree
   *     mutations that operate on BaseNode-level fields.
   *     After the mutation, propagates any change in the VC's slot-outlet set
   *     to every consumer VC ref across all pages via `syncSlotInstances`.
   *     This is what makes adding a `base.slot-outlet` to a VC automatically
   *     materialize a `base.slot-instance` child on every consumer.
   */
  function mutateActiveTree(fn: (tree: NodeTree<PageNode>) => SiteMutationResult): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const { activeDocument } = state

      if (activeDocument?.kind === 'visualComponent') {
        const vc = state.site.visualComponents.find((v) => v.id === activeDocument.vcId)
        if (!vc) return
        // VCNode is structurally compatible with PageNode (dynamicBindings is optional).
        // All tree mutations operate on BaseNode-level fields, so the cast is safe.
        const result = fn(vc.tree as NodeTree<PageNode>)
        if (!recipeDidMutate(result)) return
        pushHistorySnapshot(state, snapshot)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
        changed = true

        // Propagate slot-outlet changes to every consumer VC ref. Idempotent
        // when the slot-outlet set is unchanged. Cheap: O(pages × refs × tree
        // size); for non-trivial sites still well below a frame budget.
        reconcileVCRefsForVc(state, vc.id)
        return
      }

      // Page mode (activeDocument is null or kind === 'page').
      // Page IS NodeTree<PageNode> — pass directly, no conversion needed.
      const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : state.activePageId
      const page = state.site.pages.find((p) => p.id === pageId)
      if (!page) return
      const result = fn(page)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /** Mutate the site — auto-snapshots undo history on real changes. */
  function mutateSite(fn: (site: SiteDocument) => SiteMutationResult): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const result = fn(state.site)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  const mutateSiteWithExplorerReconcile: SiteSliceHelpers['mutateSiteWithExplorerReconcile'] = (fn) =>
    mutateSite((site) => {
      const result = fn(site)
      if (!recipeDidMutate(result)) return false
      reconcileSiteExplorerInPlace(site)
      return result
    })

  /** Mutate editor state and site together — auto-snapshots undo history on real changes. */
  const mutateSiteState: SiteSliceHelpers['mutateSiteState'] = (fn) => {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const result = fn(state, state.site)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /**
   * Mutate the active node tree AND the surrounding site — auto-snapshots
   * undo history on real changes. Same active-document routing as `mutateActiveTree`, but
   * also hands the recipe a `SiteDocument` draft so it can read or write
   * site-level state alongside the tree mutation in one transaction.
   *
   * Used by duplicate operations that must clone scoped classes (which live
   * on `site.styleRules`) atomically with the node duplication. Without this
   * the duplicate's `classIds` would point at the source's scoped classes,
   * silently coupling per-node CSS across both nodes.
   */
  function mutateActiveTreeAndSite(
    fn: (tree: NodeTree<PageNode>, site: SiteDocument) => SiteMutationResult,
  ): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const { activeDocument } = state

      if (activeDocument?.kind === 'visualComponent') {
        const vc = state.site.visualComponents.find((v) => v.id === activeDocument.vcId)
        if (!vc) return
        const result = fn(vc.tree as NodeTree<PageNode>, state.site)
        if (!recipeDidMutate(result)) return
        pushHistorySnapshot(state, snapshot)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
        changed = true
        // Mirror mutateActiveTree's slot-outlet propagation contract.
        reconcileVCRefsForVc(state, vc.id)
        return
      }

      const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : state.activePageId
      const page = state.site.pages.find((p) => p.id === pageId)
      if (!page) return
      const result = fn(page, state.site)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /**
   * Mutate the entire site — all pages and style rules — in ONE undoable
   * history snapshot. The recipe receives a SiteDocument draft and transaction
   * helpers for adding or overwriting pages and style rules.
   *
   * Class names on imported fragment nodes are resolved to registry ids (and
   * unknown names auto-create bare classes) via the shared `byName` map that
   * the helpers build once and share across the whole recipe. This guarantees
   * that a class added by `addStyleRule` earlier in the recipe is reused by
   * `addPage` later in the same recipe — no duplicate rules for the same name.
   *
   * A history snapshot is pushed ONLY when the recipe returns a non-false
   * result AND at least one helper actually mutated the site. Explicit no-ops
   * (`return false`) never produce a history entry.
   */
  function mutateAllPagesAndSite(
    fn: (site: SiteDocument, helpers: SuperImportHelpers) => SiteMutationResult,
  ): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const site = state.site
      let didMutate = false

      // Build the name→id index once. All helpers share this map so that
      // a `addStyleRule(kind:'class', name:'btn')` followed by
      // `addPage(fragment with node.classIds:['btn'])` resolves to the same id.
      const byName = indexStyleRulesByName(site.styleRules)

      const helpers: SuperImportHelpers = {
        addPage({ id: pageId, title, slug, nodeFragment }: { id?: string; title: string; slug: string; nodeFragment: ImportFragment }): string {
          // addPage creates a fresh base.body root, normalises the slug, and
          // pushes the page onto site.pages. We then graft the fragment nodes
          // in as children of that root — same logical step as insertImportedNodes.
          const page = addPage(site as SiteDocument, title, slug)
          // Honour a caller-supplied id so the importer can pre-mint page ids
          // and rewrite internal links to `cms:page:<id>` before committing.
          if (pageId) page.id = pageId
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            // `node.inlineStyles` rides along on the spread — first-class field.
            page.nodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName),
            }
          }
          page.nodes[page.rootNodeId]!.children = [...nodeFragment.rootIds]
          didMutate = true
          return page.id
        },

        addStyleRule(rule: NewStyleRule): string {
          const id = nanoid()
          const now = Date.now()
          // Append after every existing rule so imports don't disrupt the
          // established cascade order.
          let maxOrder = -1
          for (const r of Object.values(site.styleRules)) {
            if (typeof r.order === 'number' && r.order > maxOrder) maxOrder = r.order
          }
          const newRule: StyleRule = {
            ...rule,
            id,
            createdAt: now,
            updatedAt: now,
            order: maxOrder + 1,
          }
          site.styleRules[id] = newRule
          // Register in byName so subsequent addPage calls referencing this
          // class name resolve to this id rather than creating a duplicate.
          if (rule.kind === 'class') byName.set(rule.name, id)
          didMutate = true
          return id
        },

        overwritePage(pageId: string, { title, slug, nodeFragment }: { title: string; slug: string; nodeFragment: ImportFragment }): void {
          const page = site.pages.find((p) => p.id === pageId)
          if (!page) throw new Error('overwritePage: page not found')

          // Mint a fresh body root; wire fragment roots as its children.
          const rootNode = createNode('base.body')
          rootNode.children = [...nodeFragment.rootIds]

          const newNodes: Record<string, PageNode> = { [rootNode.id]: rootNode }
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            newNodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName),
            }
          }

          // Replace tree fields; preserve identity + ownership fields.
          page.rootNodeId = rootNode.id
          page.nodes = newNodes
          page.title = title
          page.slug = slug
          didMutate = true
        },

        overwriteStyleRule(ruleId: string, rule: NewStyleRule): void {
          const existing = site.styleRules[ruleId]
          if (!existing) throw new Error('overwriteStyleRule: style rule not found')

          const now = Date.now()
          // Replace all fields except identity + cascade position.
          site.styleRules[ruleId] = {
            ...rule,
            id: ruleId,
            createdAt: existing.createdAt,
            updatedAt: now,
            order: existing.order,
          }
          if (rule.kind === 'class') byName.set(rule.name, ruleId)
          didMutate = true
        },

        addConditions(conditions): void {
          if (conditions.length === 0) return
          if (!site.conditions) site.conditions = []
          const existing = new Set(site.conditions.map((c) => c.id))
          for (const def of conditions) {
            if (existing.has(def.id)) continue
            existing.add(def.id)
            site.conditions.push(def)
            didMutate = true
          }
        },

        addFonts(fonts): { id: string; family: string }[] {
          const committed = addImportedFonts(site, fonts)
          if (committed.length > 0) didMutate = true
          return committed
        },

        addFontTokens(tokens): { id: string; name: string; variable: string }[] {
          const committed = addImportedFontTokens(site, tokens)
          if (committed.length > 0) didMutate = true
          return committed
        },

        addColorTokens(colors): { slug: string; value: string }[] {
          const committed = addImportedColorTokens(site, colors)
          if (committed.length > 0) {
            reconcileFrameworkClasses(site)
            didMutate = true
          }
          return committed
        },

        addScripts(scripts): { id: string; path: string }[] {
          const committed = addImportedScripts(site, state.siteRuntime, scripts)
          if (committed.length > 0) didMutate = true
          return committed
        },
      }

      const result = fn(site as SiteDocument, helpers)
      if (recipeDidMutate(result) && didMutate) {
        pushHistorySnapshot(state, snapshot)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
        changed = true
      }
    })
    return changed
  }

  return {
    set,
    get,
    pushHistory,
    mutatePage,
    mutateActiveTree,
    mutateActiveTreeAndSite,
    mutateSite,
    mutateSiteWithExplorerReconcile,
    mutateSiteState,
    mutateAllPagesAndSite,
  }
}

/**
 * Merge imported colour tokens into `site.settings.framework.colors` as PLAIN
 * BASE tokens — each emits only `--<slug>` (no shades/tints/transparent variants
 * and no `bg-/text-/border-` utility classes), so the palette is a faithful 1:1
 * of the source `:root` and every imported `var(--<slug>)` keeps resolving.
 *
 * A slug already present in the framework (case/format-normalised) is skipped:
 * the existing token wins, mirroring the class-conflict "first wins" rule.
 *
 * @returns The committed `{ slug, value }` for each newly-added token.
 */
function addImportedColorTokens(
  site: Draft<SiteDocument>,
  colors: ImportColorToken[],
): { slug: string; value: string }[] {
  if (colors.length === 0) return []

  // Ensure the framework colours container exists (enabling the framework).
  site.settings.framework ??= { colors: { tokens: [] } }
  site.settings.framework.colors ??= { tokens: [] }
  const tokens = site.settings.framework.colors.tokens

  const existingSlugs = new Set(tokens.map((t) => normalizeFrameworkColorSlug(t.slug)))
  let maxOrder = tokens.reduce((m, t) => Math.max(m, t.order ?? 0), -1)
  const committed: { slug: string; value: string }[] = []

  for (const { slug: rawSlug, value } of colors) {
    const slug = normalizeFrameworkColorSlug(rawSlug)
    if (existingSlugs.has(slug)) continue
    existingSlugs.add(slug)
    const now = Date.now()
    const token: FrameworkColorToken = {
      id: nanoid(),
      category: '',
      slug,
      lightValue: value,
      darkValue: '',
      darkModeEnabled: false,
      generateUtilities: { text: false, background: false, border: false, fill: false },
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
      order: (maxOrder += 1),
      createdAt: now,
      updatedAt: now,
    }
    tokens.push(token)
    committed.push({ slug, value })
  }

  return committed
}

/**
 * Add imported JS files as `SiteFile`s (`type: 'script'`) plus an all-pages
 * `site.runtime.scripts` entry each, so they run on every published page. The
 * runtime entry is mirrored onto the live `siteRuntime` draft (the canvas reads
 * that copy) exactly as `filesSlice.deleteFile` mirrors its delete.
 *
 * Paths are normalised + made unique within `site.files`; an unsafe source path
 * falls back to a sanitised name under `src/scripts/`.
 *
 * @returns The committed `{ id, path }` for each added script.
 */
function addImportedScripts(
  site: Draft<SiteDocument>,
  siteRuntime: Draft<SiteRuntimeConfig> | undefined,
  scripts: ImportScript[],
): { id: string; path: string }[] {
  if (scripts.length === 0) return []

  site.runtime ??= { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {}, styles: {} }
  site.runtime.scripts ??= {}

  const usedPaths = new Set(site.files.map((f) => f.path))
  const committed: { id: string; path: string }[] = []

  for (const script of scripts) {
    const path = uniqueFilePath(safeScriptPath(script.path), usedPaths)
    usedPaths.add(path)

    const id = nanoid()
    const now = Date.now()
    const file: SiteFile = {
      id,
      path,
      type: 'script',
      content: script.content,
      createdAt: now,
      updatedAt: now,
    }
    site.files.push(file)

    const config = { ...DEFAULT_SCRIPT_RUNTIME_CONFIG }
    site.runtime.scripts[id] = config
    if (siteRuntime?.scripts) siteRuntime.scripts[id] = { ...config }

    committed.push({ id, path })
  }

  return committed
}

/** Normalise a source path into a safe SiteFile path, falling back to src/scripts/. */
function safeScriptPath(rawPath: string): string {
  const normalized = normalizePath(rawPath)
  if (isSafePath(normalized)) return normalized
  const base = (rawPath.split('/').pop() ?? 'script.js').replace(/[^a-zA-Z0-9._-]+/g, '-')
  return `src/scripts/${base || 'script.js'}`
}

/** Append `-2`, `-3`, … before the extension until the path is unused. */
function uniqueFilePath(path: string, used: Set<string>): string {
  if (!used.has(path)) return path
  const dot = path.lastIndexOf('.')
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : ''
  let n = 2
  while (used.has(`${stem}-${n}${ext}`)) n += 1
  return `${stem}-${n}${ext}`
}
