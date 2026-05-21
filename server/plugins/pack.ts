/**
 * Plugin pack — importable Visual Components, page templates, and class
 * definitions delivered alongside a plugin.
 *
 * The plugin manifest declares `pack: { path: 'pack/site.json' }` (path is
 * relative to the package zip). When the site owner triggers an "install
 * pack" action from the Plugins admin page, the host:
 *
 *   1. Loads the pack JSON from disk (plus integrity / containment checks).
 *   2. Validates each entry against the canonical site-document schemas
 *      (`parseVisualComponent`, `parsePageNode` traversal, etc.).
 *   3. Merges into the active draft site by id — ids that already exist on
 *      the site get replaced (idempotent re-install). Class ids prefixed
 *      with the plugin id stay namespaced; non-namespaced classes from the
 *      pack are rejected to keep ownership traceable.
 *   4. Saves the updated site.
 *
 * Pack validation lives here so the route handler stays thin and the rules
 * are easy to test directly.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CSSClass,
  Page,
  SiteDocument,
} from '@core/page-tree'
import {
  parseVisualComponent,
  type VisualComponent,
} from '@core/visualComponents/schemas'
import { parseValue, safeParseValue, Value } from '@core/utils/typeboxHelpers'
import { Type } from '@sinclair/typebox'
import { CSSClassSchema, PageSchema } from '@core/page-tree'
import { assertPluginPathWithin } from './runtime'

export interface PluginPackContents {
  visualComponents: VisualComponent[]
  pages: Page[]
  classes: CSSClass[]
}

export interface PluginPackInstallResult {
  installed: PluginPackContents
  /** ids that already existed on the site and got overwritten by the pack. */
  replacedIds: {
    visualComponents: string[]
    pages: string[]
    classes: string[]
  }
}

export class PluginPackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginPackError'
  }
}

const PluginPackFileSchema = Type.Object({
  visualComponents: Type.Optional(Type.Array(Type.Unknown())),
  pages: Type.Optional(Type.Array(Type.Unknown())),
  classes: Type.Optional(Type.Array(Type.Unknown())),
})

export async function loadPluginPackFile(
  uploadsDir: string,
  assetBasePath: string,
  packPath: string,
): Promise<unknown> {
  const relativeBase = assetBasePath.replace(/^\/uploads\/?/, '')
  const fullPath = join(uploadsDir, relativeBase, packPath)
  assertPluginPathWithin(uploadsDir, fullPath)
  const text = await readFile(fullPath, 'utf-8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new PluginPackError(`Plugin pack file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function parsePluginPack(pluginId: string, raw: unknown): PluginPackContents {
  const parsed = safeParseValue(PluginPackFileSchema, raw)
  if (!parsed.ok) {
    throw new PluginPackError(`Plugin pack manifest is malformed: ${parsed.errors[0]?.message ?? 'unknown error'}`)
  }

  const visualComponents: VisualComponent[] = []
  for (const rawVc of parsed.value.visualComponents ?? []) {
    const vc = parseVisualComponent(rawVc)
    if (!vc) {
      throw new PluginPackError(`Plugin "${pluginId}" pack contains an invalid Visual Component entry`)
    }
    visualComponents.push(vc)
  }

  const pages: Page[] = []
  for (const rawPage of parsed.value.pages ?? []) {
    if (!Value.Check(PageSchema, rawPage)) {
      throw new PluginPackError(`Plugin "${pluginId}" pack contains an invalid Page entry`)
    }
    pages.push(parseValue(PageSchema, rawPage) as Page)
  }

  const classes: CSSClass[] = []
  for (const rawClass of parsed.value.classes ?? []) {
    if (!Value.Check(CSSClassSchema, rawClass)) {
      throw new PluginPackError(`Plugin "${pluginId}" pack contains an invalid CSS class entry`)
    }
    const cls = parseValue(CSSClassSchema, rawClass) as CSSClass
    if (!cls.id.startsWith(`${pluginId}/`) && !cls.id.startsWith(`${pluginId}.`)) {
      throw new PluginPackError(
        `Plugin "${pluginId}" pack class "${cls.id}" must be namespaced under the plugin id (e.g. "${pluginId}/${cls.id}").`,
      )
    }
    // The CSS class `name` doubles as the rendered HTML classname (see
    // `classNamesForClassIds` in `@core/page-tree/classNames`). Whitespace
    // would split it into multiple classes, none of which would have rules.
    // Reject pack authors that ship friendly names — the `id` is for
    // namespacing, the `name` is the CSS identifier.
    if (!isValidCssClassName(cls.name)) {
      throw new PluginPackError(
        `Plugin "${pluginId}" pack class "${cls.id}" name "${cls.name}" is not a valid CSS class name. Use a single token (no spaces, no slashes), e.g. "${suggestClassName(pluginId, cls.id)}".`,
      )
    }
    classes.push(cls)
  }

  return { visualComponents, pages, classes }
}

const CSS_CLASS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/

function isValidCssClassName(name: string): boolean {
  return CSS_CLASS_NAME_PATTERN.test(name)
}

function suggestClassName(pluginId: string, classId: string): string {
  const tail = classId.replace(`${pluginId}/`, '').replace(`${pluginId}.`, '')
  const safeTail = tail.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const safePrefix = pluginId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safePrefix}-${safeTail || 'class'}`
}

/**
 * Merge a parsed pack's pages and classes into a site document, replacing
 * entries by id. Returns the next site document and a list of replaced ids
 * per category.
 *
 * NOTE: Visual Components are no longer merged into the shell. They are
 * returned separately in `pack.visualComponents` so the caller can upsert
 * them as `data_rows` (table_id = 'components') via the data API.
 * See `installPluginPackToSite` in `server/handlers/cms/plugins/pack.ts`.
 */
export function applyPluginPackToSite(
  site: SiteDocument,
  pack: PluginPackContents,
): { site: SiteDocument; replaced: PluginPackInstallResult['replacedIds'] } {
  const replaced: PluginPackInstallResult['replacedIds'] = {
    visualComponents: [],
    pages: [],
    classes: [],
  }

  // VCs are handled separately by the caller (upserted as data_rows).
  // Record which existing VC ids would be replaced.
  for (const vc of pack.visualComponents) {
    if (site.visualComponents.some((v) => v.id === vc.id)) {
      replaced.visualComponents.push(vc.id)
    }
  }

  const pagesById = new Map(site.pages.map((p) => [p.id, p]))
  for (const page of pack.pages) {
    if (pagesById.has(page.id)) replaced.pages.push(page.id)
    pagesById.set(page.id, page)
  }

  const nextClasses = { ...site.classes }
  for (const cls of pack.classes) {
    if (nextClasses[cls.id]) replaced.classes.push(cls.id)
    nextClasses[cls.id] = cls
  }

  return {
    site: {
      ...site,
      pages: [...pagesById.values()],
      classes: nextClasses,
      updatedAt: Date.now(),
    },
    replaced,
  }
}
