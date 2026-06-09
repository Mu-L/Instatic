/**
 * Server-side render of the agent's posted tree into the HTML read surface.
 *
 * `renderAgentPage` produces the artifacts the model edits: the annotated
 * `<body>` (each element tagged `uid="<nodeId>"`) plus page-relevant CSS in a
 * `<style>` block. It intentionally does NOT inline the public full-site CSS
 * bundle: browser-only font-face declarations and unrelated imported-page
 * ambient selectors are dead weight in model context. Reset CSS is also
 * omitted — it is page-independent browser-normalisation boilerplate the agent
 * never reasons about.
 */

import { registry } from '@core/module-engine'
import type {
  AnyModuleDefinition,
  PropertyControl,
  PropertySchema,
} from '@core/module-engine'
import {
  collectUserStylesheetCss,
  generateFrameworkCss,
  generateClassCSS,
  publishPage,
  renderNode,
  sanitizeModuleCSS,
  type SiteCssBundle,
} from '@core/publisher'
import { describeFrameworkTokens } from '@core/framework'
import { describeFontTokens, generateFontTokenVariablesCss } from '@core/fonts'
import {
  isGeneratedClass,
  type Page,
  type SiteDocument,
  type StyleRule,
} from '@core/page-tree'
import type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'
import type { ModuleInfo, ModulePropInfo, ModuleStyleInfo, SnapshotTokens } from './snapshot'

/** A single token family name within `SnapshotTokens`. */
export type TokenFamily = keyof SnapshotTokens

export interface AgentPageRender {
  /** Annotated inner <body> HTML (uid="<nodeId>" on each element). */
  html: string
  /** The page's CSS wrapped in a <style> block; '' when the page has no CSS. */
  css: string
}

const EMPTY_AGENT_CSS_BUNDLE: SiteCssBundle = {
  reset: { bundle: 'reset', filename: 'reset-empty.css', hash: 'empty', content: '' },
  framework: { bundle: 'framework', filename: 'framework-empty.css', hash: 'empty', content: '' },
  style: { bundle: 'style', filename: 'style-empty.css', hash: 'empty', content: '' },
  userStyles: { bundle: 'userStyles', filename: 'userStyles-empty.css', hash: 'empty', content: '' },
}

/** Extract the inner `<body>` HTML from a full published document. */
function extractBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/)
  return m ? m[1] : html
}

export function renderAgentPage(snap: SiteAgentSnapshot): AgentPageRender {
  const { page, site } = snap
  const { html: fullDocument } = publishPage(page, site, registry, {
    annotateNodeIds: true,
    cssEmission: 'external',
    cssBundle: EMPTY_AGENT_CSS_BUNDLE,
  })
  const html = extractBody(fullDocument)
  const cssBody = [
    buildAgentFrameworkCss(site),
    collectPageModuleCss(page, site),
    collectAgentPageClassCss(page, site),
    collectUserStylesheetCss(site, page),
  ].filter(Boolean).join('\n\n')
  const css = cssBody ? `<style>\n${cssBody}\n</style>` : ''

  return { html, css }
}

function buildAgentFrameworkCss(site: SiteDocument): string {
  return [
    generateFontTokenVariablesCss(site.settings.fonts),
    generateFrameworkCss(site),
  ].filter(Boolean).join('\n')
}

/**
 * Collect module CSS for the active page only. The public CSS bundle walks the
 * whole site because visitor pages share page-invariant files; `read_page`
 * inlines CSS into model context, so unrelated pages must not ride along.
 */
function collectPageModuleCss(page: Page, site: SiteDocument): string {
  const acc = {
    cssMap: new Map<string, string>(),
    infiniteLoopIds: new Set<string>(),
    holeNodeIds: new Set<string>(),
  }
  renderNode(page.rootNodeId, { page, site, registry, breakpointId: undefined }, acc)
  return Array.from(acc.cssMap.values()).join('\n')
}

function collectAgentPageClassCss(page: Page, site: SiteDocument): string {
  if (!site.styleRules) return ''

  const usedClassIds = collectActivePageClassIds(page, site)
  const usedClassNames = new Set<string>()
  const rules: Record<string, StyleRule> = {}

  for (const id of usedClassIds) {
    const rule = site.styleRules[id]
    if (!rule || isGeneratedClass(rule) || rule.kind !== 'class') continue
    rules[id] = rule
    usedClassNames.add(rule.name)
  }

  for (const rule of Object.values(site.styleRules)) {
    if (rule.kind !== 'ambient' || isGeneratedClass(rule)) continue
    if (ambientRuleCanAffectPage(rule, usedClassNames)) rules[rule.id] = rule
  }

  return sanitizeModuleCSS(generateClassCSS(rules, site.breakpoints, site.conditions ?? []))
}

function collectActivePageClassIds(page: Page, site: SiteDocument): Set<string> {
  const ids = new Set<string>()
  for (const node of Object.values(page.nodes)) {
    for (const id of node.classIds ?? []) ids.add(id)
  }

  // Visual Components render inline when referenced by the active page. The
  // ref-to-definition graph can be nested, so keep VC class CSS conservative:
  // include class ids from all VC definitions rather than risking a missing
  // component-scoped selector in read_page.
  for (const vc of site.visualComponents ?? []) {
    for (const id of vc.classIds ?? []) ids.add(id)
    for (const node of Object.values(vc.tree.nodes)) {
      for (const id of node.classIds ?? []) ids.add(id)
    }
  }
  return ids
}

function ambientRuleCanAffectPage(rule: StyleRule, usedClassNames: Set<string>): boolean {
  if (rule.rawCss) return true
  const selectorClasses = selectorClassTokens(rule.selector)
  if (selectorClasses.length === 0) return true
  return selectorClasses.every((name) => usedClassNames.has(name))
}

const CLASS_SELECTOR_RE = /\.((?:\\.|[-_a-zA-Z0-9])+)/g

function selectorClassTokens(selector: string): string[] {
  const tokens: string[] = []
  for (const match of selector.matchAll(CLASS_SELECTOR_RE)) {
    tokens.push(match[1]!.replace(/\\([^\s])/g, '$1'))
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Catalog derivations — the module/token surface the agent's catalog tools
// (`list_modules`, `list_tokens`) return. Sourced from the server registry +
// the posted site, replacing the old browser-flattened snapshot fields.
// ---------------------------------------------------------------------------

/** Describe every insertable module from the registry (excludes `base.body`). */
export function describeAgentModules(): ModuleInfo[] {
  return registry
    .list()
    .filter((mod) => mod.id !== 'base.body')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(moduleDefinitionToModuleInfo)
}

/** Describe the site's design tokens (framework colors/typography/spacing + fonts). */
export function describeAgentTokens(site: SiteDocument): SnapshotTokens {
  return {
    ...describeFrameworkTokens(site.settings.framework),
    fonts: describeFontTokens(site.settings.fonts),
  }
}

/**
 * Narrow a token digest to one family, leaving the others empty so the shape
 * stays stable. Returns the full digest when no family is given.
 */
export function filterTokenFamily(tokens: SnapshotTokens, family?: TokenFamily): SnapshotTokens {
  if (!family) return tokens
  return {
    colors: family === 'colors' ? tokens.colors : [],
    typography: family === 'typography' ? tokens.typography : [],
    spacing: family === 'spacing' ? tokens.spacing : [],
    fonts: family === 'fonts' ? tokens.fonts : [],
  }
}

function moduleDefinitionToModuleInfo(mod: AnyModuleDefinition): ModuleInfo {
  return {
    id: mod.id,
    name: mod.name,
    description: mod.description,
    category: mod.category,
    canHaveChildren: mod.canHaveChildren,
    defaults: toSerializableRecord(mod.defaults ?? {}),
    props: schemaToModuleProps(mod.schema, mod.defaults ?? {}),
    styles: genericStyleHintsForModule(mod),
  }
}

function genericStyleHintsForModule(mod: AnyModuleDefinition): ModuleStyleInfo[] {
  if (mod.id === 'base.text' || mod.category.toLowerCase() === 'typography') {
    return [
      { key: 'fontFamily', type: 'text', label: 'Font family', defaultValue: 'inherit', cssProperties: ['fontFamily'] },
      { key: 'fontSize', type: 'text', label: 'Font size', defaultValue: '16px', cssProperties: ['fontSize'] },
      { key: 'fontWeight', type: 'select', label: 'Font weight', defaultValue: '400', cssProperties: ['fontWeight'], options: [
        { label: 'Regular', value: '400' },
        { label: 'Medium', value: '500' },
        { label: 'Semi bold', value: '600' },
        { label: 'Bold', value: '700' },
        { label: 'Black', value: '900' },
      ] },
      { key: 'lineHeight', type: 'text', label: 'Line height', defaultValue: '1.4', cssProperties: ['lineHeight'] },
      { key: 'letterSpacing', type: 'text', label: 'Letter spacing', defaultValue: '0px', cssProperties: ['letterSpacing'] },
      { key: 'color', type: 'color', label: 'Text color', defaultValue: 'inherit', cssProperties: ['color'] },
      { key: 'textAlign', type: 'select', label: 'Text align', defaultValue: 'left', cssProperties: ['textAlign'], options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
        { label: 'Right', value: 'right' },
        { label: 'Justify', value: 'justify' },
      ] },
      { key: 'marginBottom', type: 'text', label: 'Bottom margin', defaultValue: '0px', cssProperties: ['marginBottom'] },
    ]
  }

  return []
}

function schemaToModuleProps(
  schema: PropertySchema,
  defaults: Record<string, unknown>,
): ModulePropInfo[] {
  const props: ModulePropInfo[] = []

  for (const [key, control] of Object.entries(schema)) {
    if (control.type === 'group') {
      props.push(...schemaToModuleProps(control.children, defaults))
      continue
    }
    props.push(controlToModuleProp(key, control, defaults[key]))
  }

  return props
}

function controlToModuleProp(
  key: string,
  control: Exclude<PropertyControl, { type: 'group' }>,
  defaultValue: unknown,
): ModulePropInfo {
  const prop: ModulePropInfo = {
    key,
    type: control.type,
    label: control.label,
    description: control.description,
    defaultValue: toSerializableValue(defaultValue),
  }

  if (control.breakpointOverridable === true) {
    prop.breakpointOverridable = true
  }

  if (control.type === 'select') {
    prop.options = control.options.map((option) => ({
      label: option.label,
      value: toSerializableValue(option.value),
    }))
  }

  return prop
}

function toSerializableRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = toSerializableValue(value)
  }
  return result
}

function toSerializableValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) return value.map(toSerializableValue)

  if (typeof value === 'object' && value) {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toSerializableValue(nestedValue)
    }
    return result
  }

  return String(value)
}
