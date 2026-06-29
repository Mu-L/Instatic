/**
 * Headless design-system read tool for MCP.
 *
 * The agent reads (and writes) the site as HTML + CSS — pages come back as HTML
 * (`read_document` / `getNodeHtml`), and this returns the design system as a CSS
 * stylesheet: the design tokens (CSS custom properties for colors, type scale,
 * spacing) plus every class and ambient rule. It is the exact CSS you write
 * back with `applyCss`, so Instatic just parses it back and forth.
 *
 * Server-resolved + headless: reads the draft site shell straight from the DB
 * (`getDraftSite`) and reuses the publisher's CSS emitters. No editor, no
 * browser snapshot — fixing the old `list_tokens` (which silently needed the
 * editor's posted snapshot and returned nothing over MCP).
 */
import { Type } from '@core/utils/typeboxHelpers'
import { isGeneratedClass, type SiteDocument, type StyleRule } from '@core/page-tree'
import { generateClassCSS, generateFrameworkCss } from '@core/publisher'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool, ToolContext } from '../../runtime/types'
import { getDraftSite } from '../../../repositories/site'

const SITE_READ_CAPS: readonly CoreCapability[] = [
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.edit',
]

const ReadStylesInput = Type.Object(
  {
    className: Type.Optional(
      Type.String({
        description: 'Limit output to one class by name (without the leading dot). Omit for the full stylesheet.',
      }),
    ),
    includeTokens: Type.Optional(
      Type.Boolean({
        description: 'Include the design-token (CSS custom property) definitions. Defaults to true; ignored when className is set.',
      }),
    ),
  },
  { additionalProperties: false },
)

export const styleMcpTools: AiTool[] = [
  {
    name: 'read_styles',
    description:
      "Read the site's design system as a CSS stylesheet — design tokens (CSS custom properties for colors, type scale, spacing) plus every class and ambient rule. This is the SAME CSS you write back with applyCss, so read it first to learn the available classes (e.g. .ist-btn) and token variables (e.g. var(--ist-accent)) before authoring HTML/CSS. Works headless — no open editor needed. Pass className to read one rule; omit for the whole sheet.",
    scope: 'site',
    execution: 'server',
    inputSchema: ReadStylesInput,
    requiredCapabilities: SITE_READ_CAPS,
    handler: async (input, ctx: ToolContext) => {
      const { className, includeTokens = true } = input as { className?: string; includeTokens?: boolean }
      const site = await getDraftSite(ctx.db)
      if (!site) return { ok: false, error: 'No site found.' }

      // Author-defined classes + ambient rules. Framework-generated utility
      // classes are excluded here — they ride in the token CSS below.
      const rules: Record<string, StyleRule> = {}
      for (const [id, rule] of Object.entries(site.styleRules)) {
        if (isGeneratedClass(rule)) continue
        if (className && !(rule.kind === 'class' && rule.name === className)) continue
        rules[id] = rule
      }

      const parts: string[] = []
      if (includeTokens && !className) {
        // generateFrameworkCss reads site.settings.framework; pages/VCs/layouts
        // are irrelevant to token emission, so complete the SiteDocument shape
        // with empties.
        const doc: SiteDocument = { ...site, pages: [], visualComponents: [], layouts: [] }
        const tokenCss = generateFrameworkCss(doc).trim()
        if (tokenCss) parts.push(`/* === Design tokens === */\n${tokenCss}`)
      }
      const classCss = generateClassCSS(rules, site.breakpoints, site.conditions ?? []).trim()
      if (classCss) parts.push(`/* === Classes === */\n${classCss}`)

      if (className && parts.length === 0) {
        return { ok: false, error: `No class named "${className}" found.` }
      }

      return { css: parts.join('\n\n'), classCount: Object.keys(rules).length }
    },
  },
]
